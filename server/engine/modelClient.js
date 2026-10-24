export class ModelError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
  }
}

const MAX_ERROR_BODY_CHARS = 500;

export function createModelClient({
  fetchImpl = fetch,
  apiKey,
  baseUrl = 'https://api.minimax.chat/v1/text/chatcompletion_v2',
  model = 'MiniMax-M2.7',
  maxTokens = 2000,
} = {}) {
  if (!apiKey) {
    throw new Error('MINIMAX_API_KEY is required');
  }

  return async function callModel({ systemPrompt, messages = [] }) {
    // systemPrompt 缺失时请求体会变成 {"role":"system"}（undefined 的 content
    // 被 JSON.stringify 丢掉），网关会直接 400 —— 与其拿一个没有上下文的
    // 请求去撞网关，不如在本地就失败。
    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
      throw new Error('systemPrompt 是必填的（不能为空）');
    }
    if (!Array.isArray(messages)) {
      throw new Error('messages 必须是数组');
    }

    const res = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          // 调用方自己带的 system 消息剔掉，避免出现两条 system。
          ...messages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role, content: m.content })),
        ],
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      // 错误响应体是排障的关键信息（base_resp.status_msg 等），不能丢。
      // fakeFetch 的 text() 可能不存在或抛错，所以要兜住。
      let body = '';
      try {
        body = typeof res.text === 'function' ? await res.text() : '';
      } catch {
        body = '';
      }
      if (typeof body !== 'string') body = '';
      const detail = body.slice(0, MAX_ERROR_BODY_CHARS);
      throw new ModelError(
        `AI 网关错误：${res.status}${detail ? ` — ${detail}` : ''}`,
        res.status
      );
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      // 网关返回 HTML 或响应被截断时 res.json() 抛的是原生 SyntaxError，
      // 包成 ModelError，下游只 catch ModelError 也漏不了网。
      throw new ModelError(
        `AI 网关返回了无法解析的响应（HTTP ${res.status}）：${err && err.message ? err.message : err}`,
        res.status
      );
    }

    const content = data?.choices?.[0]?.message?.content || '';

    // MiniMax 有可能以 HTTP 200 返回业务错误，例如
    // {"base_resp":{"status_code":1004,"status_msg":"insufficient balance"},"choices":[]}
    //
    // 注意：我们没有用真实网关确认过「成功响应里 base_resp.status_code 是多少」，
    // 所以**不能**无条件把它当错误判据（万一会误伤正常调用）。这里用保守规则：
    // 只有在「响应里没有可用内容」并且 status_code 存在且非 0 时才抛错 ——
    // 即使成功响应带了非零 status_code，也因为有内容而不会被误伤。
    const baseResp = data?.base_resp;
    const statusCode = baseResp?.status_code;
    if (
      !content &&
      statusCode !== undefined &&
      statusCode !== null &&
      statusCode !== 0
    ) {
      throw new ModelError(
        `AI 网关业务错误：${statusCode} ${baseResp?.status_msg || ''}`.trim(),
        res.status
      );
    }

    const usage = data?.usage || null;
    return {
      content,
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            total_tokens:
              usage.total_tokens ||
              (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
          }
        : null,
    };
  };
}
