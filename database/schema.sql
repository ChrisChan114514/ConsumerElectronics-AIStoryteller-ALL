-- AI Storyteller application schema. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS story_pools (
  pool_key CHAR(64) PRIMARY KEY,
  language VARCHAR(10) NOT NULL,
  card_ids JSON NOT NULL,
  card_count TINYINT UNSIGNED NOT NULL,
  max_stories SMALLINT UNSIGNED NOT NULL,
  story_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS story_clients (
  client_key VARCHAR(191) PRIMARY KEY,
  client_type ENUM('pc', 'device') NOT NULL,
  client_id VARCHAR(128) NOT NULL,
  first_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_story_client_id (client_type, client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stories (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS story_audio (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The application inserts audio rows only for single-card stories. Multi-card
-- stories retain text and playback history without storing audio blobs.

CREATE TABLE IF NOT EXISTS story_history (
  client_key VARCHAR(191) NOT NULL,
  story_id CHAR(36) NOT NULL,
  play_count INT UNSIGNED NOT NULL DEFAULT 0,
  first_played_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_played_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (client_key, story_id),
  KEY idx_story_history_oldest (client_key, last_played_at),
  CONSTRAINT fk_story_history_client FOREIGN KEY (client_key) REFERENCES story_clients(client_key),
  CONSTRAINT fk_story_history_story FOREIGN KEY (story_id) REFERENCES stories(story_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
