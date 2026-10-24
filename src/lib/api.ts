export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StreamChatResult {
  content: AsyncGenerator<string>;
  conversationId: string | null;
}

export async function createConversation(): Promise<{ id: string }> {
  const res = await fetch('/api/conversations', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create conversation');
  return res.json();
}

export async function getConversation(id: string): Promise<{
  id: string;
  status: string;
  expires_at: string | null;
  messages: { role: string; content: string; created_at: string }[];
} | null> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (res.status === 410) return null; // expired
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to get conversation');
  return res.json();
}

export async function* streamChat(
  messages: Message[],
  conversationId?: string
): AsyncGenerator<string> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      conversation_id: conversationId || undefined,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  // Capture conversation ID from response header
  const newConvId = response.headers.get('X-Conversation-Id');
  if (newConvId && !conversationId) {
    // Store for the caller to pick up
    (streamChat as any)._lastConversationId = newConvId;
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch (e) {
          // ignore
        }
      }
    }
  }
}

// Admin API helpers
export async function adminLogin(password: string): Promise<string | null> {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.token;
}

function adminHeaders(): Record<string, string> {
  const token = sessionStorage.getItem('admin_token');
  return {
    'Content-Type': 'application/json',
    'X-Admin-Token': token || '',
  };
}

export async function adminGetConversations(params: {
  page?: number;
  limit?: number;
  status?: string;
  from?: string;
  to?: string;
}) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.status) qs.set('status', params.status);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);

  const res = await fetch(`/api/admin/conversations?${qs}`, {
    headers: adminHeaders(),
  });
  if (res.status === 401) throw new Error('Unauthorized');
  return res.json();
}

export async function adminGetConversation(id: string) {
  const res = await fetch(`/api/admin/conversations/${encodeURIComponent(id)}`, {
    headers: adminHeaders(),
  });
  if (res.status === 401) throw new Error('Unauthorized');
  return res.json();
}

export async function adminCreateLink(title: string, expiresInDays: number | null) {
  const res = await fetch('/api/admin/conversations', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      title: title || undefined,
      expires_in_days: expiresInDays,
    }),
  });
  if (res.status === 401) throw new Error('Unauthorized');
  return res.json();
}

export async function adminUpdateConversation(
  id: string,
  payload: {
    title?: string;
    expires_in_days?: number | null;
    expires_at?: string;
    never?: boolean;
  }
) {
  const res = await fetch(`/api/admin/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: adminHeaders(),
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new Error('Unauthorized');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update conversation');
  }
  return res.json();
}

export async function adminGetStats(from?: string, to?: string) {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);

  const res = await fetch(`/api/admin/stats?${qs}`, {
    headers: adminHeaders(),
  });
  if (res.status === 401) throw new Error('Unauthorized');
  return res.json();
}
