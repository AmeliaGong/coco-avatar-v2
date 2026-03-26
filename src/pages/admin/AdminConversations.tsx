import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminGetConversations } from '../../lib/api';

interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  expires_at: string | null;
  status: string;
  message_count: number;
  total_tokens: number | null;
}

export function AdminConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const data = await adminGetConversations({
        page,
        limit: 20,
        status: statusFilter || undefined,
      });
      setConversations(data.conversations);
      setTotal(data.total);
    } catch (e) {
      if ((e as Error).message === 'Unauthorized') {
        sessionStorage.removeItem('admin_token');
        window.location.reload();
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [page, statusFilter]);

  const totalPages = Math.ceil(total / 20);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">对话列表 ({total})</h2>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-1 border border-warm-grey/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage/40"
        >
          <option value="">全部状态</option>
          <option value="active">活跃</option>
          <option value="expired">已过期</option>
        </select>
      </div>

      {loading ? (
        <p className="text-gray-400">加载中...</p>
      ) : conversations.length === 0 ? (
        <p className="text-gray-400">暂无对话</p>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-hidden border border-warm-grey/20">
          <table className="w-full text-sm">
            <thead className="bg-warm-beige/40 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">标题 / ID</th>
                <th className="text-left px-4 py-3">创建时间</th>
                <th className="text-center px-4 py-3">消息数</th>
                <th className="text-center px-4 py-3">Tokens</th>
                <th className="text-center px-4 py-3">状态</th>
                <th className="text-center px-4 py-3">过期时间</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map(c => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/admin/conversations/${c.id}`)}
                  className="border-t border-warm-grey/20 hover:bg-warm-beige/20 cursor-pointer transition"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">
                      {c.title || <span className="text-gray-400">无标题</span>}
                    </div>
                    <div className="text-xs text-gray-400 font-mono">{c.id.slice(0, 8)}...</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {new Date(c.created_at).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-4 py-3 text-center">{c.message_count}</td>
                  <td className="px-4 py-3 text-center">{c.total_tokens ?? 0}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${
                      c.status === 'active'
                        ? 'bg-sage/20 text-sage'
                        : 'bg-warm-grey/30 text-gray-500'
                    }`}>
                      {c.status === 'active' ? '活跃' : '已过期'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center text-gray-500 text-xs">
                    {c.expires_at ? new Date(c.expires_at).toLocaleDateString('zh-CN') : '永不'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="px-3 py-1 border border-warm-grey/50 rounded-lg text-sm disabled:opacity-30 hover:bg-warm-beige/40 transition"
          >
            上一页
          </button>
          <span className="px-3 py-1 text-sm text-gray-600">{page} / {totalPages}</span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="px-3 py-1 border border-warm-grey/50 rounded-lg text-sm disabled:opacity-30 hover:bg-warm-beige/40 transition"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
