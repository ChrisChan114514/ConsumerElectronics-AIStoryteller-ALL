export class StoryServiceError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'StoryServiceError';
    this.status = status;
    this.code = code;
  }
}

export class StoryServiceClient {
  constructor({ baseUrl, fetchImpl = fetch, timeoutMs = 180_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(pathname, body, deviceId, expectAudio = false) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Story-Client-Id': deviceId,
          'X-Story-Client-Type': 'device'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new StoryServiceError(`Unable to reach WebService: ${error.message}`, 502, 'WEB_SERVICE_UNREACHABLE');
    }

    if (!response.ok) {
      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json')
        ? await response.json().catch(() => ({}))
        : { error: { message: await response.text() } };
      throw new StoryServiceError(
        payload.error?.message || `WebService returned HTTP ${response.status}.`,
        response.status,
        payload.error?.code || 'WEB_SERVICE_ERROR'
      );
    }
    return expectAudio ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  generateStory(request, deviceId) {
    return this.request('/api/stories/generate', request, deviceId);
  }

  synthesizeSpeech(story, deviceId) {
    return this.request('/api/speech/synthesize', {
      story_id: story.story_id,
      text: story.text,
      rate: 0.95,
      volume: 60,
      pitch: 1
    }, deviceId, true);
  }
}
