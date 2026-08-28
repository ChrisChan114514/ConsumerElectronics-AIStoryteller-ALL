import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(sourceDirectory, '..');

function loadEnvFile(filename) {
  if (!fs.existsSync(filename)) return;

  for (const rawLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(projectRoot, '.env'));

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function boolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function string(name, fallback = '') {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

function readApiKeyFile() {
  const configuredPath = process.env.LLM_API_KEY_FILE;
  const filename = configuredPath
    ? path.resolve(projectRoot, configuredPath)
    : path.join(projectRoot, 'APIkey', 'DeepseekAPI.txt');

  try {
    const valueLine = fs.readFileSync(filename, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) || '';
    const value = valueLine.startsWith('LLM_API_KEY=')
      ? valueLine.slice('LLM_API_KEY='.length).trim()
      : valueLine;
    return value.replace(/^["']|["']$/g, '');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(`Unable to read LLM API key file: ${filename}`, { cause: error });
  }
}

function readDoubaoTtsKeyFile() {
  const filename = process.env.TTS_CONFIG_FILE
    ? path.resolve(projectRoot, process.env.TTS_CONFIG_FILE)
    : path.join(projectRoot, 'APIkey', 'Doubao_TTS.txt');

  try {
    return fs.readFileSync(filename, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) || '';
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(`Unable to read Doubao TTS key file: ${filename}`, { cause: error });
  }
}

const ttsProvider = string('TTS_PROVIDER', 'kokoro').toLowerCase();

function thinkingMode() {
  const value = (process.env.LLM_THINKING || 'disabled').toLowerCase();
  return ['enabled', 'disabled'].includes(value) ? value : 'disabled';
}

export const config = Object.freeze({
  host: process.env.HOST || '0.0.0.0',
  port: integer('PORT', 2210, 1, 65535),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  llm: Object.freeze({
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || readApiKeyFile(),
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    timeoutMs: integer('LLM_TIMEOUT_MS', 90_000, 1_000, 300_000),
    retryAttempts: integer('LLM_RETRY_ATTEMPTS', 2, 1, 3),
    allowModelOverride: boolean('ALLOW_MODEL_OVERRIDE', true),
    thinking: thinkingMode()
  }),
  tts: Object.freeze({
    provider: ttsProvider,
    endpoint: process.env.TTS_BASE_URL || (ttsProvider === 'doubao'
      ? 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
      : 'http://127.0.0.1:2229'),
    apiKey: process.env.TTS_API_KEY || (ttsProvider === 'doubao' ? readDoubaoTtsKeyFile() : ''),
    resourceId: process.env.TTS_RESOURCE_ID || (ttsProvider === 'doubao' ? 'seed-tts-2.0' : 'kokoro-split-hybrid-trt-cuda'),
    voice: process.env.TTS_VOICE || (ttsProvider === 'doubao' ? 'zh_female_vv_uranus_bigtts' : 'af_heart'),
    timeoutMs: integer('TTS_TIMEOUT_MS', 120_000, 5_000, 300_000),
    sampleRate: integer('TTS_SAMPLE_RATE', 24_000, 8_000, 48_000)
  }),
  database: Object.freeze({
    enabled: boolean('MYSQL_ENABLED', false),
    host: string('MYSQL_HOST', '127.0.0.1'),
    port: integer('MYSQL_PORT', 2211, 1, 65_535),
    user: string('MYSQL_USER', 'story_machine'),
    password: process.env.MYSQL_PASSWORD || '',
    database: string('MYSQL_DATABASE', 'story_machine'),
    connectionLimit: integer('MYSQL_CONNECTION_LIMIT', 10, 1, 50),
    timezone: string('MYSQL_TIMEZONE', 'Z')
  })
});
