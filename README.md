# AI Storyteller WebService

This service implements the current story-machine prototype: a child scans one physical card at a time, the device remembers the latest 1 to 4 cards, DeepSeek generates an English-first children's story, and Doubao Seed TTS 2.0 converts the result to MP3 narration. The same Node.js process serves both the JSON API and the browser control console on port `2210`.

The built-in catalog contains 128 stable bilingual word cards (`C001` to `C128`) across 16 child-friendly categories. English is the primary story language; Chinese remains available for bilingual testing.

## Local Windows startup

Requires Node.js 22 or newer.

```powershell
cd WebService
npm.cmd ci
npm.cmd test
npm.cmd start
```

Open `http://localhost:2210`. Credentials are kept together under `APIkey/`. The service reads `APIkey/DeepseekAPI.txt` and `APIkey/Doubao_TTS.txt` automatically. Environment variables can override either file when needed.

The default speech resource is `seed-tts-2.0` with the bilingual `vivi 2.0` voice (`zh_female_vv_uranus_bigtts`) at 24kHz. The control console can synthesize, play, and download the current story as MP3.

## MySQL story pools

On the target Arch Linux or Ubuntu/Debian host, run `bash bash/setup_mysql.sh` once before `bash bash/start_pm2.sh`. On Arch it installs and initializes MariaDB; on Ubuntu/Debian it installs MySQL. Both paths configure the local database on `127.0.0.1:2211`, create the database, application user, and five application tables, update `.env`, and verify the configured login. [`database/bootstrap.sql`](database/bootstrap.sql) and [`database/schema.sql`](database/schema.sql) remain available for manual database installations. The service also checks the tables automatically on the first database request. A pool is keyed by the selected card set and language: a single-card pool holds up to 200 stories, while every 2-, 3-, or 4-card pool holds up to 100. Until a pool reaches its limit, each request creates a new story. After it is full, the service selects a random story the current client has not played; when all are played, it selects the least-recently played story.

Stories, MP3 audio, PC test-client/device-client records, and playback history are stored in MySQL. The browser console identifies itself with a persistent PC client ID. Future firmware should send `X-Story-Client-Type: device` and a stable `X-Story-Client-Id` on both story and speech requests.

## API

- `GET /api/health`: service, LLM, and TTS configuration status.
- `GET /api/config`: public model, language, length, and card-limit settings.
- `GET /api/cards`: all 128 bilingual cards and 16 categories.
- `GET /api/database/dashboard`: MySQL connection details, pool/story/audio/client totals, and recent activity for the database console.
- `GET /api/database/stories/:storyId/audio`: play a stored MP3 from the database console without changing client history.
- `POST /api/stories/preview`: validate a request and return its LLM messages without calling DeepSeek.
- `POST /api/stories/generate`: generate or select a story pool entry. Returns `cache_status` and `story_id`.
- `POST /api/speech/synthesize`: synthesize up to 10,000 characters, or reuse the `story_id` MP3, and return `audio/mpeg`.

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
