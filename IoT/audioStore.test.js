import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveGeneratedAudio, serveGeneratedAudio } from './audioStore.js';

test('serves generated MP3 with HTTP byte ranges', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-audio-'));
  await saveGeneratedAudio('audio-test', Buffer.from('0123456789'), {}, directory);
  const server = http.createServer((request, response) => {
    void serveGeneratedAudio(request, response, 'audio-test', directory);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await response.text(), '2345');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
