import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { createPromptRegistry } from './server/promptRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const MINIMAX_API_URL = process.env.MINIMAX_API_URL || 'https://api.minimax.chat/v1/text/chatcompletion_v2';

// 判定本文件是否作为进程入口运行。
// 两边都取 realpath 再比较：import.meta.url 默认是模块的真实路径，
// 而 process.argv[1] 是「敲进来的那个路径」（可能是软链）；在
// --preserve-symlinks-main 下则正好相反。只比较 realpath 两种情况都对，
// 只比原始路径会在软链启动时静默地不监听、也不报错。
const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
})();

// 缺少 API key 时直接退出。放在 getDb() 之前，与改造前的顺序完全一致：
// 缺 key 时不建库、不改 schema。
if (!MINIMAX_API_KEY) {
  console.error('Error: MINIMAX_API_KEY environment variable is not set');
  process.exit(1);
}

// Initialize database
const db = getDb();

// Prompt Registry：文件是兜底真相源，数据库里的激活版本优先。
// 这样真人教练可以随时调整话术而不需要重新部署。
const promptRegistry = createPromptRegistry({ db });

// Clean up expired admin sessions on startup
db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(new Date().toISOString());

app.use(cors());
app.use(express.json());

// --- Helper functions ---

function generateId() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
  if (!session || new Date(session.expires_at) < new Date()) {
    if (session) {
      db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Conversation API (frontend) ---

// Create a new conversation
app.post('/api/conversations', (req, res) => {
  const id = generateId();
  const createdAt = now();
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, status) VALUES (?, ?, ?, ?)'
  ).run(id, null, createdAt, 'active');
  res.json({ id, created_at: createdAt, status: 'active' });
});

// Get conversation info (with expiry check)
app.get('/api/conversations/:id', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  if (isExpired(conv.expires_at)) {
    // Update status if not already expired
    if (conv.status !== 'expired') {
      db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('expired', conv.id);
    }
    return res.status(410).json({ error: 'Conversation expired', expired: true });
  }
  // Load messages for this conversation
  const messages = db.prepare(
    'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(req.params.id);
  res.json({ ...conv, messages });
});

// Chat endpoint with persistence and token tracking
app.post('/api/chat', async (req, res) => {
  const { messages, conversation_id, scenario = 'chat' } = req.body;
  let convId = conversation_id;

  // Auto-create conversation if not provided or if it doesn't exist in DB
  if (!convId) {
    convId = generateId();
  }
  // Check if conversation exists; if not, create it first (disable FK check to avoid
  // constraint error on the INSERT, then re-enable immediately after)
  const existing = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!existing) {
    db.pragma('foreign_keys = OFF');
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, status) VALUES (?, ?, ?, ?)'
    ).run(convId, null, now(), 'active');
    db.pragma('foreign_keys = ON');
  } else if (isExpired(existing.expires_at)) {
    return res.status(410).json({ error: 'Conversation expired', expired: true });
  }

  // Save user message
  const userMsg = messages.filter(m => m.role === 'user').pop();
  if (userMsg) {
    db.prepare(
      'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(convId, 'user', userMsg.content, now());
  }

  try {
    const response = await fetch(MINIMAX_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        messages: [
          { role: 'system', content: promptRegistry.getPrompt(scenario) },
          ...messages.filter(m => m.role !== 'system'),
        ],
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI Gateway error:', errorText);
      res.status(response.status).json({ error: 'AI Gateway error' });
      return;
    }

    // MiniMax returns a JSON response (not SSE streaming)
    const data = await response.json();

    // Set headers — include conversation_id so frontend knows it
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Conversation-Id', convId);

    // Extract content from MiniMax response format
    const fullContent = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || null;

    // Send the response as a simulated SSE stream for frontend compatibility
    if (fullContent) {
      // Stream chunks to simulate SSE for frontend compatibility
      const chunkSize = 50;
      for (let i = 0; i < fullContent.length; i += chunkSize) {
        const chunk = fullContent.slice(i, i + chunkSize);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();

    // Save assistant message
    if (fullContent) {
      db.prepare(
        'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(convId, 'assistant', fullContent, now());
    }

    // Save token usage
    if (usage) {
      db.prepare(
        'INSERT INTO token_usage (conversation_id, prompt_tokens, completion_tokens, total_tokens, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        convId,
        usage.prompt_tokens || 0,
        usage.completion_tokens || 0,
        usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        now()
      );
    }

    // Auto-set title from first user message if not set
    const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(convId);
    if (conv && !conv.title && userMsg) {
      const title = userMsg.content.substring(0, 50) + (userMsg.content.length > 50 ? '...' : '');
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, convId);
    }
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Admin API ---

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  // Clean up expired sessions opportunistically
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(createdAt);
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)').run(token, createdAt, expiresAt);
  res.json({ token });
});

// Admin: list conversations
app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  const { page = 1, limit = 20, status, from, to } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = 'WHERE 1=1';
  const params = [];

  if (status) {
    where += ' AND c.status = ?';
    params.push(status);
  }
  if (from) {
    where += ' AND c.created_at >= ?';
    params.push(from);
  }
  if (to) {
    where += ' AND c.created_at <= ?';
    params.push(to);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as count FROM conversations c ${where}`
  ).get(...params).count;

  const conversations = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count,
      (SELECT SUM(total_tokens) FROM token_usage WHERE conversation_id = c.id) as total_tokens
    FROM conversations c
    ${where}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  // Check and update expired conversations
  for (const conv of conversations) {
    if (conv.status === 'active' && isExpired(conv.expires_at)) {
      db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('expired', conv.id);
      conv.status = 'expired';
    }
  }

  res.json({ conversations, total, page: parseInt(page), limit: parseInt(limit) });
});

// Admin: conversation detail
app.get('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const messages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(req.params.id);

  const tokenUsage = db.prepare(
    'SELECT * FROM token_usage WHERE conversation_id = ? ORDER BY id ASC'
  ).all(req.params.id);

  res.json({ ...conv, messages, token_usage: tokenUsage });
});

// Admin: create conversation link (with optional expiry)
app.post('/api/admin/conversations', requireAdmin, (req, res) => {
  const { title, expires_in_days } = req.body;
  const id = generateId();
  const createdAt = now();
  let expiresAt = null;

  if (expires_in_days && expires_in_days > 0) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + parseInt(expires_in_days));
    expiresAt = d.toISOString();
  }

  db.prepare(
    'INSERT INTO conversations (id, title, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?)'
  ).run(id, title || null, createdAt, expiresAt, 'active');

  res.json({ id, title, created_at: createdAt, expires_at: expiresAt, status: 'active' });
});

// Admin: update an existing conversation link (title / expiry)
app.patch('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const { title, expires_at, expires_in_days, never } = req.body || {};
  const updates = [];
  const params = [];

  if (typeof title === 'string') {
    updates.push('title = ?');
    params.push(title.trim() || null);
  }

  let newExpiresAt = conv.expires_at;
  if (never === true) {
    newExpiresAt = null;
  } else if (typeof expires_at === 'string' && expires_at) {
    const d = new Date(expires_at);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'Invalid expires_at' });
    }
    newExpiresAt = d.toISOString();
  } else if (expires_in_days !== undefined && expires_in_days !== null) {
    const days = parseInt(expires_in_days, 10);
    if (isNaN(days) || days < 0) {
      return res.status(400).json({ error: 'Invalid expires_in_days' });
    }
    if (days === 0) {
      newExpiresAt = null;
    } else {
      // N days counted from the link's creation time
      const d = new Date(conv.created_at);
      d.setUTCDate(d.getUTCDate() + days);
      newExpiresAt = d.toISOString();
    }
  }

  if (newExpiresAt !== conv.expires_at) {
    updates.push('expires_at = ?');
    params.push(newExpiresAt);
  }

  // status follows the expiry: a revived link goes back to active
  updates.push('status = ?');
  params.push(isExpired(newExpiresAt) ? 'expired' : 'active');

  if (updates.length) {
    params.push(conv.id);
    db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  res.json(db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id));
});

// Admin: token stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const { from, to } = req.query;

  let where = 'WHERE 1=1';
  const params = [];
  if (from) { where += ' AND created_at >= ?'; params.push(from); }
  if (to) { where += ' AND created_at <= ?'; params.push(to); }

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COUNT(*) as total_requests
    FROM token_usage ${where}
  `).get(...params);

  const daily = db.prepare(`
    SELECT
      date(created_at) as date,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      SUM(total_tokens) as total_tokens,
      COUNT(*) as requests
    FROM token_usage ${where}
    GROUP BY date(created_at)
    ORDER BY date DESC
    LIMIT 30
  `).all(...params);

  const conversationCount = db.prepare(
    'SELECT COUNT(*) as count FROM conversations'
  ).get().count;

  res.json({ totals, daily, conversation_count: conversationCount });
});

// --- Stories API ---
app.get('/api/stories', (req, res) => {
  const stories = db.prepare(`
    SELECT id, name, city, country, lat, lng, title, summary, is_coco as isCoco, avatar, created_at as createdAt
    FROM stories ORDER BY is_coco DESC, created_at DESC
  `).all();
  res.json({ stories });
});

app.get('/api/stories/:id', (req, res) => {
  const story = db.prepare(`
    SELECT id, name, city, country, lat, lng, title, summary, content, is_coco as isCoco, avatar, created_at as createdAt
    FROM stories WHERE id = ?
  `).get(req.params.id);
  if (!story) return res.status(404).json({ error: 'Story not found' });
  res.json(story);
});

app.post('/api/stories', (req, res) => {
  const { id, name, city, country, lat, lng, title, summary, content, isCoco, avatar } = req.body;
  if (!id || !name || !city || !country || !title || !summary || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO stories (id, name, city, country, lat, lng, title, summary, content, is_coco, avatar, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, city, country, lat || 0, lng || 0, title, summary, content, isCoco ? 1 : 0, avatar || null, now);
  res.json({ success: true });
});

app.put('/api/stories/:id', (req, res) => {
  const { name, city, country, lat, lng, title, summary, content, avatar } = req.body;
  const existing = db.prepare('SELECT id FROM stories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Story not found' });
  db.prepare(`
    UPDATE stories SET name=?, city=?, country=?, lat=?, lng=?, title=?, summary=?, content=?, avatar=?
    WHERE id=?
  `).run(name, city, country, lat||0, lng||0, title, summary, content, avatar||null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/stories/:id', (req, res) => {
  db.prepare('DELETE FROM stories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Serve static files from the dist directory
app.use(express.static(path.join(__dirname, 'dist')));

// Serve index.html for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// 只有当本文件是进程入口时才启动监听器。
// 这样测试可以 import app 而不会占用端口。
// （判定逻辑见文件上部的 isEntryPoint）
if (isEntryPoint) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export { app };
