-- Run as a MySQL administrator once. Change the password before production use.
CREATE DATABASE IF NOT EXISTS kokoro_TensorRT_FP16
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'story_machine'@'localhost' IDENTIFIED BY 'CHANGE_THIS_PASSWORD';
GRANT ALL PRIVILEGES ON kokoro_TensorRT_FP16.* TO 'story_machine'@'localhost';
CREATE USER IF NOT EXISTS 'story_machine'@'127.0.0.1' IDENTIFIED BY 'CHANGE_THIS_PASSWORD';
GRANT ALL PRIVILEGES ON kokoro_TensorRT_FP16.* TO 'story_machine'@'127.0.0.1';
FLUSH PRIVILEGES;

-- The Node.js service creates the five application tables automatically.
-- Only single-card stories receive audio rows; multi-card stories retain text
-- and playback history without storing audio blobs.
