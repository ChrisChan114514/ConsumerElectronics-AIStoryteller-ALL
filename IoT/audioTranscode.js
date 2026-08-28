import { spawn } from 'node:child_process';

function isWav(audio) {
  return Buffer.isBuffer(audio) && audio.length >= 12 &&
    audio.subarray(0, 4).toString('ascii') === 'RIFF' &&
    audio.subarray(8, 12).toString('ascii') === 'WAVE';
}

/** Convert the Kokoro teacher WAV to the MP3 stream expected by the ESP32. */
export function transcodeWavToMp3(audio, {
  ffmpegBin = process.env.IOT_FFMPEG_BIN || 'ffmpeg',
  bitrate = process.env.IOT_MP3_BITRATE || '96k',
  spawnImpl = spawn
} = {}) {
  if (!isWav(audio)) return Promise.resolve(audio);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(ffmpegBin, [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn', '-ac', '1', '-ar', '24000',
        '-codec:a', 'libmp3lame', '-b:a', bitrate,
        '-f', 'mp3', 'pipe:1'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error(`Unable to start ffmpeg: ${error.message}`, { cause: error }));
      return;
    }

    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.once('error', (error) => reject(new Error(`Unable to run ffmpeg: ${error.message}`, { cause: error })));
    child.once('close', (code, signal) => {
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        reject(new Error(`ffmpeg WAV to MP3 conversion failed (${code ?? signal}).${detail ? ` ${detail}` : ''}`));
        return;
      }
      const converted = Buffer.concat(output);
      if (converted.length === 0) {
        reject(new Error('ffmpeg returned an empty MP3 stream.'));
        return;
      }
      resolve(converted);
    });
    child.stdin.end(audio);
  });
}

export { isWav };
