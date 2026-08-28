import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { iotConfig } from './config.js';

const audioIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
const audioFormatPattern = /^(mp3|wav)$/i;

function assertAudioId(audioId) {
  if (!audioIdPattern.test(audioId)) throw new Error('Invalid IoT audio ID.');
}

export function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || start >= size) return false;
  return { start, end: Math.min(end, size - 1) };
}

export function generatedAudioPath(audioId, directory = iotConfig.audioDirectory, format = 'mp3') {
  assertAudioId(audioId);
  if (!audioFormatPattern.test(format)) throw new Error('Invalid IoT audio format.');
  return path.join(directory, `${audioId}.${format.toLowerCase()}`);
}

export async function saveGeneratedAudio(audioId, audio, metadata = {}, directory = iotConfig.audioDirectory) {
  assertAudioId(audioId);
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw new Error('Generated audio is empty.');
  await fs.mkdir(directory, { recursive: true });

  const format = String(metadata.audio_format || metadata.format || 'mp3').toLowerCase();
  const filename = generatedAudioPath(audioId, directory, format);
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, audio);
  await fs.rename(temporary, filename);
  await fs.writeFile(`${filename}.json`, JSON.stringify({
    audio_id: audioId,
    bytes: audio.length,
    created_at: new Date().toISOString(),
    ...metadata
  }, null, 2));
  return { filename, bytes: audio.length };
}

export async function serveGeneratedAudio(request, response, audioId, directory = iotConfig.audioDirectory, format = 'mp3') {
  let filename;
  let stat;
  try {
    filename = generatedAudioPath(audioId, directory, format);
    stat = await fs.stat(filename);
  } catch (error) {
    if (error.code === 'ENOENT' || error.message.startsWith('Invalid IoT audio')) {
      const body = JSON.stringify({ error: { code: 'AUDIO_NOT_FOUND', message: 'Generated audio was not found.' } });
      response.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
      });
      response.end(body);
      return;
    }
    throw error;
  }

  const requestedRange = parseByteRange(request.headers.range, stat.size);
  if (requestedRange === false) {
    response.writeHead(416, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${stat.size}` });
    response.end();
    return;
  }

  const range = requestedRange ?? { start: 0, end: stat.size - 1 };
  const partial = requestedRange !== null;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Length': range.end - range.start + 1,
    'Content-Type': format.toLowerCase() === 'wav' ? 'audio/wav' : 'audio/mpeg'
  };
  if (partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
  response.writeHead(partial ? 206 : 200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(filename, range);
  stream.on('error', (error) => response.destroy(error));
  stream.pipe(response);
}
