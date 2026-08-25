import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { config, projectRoot } from './config.js';
import { iotConfig } from '../IoT/config.js';
import { serveGeneratedAudio } from '../IoT/audioStore.js';
import { readIoTRuntimeStatus } from '../IoT/runtimeStatus.js';
import { CARD_CATALOG, CARD_CATEGORIES } from './cards.js';
import { createChatCompletion, LlmError } from './llm.js';
import { buildStoryMessages, getLengthOptions, normalizeStoryRequest, ValidationError } from './story.js';
import { synthesizeSpeech, TtsError } from './tts.js';
import { createPoolIdentity, normalizeClient, StoryDatabase, StoryDatabaseError } from './storyStore.js';

const publicRoot = path.join(projectRoot, 'public');
const maximumBodySize = 64 * 1024;
const storyIdPattern = /^[0-9a-f-]{36}$/i;
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};
let lastDatabaseErrorLogAt = 0;
let lastDatabaseErrorMessage = '';

function applyCommonHeaders(response, requestId) {
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id, X-Story-Client-Type, X-Story-Client-Id');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendAudio(response, speech) {
  response.writeHead(200, {
    'Content-Type': speech.contentType,
    'Content-Length': speech.audio.length,
    'Content-Disposition': `inline; filename="story.${speech.format}"`,
    'X-TTS-Model': speech.model,
    'X-TTS-Latency-Ms': speech.latencyMs,
    'X-TTS-Task-Id': speech.taskId,
    'X-TTS-Cached': String(Boolean(speech.cached))
  });
  response.end(speech.audio);
}

function requestClient(request, body = {}) {
  return normalizeClient({
    type: request.headers['x-story-client-type'] || body.client_type,
    id: request.headers['x-story-client-id'] || body.device_id || body.client_id
  });
}

async function databaseStatus(storyDatabase) {
  if (!storyDatabase.configured) return { configured: false, ready: false };
  try {
    await storyDatabase.initialize();
    return { configured: true, ready: true };
  } catch (error) {
    const now = Date.now();
    if (error.message !== lastDatabaseErrorMessage || now - lastDatabaseErrorLogAt >= 60_000) {
      console.error(JSON.stringify({ event: 'story_database.unavailable', message: error.message }));
      lastDatabaseErrorMessage = error.message;
      lastDatabaseErrorLogAt = now;
    }
    return { configured: true, ready: false };
  }
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBodySize) {
      const error = new ValidationError('请求内容不能超过 64 KB');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new ValidationError('请求内容不是有效的 JSON');
  }
}

async function serveStatic(requestPath, response, headOnly = false) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return false;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const filename = path.resolve(publicRoot, relativePath);
  const relative = path.relative(publicRoot, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

  try {
    const content = await fs.readFile(filename);
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control': path.extname(filename) === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    response.end(headOnly ? undefined : content);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

async function findGeneratedAudio(storyId) {
  let entries;
  try {
    entries = await fs.readdir(iotConfig.audioDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mp3.json')) continue;
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(iotConfig.audioDirectory, entry.name), 'utf8'));
      if (metadata.story_id !== storyId) continue;
      const audioId = entry.name.slice(0, -'.mp3.json'.length);
      matches.push({
        audio_id: audioId,
        request_id: metadata.request_id || '',
        device_id: metadata.device_id || '',
        card_ids: metadata.card_ids || [],
        language: metadata.language || 'en-US',
        bytes: Number(metadata.bytes || 0),
        created_at: metadata.created_at || null,
        endpoint: `/api/iot/audio/${audioId}.mp3`
      });
    } catch {
      // Ignore an incomplete metadata file while the IoT service is writing it.
    }
  }
  return matches.sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))[0] || null;
}

async function buildStoryDelivery(story, iotStatusPath) {
  const generatedAudio = await findGeneratedAudio(story.story_id);
  const runtime = await readIoTRuntimeStatus(iotStatusPath);
  const requestId = generatedAudio?.request_id || '';
  const events = requestId
    ? (runtime.recent_actions || []).filter((action) => String(action.detail || '').includes(requestId))
    : [];
  return {
    generated_audio: generatedAudio,
    mqtt: {
      request_id: requestId,
      device_id: generatedAudio?.device_id || '',
      events,
      status_available: Boolean(runtime.updated_at && !runtime.stale)
    }
  };
}

async function handleApi(request, response, pathname, requestId, storyDatabase, iotStatusPath) {
  const iotAudioMatch = pathname.match(/^\/api\/iot\/audio\/([A-Za-z0-9_-]{1,80})\.mp3$/);
  if (['GET', 'HEAD'].includes(request.method) && iotAudioMatch) {
    await serveGeneratedAudio(request, response, iotAudioMatch[1]);
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/iot/dashboard') {
    sendJson(response, 200, await readIoTRuntimeStatus(iotStatusPath));
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/health') {
    const database = await databaseStatus(storyDatabase);
    sendJson(response, 200, {
      status: 'ok',
      service: 'story-machine-web-service',
      llm_configured: Boolean(config.llm.apiKey),
      tts_configured: Boolean(config.tts.apiKey && config.tts.endpoint),
      database_configured: database.configured,
      database_ready: database.ready,
      timestamp: new Date().toISOString()
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, {
      model: config.llm.model,
      base_url: config.llm.baseUrl,
      llm_configured: Boolean(config.llm.apiKey),
      tts_configured: Boolean(config.tts.apiKey && config.tts.endpoint),
      tts_provider: config.tts.provider,
      tts_model: config.tts.resourceId,
      tts_voice: config.tts.voice,
      database_enabled: storyDatabase.configured,
      story_pool_limits: { single_card: 200, multi_card: 100 },
      client_identity_headers: { type: 'X-Story-Client-Type', id: 'X-Story-Client-Id' },
      allow_model_override: config.llm.allowModelOverride,
      default_language: 'en-US',
      supported_languages: ['en-US', 'zh-CN'],
      maximum_cards: 4,
      lengths: getLengthOptions()
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/database/dashboard') {
    const connection = {
      enabled: storyDatabase.configured,
      host: config.database.host,
      port: config.database.port,
      database: config.database.database
    };
    if (!storyDatabase.configured) {
      sendJson(response, 200, {
        connected: false,
        connection,
        message: 'MySQL is disabled. Set MYSQL_ENABLED=true to inspect story data.'
      });
      return true;
    }
    try {
      const dashboard = await storyDatabase.getDashboard();
      sendJson(response, 200, { connected: true, connection, ...dashboard });
    } catch (error) {
      console.error(JSON.stringify({ event: 'story_database.dashboard_failed', message: error.message }));
      sendJson(response, 200, {
        connected: false,
        connection,
        error: { code: error.code || 'MYSQL_CONNECTION_ERROR', message: error.message }
      });
    }
    return true;
  }

  const databaseStoryMatch = pathname.match(/^\/api\/database\/stories\/([^/]+)$/i);
  if (request.method === 'GET' && databaseStoryMatch) {
    if (!storyDatabase.configured) {
      sendJson(response, 503, { error: { code: 'DATABASE_DISABLED', message: 'MySQL is disabled.' }, request_id: requestId });
      return true;
    }
    if (!storyIdPattern.test(databaseStoryMatch[1])) {
      sendJson(response, 400, { error: { code: 'INVALID_STORY_ID', message: 'Story ID must be a UUID.' }, request_id: requestId });
      return true;
    }
    const story = await storyDatabase.getStoryDetails(databaseStoryMatch[1]);
    if (!story) {
      sendJson(response, 404, { error: { code: 'STORY_NOT_FOUND', message: 'Story was not found.' }, request_id: requestId });
      return true;
    }
    const delivery = await buildStoryDelivery(story, iotStatusPath);
    if (!story.audio && delivery.generated_audio) {
      story.audio = {
        provider: 'iot-generated',
        model: null,
        voice: null,
        format: 'mp3',
        sample_rate: null,
        bytes: delivery.generated_audio.bytes,
        created_at: delivery.generated_audio.created_at,
        endpoint: delivery.generated_audio.endpoint
      };
    }
    sendJson(response, 200, { story, delivery });
    return true;
  }

  const databaseAudioMatch = pathname.match(/^\/api\/database\/stories\/([0-9a-f-]{36})\/audio$/i);
  if (request.method === 'GET' && databaseAudioMatch) {
    if (!storyDatabase.configured) {
      sendJson(response, 503, { error: { code: 'DATABASE_DISABLED', message: 'MySQL is disabled.' }, request_id: requestId });
      return true;
    }
    try {
      const speech = await storyDatabase.getAudio(databaseAudioMatch[1]);
      if (!speech) {
        sendJson(response, 404, { error: { code: 'AUDIO_NOT_FOUND', message: 'This story has no cached audio.' }, request_id: requestId });
      } else {
        sendAudio(response, speech);
      }
    } catch (error) {
      throw new StoryDatabaseError('Story database could not load cached audio.', error.message);
    }
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/cards') {
    sendJson(response, 200, {
      total: CARD_CATALOG.length,
      categories: CARD_CATEGORIES,
      cards: CARD_CATALOG
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/stories/preview') {
    const storyRequest = normalizeStoryRequest(await readJson(request));
    sendJson(response, 200, { messages: buildStoryMessages(storyRequest), normalized: storyRequest });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/stories/generate') {
    const body = await readJson(request);
    const storyRequest = normalizeStoryRequest(body);
    const client = requestClient(request, body);
    const identity = createPoolIdentity(storyRequest.cards, storyRequest.language);
    let completion = null;
    let story = null;
    let cacheStatus = 'database-disabled';

    if (storyDatabase.configured) {
      try {
        await storyDatabase.ensureClient(client);
        const pool = await storyDatabase.ensurePool(identity);
        if (pool.story_count >= pool.max_stories) {
          story = await storyDatabase.selectCachedStory(identity.poolKey, client.key);
          cacheStatus = story ? 'cached' : 'cache-empty';
        }
      } catch (error) {
        throw new StoryDatabaseError('Story database is unavailable.', error.message);
      }
    }

    if (!story) {
      const messages = buildStoryMessages(storyRequest);
      completion = await createChatCompletion({
        config: config.llm,
        messages,
        options: storyRequest.options
      });
      story = {
        storyId: crypto.randomUUID(),
        text: completion.content,
        language: storyRequest.language,
        model: completion.model,
        usage: completion.usage,
        age: storyRequest.child.age,
        createdAt: new Date().toISOString()
      };
      if (storyDatabase.configured) {
        try {
          const inserted = await storyDatabase.insertStoryIfCapacity(identity, story);
          if (!inserted) {
            const cached = await storyDatabase.selectCachedStory(identity.poolKey, client.key);
            if (cached) {
              story = cached;
              completion = null;
              cacheStatus = 'cached-after-capacity-race';
            }
          } else {
            cacheStatus = 'generated-and-stored';
          }
        } catch (error) {
          throw new StoryDatabaseError('Story database could not save the generated story.', error.message);
        }
      }
    }

    console.info(JSON.stringify({
      event: completion ? 'story.generated' : 'story.selected', requestId,
      storyId: story.storyId, cacheStatus, client: client.key,
      model: story.model, latencyMs: completion?.latencyMs || 0,
      keywordCount: storyRequest.keywords.length
    }));
    sendJson(response, 200, {
      story_id: story.storyId,
      status: 'completed',
      text: story.text,
      language: storyRequest.language,
      cards: storyRequest.cards,
      model: story.model,
      usage: story.usage,
      finish_reason: completion?.finishReason || 'cached',
      latency_ms: completion?.latencyMs || 0,
      cache_status: cacheStatus,
      client: { type: client.type, id: client.id },
      created_at: story.createdAt
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/speech/synthesize') {
    const body = await readJson(request);
    const client = requestClient(request, body);
    let speech = null;
    if (storyDatabase.configured && body.story_id) {
      try {
        speech = await storyDatabase.getAudio(body.story_id);
      } catch (error) {
        throw new StoryDatabaseError('Story database is unavailable.', error.message);
      }
    }
    if (!speech) {
      speech = await synthesizeSpeech({ config: config.tts, request: body });
      if (storyDatabase.configured && body.story_id) {
        try {
          await storyDatabase.saveAudio(body.story_id, speech, config.tts);
        } catch (error) {
          throw new StoryDatabaseError('Story database could not save the generated audio.', error.message);
        }
      }
    }
    if (storyDatabase.configured && body.story_id) {
      try {
        await storyDatabase.recordPlayback(client, body.story_id);
      } catch (error) {
        throw new StoryDatabaseError('Story database could not record playback history.', error.message);
      }
    }
    console.info(JSON.stringify({
      event: 'speech.synthesized', requestId, taskId: speech.taskId,
      model: speech.model, latencyMs: speech.latencyMs,
      audioBytes: speech.audio.length, characters: speech.usage?.characters
    }));
    sendAudio(response, speech);
    return true;
  }

  return false;
}

export function createServer({ storyDatabase = new StoryDatabase(config.database), iotStatusPath } = {}) {
  return http.createServer(async (request, response) => {
    const requestId = request.headers['x-request-id'] || crypto.randomUUID();
    applyCommonHeaders(response, requestId);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(request, response, url.pathname, requestId, storyDatabase, iotStatusPath);
        if (!handled) sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' }, request_id: requestId });
        return;
      }

      if (!['GET', 'HEAD'].includes(request.method) || !await serveStatic(url.pathname, response, request.method === 'HEAD')) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' }, request_id: requestId });
      }
    } catch (error) {
      const knownError = error instanceof ValidationError || error instanceof LlmError || error instanceof TtsError || error instanceof StoryDatabaseError;
      const status = error.status || (error instanceof ValidationError ? 400 : 500);
      console.error(JSON.stringify({ event: 'request.failed', requestId, code: error.code, message: error.message }));
      sendJson(response, status, {
        error: {
          code: error.code || (knownError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR'),
          message: knownError ? error.message : '服务器内部错误',
          ...(error.field ? { field: error.field } : {}),
          ...(error.details && process.env.NODE_ENV !== 'production' ? { details: error.details } : {})
        },
        request_id: requestId
      });
    }
  });
}
