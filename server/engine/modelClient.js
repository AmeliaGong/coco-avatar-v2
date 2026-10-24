export class ModelError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
  }
}

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

  return async function callModel({ systemPrompt, messages }) {
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
          ...messages.map(m => ({ role: m.role, content: m.content })),
        ],
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      throw new ModelError(`AI 网关错误：${res.status}`, res.status);
    }

    const data = await res.json();
    const usage = data.usage || null;
    return {
      content: data.choices?.[0]?.message?.content || '',
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
