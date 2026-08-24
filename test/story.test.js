import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_CATALOG, CARD_CATEGORIES, getCardById } from '../src/cards.js';
import { buildStoryMessages, normalizeStoryRequest, ValidationError } from '../src/story.js';
import { createChatCompletion, LlmError } from '../src/llm.js';

test('contains 128 unique bilingual literacy cards in 16 categories', () => {
  assert.equal(CARD_CATALOG.length, 128);
  assert.equal(CARD_CATEGORIES.length, 16);
  assert.equal(new Set(CARD_CATALOG.map((card) => card.id)).size, 128);
  assert.equal(new Set(CARD_CATALOG.map((card) => card.en)).size, 128);
  assert.ok(CARD_CATALOG.every((card) => card.en && card.zh));
  assert.deepEqual(getCardById('C003'), {
    id: 'C003', en: 'rabbit', zh: '兔子', category: 'pets-farm'
  });
});

test('accepts each supported 1 to 4 card story form', () => {
  for (let count = 1; count <= 4; count += 1) {
    const cardIds = CARD_CATALOG.slice(0, count).map((card) => card.id);
    const request = normalizeStoryRequest({ card_ids: cardIds, child: { age: 4 } });
    assert.equal(request.cards.length, count);
    assert.equal(request.language, 'en-US');
  }
});

test('rejects empty, excessive, and unknown card selections', () => {
  assert.throws(() => normalizeStoryRequest({ card_ids: [] }), ValidationError);
  assert.throws(
    () => normalizeStoryRequest({ card_ids: ['C001', 'C002', 'C003', 'C004', 'C005'] }),
    (error) => error instanceof ValidationError && error.field === 'card_ids'
  );
  assert.throws(
    () => normalizeStoryRequest({ card_ids: ['C999'] }),
    (error) => error instanceof ValidationError && error.field === 'card_ids'
  );
});

test('builds an English literacy prompt by default', () => {
  const request = normalizeStoryRequest({
    card_ids: ['C003', 'C048', 'C121'],
    child: { nickname: 'Alex', age: 5 },
    length: 'short'
  });
  const messages = buildStoryMessages(request);

  assert.match(messages[0].content, /English-language storyteller/);
  assert.match(messages[1].content, /3-card story/);
  assert.match(messages[1].content, /rabbit \(兔子\)/);
  assert.match(messages[1].content, /rocket \(火箭\)/);
  assert.match(messages[1].content, /treasure \(宝藏\)/);
  assert.match(messages[1].content, /160-220 English words/);
  assert.match(messages[1].content, /Alex/);
});

test('supports an optional Chinese bilingual story prompt', () => {
  const request = normalizeStoryRequest({
    card_ids: ['C001'], language: 'zh-CN', child: { age: 4 }
  });
  const messages = buildStoryMessages(request);

  assert.equal(request.language, 'zh-CN');
  assert.match(messages[1].content, /中文故事/);
  assert.match(messages[1].content, /cat \(猫\)/);
});

test('keeps legacy keyword requests compatible with the 4-card limit', () => {
  const request = normalizeStoryRequest({
    keywords: ['rabbit', 'rocket', 'rabbit'],
    child: { age: 4 },
    options: { temperature: 9, max_tokens: 20 }
  });

  assert.deepEqual(request.keywords, ['rabbit', 'rocket']);
  assert.equal(request.options.temperature, 1.5);
  assert.equal(request.options.maxTokens, 256);
});

test('calls an OpenAI-compatible completion endpoint', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body), authorization: options.headers.Authorization };
    return new Response(JSON.stringify({
      model: 'test-model',
      choices: [{ message: { content: 'The Moon Rabbit\n\nOnce upon a time...' }, finish_reason: 'stop' }],
      usage: { total_tokens: 42 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await createChatCompletion({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'test-model', timeoutMs: 1000, allowModelOverride: false, thinking: 'disabled' },
    messages: [{ role: 'user', content: 'test' }],
    options: { model: '', temperature: 0.8, maxTokens: 500 },
    fetchImpl
  });
  assert.equal(captured.url, 'https://example.test/v1/chat/completions');
  assert.equal(captured.authorization, 'Bearer secret');
  assert.equal(captured.body.stream, false);
  assert.deepEqual(captured.body.thinking, { type: 'disabled' });
  assert.match(result.content, /Once upon a time/);
});

test('reports a missing API key before making a request', async () => {
  await assert.rejects(
    createChatCompletion({
      config: { baseUrl: 'https://example.test/v1', apiKey: '', model: 'test', timeoutMs: 1000 },
      messages: [], options: {}
    }),
    (error) => error instanceof LlmError && error.code === 'LLM_NOT_CONFIGURED'
  );
});
