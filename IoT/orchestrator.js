import crypto from 'node:crypto';
import { saveGeneratedAudio } from './audioStore.js';

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
    length: ['short', 'medium', 'long'].includes(payload.length) ? payload.length : 'short'
  };
}

export class StoryOrchestrator {
  constructor({ storyClient, audioDirectory, publicAudioBaseUrl, idFactory = () => crypto.randomUUID() }) {
    this.storyClient = storyClient;
    this.audioDirectory = audioDirectory;
    this.publicAudioBaseUrl = publicAudioBaseUrl.replace(/\/+$/, '');
    const publicUrl = new URL(this.publicAudioBaseUrl);
    this.audioPort = Number(publicUrl.port) || (publicUrl.protocol === 'https:' ? 443 : 80);
    this.idFactory = idFactory;
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
      const synthesizing = {
        type: 'story.synthesizing',
        request_id: request.request_id,
        story_id: story.story_id,
        message: 'Story text is ready; speech synthesis started.'
      };
      this.jobs.set(key, { state: 'synthesizing', event: synthesizing });
      await publish(synthesizing);

      const audio = await this.storyClient.synthesizeSpeech(story, deviceId);
      const audioId = this.idFactory();
      await saveGeneratedAudio(audioId, audio, {
        request_id: request.request_id,
        story_id: story.story_id,
        device_id: deviceId,
        card_ids: request.card_ids,
        language: 'en-US'
      }, this.audioDirectory);

      const audioPath = `/api/iot/audio/${audioId}.mp3`;
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
