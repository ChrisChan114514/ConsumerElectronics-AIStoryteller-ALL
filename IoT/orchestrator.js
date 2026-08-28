import crypto from 'node:crypto';
import { saveGeneratedAudio } from './audioStore.js';
import { transcodeWavToMp3 } from './audioTranscode.js';

const requestIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
const cardIdPattern = /^C\d{3}$/;

function normalizeRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Request must be a JSON object.');
  if (!requestIdPattern.test(payload.request_id || '')) throw new Error('request_id must contain 1-80 letters, numbers, _ or -.');
  if (!Array.isArray(payload.card_ids) || payload.card_ids.length < 1 || payload.card_ids.length > 4) {
    throw new Error('card_ids must contain 1 to 4 scanned card slots.');
  }
  const cardIds = payload.card_ids.map((value) => String(value).trim().toUpperCase());
  if (cardIds.some((value) => !cardIdPattern.test(value))) throw new Error('Every card ID must use the C001 format.');

  return {
    request_id: payload.request_id,
    card_ids: cardIds,
    child: {
      nickname: typeof payload.child?.nickname === 'string' ? payload.child.nickname.slice(0, 24) : '',
      age: Number.isInteger(payload.child?.age) ? payload.child.age : 4
    },
    // This IoT product is English-only. Do not let a device select another story language.
    language: 'en-US',
    length: ['short', 'medium', 'long'].includes(payload.length) ? payload.length : 'short',
    // Edge-capable devices request the story text only and synthesize audio
    // themselves. Legacy devices omit this field and keep the server TTS path.
    synthesize_audio: payload.synthesize_audio !== false
  };
}

function detectAudioFormat(audio) {
  return Buffer.isBuffer(audio) && audio.length >= 12 && audio.subarray(0, 4).toString('ascii') === 'RIFF'
    ? 'wav'
    : 'mp3';
}

async function synthesizeWithRetry(storyClient, story, deviceId) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await storyClient.synthesizeSpeech(story, deviceId);
    } catch (error) {
      lastError = error;
      const retryable = ['WEB_SERVICE_UNREACHABLE', 'TTS_CONNECTION_FAILED', 'TTS_TIMEOUT'].includes(error.code);
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

export class StoryOrchestrator {
  constructor({ storyClient, audioDirectory, publicAudioBaseUrl,
    idFactory = () => crypto.randomUUID(), transcodeAudio = transcodeWavToMp3 }) {
    this.storyClient = storyClient;
    this.audioDirectory = audioDirectory;
    this.publicAudioBaseUrl = publicAudioBaseUrl.replace(/\/+$/, '');
    const publicUrl = new URL(this.publicAudioBaseUrl);
    this.audioPort = Number(publicUrl.port) || (publicUrl.protocol === 'https:' ? 443 : 80);
    this.idFactory = idFactory;
    this.transcodeAudio = transcodeAudio;
    this.jobs = new Map();
  }

  async run(deviceId, payload, publish) {
    let request;
    try {
      request = normalizeRequest(payload);
    } catch (error) {
      await publish({
        type: 'story.error', request_id: payload?.request_id || '',
        code: 'INVALID_REQUEST', message: error.message
      });
      return;
    }

    const key = `${deviceId}:${request.request_id}`;
    const existing = this.jobs.get(key);
    if (existing) {
      await publish(existing.event);
      return;
    }

    const generating = {
      type: 'story.generating',
      request_id: request.request_id,
      card_ids: request.card_ids,
      message: 'Story generation started.'
    };
    this.jobs.set(key, { state: 'generating', event: generating });
    await publish(generating);

    try {
      const story = await this.storyClient.generateStory(request, deviceId);
      if (!request.synthesize_audio) {
        const textReady = {
          type: 'story.text_ready',
          request_id: request.request_id,
          story_id: story.story_id,
          language: 'en-US',
          story_text: story.text,
          message: 'Story text is ready; device-side speech synthesis may start.'
        };
        this.jobs.set(key, { state: 'text_ready', event: textReady });
        await publish(textReady);
        return;
      }
      const synthesizing = {
        type: 'story.synthesizing',
        request_id: request.request_id,
        story_id: story.story_id,
        message: 'Story text is ready; speech synthesis started.'
      };
      this.jobs.set(key, { state: 'synthesizing', event: synthesizing });
      await publish(synthesizing);

      const sourceAudio = await synthesizeWithRetry(this.storyClient, story, deviceId);
      // WebService keeps the original teacher WAV in MySQL. IoT serves an MP3
      // derivative because the current ESP32 firmware uses AudioGeneratorMP3.
      const audio = await this.transcodeAudio(sourceAudio);
      const audioId = this.idFactory();
      const audioFormat = 'mp3';
      await saveGeneratedAudio(audioId, audio, {
        request_id: request.request_id,
        story_id: story.story_id,
        device_id: deviceId,
        card_ids: request.card_ids,
        language: 'en-US',
        audio_format: audioFormat,
        source_audio_format: detectAudioFormat(sourceAudio),
        content_type: audioFormat === 'wav' ? 'audio/wav' : 'audio/mpeg'
      }, this.audioDirectory);

      const audioPath = `/api/iot/audio/${audioId}.${audioFormat}`;
      const ready = {
        type: 'story.ready',
        request_id: request.request_id,
        story_id: story.story_id,
        language: 'en-US',
        audio_url: `${this.publicAudioBaseUrl}${audioPath}`,
        audio_path: audioPath,
        audio_port: this.audioPort,
        audio_bytes: audio.length,
        loop: true,
        message: 'Story audio is ready.'
      };
      this.jobs.set(key, { state: 'ready', event: ready });
      await publish(ready);
    } catch (error) {
      const failed = {
        type: 'story.error',
        request_id: request.request_id,
        code: error.code || 'GENERATION_FAILED',
        message: error.message || 'Story generation failed.'
      };
      this.jobs.set(key, { state: 'error', event: failed });
      await publish(failed);
    }
  }
}

export { normalizeRequest };
