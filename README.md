# AI Storyteller WebService

This service implements the current story-machine prototype: a child scans one physical card at a time, the device remembers the latest 1 to 4 cards, DeepSeek generates an English-first children's story, and the local Kokoro TensorRT FP16 service converts the result to WAV narration. The Node.js process serves both the JSON API and browser control console on port `2210`.

Port `2210` is the control-plane owner. It routes LLM/TTS requests, owns database transactions,
and exposes dependency health. IoT on `2215` owns MQTT/device orchestration; Kokoro on `2229`
is a GPU worker managed by the same PM2 scripts; MariaDB on `2211` is the persistence dependency.
Devices and browser clients should never call `2229` directly.

The built-in catalog contains 128 stable bilingual word cards (`C001` to `C128`) across 16 child-friendly categories. English is the primary story language; Chinese remains available for bilingual testing.

## Local Windows startup

Requires Node.js 22 or newer.

```powershell
cd WebService
npm.cmd ci
npm.cmd test
npm.cmd start
```

Open a second PowerShell window and run `npm.cmd run iot:start` from `WebService` to start the MQTT control plane on port `2215`.

Open `http://localhost:2210`. The console contains Story Builder, Database, and IoT Monitor views. IoT Monitor reads the broker snapshot and refreshes every three seconds. The service reads `APIkey/DeepseekAPI.txt` automatically; TTS defaults to the local Kokoro worker.

The default speech resource is `kokoro-split-hybrid-trt-cuda` with the `af_heart` voice at 24 kHz. The control console can synthesize, play, and download the current story as WAV.

## MySQL story pools

On the target Arch Linux or Ubuntu/Debian host, run `bash bash/setup_mysql.sh` once before `bash bash/start_pm2.sh`. On Arch it installs and initializes MariaDB; on Ubuntu/Debian it installs MySQL. Both paths configure the local database on `127.0.0.1:2211`, create the database, application user, and five application tables, update `.env`, and verify the configured login. [`database/bootstrap.sql`](database/bootstrap.sql) and [`database/schema.sql`](database/schema.sql) remain available for manual database installations. The service also checks the tables automatically on the first database request. A pool is keyed by the selected card set and language: a single-card pool holds up to 200 stories, while every 2-, 3-, or 4-card pool holds up to 100. Until a pool reaches its limit, each request creates a new story. After it is full, the service selects a random story the current client has not played; when all are played, it selects the least-recently played story.

Stories, single-card teacher WAV audio, PC test-client/device-client records, and playback history are stored in MySQL. Multi-card requests retain their story text and playback history but do not cache audio. The IoT broker creates a temporary MP3 derivative for the current ESP32 firmware and serves it from port `2210`; the browser console keeps using the database WAV. The browser console identifies itself with a persistent PC client ID. Future firmware should send `X-Story-Client-Type: device` and a stable `X-Story-Client-Id` on both story and speech requests.

## API

- `GET /api/health`: service, LLM, database, and live Kokoro readiness (`tts_ready`).
- `GET /api/config`: public model, language, length, and card-limit settings.
- `GET /api/cards`: all 128 bilingual cards and 16 categories.
- `GET /api/database/dashboard`: MySQL connection details, pool/story/audio/client totals, and recent activity for the database console.
- `GET /api/iot/dashboard`: MQTT listener health, terminal states, counters, and recent IoT actions.
- `GET /api/database/stories/:storyId/audio`: play stored single-card WAV audio from the database console without changing client history.
- `POST /api/stories/preview`: validate a request and return its LLM messages without calling DeepSeek.
- `POST /api/stories/generate`: generate or select a story pool entry. Returns `cache_status` and `story_id`.
- `POST /api/speech/synthesize`: synthesize up to 10,000 characters, or reuse the `story_id` WAV, and return `audio/wav`.

The database retention rule is enforced by the application: only single-card stories get a
`story_audio` row containing the original Kokoro WAV. Multi-card stories keep text and playback
history only. To remove multi-card audio created before this rule was installed, run
`bash bash/cleanup_multi_card_audio.sh --yes`; it does not delete stories or history.

English generation example:

```json
{
  "card_ids": ["C003", "C048", "C121"],
  "child": { "nickname": "Mia", "age": 5 },
  "language": "en-US",
  "length": "short",
  "options": {
    "temperature": 0.8,
    "max_tokens": 900
  }
}
```

`card_ids` must contain 1 to 4 known card IDs. The older `keywords` field remains accepted for compatibility, but new device and test-console integrations should use card IDs.

## Linux PM2 deployment

Remote startup, boot registration, health diagnostics, and shutdown scripts are in [`bash/`](bash/README.md). They target `/home/cc/Desktop/AIStoryteller/WebService` and port `2210`.
