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

// ---------------------------------------------------------------------------
// 交付模块（教练分析 + 用户练习跟进）—— 后台与用户端的 API 封装
//
// 后台走 `X-Admin-Token`（adminHeaders），用户端走「链接即凭证」
// （链接里的 conversation id 就是凭证，所以用户端请求不带任何头）。
// ---------------------------------------------------------------------------

export interface DeliveryClient {
  id: string;
  display_name: string;
  phone: string | null;
  email: string | null;
  status: string;
  notes: string | null;
  source: string;
  /**
   * 外部系统给的建档标识（契约 3 的程序建档用）。
   * 今天还没有程序建档，所以正常是 null —— 但字段得先在类型里留好，
   * 否则 12 月接云函数 BFF 时要改一整轮类型。
   */
  external_id?: string | null;
  created_at: string;
  updated_at: string;
  stuck_points?: DeliveryStuckPoint[];
  conversation_count?: number;
  plan_count?: number;
  last_conversation_at?: string | null;
}

export interface DeliveryStuckPoint {
  id: string;
  title: string;
  belief: string;
  evidence_against: string[];
  emotion: string;
  micro_action: string;
  created_at: string;
}

export interface DeliveryPractice {
  id: string;
  day: number | null;
  title: string;
  intent: string;
  action: string;
  evidence_prompt: string;
  success_criteria: string;
  circle: string | null;
  scenario: string | null;
  target_belief: string | null;
  custom_data: string | null;
  sort_order: number;
}

export interface DeliveryPlan {
  id: string;
  client_id: string;
  status: string;
  version: number;
  payload: any;
  diagnosis_md: string | null;
  created_at: string;
  published_at: string | null;
  activated_at: string | null;
}

export interface CoachMove {
  id: string;
  name: string;
  summary: string;
  when_to_use: string;
  script: string;
  /**
   * 手法针对的信念类型 / 标签。后端存 JSON 字符串，**读出来时已经解成数组**。
   * （所以这里是数组而不是 string —— 页面直接 map 就行。）
   */
  targets: string[];
  tags: string[];
  active: number;
  created_at: string;
  updated_at: string;
}

export interface UserPlanResponse {
  has_plan: boolean;
  status?: string;
  vision?: { title: string; narrative: string; horizon: string };
  diagnosis?: any;
  practices?: Array<{
    id: string;
    day: number | null;
    title: string;
    intent: string;
    action: string;
    evidence_prompt: string;
    success_criteria: string;
    circle: string | null;
    scenario: string | null;
    target_belief: string | null;
    done: boolean;
    evidence_count: number;
  }>;
  current_practice?: {
    id: string;
    day: number | null;
    title: string;
    intent: string;
    action: string;
    evidence_prompt: string;
    success_criteria: string;
    circle: string | null;
    scenario: string | null;
    target_belief: string | null;
  } | null;
  evidences?: Array<{ id: string; practice_id: string; content: string; created_at: string }>;
  /**
   * 进度。**后端算出来的形状是 `{ total, completed, ratio, streak_days }`**
   * （server/delivery/progress.js 的 computeProgress）——
   * 前端不要再自己算一遍，两边算出来的「第几天」会不一样。
   *
   * `done / percent / streak` 是早期字段名，留着是为了不破坏已经写好的
   * 前端读取逻辑；后端不再返回它们。
   */
  progress?: {
    total: number;
    completed: number;
    ratio: number;
    streak_days: number;
    done?: number;
    percent?: number;
    streak?: number;
  };
  /**
   * 练习的推进形态：`sequence`（一天一张，14 张依次走）还是
   * `daily_repeat`（同一条动作每天重复）。影响「第 N / M 天」怎么显示。
   */
  mode?: 'sequence' | 'daily_repeat' | string;
}

async function adminRequest(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { ...adminHeaders(), ...(init?.headers || {}) },
  });
  if (res.status === 401) throw new Error('Unauthorized');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function adminListClients() {
  const data = await adminRequest('/api/admin/clients');
  return data.clients as DeliveryClient[];
}

export async function adminCreateClient(payload: {
  display_name: string;
  phone?: string;
  email?: string;
  notes?: string;
}) {
  return adminRequest('/api/admin/clients', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function adminGetClient(id: string) {
  return adminRequest(`/api/admin/clients/${encodeURIComponent(id)}`);
}

export async function adminUpdateClient(
  id: string,
  payload: Partial<Pick<DeliveryClient, 'display_name' | 'phone' | 'email' | 'status' | 'notes'>>
) {
  return adminRequest(`/api/admin/clients/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/**
 * 删除客户（连同它的方案、打卡、卡点、1v1 记录）。
 *
 * `confirm` 必须是这个客户的 id —— 后端会核对，对不上就不删
 * （防手滑，也防有人拿别人的 id 乱调）。会话不删，只解除挂载。
 *
 * 来自游民纪元的客户（external_id 非空）后端会拒绝（409）：那边是真实
 * 付费用户，要停用就 PATCH status='archived'。
 */
export async function adminDeleteClient(id: string) {
  return adminRequest(
    `/api/admin/clients/${encodeURIComponent(id)}?confirm=${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: id }),
    }
  );
}

/**
 * 把已有 CBT 会话挂到这个客户名下。
 * 挂载时会顺带从会话里的结构化输出导入卡点 —— 响应里的
 * `stuck_points_imported` 是教练要看到的数字（「导入了 N 条卡点」）。
 */
export async function adminAttachConversations(
  clientId: string,
  conversationIds: string[]
) {
  return adminRequest(`/api/admin/clients/${encodeURIComponent(clientId)}/conversations`, {
    method: 'POST',
    body: JSON.stringify({ conversation_ids: conversationIds }),
  });
}

/** 教练手录一条卡点（会话里没有结构化输出时用）。 */
export async function adminAddStuckPoint(
  clientId: string,
  payload: {
    title: string;
    belief?: string;
    evidence_against?: string[];
    emotion?: string;
    micro_action?: string;
  }
) {
  return adminRequest(`/api/admin/clients/${encodeURIComponent(clientId)}/stuck-points`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function adminListSessions(clientId: string) {
  const data = await adminRequest(`/api/admin/clients/${encodeURIComponent(clientId)}/sessions`);
  return data.sessions as Array<{ id: string; transcript: string; source: string; created_at: string }>;
}

export async function adminSaveSession(clientId: string, transcript: string) {
  return adminRequest(`/api/admin/clients/${encodeURIComponent(clientId)}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ transcript }),
  });
}

export async function adminUploadSession(clientId: string, file: File) {
  const res = await fetch(
    `/api/admin/clients/${encodeURIComponent(clientId)}/sessions/upload`,
    {
      method: 'POST',
      headers: {
        'X-Admin-Token': sessionStorage.getItem('admin_token') || '',
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    }
  );
  if (res.status === 401) throw new Error('Unauthorized');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function adminListPlans(clientId: string) {
  const data = await adminRequest(`/api/admin/clients/${encodeURIComponent(clientId)}/plans`);
  return data.plans as DeliveryPlan[];
}

export async function adminGeneratePlan(clientId: string, sessionId?: string) {
  return adminRequest(`/api/admin/clients/${encodeURIComponent(clientId)}/plans/generate`, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
  });
}

export async function adminSecondaryAnalysis(clientId: string, payload: Record<string, unknown> = {}) {
  return adminRequest(`/api/admin/clients/${encodeURIComponent(clientId)}/secondary-analysis`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function adminGetPlan(planId: string) {
  return adminRequest(`/api/admin/plans/${encodeURIComponent(planId)}`);
}

export async function adminUpdatePlan(
  planId: string,
  payload: { payload?: any; diagnosis_md?: string }
) {
  return adminRequest(`/api/admin/plans/${encodeURIComponent(planId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function adminUpdatePractice(
  planId: string,
  practiceId: string,
  payload: Partial<DeliveryPractice>
) {
  return adminRequest(
    `/api/admin/plans/${encodeURIComponent(planId)}/practices/${encodeURIComponent(practiceId)}`,
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
}

export async function adminPublishPlan(planId: string) {
  return adminRequest(`/api/admin/plans/${encodeURIComponent(planId)}/publish`, { method: 'POST' });
}

export async function adminListCoachMoves(includeArchived = false) {
  // 后端默认只返回启用中的手法（?all=1 才带归档）——
  // 前台要能看见「归档」这个状态本身，不然归档后手法就从列表里消失了，
  // 教练再也找不回来。
  const data = await adminRequest(
    `/api/admin/coach-moves${includeArchived ? '?all=1' : ''}`
  );
  return (data.moves || data) as CoachMove[];
}

export async function adminCreateCoachMove(payload: Partial<CoachMove>) {
  return adminRequest('/api/admin/coach-moves', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function adminUpdateCoachMove(id: string, payload: Partial<CoachMove>) {
  return adminRequest(`/api/admin/coach-moves/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function adminArchiveCoachMove(id: string) {
  return adminRequest(`/api/admin/coach-moves/${encodeURIComponent(id)}/archive`, { method: 'POST' });
}

// --- 用户端（链接即凭证：不带任何鉴权头）---

export async function userGetPlan(conversationId: string): Promise<UserPlanResponse> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/plan`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function userStartPlan(conversationId: string): Promise<UserPlanResponse> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/plan/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function userSubmitEvidence(
  conversationId: string,
  practiceId: string,
  content: string
): Promise<UserPlanResponse> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/plan/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ practice_id: practiceId, content }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
