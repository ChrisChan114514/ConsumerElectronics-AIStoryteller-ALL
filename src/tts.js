import crypto from 'node:crypto';

const maximumTextLength = 10_000;
const successCodes = new Set([0, 20_000_000]);

export class TtsError extends Error {
  constructor(message, code = 'TTS_ERROR', status = 502, details) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function numberOption(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

export function normalizeSpeechRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TtsError('Request body must be a JSON object.', 'INVALID_TTS_REQUEST', 400);
  }

  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new TtsError('Story text is required.', 'INVALID_TTS_TEXT', 400);
  if (text.length > maximumTextLength) {
    throw new TtsError(`Story text cannot exceed ${maximumTextLength} characters.`, 'TTS_TEXT_TOO_LONG', 400);
  }

  return {
    text,
    format: 'mp3',
    volume: numberOption(input.volume, 60, 0, 100),
    rate: numberOption(input.rate, 0.95, 0.5, 2),
    pitch: numberOption(input.pitch, 1, 0.5, 2)
  };
}

function parseEvents(body) {
  return body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new TtsError('Doubao TTS returned an invalid event.', 'TTS_INVALID_RESPONSE');
    }
  });
}

function eventError(event) {
  const code = event.header?.code ?? event.code;
  if (code === undefined || successCodes.has(code)) return null;
  return {
    code: `DOUBAO_${code}`,
    message: event.header?.message || event.message || 'Doubao TTS synthesis failed.'
  };
}

export async function synthesizeSpeech({ config, request, fetchImpl = fetch }) {
  if (config.provider === 'kokoro') {
    return synthesizeKokoroSpeech({ config, request, fetchImpl });
  }
  if (!config.apiKey || !config.endpoint) {
    throw new TtsError('Doubao TTS is not configured.', 'TTS_NOT_CONFIGURED', 503);
  }

  const normalized = normalizeSpeechRequest(request);
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let response;

  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': config.apiKey,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Request-Id': requestId
      },
      body: JSON.stringify({
        req_params: {
          text: normalized.text,
          speaker: config.voice,
          audio_params: {
            format: normalized.format,
            sample_rate: config.sampleRate,
            speech_rate: Math.round((normalized.rate - 1) * 100),
            loudness_rate: Math.round((normalized.volume - 50) * 2),
            pitch_rate: Math.round((normalized.pitch - 1) * 12)
          }
        }
      }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new TtsError(
      timedOut ? 'Doubao TTS request timed out.' : 'Unable to connect to Doubao TTS.',
      timedOut ? 'TTS_TIMEOUT' : 'TTS_CONNECTION_FAILED',
      timedOut ? 504 : 502,
      error.message
    );
  }

  const events = parseEvents(await response.text());
  const failure = events.map(eventError).find(Boolean);
  if (!response.ok || failure) {
    throw new TtsError(
      failure?.message || `Doubao TTS rejected the request (${response.status}).`,
      failure?.code || 'TTS_REQUEST_REJECTED',
      502
    );
  }

  const audioChunks = events
    .filter((event) => event.data)
    .map((event) => Buffer.from(event.data, 'base64'));
  if (audioChunks.length === 0) {
    throw new TtsError('Doubao TTS returned no audio data.', 'TTS_EMPTY_AUDIO');
  }

  return {
    audio: Buffer.concat(audioChunks),
    contentType: 'audio/mpeg',
    format: normalized.format,
    model: `${config.resourceId}/${config.voice}`,
    taskId: requestId,
    usage: { characters: normalized.text.length },
    latencyMs: Date.now() - startedAt,
    providerRequestId: response.headers.get('x-tt-logid') || ''
  };
}

async function synthesizeKokoroSpeech({ config, request, fetchImpl }) {
  if (!config.endpoint) {
    throw new TtsError('Kokoro TTS is not configured.', 'TTS_NOT_CONFIGURED', 503);
  }

  const normalized = normalizeSpeechRequest(request);
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(`${config.endpoint.replace(/\/+$/, '')}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      body: JSON.stringify({
        model: 'kokoro',
        voice: config.voice,
        input: normalized.text,
        response_format: 'wav',
        speed: normalized.rate
      }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new TtsError(
      timedOut ? 'Kokoro TTS request timed out.' : 'Unable to connect to Kokoro TTS.',
      timedOut ? 'TTS_TIMEOUT' : 'TTS_CONNECTION_FAILED',
      timedOut ? 504 : 502,
      error.message
    );
  }

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new TtsError(
      message || `Kokoro TTS rejected the request (${response.status}).`,
      'TTS_REQUEST_REJECTED',
      502
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('audio') && !contentType.includes('octet-stream')) {
    throw new TtsError('Kokoro TTS returned a non-audio response.', 'TTS_INVALID_RESPONSE', 502);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new TtsError('Kokoro TTS returned no audio data.', 'TTS_EMPTY_AUDIO');

  return {
    audio,
    contentType: 'audio/wav',
    format: 'wav',
    model: config.resourceId || 'kokoro',
    taskId: requestId,
    usage: { characters: normalized.text.length },
    latencyMs: Date.now() - startedAt,
    providerRequestId: response.headers.get('x-request-id') || requestId
  };
}
