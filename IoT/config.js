import path from 'node:path';
import { projectRoot } from '../src/config.js';

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export const iotConfig = Object.freeze({
  host: process.env.IOT_HOST || '0.0.0.0',
  mqttPort: integer('IOT_MQTT_PORT', 2215, 1, 65_535),
  webServiceUrl: (process.env.IOT_WEB_SERVICE_URL || 'http://127.0.0.1:2210').replace(/\/+$/, ''),
  publicAudioBaseUrl: (process.env.IOT_PUBLIC_AUDIO_BASE_URL || 'http://192.168.137.1:2210').replace(/\/+$/, ''),
  mqttUsername: process.env.IOT_MQTT_USERNAME || 'story-device',
  mqttPassword: process.env.IOT_MQTT_PASSWORD || 'story-test-2026',
  audioDirectory: path.join(projectRoot, 'IoT', 'generated-audio')
});
