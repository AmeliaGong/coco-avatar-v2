import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { adminGetConversation, adminUpdateConversation } from '../../lib/api';

interface Message {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

interface TokenUsage {
  id: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: string;
}

interface ConvDetail {
  id: string;
  title: string | null;
  created_at: string;
  expires_at: string | null;
  status: string;
  messages: Message[];
  token_usage: TokenUsage[];
}

export function AdminConversationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [conv, setConv] = useState<ConvDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // --- edit state ---
  const [editTitle, setEditTitle] = useState('');
  const [expiryMode, setExpiryMode] = useState('keep');
  const [customDate, setCustomDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    adminGetConversation(id)
      .then(data => {
        setConv(data);
        setEditTitle(data.title || '');
      })
      .catch(e => {
        if ((e as Error).message === 'Unauthorized') {
          sessionStorage.removeItem('admin_token');
          window.location.reload();
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  // preview of the expiry the current selection would produce
  const previewExpiry = (): string | null => {
    if (!conv) return null;
    if (expiryMode === 'keep') return conv.expires_at;
    if (expiryMode === 'never') return null;
    if (expiryMode === 'date') {
      if (!customDate) return null;
      const [y, m, d] = customDate.split('-').map(Number);
      if (!y || !m || !d) return null;
      return new Date(y, m - 1, d, 23, 59, 59).toISOString();
    }
    const days = parseInt(expiryMode, 10);
    if (isNaN(days)) return null;
    const t = new Date(conv.created_at);
    t.setUTCDate(t.getUTCDate() + days);
    return t.toISOString();
  };

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setFeedback(null);
    try {
      const payload: Parameters<typeof adminUpdateConversation>[1] = {
        title: editTitle,
      };
      if (expiryMode === 'keep') {
        // leave the expiry untouched
      } else if (expiryMode === 'never') {
        payload.never = true;
      } else if (expiryMode === 'date') {
        if (!customDate) throw new Error('请选择日期');
        const [y, m, d] = customDate.split('-').map(Number);
        payload.expires_at = new Date(y, m - 1, d, 23, 59, 59).toISOString();
      } else {
        payload.expires_in_days = parseInt(expiryMode, 10);
      }
      const updated = await adminUpdateConversation(id, payload);
      setConv(updated);
      setFeedback({ ok: true, text: '已保存' });
      setTimeout(() => setFeedback(null), 3000);
    } catch (e) {
      if ((e as Error).message === 'Unauthorized') {
        sessionStorage.removeItem('admin_token');
        window.location.reload();
        return;
      }
      setFeedback({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-gray-400">加载中...</p>;
  if (!conv) return <p className="text-gray-400">对话不存在</p>;

  const totalTokens = conv.token_usage.reduce((sum, t) => sum + t.total_tokens, 0);

  return (
    <div>
      <button
        onClick={() => navigate('/admin')}
        className="sticky top-2 z-10 inline-block text-sm text-sage hover:underline mb-4 bg-white/80 backdrop-blur px-2 py-1 rounded-lg"
      >
        &larr; 返回列表
      </button>

      <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-4 mb-4">
        <h2 className="text-lg font-bold text-gray-800 mb-2">
          {conv.title || '无标题'}
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
          <div>
            <span className="text-gray-500">ID: </span>
            <span className="font-mono text-xs break-all">{conv.id}</span>
          </div>
          <div>
            <span className="text-gray-500">创建: </span>
            {new Date(conv.created_at).toLocaleString('zh-CN')}
          </div>
          <div>
            <span className="text-gray-500">过期: </span>
            <span className="font-medium">
              {conv.expires_at ? new Date(conv.expires_at).toLocaleString('zh-CN') : '永不'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">状态: </span>
            <span className={conv.status === 'active' ? 'text-sage font-medium' : 'text-gray-500'}>
              {conv.status === 'active' ? '活跃' : '已过期'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Token 总消耗: </span>
            <span className="font-medium">{totalTokens.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-4 mb-4">
        <h3 className="font-bold text-gray-700 mb-3 text-sm">修改链接</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">标题</label>
            <input
              type="text"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              placeholder="无标题"
              className="w-full px-3 py-2 border border-warm-grey/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage/40"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">有效期（天数为自创建日起算）</label>
            <div className="flex gap-2">
              <select
                value={expiryMode}
                onChange={e => setExpiryMode(e.target.value)}
                className="flex-1 px-3 py-2 border border-warm-grey/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage/40"
              >
                <option value="keep">保持不变</option>
                <option value="7">7 天</option>
                <option value="15">15 天</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
                <option value="date">指定日期</option>
                <option value="never">永久有效</option>
              </select>
              {expiryMode === 'date' && (
                <input
                  type="date"
                  value={customDate}
                  onChange={e => setCustomDate(e.target.value)}
                  className="px-3 py-2 border border-warm-grey/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage/40"
                />
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">
              保存后过期时间：
              {previewExpiry()
                ? new Date(previewExpiry()!).toLocaleString('zh-CN')
                : expiryMode === 'never' ? '永不' : '—'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-sage text-white rounded-lg text-sm hover:bg-olive-green transition disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存'}
            </button>
            {feedback && (
              <span className={`text-sm ${feedback.ok ? 'text-sage' : 'text-red-500'}`}>
                {feedback.text}
              </span>
            )}
          </div>
        </div>
      </div>

      {conv.token_usage.length > 0 && (
        <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-4 mb-4">
          <h3 className="font-bold text-gray-700 mb-2 text-sm">Token 明细</h3>
          <table className="w-full text-xs">
            <thead className="text-gray-500 bg-warm-beige/30">
              <tr>
                <th className="text-left py-1 px-2">时间</th>
                <th className="text-right py-1 px-2">Prompt</th>
                <th className="text-right py-1 px-2">Completion</th>
                <th className="text-right py-1 px-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {conv.token_usage.map(t => (
                <tr key={t.id} className="border-t border-warm-grey/20">
                  <td className="py-1 px-2">{new Date(t.created_at).toLocaleString('zh-CN')}</td>
                  <td className="py-1 px-2 text-right">{t.prompt_tokens}</td>
                  <td className="py-1 px-2 text-right">{t.completion_tokens}</td>
                  <td className="py-1 px-2 text-right font-medium">{t.total_tokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-4">
        <h3 className="font-bold text-gray-700 mb-3 text-sm">
          对话记录 ({conv.messages.length} 条)
        </h3>
        <div className="space-y-3">
          {conv.messages.map(msg => (
            <div
              key={msg.id}
              className={`p-3 rounded-lg text-sm ${
                msg.role === 'user'
                  ? 'bg-warm-beige/40 ml-8'
                  : msg.role === 'assistant'
                  ? 'bg-sage/10 mr-8'
                  : 'bg-soft-apricot/30'
              }`}
            >
              <div className="flex justify-between mb-1">
                <span className="text-xs font-medium text-gray-500">
                  {msg.role === 'user' ? '用户' : msg.role === 'assistant' ? 'Coco' : '系统'}
                </span>
                <span className="text-xs text-gray-400">
                  {new Date(msg.created_at).toLocaleString('zh-CN')}
                </span>
              </div>
              <div className="text-gray-800 whitespace-pre-wrap">{msg.content}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
