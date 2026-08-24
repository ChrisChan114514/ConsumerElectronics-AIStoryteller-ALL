export class LlmError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = details.status || 502;
    this.code = details.code || 'LLM_REQUEST_FAILED';
    this.details = details.details;
  }
}

function completionUrl(baseUrl) {
  return baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl}/chat/completions`;
}

export async function createChatCompletion({ config, messages, options, fetchImpl = fetch }) {
  if (!config.apiKey) {
    throw new LlmError('服务端尚未配置 LLM_API_KEY', {
      status: 503,
      code: 'LLM_NOT_CONFIGURED'
    });
  }

  const model = config.allowModelOverride && options.model ? options.model : config.model;
  const startedAt = performance.now();
  let response;

  try {
    response = await fetchImpl(completionUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        ...(config.thinking ? { thinking: { type: config.thinking } } : {}),
        stream: false
      }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    throw new LlmError(timedOut ? 'LLM 请求超时' : '无法连接 LLM 服务', {
      status: timedOut ? 504 : 502,
      code: timedOut ? 'LLM_TIMEOUT' : 'LLM_CONNECTION_FAILED',
      details: error?.message
    });
  }

  const rawBody = await response.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new LlmError('LLM 返回了无法解析的响应', {
      status: 502,
      code: 'LLM_INVALID_RESPONSE',
      details: rawBody.slice(0, 500)
    });
  }

  if (!response.ok) {
    throw new LlmError(data?.error?.message || `LLM 请求失败 (${response.status})`, {
      status: response.status === 429 ? 429 : 502,
      code: response.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_UPSTREAM_ERROR'
    });
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new LlmError('LLM 没有返回故事文本', { code: 'LLM_EMPTY_RESPONSE' });
  }

  return {
    content: content.trim(),
    model: data.model || model,
    usage: data.usage || null,
    latencyMs: Math.round(performance.now() - startedAt),
    finishReason: data?.choices?.[0]?.finish_reason || null
  };
}
