import { useEffect, useState } from 'react';
import {
  adminListCoachMoves,
  adminCreateCoachMove,
  adminUpdateCoachMove,
  adminArchiveCoachMove,
} from '../../lib/api';
import type { CoachMove } from '../../lib/api';

const EMPTY = {
  name: '',
  summary: '',
  when_to_use: '',
  script: '',
  targets: '',
  tags: '',
};

const field =
  'w-full border border-warm-grey/40 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sage/40';

function splitList(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function AdminCoachMoves() {
  const [moves, setMoves] = useState<CoachMove[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const list = await adminListCoachMoves();
      setMoves(Array.isArray(list) ? list : []);
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

  const handleSubmit = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const payload: any = {
        name: form.name.trim(),
        summary: form.summary.trim(),
        when_to_use: form.when_to_use.trim(),
        script: form.script,
        targets: splitList(form.targets),
        tags: splitList(form.tags),
      };
      if (editing) {
        await adminUpdateCoachMove(editing, payload);
        setMessage('已更新');
      } else {
        await adminCreateCoachMove(payload);
        setMessage('已新增');
      }
      setForm(EMPTY);
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async (id: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await adminArchiveCoachMove(id);
      setMessage('已归档');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (m: CoachMove) => {
    setEditing(m.id);
    setMessage('');
    setError('');
    setForm({
      name: m.name || '',
      summary: m.summary || '',
      when_to_use: m.when_to_use || '',
      script: m.script || '',
      targets: Array.isArray(m.targets) ? (m.targets as any).join('，') : m.targets || '',
      tags: Array.isArray(m.tags) ? (m.tags as any).join('，') : m.tags || '',
    });
  };

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-bold text-gray-800">教练手法库</h2>
        <p className="text-xs text-gray-500 mt-1">
          你用过的一套方法。每一手有名字、有适用场景、有原话。
          <span className="text-amber-600">
            分析时勾选适用的几手，生成的练习就只能落在这些手上。
          </span>
        </p>
      </header>

      <div className="bg-white rounded-xl border border-warm-grey/20 shadow p-4 space-y-2">
        <h3 className="text-sm font-bold text-gray-700">{editing ? '改这一手' : '加一手'}</h3>
        <input
          className={field}
          placeholder="名字（如「三问圈」）"
          value={form.name}
          onChange={e => setForm({ ...form, name: e.target.value })}
        />
        <input
          className={field}
          placeholder="一句话：这一手在干什么"
          value={form.summary}
          onChange={e => setForm({ ...form, summary: e.target.value })}
        />
        <input
          className={field}
          placeholder="适用情景（什么时候用这一手）"
          value={form.when_to_use}
          onChange={e => setForm({ ...form, when_to_use: e.target.value })}
        />
        <textarea
          className={field}
          rows={3}
          placeholder="教练原话（照抄你的说法，不要改写）"
          value={form.script}
          onChange={e => setForm({ ...form, script: e.target.value })}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className={field}
            placeholder="针对的信念类型，逗号分隔（可选）"
            value={form.targets}
            onChange={e => setForm({ ...form, targets: e.target.value })}
          />
          <input
            className={field}
            placeholder="标签，逗号分隔（可选）"
            value={form.tags}
            onChange={e => setForm({ ...form, tags: e.target.value })}
          />
        </div>
        <div className="flex gap-2">
          <button
            className="px-3 py-1.5 bg-sage text-white rounded-lg text-xs disabled:opacity-40"
            disabled={busy || !form.name.trim() || !form.summary.trim()}
            onClick={handleSubmit}
          >
            {editing ? '保存修改' : '新增'}
          </button>
          {editing && (
            <button
              className="px-3 py-1.5 border border-warm-grey/50 rounded-lg text-xs text-gray-600"
              onClick={() => {
                setEditing(null);
                setForm(EMPTY);
              }}
            >
              取消
            </button>
          )}
        </div>
        {message && <p className="text-xs text-sage">{message}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : moves.length === 0 ? (
        <p className="text-gray-400 text-sm">还没有手法。先把下一轮要用到的那几手记下来。</p>
      ) : (
        <div className="space-y-2">
          {moves.map(m => (
            <div key={m.id} className="bg-white rounded-xl border border-warm-grey/20 shadow p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-gray-800">
                  {m.name}
                  {m.active === 0 && (
                    <span className="ml-2 text-xs text-gray-400">（已归档）</span>
                  )}
                </span>
                <div className="flex gap-2 text-xs">
                  <button className="text-sage hover:underline" onClick={() => startEdit(m)}>
                    改
                  </button>
                  <button
                    className="text-gray-400 hover:underline disabled:opacity-40"
                    disabled={busy || m.active === 0}
                    onClick={() => handleArchive(m.id)}
                  >
                    归档
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-600">{m.summary}</p>
              {m.when_to_use && <p className="text-xs text-gray-400">适用：{m.when_to_use}</p>}
              {m.script && (
                <p className="text-xs text-gray-500 whitespace-pre-wrap">原话：{m.script}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default AdminCoachMoves;
