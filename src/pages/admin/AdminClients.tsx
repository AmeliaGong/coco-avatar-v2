import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminListClients, adminCreateClient } from '../../lib/api';
import type { DeliveryClient } from '../../lib/api';

const SOURCE_LABEL: Record<string, string> = {
  manual: '手工建档',
  nomad: '游民纪元',
};

const STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  archived: '已归档',
};

const field =
  'w-full px-3 py-2 border border-warm-grey/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage/40';

export function AdminClients() {
  const [clients, setClients] = useState<DeliveryClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      setClients(await adminListClients());
    } catch (e) {
      if ((e as Error).message === 'Unauthorized') {
        sessionStorage.removeItem('admin_token');
        window.location.reload();
      } else {
        setError((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const created = await adminCreateClient({
        display_name: name.trim(),
        phone: phone.trim() || undefined,
      });
      const id = (created as DeliveryClient)?.id;
      setName('');
      setPhone('');
      await load();
      if (id) navigate(`/admin/clients/${id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">客户档案 ({clients.length})</h2>
        <button
          onClick={() => navigate('/admin/coach-moves')}
          className="px-3 py-1 border border-warm-grey/50 rounded-lg text-xs text-gray-600 hover:bg-warm-beige/40 transition"
        >
          教练手法库
        </button>
      </div>

      <form
        onSubmit={handleCreate}
        className="bg-white rounded-xl border border-warm-grey/20 shadow p-4 mb-6 flex gap-2 items-end"
      >
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">姓名</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="客户甲"
            className={field}
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">电话（可选）</label>
          <input
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="找回用"
            className={field}
          />
        </div>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="px-4 py-2 bg-sage text-white rounded-lg text-sm disabled:opacity-40 hover:bg-olive-green transition"
        >
          {busy ? '建档中...' : '建档'}
        </button>
      </form>

      {error && <p className="text-red-500 text-sm mb-3">{error}</p>}

      {loading ? (
        <p className="text-gray-400">加载中...</p>
      ) : clients.length === 0 ? (
        <p className="text-gray-400">还没有客户</p>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-hidden border border-warm-grey/20">
          <table className="w-full text-sm">
            <thead className="bg-warm-beige/40 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">姓名</th>
                <th className="text-left px-4 py-3">来源</th>
                <th className="text-left px-4 py-3">状态</th>
                <th className="text-center px-4 py-3">会话</th>
                <th className="text-center px-4 py-3">方案</th>
                <th className="text-left px-4 py-3">最近互动</th>
              </tr>
            </thead>
            <tbody>
              {clients.map(c => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/admin/clients/${c.id}`)}
                  className="border-t border-warm-grey/20 hover:bg-warm-beige/20 cursor-pointer transition"
                >
                  <td className="px-4 py-3 font-medium text-gray-800">{c.display_name}</td>
                  <td className="px-4 py-3 text-gray-600">{SOURCE_LABEL[c.source] || c.source}</td>
                  <td className="px-4 py-3 text-gray-600">{STATUS_LABEL[c.status] || c.status}</td>
                  <td className="px-4 py-3 text-center">{c.conversation_count ?? 0}</td>
                  <td className="px-4 py-3 text-center">{c.plan_count ?? 0}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {c.last_conversation_at
                      ? new Date(c.last_conversation_at).toLocaleDateString('zh-CN')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
