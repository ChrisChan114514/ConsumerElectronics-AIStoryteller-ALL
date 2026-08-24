import { getCardById } from './cards.js';

const LENGTH_OPTIONS = Object.freeze({
  short: Object.freeze({ label: 'Short', minutes: 1, englishWords: '160-220', chineseCharacters: '300-450' }),
  medium: Object.freeze({ label: 'Medium', minutes: 2, englishWords: '300-420', chineseCharacters: '600-850' }),
  long: Object.freeze({ label: 'Long', minutes: 4, englishWords: '550-700', chineseCharacters: '1000-1400' })
});

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function cleanText(value, maximumLength) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maximumLength)
    : '';
}

function normalizeCards(input) {
  if (Array.isArray(input.card_ids)) {
    const ids = [...new Set(input.card_ids.map((id) => cleanText(id, 8).toUpperCase()).filter(Boolean))];
    return ids.map((id) => {
      const card = getCardById(id);
      if (!card) throw new ValidationError(`Unknown card ID: ${id}`, 'card_ids');
      return card;
    });
  }

  const rawKeywords = Array.isArray(input.keywords) ? input.keywords : [];
  return [...new Set(rawKeywords.map((item) => cleanText(item, 24)).filter(Boolean))]
    .map((en) => ({ id: null, en, zh: '', category: 'custom' }));
}

export function normalizeStoryRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Request body must be a JSON object.');
  }

  const cards = normalizeCards(input);
  if (cards.length < 1 || cards.length > 4) {
    throw new ValidationError('Select between 1 and 4 story cards.', 'card_ids');
  }

  const age = Number.parseInt(input.child?.age ?? input.age ?? 4, 10);
  if (!Number.isInteger(age) || age < 2 || age > 12) {
    throw new ValidationError('Child age must be between 2 and 12.', 'child.age');
  }

  const length = LENGTH_OPTIONS[input.length] ? input.length : 'medium';
  const temperature = Number(input.options?.temperature ?? 0.8);
  const maxTokens = Number.parseInt(input.options?.max_tokens ?? 1800, 10);

  return {
    cards,
    keywords: cards.map((card) => card.en),
    child: {
      nickname: cleanText(input.child?.nickname ?? input.nickname, 24),
      age
    },
    language: input.language === 'zh-CN' ? 'zh-CN' : 'en-US',
    length,
    options: {
      temperature: Number.isFinite(temperature) ? Math.min(1.5, Math.max(0, temperature)) : 0.8,
      maxTokens: Number.isInteger(maxTokens) ? Math.min(4000, Math.max(256, maxTokens)) : 1800,
      model: cleanText(input.options?.model, 100)
    }
  };
}

function cardList(cards) {
  return cards.map((card, index) => {
    const translation = card.zh ? ` (${card.zh})` : '';
    return `${index + 1}. ${card.en}${translation}`;
  }).join('\n');
}

function buildEnglishMessages(request, length) {
  const childReference = request.child.nickname
    ? `The child's name is ${request.child.nickname}. You may use the name naturally, but it is not required.`
    : 'No child name was provided.';

  return [
    {
      role: 'system',
      content: [
        'You are an expert English-language storyteller for children ages 2 to 8.',
        'Write warm, playful, positive stories that sound natural when read aloud.',
        'Use clear concrete sentences and age-appropriate beginner vocabulary.',
        'Avoid frightening scenes, violence, discrimination, adult themes, unsafe imitation, and moralizing lectures.',
        'Return plain text only. Do not use Markdown headings, bullets, or explain your writing process.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Create a new English story for a ${request.child.age}-year-old child.`,
        childReference,
        `This is a ${request.cards.length}-card story. The cards were scanned in this order:`,
        cardList(request.cards),
        `Target length: ${length.label}, about ${length.minutes} minute(s), ${length.englishWords} English words.`,
        'Make every selected card concept important to the plot, not merely mentioned in a list.',
        'Use each selected English card word exactly as written at least once, then reinforce it naturally through context so the story also supports early word learning.',
        'Give the story a clear beginning, one gentle problem, an active cooperative solution, and a satisfying ending.',
        'The first line must contain only a short story title. Leave the second line blank, then write the complete story.'
      ].join('\n')
    }
  ];
}

function buildChineseMessages(request, length) {
  const childReference = request.child.nickname
    ? `孩子昵称是“${request.child.nickname}”，可自然地使用昵称，但不是必须。`
    : '未提供孩子昵称。';

  return [
    {
      role: 'system',
      content: [
        '你是一位面向2至8岁儿童的专业双语启蒙故事作家。',
        '故事必须温暖、有趣、积极，语言具体、简单并适合朗读。',
        '禁止恐怖、暴力、歧视、成人内容和鼓励儿童模仿危险行为的内容。',
        '只返回纯文本故事，不使用Markdown，不解释创作过程。'
      ].join('')
    },
    {
      role: 'user',
      content: [
        `请为${request.child.age}岁儿童创作一个全新的中文故事。`,
        childReference,
        `这是一个${request.cards.length}张卡片的故事，卡片按扫描顺序如下：`,
        cardList(request.cards),
        `篇幅：${length.label}，约${length.minutes}分钟，控制在${length.chineseCharacters}个汉字。`,
        '让每张卡片代表的概念自然参与情节，并在合适的位置保留对应英文单词，帮助儿童建立中英文联系。',
        '故事要有清晰开端、一次温和的小困难、主动合作的解决过程和圆满结尾。',
        '第一行只写简短标题，第二行空行，之后输出完整故事正文。'
      ].join('\n')
    }
  ];
}

export function buildStoryMessages(request) {
  const length = LENGTH_OPTIONS[request.length];
  return request.language === 'zh-CN'
    ? buildChineseMessages(request, length)
    : buildEnglishMessages(request, length);
}

export function getLengthOptions() {
  return LENGTH_OPTIONS;
}
