import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

if (!MINIMAX_API_KEY) {
  console.error('Error: MINIMAX_API_KEY environment variable is not set');
  process.exit(1);
}

// Initialize database
const db = getDb();

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
  const { messages, conversation_id } = req.body;
  let convId = conversation_id;

  // Auto-create conversation if not provided
  if (!convId) {
    convId = generateId();
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, status) VALUES (?, ?, ?, ?)'
    ).run(convId, null, now(), 'active');
  } else {
    // Verify conversation exists and is not expired
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
    if (conv && isExpired(conv.expires_at)) {
      return res.status(410).json({ error: 'Conversation expired', expired: true });
    }
  }

  // Save user message
  const userMsg = messages.filter(m => m.role === 'user').pop();
  if (userMsg) {
    db.prepare(
      'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(convId, 'user', userMsg.content, now());
  }

  try {
    const response = await fetch('https://api.minimax.chat/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'MiniMax-Text-01',
        messages: [
          {
            role: 'system',
            content: messages.find(m => m.role === 'system')?.content || '',
          },
          ...messages.filter(m => m.role !== 'system'),
        ],
        stream: true,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI Gateway error:', errorText);
      res.status(response.status).json({ error: 'AI Gateway error' });
      return;
    }

    // Set headers for SSE — include conversation_id so frontend knows it
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Conversation-Id', convId);

    // Stream the response, collect full content and parse usage
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      res.write(chunk);

      // Parse SSE lines for content and usage
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) fullContent += content;
            if (parsed.usage) usage = parsed.usage;
          } catch (e) {
            // Ignore parse errors for partial chunks
          }
        }
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
    d.setDate(d.getDate() + parseInt(expires_in_days));
    expiresAt = d.toISOString();
  }

  db.prepare(
    'INSERT INTO conversations (id, title, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?)'
  ).run(id, title || null, createdAt, expiresAt, 'active');

  res.json({ id, title, created_at: createdAt, expires_at: expiresAt, status: 'active' });
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

// Serve static files from the dist directory
app.use(express.static(path.join(__dirname, 'dist')));

// Serve index.html for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
