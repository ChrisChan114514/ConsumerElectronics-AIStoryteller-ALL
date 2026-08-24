import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

export const STORY_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS story_pools (
    pool_key CHAR(64) PRIMARY KEY,
    language VARCHAR(10) NOT NULL,
    card_ids JSON NOT NULL,
    card_count TINYINT UNSIGNED NOT NULL,
    max_stories SMALLINT UNSIGNED NOT NULL,
    story_count INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS story_clients (
    client_key VARCHAR(191) PRIMARY KEY,
    client_type ENUM('pc', 'device') NOT NULL,
    client_id VARCHAR(128) NOT NULL,
    first_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_story_client_id (client_type, client_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS stories (
    story_id CHAR(36) PRIMARY KEY,
    pool_key CHAR(64) NOT NULL,
    language VARCHAR(10) NOT NULL,
    card_ids JSON NOT NULL,
    story_text MEDIUMTEXT NOT NULL,
    child_age TINYINT UNSIGNED NOT NULL,
    model VARCHAR(100) NOT NULL,
    usage_json JSON NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_stories_pool_created (pool_key, created_at),
    CONSTRAINT fk_stories_pool FOREIGN KEY (pool_key) REFERENCES story_pools(pool_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS story_audio (
    story_id CHAR(36) PRIMARY KEY,
    provider VARCHAR(32) NOT NULL,
    model VARCHAR(160) NOT NULL,
    voice VARCHAR(160) NOT NULL,
    audio_format VARCHAR(16) NOT NULL,
    sample_rate INT UNSIGNED NOT NULL,
    audio_bytes LONGBLOB NOT NULL,
    byte_length INT UNSIGNED NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_story_audio_story FOREIGN KEY (story_id) REFERENCES stories(story_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS story_history (
    client_key VARCHAR(191) NOT NULL,
    story_id CHAR(36) NOT NULL,
    play_count INT UNSIGNED NOT NULL DEFAULT 0,
    first_played_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_played_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (client_key, story_id),
    KEY idx_story_history_oldest (client_key, last_played_at),
    CONSTRAINT fk_story_history_client FOREIGN KEY (client_key) REFERENCES story_clients(client_key),
    CONSTRAINT fk_story_history_story FOREIGN KEY (story_id) REFERENCES stories(story_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
]);

export class StoryDatabaseError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'StoryDatabaseError';
    this.code = 'STORY_DATABASE_ERROR';
    this.status = 503;
    this.details = details;
  }
}

export function normalizeClient(input = {}) {
  const type = input.type === 'device' ? 'device' : 'pc';
  const id = String(input.id || '').trim().replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128) || 'browser-default';
  return { type, id, key: `${type}:${id}` };
}

export function createPoolIdentity(cards, language = 'en-US') {
  const cardIds = cards.map((card) => card.id || card.en).map(String).sort();
  const canonical = `${language}|${cardIds.join('|')}`;
  return {
    poolKey: crypto.createHash('sha256').update(canonical).digest('hex'),
    cardIds,
    language,
    maxStories: cardIds.length === 1 ? 200 : 100
  };
}

export class StoryDatabase {
  constructor(databaseConfig, { pool } = {}) {
    this.config = databaseConfig;
    this.pool = pool || null;
    this.initialization = null;
  }

  get configured() {
    return Boolean(this.config?.enabled && (this.pool || this.config.database));
  }

  async initialize() {
    if (!this.configured) return false;
    if (!this.initialization) {
      if (!this.pool) {
        this.pool = mysql.createPool({
          host: this.config.host,
          port: this.config.port,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database,
          waitForConnections: true,
          connectionLimit: this.config.connectionLimit,
          timezone: this.config.timezone
        });
      }
      this.initialization = Promise.all(STORY_SCHEMA.map((statement) => this.pool.query(statement)))
        .then(() => true)
        .catch((error) => {
          this.initialization = null;
          throw error;
        });
    }
    return this.initialization;
  }

  async close() {
    if (this.pool) await this.pool.end();
  }

  async ensureClient(client) {
    await this.initialize();
    await this.pool.execute(
      `INSERT INTO story_clients (client_key, client_type, client_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP(3)`,
      [client.key, client.type, client.id]
    );
  }

  async ensurePool(identity) {
    await this.initialize();
    await this.pool.execute(
      `INSERT INTO story_pools (pool_key, language, card_ids, card_count, max_stories)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP(3)`,
      [identity.poolKey, identity.language, JSON.stringify(identity.cardIds), identity.cardIds.length, identity.maxStories]
    );
    const [rows] = await this.pool.execute(
      'SELECT pool_key, card_count, max_stories, story_count FROM story_pools WHERE pool_key = ?',
      [identity.poolKey]
    );
    return rows[0];
  }

  async selectCachedStory(poolKey, clientKey) {
    await this.initialize();
    const [unplayed] = await this.pool.execute(
      `SELECT s.story_id, s.story_text, s.language, s.card_ids, s.model, s.usage_json, s.created_at
       FROM stories s LEFT JOIN story_history h ON h.story_id = s.story_id AND h.client_key = ?
       WHERE s.pool_key = ? AND h.story_id IS NULL ORDER BY RAND() LIMIT 1`,
      [clientKey, poolKey]
    );
    if (unplayed[0]) return this.#decodeStory(unplayed[0]);

    const [oldest] = await this.pool.execute(
      `SELECT s.story_id, s.story_text, s.language, s.card_ids, s.model, s.usage_json, s.created_at
       FROM stories s LEFT JOIN story_history h ON h.story_id = s.story_id AND h.client_key = ?
       WHERE s.pool_key = ? ORDER BY h.last_played_at ASC, s.created_at ASC LIMIT 1`,
      [clientKey, poolKey]
    );
    return oldest[0] ? this.#decodeStory(oldest[0]) : null;
  }

  async insertStoryIfCapacity(identity, story) {
    await this.initialize();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [pools] = await connection.execute(
        'SELECT story_count, max_stories FROM story_pools WHERE pool_key = ? FOR UPDATE',
        [identity.poolKey]
      );
      const pool = pools[0];
      if (!pool || pool.story_count >= pool.max_stories) {
        await connection.rollback();
        return false;
      }
      await connection.execute(
        `INSERT INTO stories (story_id, pool_key, language, card_ids, story_text, child_age, model, usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [story.storyId, identity.poolKey, identity.language, JSON.stringify(identity.cardIds), story.text,
          story.age, story.model, JSON.stringify(story.usage || {})]
      );
      await connection.execute(
        'UPDATE story_pools SET story_count = story_count + 1 WHERE pool_key = ?',
        [identity.poolKey]
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getAudio(storyId) {
    await this.initialize();
    const [rows] = await this.pool.execute(
      `SELECT provider, model, voice, audio_format, sample_rate, audio_bytes, byte_length
       FROM story_audio WHERE story_id = ?`,
      [storyId]
    );
    if (!rows[0]) return null;
    return {
      audio: Buffer.from(rows[0].audio_bytes),
      contentType: rows[0].audio_format === 'mp3' ? 'audio/mpeg' : `audio/${rows[0].audio_format}`,
      format: rows[0].audio_format,
      model: rows[0].model,
      taskId: `cached-${storyId}`,
      latencyMs: 0,
      cached: true
    };
  }

  async saveAudio(storyId, speech, ttsConfig) {
    await this.initialize();
    await this.pool.execute(
      `INSERT INTO story_audio (story_id, provider, model, voice, audio_format, sample_rate, audio_bytes, byte_length)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE audio_bytes = VALUES(audio_bytes), byte_length = VALUES(byte_length)`,
      [storyId, ttsConfig.provider, speech.model, ttsConfig.voice, speech.format, ttsConfig.sampleRate,
        speech.audio, speech.audio.length]
    );
  }

  async recordPlayback(client, storyId) {
    await this.ensureClient(client);
    await this.pool.execute(
      `INSERT INTO story_history (client_key, story_id, play_count)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE play_count = play_count + 1, last_played_at = CURRENT_TIMESTAMP(3)`,
      [client.key, storyId]
    );
  }

  async getDashboard() {
    await this.initialize();
    const [serverRows, summaryRows, poolRows, storyRows, clientRows, activityRows] = await Promise.all([
      this.pool.query('SELECT VERSION() AS version, DATABASE() AS database_name, NOW(3) AS server_time'),
      this.pool.query(`SELECT
        (SELECT COUNT(*) FROM story_pools) AS pools,
        (SELECT COUNT(*) FROM stories) AS stories,
        (SELECT COUNT(*) FROM story_audio) AS audio_files,
        (SELECT COALESCE(SUM(byte_length), 0) FROM story_audio) AS audio_bytes,
        (SELECT COUNT(*) FROM story_clients) AS clients,
        (SELECT COUNT(*) FROM story_clients WHERE client_type = 'pc') AS pc_clients,
        (SELECT COUNT(*) FROM story_clients WHERE client_type = 'device') AS device_clients,
        (SELECT COALESCE(SUM(play_count), 0) FROM story_history) AS total_plays`),
      this.pool.query(`SELECT pool_key, language, card_ids, card_count, max_stories, story_count, updated_at
        FROM story_pools ORDER BY updated_at DESC LIMIT 100`),
      this.pool.query(`SELECT s.story_id, s.language, s.card_ids, s.story_text, s.model, s.created_at,
          a.byte_length AS audio_bytes, a.audio_format, a.voice,
          COALESCE(h.listeners, 0) AS listeners, COALESCE(h.plays, 0) AS plays,
          h.last_played_at
        FROM stories s
        LEFT JOIN story_audio a ON a.story_id = s.story_id
        LEFT JOIN (
          SELECT story_id, COUNT(*) AS listeners, SUM(play_count) AS plays, MAX(last_played_at) AS last_played_at
          FROM story_history GROUP BY story_id
        ) h ON h.story_id = s.story_id
        ORDER BY s.created_at DESC LIMIT 100`),
      this.pool.query(`SELECT c.client_key, c.client_type, c.client_id, c.first_seen_at, c.last_seen_at,
          COUNT(h.story_id) AS unique_stories, COALESCE(SUM(h.play_count), 0) AS total_plays,
          MAX(h.last_played_at) AS last_played_at
        FROM story_clients c LEFT JOIN story_history h ON h.client_key = c.client_key
        GROUP BY c.client_key, c.client_type, c.client_id, c.first_seen_at, c.last_seen_at
        ORDER BY c.last_seen_at DESC LIMIT 100`),
      this.pool.query(`SELECT h.client_key, c.client_type, c.client_id, h.story_id, h.play_count,
          h.last_played_at, LEFT(REPLACE(s.story_text, '\\n', ' '), 100) AS story_preview
        FROM story_history h
        JOIN story_clients c ON c.client_key = h.client_key
        JOIN stories s ON s.story_id = h.story_id
        ORDER BY h.last_played_at DESC LIMIT 100`)
    ]);

    const decodeJson = (value) => typeof value === 'string' ? JSON.parse(value) : value;
    return {
      server: serverRows[0][0],
      summary: summaryRows[0][0],
      pools: poolRows[0].map((row) => ({ ...row, card_ids: decodeJson(row.card_ids) })),
      stories: storyRows[0].map((row) => ({
        ...row,
        card_ids: decodeJson(row.card_ids),
        title: row.story_text.split(/\r?\n/, 1)[0].replace(/^#+\s*/, '').trim() || 'Untitled story',
        preview: row.story_text.replace(/\s+/g, ' ').trim().slice(0, 180),
        story_text: undefined
      })),
      clients: clientRows[0],
      recent_activity: activityRows[0]
    };
  }

  #decodeStory(row) {
    return {
      storyId: row.story_id,
      text: row.story_text,
      language: row.language,
      cardIds: typeof row.card_ids === 'string' ? JSON.parse(row.card_ids) : row.card_ids,
      model: row.model,
      usage: typeof row.usage_json === 'string' ? JSON.parse(row.usage_json) : row.usage_json,
      createdAt: row.created_at
    };
  }
}
