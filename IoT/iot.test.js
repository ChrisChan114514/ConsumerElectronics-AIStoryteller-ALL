import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import mqtt from 'mqtt';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIoTService, topicFor } from './mqttService.js';

function connect(url, options) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { protocolVersion: 4, reconnectPeriod: 0, ...options });
    client.once('connect', () => resolve(client));
    client.once('error', reject);
  });
}

function waitForEvents(client, count) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for MQTT events.')), 3000);
    client.on('message', (_topic, payload) => {
      events.push(JSON.parse(payload.toString('utf8')));
      if (events.length === count) {
        clearTimeout(timeout);
        resolve(events);
      }
    });
  });
}

test('authenticates a device and completes the story control flow', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-iot-'));
  const storyClient = {
    async generateStory(request) {
      assert.deepEqual(request.card_ids, ['C001', 'C002', 'C002', 'C004']);
      assert.equal(request.language, 'en-US');
      return { story_id: 'story-1', text: 'A short test story.' };
    },
    async synthesizeSpeech() {
      return Buffer.from('ID3-test-audio');
    }
  };
  const service = await createIoTService({
    host: '127.0.0.1', mqttPort: 0,
    mqttUsername: 'test-user', mqttPassword: 'test-password',
    publicAudioBaseUrl: 'http://127.0.0.1:2210', audioDirectory: directory,
    statusPath: path.join(directory, 'runtime-status.json'),
    storyClient
  });
  let client;
  try {
    const address = await service.start(0, '127.0.0.1');
    client = await connect(`mqtt://127.0.0.1:${address.port}`, {
      clientId: 'SIM-TEST01', username: 'test-user', password: 'test-password'
    });
    await new Promise((resolve, reject) => client.subscribe(topicFor('SIM-TEST01', 'events'), { qos: 1 },
      (error) => error ? reject(error) : resolve()));
    const received = waitForEvents(client, 3);
    client.publish(topicFor('SIM-TEST01', 'request'), JSON.stringify({
      request_id: 'req-test-1', card_ids: ['C001', 'C002', 'C002', 'C004'],
      language: 'zh-CN'
    }), { qos: 1 });
    const events = await received;
    assert.deepEqual(events.map((event) => event.type), ['story.generating', 'story.synthesizing', 'story.ready']);
    assert.equal(events[2].audio_bytes, 14);
    const filename = events[2].audio_path.split('/').at(-1);
    assert.equal((await fs.readFile(path.join(directory, filename))).toString(), 'ID3-test-audio');
  } finally {
    if (client) client.end(true);
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('converts teacher WAV to an MP3 playback artifact before publishing ready', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-iot-wav-'));
  const storyClient = {
    async generateStory() { return { story_id: 'story-wav', text: 'A WAV story.' }; },
    async synthesizeSpeech() {
      return Buffer.from('RIFF----WAVEfmt ');
    }
  };
  const service = await createIoTService({
    host: '127.0.0.1', mqttPort: 0,
    mqttUsername: 'wav-user', mqttPassword: 'wav-password',
    publicAudioBaseUrl: 'http://127.0.0.1:2210', audioDirectory: directory,
    statusPath: path.join(directory, 'runtime-status.json'), storyClient,
    orchestrator: new (await import('./orchestrator.js')).StoryOrchestrator({
      storyClient, audioDirectory: directory, publicAudioBaseUrl: 'http://127.0.0.1:2210',
      transcodeAudio: async (audio) => {
        assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
        return Buffer.from('ID3-converted');
      }
    })
  });
  let client;
  try {
    const address = await service.start(0, '127.0.0.1');
    client = await connect(`mqtt://127.0.0.1:${address.port}`, {
      clientId: 'SIM-WAV01', username: 'wav-user', password: 'wav-password'
    });
    await new Promise((resolve, reject) => client.subscribe(topicFor('SIM-WAV01', 'events'), { qos: 1 },
      (error) => error ? reject(error) : resolve()));
    const received = waitForEvents(client, 3);
    client.publish(topicFor('SIM-WAV01', 'request'), JSON.stringify({
      request_id: 'req-wav-1', card_ids: ['C001']
    }), { qos: 1 });
    const events = await received;
    assert.equal(events[2].audio_path.endsWith('.mp3'), true);
    assert.equal(events[2].audio_bytes, 13);
    const filename = events[2].audio_path.split('/').at(-1);
    assert.equal((await fs.readFile(path.join(directory, filename))).toString(), 'ID3-converted');
  } finally {
    if (client) client.end(true);
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejects invalid MQTT credentials', async () => {
  const service = await createIoTService({
    host: '127.0.0.1', mqttPort: 0,
    mqttUsername: 'right-user', mqttPassword: 'right-password',
    publicAudioBaseUrl: 'http://127.0.0.1:2210', audioDirectory: os.tmpdir(),
    statusPath: path.join(os.tmpdir(), `story-iot-status-${process.pid}.json`),
    storyClient: { generateStory() {}, synthesizeSpeech() {} }
  });
  try {
    const address = await service.start(0, '127.0.0.1');
    await assert.rejects(connect(`mqtt://127.0.0.1:${address.port}`, {
      clientId: 'SIM-TEST02', username: 'wrong-user', password: 'wrong-password'
    }), /Not authorized|Connection refused/);
  } finally {
    await service.close();
  }
});
