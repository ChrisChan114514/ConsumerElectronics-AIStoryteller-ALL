import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolIdentity, normalizeClient, StoryDatabase } from '../src/storyStore.js';

test('canonicalizes card pools and applies the product story limits', () => {
  const single = createPoolIdentity([{ id: 'C128' }], 'en-US');
  assert.equal(single.maxStories, 200);

  const firstOrder = createPoolIdentity([{ id: 'C048' }, { id: 'C003' }], 'en-US');
  const secondOrder = createPoolIdentity([{ id: 'C003' }, { id: 'C048' }], 'en-US');
  assert.equal(firstOrder.poolKey, secondOrder.poolKey);
  assert.equal(firstOrder.maxStories, 100);
  assert.notEqual(firstOrder.poolKey, createPoolIdentity([{ id: 'C003' }, { id: 'C048' }], 'zh-CN').poolKey);
});

test('normalizes PC and device identities for playback history', () => {
  assert.deepEqual(normalizeClient({ type: 'device', id: 'toy/room 1' }), {
    type: 'device',
    id: 'toyroom1',
    key: 'device:toyroom1'
  });
  assert.deepEqual(normalizeClient({}), {
    type: 'pc',
    id: 'browser-default',
    key: 'pc:browser-default'
  });
});

test('uses portable parameterized JSON inserts for MySQL and MariaDB', async () => {
  const statements = [];
  const connection = {
    async beginTransaction() {},
    async execute(statement) {
      statements.push(statement);
      if (statement.startsWith('SELECT story_count')) {
        return [[{ story_count: 0, max_stories: 200 }]];
      }
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() {},
    release() {}
  };
  const pool = {
    async query(statement) {
      statements.push(statement);
      return [[]];
    },
    async execute(statement) {
      statements.push(statement);
      if (statement.startsWith('SELECT pool_key')) {
        return [[{ pool_key: 'pool', story_count: 0, max_stories: 200 }]];
      }
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return connection;
    }
  };
  const database = new StoryDatabase({ enabled: true, database: 'story_machine' }, { pool });
  const identity = createPoolIdentity([{ id: 'C001' }]);

  await database.ensurePool(identity);
  await database.insertStoryIfCapacity(identity, {
    storyId: '00000000-0000-0000-0000-000000000001',
    text: 'Test story',
    age: 6,
    model: 'test-model',
    usage: {}
  });

  const inserts = statements.filter((statement) => statement.startsWith('INSERT INTO'));
  assert.equal(inserts.length, 2);
  assert.equal(inserts.every((statement) => !statement.includes('CAST(? AS JSON)')), true);
});
