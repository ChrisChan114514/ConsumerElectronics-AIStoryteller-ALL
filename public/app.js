const elements = {
  form: document.querySelector('#storyForm'),
  serviceState: document.querySelector('#serviceState'),
  serviceStateText: document.querySelector('#serviceStateText'),
  modelInput: document.querySelector('#modelInput'),
  temperatureInput: document.querySelector('#temperatureInput'),
  temperatureOutput: document.querySelector('#temperatureOutput'),
  generateButton: document.querySelector('#generateButton'),
  generateLabel: document.querySelector('#generateButton .button-label'),
  generateWorking: document.querySelector('#generateWorking'),
  formMessage: document.querySelector('#formMessage'),
  clearCardsButton: document.querySelector('#clearCardsButton'),
  storyMode: document.querySelector('#storyMode'),
  cardQueue: document.querySelector('#cardQueue'),
  cardCatalog: document.querySelector('#cardCatalog'),
  cardSearch: document.querySelector('#cardSearch'),
  categoryFilter: document.querySelector('#categoryFilter'),
  catalogCount: document.querySelector('#catalogCount'),
  emptyResult: document.querySelector('#emptyResult'),
  emptyResultText: document.querySelector('#emptyResultText'),
  storyResult: document.querySelector('#storyResult'),
  storyTitle: document.querySelector('#storyTitle'),
  storyText: document.querySelector('#storyText'),
  storyMeta: document.querySelector('#storyMeta'),
  copyButton: document.querySelector('#copyButton'),
  speechButton: document.querySelector('#speechButton'),
  speechButtonLabel: document.querySelector('.speech-button-label'),
  speechButtonWorking: document.querySelector('.speech-button-working'),
  speechStatus: document.querySelector('#speechStatus'),
  storyAudio: document.querySelector('#storyAudio'),
  downloadAudio: document.querySelector('#downloadAudio'),
  previewButton: document.querySelector('#previewButton'),
  promptDialog: document.querySelector('#promptDialog'),
  promptContent: document.querySelector('#promptContent'),
  closeDialogButton: document.querySelector('#closeDialogButton'),
  requestLog: document.querySelector('#requestLog'),
  clearLogButton: document.querySelector('#clearLogButton'),
  viewButtons: document.querySelectorAll('[data-view]'),
  builderView: document.querySelector('#builderView'),
  databaseView: document.querySelector('#databaseView'),
  refreshDatabase: document.querySelector('#refreshDatabase'),
  databaseUpdated: document.querySelector('#databaseUpdated'),
  databaseDot: document.querySelector('#databaseDot'),
  databaseMessage: document.querySelector('#databaseMessage'),
  databaseHost: document.querySelector('#databaseHost'),
  databaseName: document.querySelector('#databaseName'),
  databaseVersion: document.querySelector('#databaseVersion'),
  databaseTime: document.querySelector('#databaseTime'),
  databaseContent: document.querySelector('#databaseContent'),
  databaseAudio: document.querySelector('#databaseAudio'),
  metricPools: document.querySelector('#metricPools'),
  metricStories: document.querySelector('#metricStories'),
  metricAudio: document.querySelector('#metricAudio'),
  metricAudioSize: document.querySelector('#metricAudioSize'),
  metricClients: document.querySelector('#metricClients'),
  metricClientTypes: document.querySelector('#metricClientTypes'),
  metricPlays: document.querySelector('#metricPlays'),
  poolRows: document.querySelector('#poolRows'),
  storyRows: document.querySelector('#storyRows'),
  clientRows: document.querySelector('#clientRows'),
  activityRows: document.querySelector('#activityRows'),
  poolRowCount: document.querySelector('#poolRowCount'),
  storyRowCount: document.querySelector('#storyRowCount'),
  clientRowCount: document.querySelector('#clientRowCount'),
  activityRowCount: document.querySelector('#activityRowCount')
};

const state = {
  cards: [],
  categories: [],
  selectedCards: [],
  storyText: '',
  storyId: '',
  clientId: '',
  audioUrl: '',
  ttsConfigured: false,
  speechLoading: false,
  loading: false,
  activeView: 'builder',
  databaseLoading: false,
  databaseAudioUrl: ''
};

function getClientId() {
  const storageKey = 'story-machine-pc-client-id';
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return `session-${Math.random().toString(36).slice(2)}`;
  }
}

state.clientId = getClientId();

const categoryColors = [
  '#2d7a5b', '#b4513d', '#3979a8', '#8b6b2f',
  '#77549a', '#347d8b', '#4e7041', '#b06d32',
  '#b9475d', '#596a86', '#9a633e', '#607a34',
  '#2e7690', '#9b4f75', '#b18326', '#5961a3'
];

const demoSequences = {
  1: ['C003'],
  2: ['C002', 'C081'],
  3: ['C038', 'C055', 'C080'],
  4: ['C040', 'C048', 'C059', 'C121']
};

function colorForCard(card) {
  const index = state.categories.findIndex((category) => category.key === card.category);
  return categoryColors[index < 0 ? 0 : index % categoryColors.length];
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Story-Client-Type': 'pc',
      'X-Story-Client-Id': state.clientId,
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Request failed (${response.status})`);
    error.code = data.error?.code;
    error.requestId = data.request_id || response.headers.get('x-request-id');
    throw error;
  }
  return data;
}

async function speechApi(text, storyId) {
  const response = await fetch('/api/speech/synthesize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Story-Client-Type': 'pc',
      'X-Story-Client-Id': state.clientId
    },
    body: JSON.stringify({ text, story_id: storyId, rate: 0.95, volume: 60 })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error?.message || `Speech request failed (${response.status})`);
    error.code = data.error?.code;
    throw error;
  }
  return {
    blob: await response.blob(),
    model: response.headers.get('x-tts-model') || 'Doubao TTS',
    latencyMs: Number(response.headers.get('x-tts-latency-ms')) || 0,
    cached: response.headers.get('x-tts-cached') === 'true'
  };
}

function clearAudio() {
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = '';
  elements.storyAudio.pause();
  elements.storyAudio.removeAttribute('src');
  elements.storyAudio.hidden = true;
  elements.downloadAudio.removeAttribute('href');
  elements.downloadAudio.hidden = true;
  elements.speechStatus.textContent = state.ttsConfigured
    ? 'Generate an MP3 narration from this story.'
    : 'Doubao TTS is not configured.';
}

function setSpeechLoading(loading) {
  state.speechLoading = loading;
  elements.speechButton.disabled = loading || state.loading || !state.ttsConfigured || !state.storyText;
  elements.speechButtonLabel.hidden = loading;
  elements.speechButtonWorking.hidden = !loading;
}

function showSpeech(speech) {
  clearAudio();
  state.audioUrl = URL.createObjectURL(speech.blob);
  elements.storyAudio.src = state.audioUrl;
  elements.storyAudio.hidden = false;
  elements.downloadAudio.href = state.audioUrl;
  elements.downloadAudio.hidden = false;
  const seconds = speech.latencyMs ? ` in ${(speech.latencyMs / 1000).toFixed(1)} sec` : '';
  elements.speechStatus.textContent = speech.cached
    ? `${speech.model} replayed from story pool.`
    : `${speech.model} generated ${(speech.blob.size / 1024).toFixed(0)} KB${seconds}.`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Copy is unavailable in this browser.');
}

function selectedLanguage() {
  return new FormData(elements.form).get('language') || 'en-US';
}

function getPayload() {
  const data = new FormData(elements.form);
  return {
    card_ids: state.selectedCards.map((card) => card.id),
    child: { nickname: data.get('nickname').trim(), age: Number(data.get('age')) },
    language: data.get('language'),
    length: data.get('length'),
    options: {
      model: data.get('model').trim(),
      temperature: Number(data.get('temperature')),
      max_tokens: Number(data.get('maxTokens'))
    }
  };
}

function renderQueue() {
  elements.cardQueue.replaceChildren();

  for (let index = 0; index < 4; index += 1) {
    const card = state.selectedCards[index];
    if (!card) {
      elements.cardQueue.append(createElement('div', 'queue-slot', `Slot ${index + 1}`));
      continue;
    }

    const button = createElement('button', 'queue-card');
    button.type = 'button';
    button.dataset.removeCardId = card.id;
    button.style.setProperty('--card-accent', colorForCard(card));
    button.setAttribute('aria-label', `Remove ${card.en}`);
    button.append(
      createElement('strong', '', card.en),
      createElement('small', '', `${card.zh} · ${card.id}`),
      createElement('span', 'remove-mark', '×')
    );
    elements.cardQueue.append(button);
  }

  const count = state.selectedCards.length;
  elements.storyMode.textContent = count ? `${count}-card story` : 'No cards selected';
  elements.emptyResultText.textContent = count
    ? `${count} card${count === 1 ? '' : 's'} ready for a story.`
    : 'Select 1 to 4 word cards.';
  elements.clearCardsButton.disabled = count === 0 || state.loading;
  elements.generateButton.disabled = count === 0 || state.loading;
}

function renderCatalog() {
  const query = elements.cardSearch.value.trim().toLocaleLowerCase();
  const category = elements.categoryFilter.value;
  const selectedIds = new Set(state.selectedCards.map((card) => card.id));
  const filtered = state.cards.filter((card) => {
    const inCategory = category === 'all' || card.category === category;
    const searchable = `${card.id} ${card.en} ${card.zh}`.toLocaleLowerCase();
    return inCategory && (!query || searchable.includes(query));
  });

  elements.cardCatalog.replaceChildren();
  if (filtered.length === 0) {
    elements.cardCatalog.append(createElement('p', 'catalog-empty', 'No matching cards'));
  } else {
    const fragment = document.createDocumentFragment();
    for (const card of filtered) {
      const button = createElement('button', `word-card${selectedIds.has(card.id) ? ' selected' : ''}`);
      button.type = 'button';
      button.dataset.cardId = card.id;
      button.style.setProperty('--card-accent', colorForCard(card));
      button.setAttribute('aria-pressed', String(selectedIds.has(card.id)));
      button.append(
        createElement('strong', '', card.en),
        createElement('span', '', card.zh),
        createElement('small', '', card.id)
      );
      fragment.append(button);
    }
    elements.cardCatalog.append(fragment);
  }

  elements.catalogCount.textContent = filtered.length === state.cards.length
    ? `${state.cards.length} bilingual cards`
    : `${filtered.length} of ${state.cards.length} cards`;
}

function selectCard(cardId) {
  const card = state.cards.find((candidate) => candidate.id === cardId);
  if (!card || state.loading) return;

  state.selectedCards = state.selectedCards.filter((selected) => selected.id !== cardId);
  state.selectedCards.push(card);
  if (state.selectedCards.length > 4) state.selectedCards.shift();
  elements.formMessage.textContent = '';
  renderQueue();
  renderCatalog();
}

function removeCard(cardId) {
  if (state.loading) return;
  state.selectedCards = state.selectedCards.filter((card) => card.id !== cardId);
  renderQueue();
  renderCatalog();
}

function loadDemo(count) {
  const ids = demoSequences[count] || [];
  state.selectedCards = ids.map((id) => state.cards.find((card) => card.id === id)).filter(Boolean);
  elements.formMessage.textContent = '';
  renderQueue();
  renderCatalog();
}

function setLoading(loading) {
  state.loading = loading;
  elements.generateButton.classList.toggle('is-loading', loading);
  elements.previewButton.disabled = loading;
  elements.cardSearch.disabled = loading;
  elements.categoryFilter.disabled = loading;
  elements.speechButton.disabled = loading || state.speechLoading || !state.ttsConfigured || !state.storyText;
  renderQueue();
}

function addLog(status, cards, detail) {
  if (elements.requestLog.querySelector('.log-empty')) elements.requestLog.replaceChildren();
  const item = createElement('li', status);
  const time = createElement('time', '', new Date().toLocaleTimeString('en-GB', { hour12: false }));
  const text = createElement('span', '', cards.map((card) => card.en).join(' + '));
  const metadata = createElement('em', '', detail);
  item.append(time, text, metadata);
  elements.requestLog.prepend(item);
  while (elements.requestLog.children.length > 6) elements.requestLog.lastElementChild.remove();
}

function renderStory(text) {
  clearAudio();
  state.storyText = text;
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n');
  const title = (lines.shift() || 'Untitled story').replace(/^#+\s*/, '').trim();
  const body = lines.join('\n').trim();
  const paragraphs = body.split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\n/g, ' ').trim()).filter(Boolean);

  elements.storyTitle.textContent = title;
  elements.storyText.replaceChildren();
  for (const paragraph of paragraphs.length ? paragraphs : [body || normalized]) {
    elements.storyText.append(createElement('p', '', paragraph));
  }
}

function updateLanguageLabel() {
  elements.generateLabel.textContent = selectedLanguage() === 'zh-CN'
    ? '生成中文故事和音频'
    : 'Generate English story & audio';
}

function formatDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-GB', { hour12: false });
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function addTableCell(row, primary, secondary = '') {
  const cell = document.createElement('td');
  cell.append(createElement('strong', '', String(primary ?? '-')));
  if (secondary) cell.append(createElement('small', '', String(secondary)));
  row.append(cell);
  return cell;
}

function emptyTable(tbody, columns, message) {
  const row = createElement('tr', 'empty-table');
  const cell = createElement('td', '', message);
  cell.colSpan = columns;
  row.append(cell);
  tbody.replaceChildren(row);
}

function cardTags(ids) {
  const wrapper = createElement('div', 'cell-tags');
  for (const id of ids || []) wrapper.append(createElement('span', 'cell-tag', id));
  return wrapper;
}

function renderDatabaseDashboard(data) {
  const summary = data.summary || {};
  elements.metricPools.textContent = Number(summary.pools || 0).toLocaleString();
  elements.metricStories.textContent = Number(summary.stories || 0).toLocaleString();
  elements.metricAudio.textContent = Number(summary.audio_files || 0).toLocaleString();
  elements.metricAudioSize.textContent = formatBytes(summary.audio_bytes);
  elements.metricClients.textContent = Number(summary.clients || 0).toLocaleString();
  elements.metricClientTypes.textContent = `${summary.pc_clients || 0} PC / ${summary.device_clients || 0} device`;
  elements.metricPlays.textContent = Number(summary.total_plays || 0).toLocaleString();

  const pools = data.pools || [];
  elements.poolRows.replaceChildren();
  for (const pool of pools) {
    const row = document.createElement('tr');
    const cards = document.createElement('td');
    cards.append(cardTags(pool.card_ids));
    row.append(cards);
    addTableCell(row, pool.language, `${pool.card_count}-card pool`);
    addTableCell(row, pool.story_count, `${Math.max(0, pool.max_stories - pool.story_count)} available`);
    const capacityCell = document.createElement('td');
    const capacity = createElement('div', 'capacity');
    const track = createElement('span', 'capacity-track');
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, (pool.story_count / pool.max_stories) * 100)}%`;
    track.append(fill);
    capacity.append(track, createElement('span', '', `${pool.story_count}/${pool.max_stories}`));
    capacityCell.append(capacity);
    row.append(capacityCell);
    addTableCell(row, formatDate(pool.updated_at));
    elements.poolRows.append(row);
  }
  if (!pools.length) emptyTable(elements.poolRows, 5, 'No story pools have been created.');
  elements.poolRowCount.textContent = `${pools.length} rows`;

  const stories = data.stories || [];
  elements.storyRows.replaceChildren();
  for (const story of stories) {
    const row = document.createElement('tr');
    addTableCell(row, story.title, `${story.story_id.slice(0, 8)} · ${story.preview}`);
    const cards = document.createElement('td');
    cards.append(cardTags(story.card_ids));
    row.append(cards);
    const audio = document.createElement('td');
    if (story.audio_bytes) {
      const button = createElement('button', 'audio-preview', `Play ${formatBytes(story.audio_bytes)}`);
      button.type = 'button';
      button.dataset.audioStoryId = story.story_id;
      audio.append(button);
    } else {
      audio.append(createElement('span', 'status-label', 'Not generated'));
    }
    row.append(audio);
    addTableCell(row, `${story.listeners} / ${story.plays}`, story.last_played_at ? `Last ${formatDate(story.last_played_at)}` : 'Never played');
    addTableCell(row, formatDate(story.created_at), story.model);
    elements.storyRows.append(row);
  }
  if (!stories.length) emptyTable(elements.storyRows, 5, 'No generated stories are stored.');
  elements.storyRowCount.textContent = `${stories.length} rows`;

  const clients = data.clients || [];
  elements.clientRows.replaceChildren();
  for (const client of clients) {
    const row = document.createElement('tr');
    addTableCell(row, client.client_id, client.client_key);
    const type = document.createElement('td');
    type.append(createElement('span', 'status-label ready', client.client_type));
    row.append(type);
    addTableCell(row, client.unique_stories);
    addTableCell(row, client.total_plays);
    addTableCell(row, formatDate(client.last_played_at || client.last_seen_at), `First seen ${formatDate(client.first_seen_at)}`);
    elements.clientRows.append(row);
  }
  if (!clients.length) emptyTable(elements.clientRows, 5, 'No PC or device clients have connected.');
  elements.clientRowCount.textContent = `${clients.length} rows`;

  const activity = data.recent_activity || [];
  elements.activityRows.replaceChildren();
  for (const event of activity) {
    const row = document.createElement('tr');
    addTableCell(row, event.client_id, event.client_type);
    addTableCell(row, event.story_preview, event.story_id.slice(0, 8));
    addTableCell(row, event.play_count);
    addTableCell(row, formatDate(event.last_played_at));
    elements.activityRows.append(row);
  }
  if (!activity.length) emptyTable(elements.activityRows, 4, 'No listening activity has been recorded.');
  elements.activityRowCount.textContent = `${activity.length} rows`;
}

async function loadDatabaseDashboard() {
  if (state.databaseLoading) return;
  state.databaseLoading = true;
  elements.refreshDatabase.disabled = true;
  elements.databaseMessage.textContent = 'Checking database connection...';
  elements.databaseDot.className = 'database-dot';
  try {
    const data = await api('/api/database/dashboard');
    elements.databaseHost.textContent = `${data.connection.host}:${data.connection.port}`;
    elements.databaseName.textContent = data.server?.database_name || data.connection.database;
    elements.databaseVersion.textContent = data.server?.version || '-';
    elements.databaseTime.textContent = formatDate(data.server?.server_time);
    elements.databaseUpdated.textContent = `Updated ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`;
    if (!data.connected) {
      elements.databaseDot.className = 'database-dot error';
      elements.databaseMessage.textContent = data.error?.message || data.message || 'Database unavailable.';
      elements.databaseContent.hidden = true;
      return;
    }
    elements.databaseDot.className = 'database-dot online';
    elements.databaseMessage.textContent = 'Connected and responding normally.';
    elements.databaseContent.hidden = false;
    renderDatabaseDashboard(data);
  } catch (error) {
    elements.databaseDot.className = 'database-dot error';
    elements.databaseMessage.textContent = error.message;
    elements.databaseContent.hidden = true;
  } finally {
    state.databaseLoading = false;
    elements.refreshDatabase.disabled = false;
  }
}

function switchView(view) {
  state.activeView = view === 'database' ? 'database' : 'builder';
  elements.builderView.hidden = state.activeView !== 'builder';
  elements.databaseView.hidden = state.activeView !== 'database';
  for (const button of elements.viewButtons) {
    const active = button.dataset.view === state.activeView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (state.activeView === 'database') loadDatabaseDashboard();
}

async function initialize() {
  try {
    const [health, serviceConfig, catalog] = await Promise.all([
      api('/api/health'),
      api('/api/config'),
      api('/api/cards')
    ]);

    state.cards = catalog.cards;
    state.categories = catalog.categories;
    elements.modelInput.value = serviceConfig.model;
    elements.modelInput.disabled = !serviceConfig.allow_model_override;
    state.ttsConfigured = Boolean(serviceConfig.tts_configured);
    elements.speechButton.title = state.ttsConfigured
      ? `Voice: ${serviceConfig.tts_voice}`
      : 'Add Doubao TTS credentials on the server.';
    elements.categoryFilter.replaceChildren(new Option('All categories', 'all'));
    for (const category of state.categories) {
      elements.categoryFilter.add(new Option(`${category.en} / ${category.zh}`, category.key));
    }

    elements.serviceState.className = `service-state ${health.llm_configured ? 'online' : 'warning'}`;
    elements.serviceStateText.textContent = health.llm_configured
      ? `${serviceConfig.model} online${state.ttsConfigured ? ' · TTS configured' : ''}`
      : 'Service online · API key missing';
    renderQueue();
    renderCatalog();
    setSpeechLoading(false);
  } catch (error) {
    elements.serviceState.className = 'service-state offline';
    elements.serviceStateText.textContent = 'Service unavailable';
    elements.formMessage.textContent = error.message;
  }
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.formMessage.textContent = '';
  if (state.selectedCards.length < 1) {
    elements.formMessage.textContent = 'Select at least one word card.';
    return;
  }
  if (!state.ttsConfigured) {
    elements.formMessage.textContent = 'Doubao TTS is not configured. Story and audio cannot be generated together.';
    return;
  }

  const payload = getPayload();
  const requestCards = [...state.selectedCards];
  const startedAt = performance.now();
  let result = null;
  setLoading(true);
  elements.generateWorking.textContent = 'Generating story';
  try {
    result = await api('/api/stories/generate', { method: 'POST', body: JSON.stringify(payload) });
    elements.emptyResult.hidden = true;
    elements.storyResult.hidden = false;
    renderStory(result.text);
    state.storyId = result.story_id;
    elements.storyMeta.replaceChildren();
    const meta = [
      `${requestCards.length}-card story`,
      result.language === 'zh-CN' ? '中文' : 'English',
      result.model,
      result.cache_status === 'cached' ? 'from story pool' : null,
      `${(result.latency_ms / 1000).toFixed(1)} sec`,
      result.usage?.total_tokens ? `${result.usage.total_tokens} tokens` : null,
      `ID ${result.story_id.slice(0, 8)}`
    ].filter(Boolean);
    for (const value of meta) elements.storyMeta.append(createElement('span', '', value));
    elements.copyButton.disabled = false;

    elements.generateWorking.textContent = 'Synthesizing audio';
    elements.speechStatus.textContent = 'Synthesizing the complete story...';
    setSpeechLoading(true);
    const speech = await speechApi(result.text, result.story_id);
    showSpeech(speech);
    addLog('success', requestCards, `${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (error) {
    const requestSuffix = error.requestId ? ` · Request ${error.requestId.slice(0, 8)}` : '';
    if (result) {
      elements.formMessage.textContent = `Story generated, but audio failed: ${error.message}${requestSuffix}`;
      elements.speechStatus.textContent = 'Audio generation failed. Use Generate voice to retry.';
    } else {
      elements.formMessage.textContent = `${error.message}${requestSuffix}`;
    }
    addLog('error', requestCards, error.code || 'ERROR');
  } finally {
    setSpeechLoading(false);
    setLoading(false);
    elements.generateWorking.textContent = 'Generating story';
  }
});

elements.previewButton.addEventListener('click', async () => {
  elements.formMessage.textContent = '';
  if (state.selectedCards.length < 1) {
    elements.formMessage.textContent = 'Select at least one word card.';
    return;
  }
  try {
    const result = await api('/api/stories/preview', { method: 'POST', body: JSON.stringify(getPayload()) });
    elements.promptContent.textContent = result.messages
      .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
      .join('\n\n');
    elements.promptDialog.showModal();
  } catch (error) {
    elements.formMessage.textContent = error.message;
  }
});

elements.cardCatalog.addEventListener('click', (event) => {
  const button = event.target.closest('[data-card-id]');
  if (button) selectCard(button.dataset.cardId);
});
elements.cardQueue.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-card-id]');
  if (button) removeCard(button.dataset.removeCardId);
});
elements.clearCardsButton.addEventListener('click', () => {
  state.selectedCards = [];
  renderQueue();
  renderCatalog();
});
document.querySelectorAll('[data-demo-count]').forEach((button) => {
  button.addEventListener('click', () => loadDemo(Number(button.dataset.demoCount)));
});
elements.cardSearch.addEventListener('input', renderCatalog);
elements.categoryFilter.addEventListener('change', renderCatalog);
elements.form.addEventListener('change', (event) => {
  if (event.target.name === 'language') updateLanguageLabel();
});
elements.temperatureInput.addEventListener('input', () => {
  elements.temperatureOutput.textContent = elements.temperatureInput.value;
});
elements.closeDialogButton.addEventListener('click', () => elements.promptDialog.close());
elements.promptDialog.addEventListener('click', (event) => {
  if (event.target === elements.promptDialog) elements.promptDialog.close();
});
elements.copyButton.addEventListener('click', async () => {
  try {
    await copyText(state.storyText);
    const previous = elements.copyButton.textContent;
    elements.copyButton.textContent = 'Copied';
    setTimeout(() => { elements.copyButton.textContent = previous; }, 1200);
  } catch (error) {
    elements.formMessage.textContent = error.message;
  }
});
elements.speechButton.addEventListener('click', async () => {
  elements.speechStatus.textContent = 'Synthesizing the complete story...';
  setSpeechLoading(true);
  try {
    const speech = await speechApi(state.storyText, state.storyId);
    showSpeech(speech);
  } catch (error) {
    elements.speechStatus.textContent = error.message;
  } finally {
    setSpeechLoading(false);
  }
});
elements.clearLogButton.addEventListener('click', () => {
  elements.requestLog.replaceChildren(createElement('li', 'log-empty', 'No requests yet'));
});
for (const button of elements.viewButtons) {
  button.addEventListener('click', () => switchView(button.dataset.view));
}
elements.refreshDatabase.addEventListener('click', loadDatabaseDashboard);
elements.storyRows.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-audio-story-id]');
  if (!button) return;
  document.querySelectorAll('.audio-preview.playing').forEach((item) => item.classList.remove('playing'));
  button.disabled = true;
  button.textContent = 'Loading...';
  try {
    const response = await fetch(`/api/database/stories/${button.dataset.audioStoryId}/audio`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || 'Unable to load cached audio.');
    }
    if (state.databaseAudioUrl) URL.revokeObjectURL(state.databaseAudioUrl);
    state.databaseAudioUrl = URL.createObjectURL(await response.blob());
    elements.databaseAudio.src = state.databaseAudioUrl;
    elements.databaseAudio.hidden = false;
    button.classList.add('playing');
    button.textContent = 'Playing';
    await elements.databaseAudio.play();
  } catch (error) {
    elements.databaseMessage.textContent = error.message;
  } finally {
    button.disabled = false;
    if (!button.classList.contains('playing')) button.textContent = 'Play audio';
  }
});
elements.databaseAudio.addEventListener('ended', () => {
  document.querySelectorAll('.audio-preview.playing').forEach((button) => {
    button.classList.remove('playing');
    button.textContent = 'Play audio';
  });
});
setInterval(() => {
  if (state.activeView === 'database' && !document.hidden) loadDatabaseDashboard();
}, 30_000);

updateLanguageLabel();
renderQueue();
initialize();
