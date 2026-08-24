import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function withServer(run) {
  const server = createServer({ storyDatabase: { configured: false } });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('serves health, product config, and the complete card catalog', async () => {
  await withServer(async (baseUrl) => {
    const [healthResponse, configResponse, cardsResponse] = await Promise.all([
      fetch(`${baseUrl}/api/health`),
      fetch(`${baseUrl}/api/config`),
      fetch(`${baseUrl}/api/cards`)
    ]);

    const health = await healthResponse.json();
    const config = await configResponse.json();
    const catalog = await cardsResponse.json();

    assert.equal(healthResponse.status, 200);
    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'story-machine-web-service');
    assert.equal(typeof health.tts_configured, 'boolean');
    assert.equal(health.database_configured, false);
    assert.equal(health.database_ready, false);
    assert.equal(config.default_language, 'en-US');
    assert.equal(typeof config.tts_configured, 'boolean');
    assert.equal(config.tts_provider, 'doubao');
    assert.equal(config.tts_model, 'seed-tts-2.0');
    assert.equal(config.tts_voice, 'zh_female_vv_uranus_bigtts');
    assert.equal(config.maximum_cards, 4);
    assert.deepEqual(config.story_pool_limits, { single_card: 200, multi_card: 100 });
    assert.deepEqual(config.supported_languages, ['en-US', 'zh-CN']);
    assert.equal(catalog.total, 128);
    assert.equal(catalog.categories.length, 16);
    assert.equal(catalog.cards.length, 128);
  });
});

test('reports a disabled database to the control dashboard', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/database/dashboard`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.connected, false);
    assert.equal(body.connection.enabled, false);
    assert.equal(body.connection.port, 2211);
    assert.match(body.message, /MYSQL_ENABLED/);
  });
});

test('serves the IoT broker snapshot to the third console view', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-iot-dashboard-'));
  const statusPath = path.join(directory, 'runtime-status.json');
  await fs.writeFile(statusPath, JSON.stringify({
    service: 'story-machine-iot', online: true, host: '0.0.0.0', port: 2215,
    started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    connected_devices: 1,
    counters: { connections: 2, story_requests: 1, status_messages: 5, stories_ready: 1 },
    devices: [{ device_id: 'ESP32-000000000001', online: true, state: 'playing' }],
    recent_actions: [{ at: new Date().toISOString(), type: 'story.ready', device_id: 'ESP32-000000000001' }]
  }));
  const server = createServer({ storyDatabase: { configured: false }, iotStatusPath: statusPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/iot/dashboard`);
    const dashboard = await response.json();
    assert.equal(response.status, 200);
    assert.equal(dashboard.online, true);
    assert.equal(dashboard.port, 2215);
    assert.equal(dashboard.connected_devices, 1);
    assert.equal(dashboard.devices[0].state, 'playing');
    assert.equal(dashboard.recent_actions[0].type, 'story.ready');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('serves database inventory and stored audio to the second console view', async () => {
  const cachedAudio = Buffer.from('ID3-dashboard-audio');
  const storyDatabase = {
    configured: true,
    async initialize() {},
    async getDashboard() {
      return {
        server: { version: '8.4.0', database_name: 'story_machine', server_time: '2026-08-23T00:00:00Z' },
        summary: { pools: 1, stories: 2, audio_files: 1, audio_bytes: cachedAudio.length, clients: 1, pc_clients: 1, device_clients: 0, total_plays: 3 },
        pools: [], stories: [], clients: [], recent_activity: []
      };
    },
    async getAudio(storyId) {
      assert.equal(storyId, '12345678-1234-1234-1234-123456789abc');
      return { audio: cachedAudio, contentType: 'audio/mpeg', format: 'mp3', model: 'cached-model', taskId: 'dashboard', latencyMs: 0, cached: true };
    }
  };
  const server = createServer({ storyDatabase });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const dashboardResponse = await fetch(`${baseUrl}/api/database/dashboard`);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.connected, true);
    assert.equal(dashboard.server.version, '8.4.0');
    assert.equal(dashboard.summary.total_plays, 3);

    const audioResponse = await fetch(`${baseUrl}/api/database/stories/12345678-1234-1234-1234-123456789abc/audio`);
    assert.equal(audioResponse.status, 200);
    assert.equal(audioResponse.headers.get('x-tts-cached'), 'true');
    assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), cachedAudio);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('previews English stories with each supported 1-to-4 card form', async () => {
  await withServer(async (baseUrl) => {
    const cardIds = ['C003', 'C040', 'C048', 'C121'];

    for (let count = 1; count <= 4; count += 1) {
      const response = await fetch(`${baseUrl}/api/stories/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card_ids: cardIds.slice(0, count) })
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.normalized.language, 'en-US');
      assert.equal(body.normalized.cards.length, count);
      assert.match(body.messages.map((message) => message.content).join('\n'), /English-language storyteller/);
    }
  });
});

test('rejects more than four story cards', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stories/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card_ids: ['C001', 'C002', 'C003', 'C004', 'C005'] })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error.message, /1 and 4 story cards/);
  });
});

test('selects an unplayed pool story and reuses cached speech for a client', async () => {
  const cachedAudio = Buffer.from('ID3-cached-audio');
  const calls = [];
  const storyDatabase = {
    configured: true,
    async initialize() { calls.push('initialize'); },
    async ensureClient(client) { calls.push(['client', client.key]); },
    async ensurePool() { return { story_count: 100, max_stories: 100 }; },
    async selectCachedStory() {
      return { storyId: 'cached-story-id', text: 'A cached English story.', language: 'en-US', model: 'deepseek-v4-flash', usage: {} };
    },
    async getAudio() {
      return { audio: cachedAudio, contentType: 'audio/mpeg', format: 'mp3', model: 'seed-tts-2.0/voice', taskId: 'cached-task', latencyMs: 0, cached: true };
    },
    async recordPlayback(client, storyId) { calls.push(['playback', client.key, storyId]); }
  };
  const server = createServer({ storyDatabase });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      'content-type': 'application/json',
      'x-story-client-type': 'device',
      'x-story-client-id': 'toy-001'
    };
    const storyResponse = await fetch(`${baseUrl}/api/stories/generate`, {
      method: 'POST', headers,
      body: JSON.stringify({ card_ids: ['C003', 'C048'], child: { age: 5 }, length: 'short' })
    });
    const story = await storyResponse.json();
    assert.equal(storyResponse.status, 200);
    assert.equal(story.cache_status, 'cached');
    assert.equal(story.story_id, 'cached-story-id');

    const audioResponse = await fetch(`${baseUrl}/api/speech/synthesize`, {
      method: 'POST', headers,
      body: JSON.stringify({ story_id: story.story_id, text: story.text })
    });
    assert.equal(audioResponse.status, 200);
    assert.equal(audioResponse.headers.get('x-tts-cached'), 'true');
    assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), cachedAudio);
    assert.deepEqual(calls.at(-1), ['playback', 'device:toy-001', 'cached-story-id']);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
