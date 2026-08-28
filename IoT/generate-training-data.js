#!/usr/bin/env node

// PC virtual terminal: simulate 1/2/3/4-card scans over the complete 128-card catalog.
// Each request goes through DeepSeek -> WebService -> Kokoro, and completed story text is
// written to JSONL for the teacher-label collector.
import fs from 'node:fs/promises';
import path from 'node:path';
import mqtt from 'mqtt';
import { CARD_CATALOG } from '../src/cards.js';
import { iotConfig } from './config.js';
import { topicFor } from './mqttService.js';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith('--')) continue;
  args.set(value.slice(2), process.argv[index + 1]?.startsWith('--') ? true : (process.argv[index + 1] ?? true));
  if (args.get(value.slice(2)) !== true) index += 1;
}
const count = Math.max(1, Number(args.get('requests') || 32));
const concurrency = Math.max(1, Math.min(4, Number(args.get('concurrency') || 2)));
const deviceId = String(args.get('device-id') || `SIM-TRAIN${process.pid}`);
const output = path.resolve(String(args.get('output') || path.join(process.cwd(), 'StoryTTS/Kokoro-Lite-English/datasets/iot_story_requests.jsonl')));
const timeoutMs = Math.max(30_000, Number(args.get('timeout-ms') || 300_000));

function cardIdsFor(index) {
  const size = (index % 4) + 1;
  const ids = [];
  for (let offset = 0; ids.length < size; offset += 1) {
    const card = CARD_CATALOG[(index * 13 + offset * 29 + size * 7) % CARD_CATALOG.length].id;
    if (!ids.includes(card)) ids.push(card);
  }
  return ids;
}

function storySentences(text) {
  const cleaned = String(text || '').replace(/\r/g, '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const body = cleaned.length > 1 ? cleaned.slice(1).join(' ') : cleaned.join(' ');
  return body.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 8);
}

function waitForStory(client, request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${request.request_id}`)), timeoutMs);
    const onMessage = async (_topic, payload) => {
      let event;
      try { event = JSON.parse(payload.toString('utf8')); } catch { return; }
      if (event.request_id !== request.request_id || !['story.ready', 'story.error'].includes(event.type)) return;
      clearTimeout(timer);
      client.off('message', onMessage);
      if (event.type === 'story.error') return reject(new Error(event.message || event.code || 'story generation failed'));
      try {
        const response = await fetch(`${iotConfig.webServiceUrl}/api/database/stories/${event.story_id}`);
        if (!response.ok) throw new Error(`story lookup returned HTTP ${response.status}`);
        const payload = await response.json();
        resolve({ event, story: payload.story });
      } catch (error) { reject(error); }
    };
    client.on('message', onMessage);
  });
}

await fs.mkdir(path.dirname(output), { recursive: true });
const client = mqtt.connect(`mqtt://127.0.0.1:${iotConfig.mqttPort}`, {
  clientId: deviceId,
  username: iotConfig.mqttUsername,
  password: iotConfig.mqttPassword,
  protocolVersion: 4,
  clean: true,
  reconnectPeriod: 0
});

await new Promise((resolve, reject) => {
  client.once('connect', resolve);
  client.once('error', reject);
});
await new Promise((resolve, reject) => client.subscribe(topicFor(deviceId, 'events'), { qos: 1 }, (error) => error ? reject(error) : resolve()));

const records = [];
let next = 0;
let completed = 0;
async function worker() {
  while (true) {
    const index = next++;
    if (index >= count) return;
    const request = {
      request_id: `train-${Date.now().toString(36)}-${index}`,
      card_ids: cardIdsFor(index),
      child: { nickname: 'Mia', age: 4 },
      language: 'en-US',
      length: 'short'
    };
    const resultPromise = waitForStory(client, request);
    await new Promise((resolve, reject) => client.publish(
      topicFor(deviceId, 'request'), JSON.stringify(request), { qos: 1 }, (error) => error ? reject(error) : resolve()));
    const { event, story } = await resultPromise;
    const sentences = storySentences(story.story_text);
    sentences.forEach((text, sentenceIndex) => records.push({
      id: `${story.story_id}-${String(sentenceIndex).padStart(3, '0')}`,
      text,
      card_ids: request.card_ids,
      story_id: story.story_id,
      sentence_index: sentenceIndex,
      event
    }));
    completed += 1;
    console.log(`[training] ${completed}/${count} ${request.card_ids.join(',')} story=${story.story_id}`);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
await fs.writeFile(output, `${records.sort((a, b) => a.id.localeCompare(b.id)).map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
client.end();
console.log(`[training] wrote ${records.length} story texts to ${output}`);
