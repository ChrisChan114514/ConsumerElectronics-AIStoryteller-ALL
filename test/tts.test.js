import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpeechRequest, synthesizeSpeech, TtsError } from '../src/tts.js';

const ttsConfig = {
  apiKey: 'test-api-key',
  endpoint: 'https://example.com/api/v3/tts/unidirectional',
  resourceId: 'seed-tts-2.0',
  voice: 'zh_female_vv_uranus_bigtts',
  sampleRate: 24_000,
  timeoutMs: 2_000
};

test('normalizes story speech controls and enforces the text limit', () => {
  assert.deepEqual(normalizeSpeechRequest({
    text: '  Once upon a time.  ', volume: 999, rate: 0.1, pitch: 3
  }), {
    text: 'Once upon a time.', format: 'mp3', volume: 100, rate: 0.5, pitch: 2
  });
  assert.throws(() => normalizeSpeechRequest({ text: '' }), TtsError);
  assert.throws(() => normalizeSpeechRequest({ text: 'a'.repeat(10_001) }), TtsError);
});

test('calls Doubao Seed TTS 2.0 and combines streamed MP3 chunks', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response([
      JSON.stringify({ code: 0, message: '', data: Buffer.from('ID3').toString('base64') }),
      JSON.stringify({ code: 0, message: '', data: Buffer.from([1, 2, 3]).toString('base64') }),
      JSON.stringify({ code: 20_000_000, message: 'OK', data: '' })
    ].join('\n'), { status: 200, headers: { 'X-Tt-Logid': 'test-log-id' } });
  };

  const result = await synthesizeSpeech({
    config: ttsConfig,
    request: { text: 'A small story.', rate: 0.9, volume: 60 },
    fetchImpl
  });

  assert.equal(captured.url, ttsConfig.endpoint);
  assert.equal(captured.options.headers['X-Api-Key'], 'test-api-key');
  assert.equal(captured.options.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.match(captured.options.headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/);
  assert.equal(captured.body.req_params.speaker, 'zh_female_vv_uranus_bigtts');
  assert.equal(captured.body.req_params.text, 'A small story.');
  assert.deepEqual(captured.body.req_params.audio_params, {
    format: 'mp3', sample_rate: 24_000, speech_rate: -10, loudness_rate: 20, pitch_rate: 0
  });
  assert.equal(result.audio.toString('hex'), '494433010203');
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.providerRequestId, 'test-log-id');
  assert.equal(result.usage.characters, 14);
});

test('surfaces structured Doubao permission errors', async () => {
  await assert.rejects(
    synthesizeSpeech({
      config: ttsConfig,
      request: { text: 'Story' },
      fetchImpl: async () => new Response(JSON.stringify({
        header: { code: 45_000_030, message: 'requested resource not granted' }
      }), { status: 403 })
    }),
    (error) => error instanceof TtsError && error.code === 'DOUBAO_45000030'
  );
});

test('rejects synthesis when Doubao TTS is not configured', async () => {
  await assert.rejects(
    synthesizeSpeech({ config: { apiKey: '', endpoint: '' }, request: { text: 'Story' } }),
    (error) => error instanceof TtsError && error.code === 'TTS_NOT_CONFIGURED'
  );
});

test('calls the local Kokoro OpenAI-compatible endpoint and returns WAV', async () => {
  let captured;
  const result = await synthesizeSpeech({
    config: {
      provider: 'kokoro', endpoint: 'http://127.0.0.1:2229', resourceId: 'kokoro-split-hybrid-trt-cuda',
      voice: 'af_heart', timeoutMs: 2_000
    },
    request: { text: 'A tiny story.', rate: 0.9 },
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return new Response(Buffer.from('RIFF-kokoro'), { status: 200, headers: { 'content-type': 'audio/wav' } });
    }
  });
  assert.equal(captured.url, 'http://127.0.0.1:2229/v1/audio/speech');
  assert.deepEqual(captured.body, {
    model: 'kokoro', voice: 'af_heart', input: 'A tiny story.', response_format: 'wav', speed: 0.9
  });
  assert.equal(result.format, 'wav');
  assert.equal(result.contentType, 'audio/wav');
  assert.equal(result.model, 'kokoro-split-hybrid-trt-cuda');
});
