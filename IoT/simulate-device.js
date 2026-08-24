import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { iotConfig } from './config.js';
import { topicFor } from './mqttService.js';

const deviceId = process.env.IOT_SIM_DEVICE_ID || 'SIM-LOCAL01';
const requestId = `req-${crypto.randomUUID()}`;
const client = mqtt.connect(`mqtt://127.0.0.1:${iotConfig.mqttPort}`, {
  clientId: deviceId,
  username: iotConfig.mqttUsername,
  password: iotConfig.mqttPassword,
  protocolVersion: 4,
  clean: true,
  reconnectPeriod: 0
});

client.on('connect', () => {
  console.log(`[simulator] connected as ${deviceId}`);
  client.subscribe(topicFor(deviceId, 'events'), { qos: 1 }, (error) => {
    if (error) throw error;
    client.publish(topicFor(deviceId, 'request'), JSON.stringify({
      request_id: requestId,
      card_ids: ['C001', 'C002', 'C002', 'C004'],
      child: { nickname: 'Mia', age: 4 },
      language: 'en-US',
      length: 'short'
    }), { qos: 1 });
  });
});

client.on('message', (_topic, payload) => {
  const event = JSON.parse(payload.toString('utf8'));
  console.log(JSON.stringify(event, null, 2));
  if (['story.ready', 'story.error'].includes(event.type)) client.end(event.type === 'story.error');
});
client.on('error', (error) => {
  console.error(`[simulator] ${error.message}`);
  process.exitCode = 1;
});
