import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  adminGetClient,
  adminUpdateClient,
  adminDeleteClient,
  adminGetConversations,
  adminAttachConversations,
  adminAddStuckPoint,
  adminListSessions,
  adminSaveSession,
  adminUploadSession,
  adminListPlans,
  adminGeneratePlan,
  adminSecondaryAnalysis,
  adminPublishPlan,
  adminListCoachMoves,
} from '../../lib/api';
import type { DeliveryClient, DeliveryPlan, CoachMove } from '../../lib/api';

interface ClientConversation {
  id: string;
  title: string | null;
  created_at: string;
  status: string;
  message_count: number;
}

interface StuckPoint {
  id: string;
  title: string;
  belief: string;
  evidence_against: string[];
  emotion: string;
  micro_action: string;
}

interface SessionRow {
  id: string;
  transcript: string;
  source: string;
  created_at: string;
}

const PLAN_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  pending_activation: '待用户开始',
  active: '进行中',
  archived: '已归档',
};

const field =
  'w-full px-3 py-2 border border-warm-grey/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage/40';

const EMPTY_MANUAL = {
  title: '',
  belief: '',
  evidence_against: '',
  emotion: '',
  micro_action: '',
};

export function AdminClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<(DeliveryClient & { conversations?: ClientConversation[] }) | null>(null);
  const [stuckPoints, setStuckPoints] = useState<StuckPoint[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [plans, setPlans] = useState<DeliveryPlan[]>([]);
  const [allConversations, setAllConversations] = useState<any[]>([]);
  const [moves, setMoves] = useState<CoachMove[]>([]);

  const [selectedConv, setSelectedConv] = useState('');
  const [transcript, setTranscript] = useState('');
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([]);
  const [coachSpeaker, setCoachSpeaker] = useState('');
  const [selectedMoves, setSelectedMoves] = useState<string[]>([]);
  const [manual, setManual] = useState(EMPTY_MANUAL);
  const [showManual, setShowManual] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  // 删除客户要走**两步**：先点「删除客户」展开确认区，再点「确认删除」。
  const [showDelete, setShowDelete] = useState(false);
  const [editForm, setEditForm] = useState({ display_name: '', phone: '', email: '', notes: '', status: 'active' });

  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [detail, sess, pl] = await Promise.all([
        adminGetClient(id),
        adminListSessions(id),
        adminListPlans(id),
      ]);
      const c = (detail?.client || detail) as any;
      setClient(c);
      setStuckPoints((c?.stuck_points || []) as StuckPoint[]);
      setSessions((sess || []) as SessionRow[]);
      setPlans((pl || []) as DeliveryPlan[]);
      setEditForm({
        display_name: c?.display_name || '',
        phone: c?.phone || '',
        email: c?.email || '',
        notes: c?.notes || '',
        status: c?.status || 'active',
      });
      try {
        const convs = await adminGetConversations({ limit: 100 });
        setAllConversations(convs.conversations || []);
      } catch {
        setAllConversations([]);
      }
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
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    adminListCoachMoves()
      .then(list => setMoves(Array.isArray(list) ? list : []))
      .catch(() => setMoves([]));
  }, []);

  const latestSessionId = sessions.length > 0 ? sessions[0].id : '';

  const handleAttach = async () => {
    if (!selectedConv) return;
    setBusyId('attach');
    setError('');
    setMessage('');
    try {
      const r = await adminAttachConversations(id!, [selectedConv]);
      setMessage(`已挂载 ${r.attached ?? 1} 个会话，导入 ${r.stuck_points_imported ?? 0} 条卡点`);
      setSelectedConv('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveManualStuckPoint = async () => {
    setBusyId('manual');
    setError('');
    setMessage('');
    try {
      await adminAddStuckPoint(id!, {
        title: manual.title.trim(),
        belief: manual.belief.trim(),
        evidence_against: manual.evidence_against
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean),
        emotion: manual.emotion.trim(),
        micro_action: manual.micro_action.trim(),
      });
      setManual(EMPTY_MANUAL);
      setShowManual(false);
      setMessage('已保存卡点');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveSession = async () => {
    setBusyId('save');
    setError('');
    setMessage('');
    try {
      await adminSaveSession(id!, transcript);
      setTranscript('');
      setUploadWarnings([]);
      setMessage('1v1 咨询记录已存档');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const handleUpload = async (file: File) => {
    setBusyId('upload');
    setError('');
    setMessage('');
    try {
      const r = await adminUploadSession(id!, file);
      setTranscript(r.text || '');
      setUploadWarnings(r.warnings || []);
      setMessage(`已提取 ${(r.text || '').length} 字（${r.filename || file.name}），检查一下再保存`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const handleGenerate = async () => {
    setBusyId('generate');
    setError('');
    setMessage('');
    try {
      await adminGeneratePlan(id!);
      setMessage('方案草稿已生成，去「方案」一节确认后发布');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const handleSecondary = async () => {
    setBusyId('secondary');
    setError('');
    setMessage('');
    try {
      const r = await adminSecondaryAnalysis(id!, {
        session_id: latestSessionId,
        coach_move_ids: selectedMoves,
        coach_speaker: coachSpeaker.trim() || null,
      });
      const round = r?.plan?.version ?? r?.plan?.round;
      setMessage(round ? `已生成第 ${round} 轮诊断草稿` : '已生成新一轮诊断草稿');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const handlePublish = async (planId: string) => {
    setBusyId(`publish:${planId}`);
    setError('');
    setMessage('');
    try {
      await adminPublishPlan(planId);
      setMessage('方案已发布，等用户开始');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveClient = async () => {
    setBusyId('client');
    setError('');
    setMessage('');
    try {
      await adminUpdateClient(id!, {
        display_name: editForm.display_name.trim(),
        phone: editForm.phone.trim() || null,
        email: editForm.email.trim() || null,
        notes: editForm.notes.trim() || null,
        status: editForm.status,
      });
      setShowEdit(false);
      setMessage('客户信息已保存');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  // 删除客户。
  //
  // 后端会级联删掉方案、打卡、卡点、1v1 记录，会话保留（只解除挂载）。
  // 删完回到客户列表，并把「删了多少」带过去 —— 教练要看得见结果，
  // 不能是「点了没反应，也不知道删掉没」。
  const handleDelete = async () => {
    setBusyId('delete');
    setError('');
    setMessage('');
    try {
      const r: any = await adminDeleteClient(id!);
      const rm = r?.removed || {};
      navigate('/admin/clients', {
        state: {
          notice:
            `已删除「${r?.display_name || ''}」：` +
            `${rm.plans || 0} 份方案、${rm.evidences || 0} 条打卡、` +
            `${rm.stuck_points || 0} 条卡点、${rm.sessions_1v1 || 0} 条 1v1 记录`,
        },
      });
    } catch (e) {
      setError((e as Error).message);
      setShowDelete(false);
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !client) return <p className="text-gray-400">加载中...</p>;  if (!client) {
    return (
      <div>
        <p className="text-gray-400 mb-4">客户不存在或加载失败。</p>
        <button
          onClick={() => navigate('/admin/clients')}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← 客户列表
        </button>
      </div>
    );
  }

  const attachedIds = new Set((client.conversations || []).map(c => c.id));
  const candidates = allConversations.filter(c => !attachedIds.has(c.id));

  return (
    <div className="space-y-6">
      <div>
        <button
          onClick={() => navigate('/admin/clients')}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← 客户列表
        </button>
        <div className="flex items-center justify-between mt-1">
          <h2 className="text-lg font-bold text-gray-800">{client.display_name}</h2>
          <div className="flex gap-2">
            <button
              onClick={() => navigate('/admin/coach-moves')}
              className="px-3 py-1 border border-warm-grey/50 rounded-lg text-xs text-gray-600 hover:bg-warm-beige/40 transition"
            >
              教练手法库
            </button>
            <button
              onClick={() => setShowEdit(v => !v)}
              className="px-3 py-1 border border-warm-grey/50 rounded-lg text-xs text-gray-600 hover:bg-warm-beige/40 transition"
            >
              {showEdit ? '收起资料' : '编辑资料'}
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          {client.phone || '无电话'} · 建档于 {new Date(client.created_at).toLocaleString('zh-CN')}
        </p>
      </div>

      {showEdit && (
        <section className="bg-white rounded-xl border border-warm-grey/20 shadow p-4 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">姓名</label>
              <input
                value={editForm.display_name}
                onChange={e => setEditForm({ ...editForm, display_name: e.target.value })}
                className={field}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">状态</label>
              <select
                value={editForm.status}
                onChange={e => setEditForm({ ...editForm, status: e.target.value })}
                className={field}
              >
                <option value="active">进行中</option>
                <option value="archived">已归档</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">电话</label>
              <input
                value={editForm.phone}
                onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                className={field}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">邮箱</label>
              <input
                value={editForm.email}
                onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                className={field}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">教练私有备注（用户端看不到）</label>
            <textarea
              value={editForm.notes}
              onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
              rows={3}
              className={field}
            />
          </div>
          <button
            onClick={handleSaveClient}
            disabled={busyId === 'client' || !editForm.display_name.trim()}
            className="px-4 py-2 bg-sage text-white rounded-lg text-sm disabled:opacity-40 hover:bg-olive-green transition"
          >
            {busyId === 'client' ? '保存中...' : '保存资料'}
          </button>
        </section>
      )}

      {error && <p className="text-red-500 text-sm">{error}</p>}
      {message && <p className="text-sage text-sm">{message}</p>}

      {/* 1. 关联已有的 CBT 会话 */}
      <section className="bg-white rounded-xl border border-warm-grey/20 shadow p-4">
        <h3 className="font-bold text-gray-800 mb-3">1. 关联已有的 CBT 会话</h3>
        <p className="text-xs text-gray-500 mb-2">
          用户首次 CBT 练习产生的卡点，会从会话里自动导入。
        </p>
        <div className="flex gap-2">
          <select
            value={selectedConv}
            onChange={e => setSelectedConv(e.target.value)}
            className="flex-1 px-3 py-2 border border-warm-grey/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage/40"
          >
            <option value="">选择一条会话</option>
            {candidates.map(c => (
              <option key={c.id} value={c.id}>
                {c.title || c.id.slice(0, 8)}（{c.message_count} 条消息）
              </option>
            ))}
          </select>
          <button
            onClick={handleAttach}
            disabled={!selectedConv || busyId === 'attach'}
            className="px-4 py-2 bg-sage text-white rounded-lg text-sm disabled:opacity-40 hover:bg-olive-green transition"
          >
            {busyId === 'attach' ? '挂载中...' : '挂载并导入卡点'}
          </button>
        </div>

        {(client.conversations || []).length > 0 && (
          <ul className="mt-3 space-y-2 text-sm text-gray-600">
            {client.conversations!.map(c => (
              <li key={c.id} className="flex items-center gap-2">
                <span>
                  · {c.title || c.id.slice(0, 8)} — {c.message_count} 条消息
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 2. 卡点 */}
      <section className="bg-white rounded-xl border border-warm-grey/20 shadow p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-gray-800">2. 卡点</h3>
          {!showManual && (
            <button
              onClick={() => setShowManual(true)}
              className="text-xs text-gray-500 hover:text-sage transition"
            >
              + 手录卡点
            </button>
          )}
        </div>

        {showManual && (
          <div className="border border-warm-grey/40 rounded-lg p-3 space-y-2 mb-3">
            <input
              value={manual.title}
              onChange={e => setManual({ ...manual, title: e.target.value })}
              placeholder="一句话概括（必填）"
              className={field}
            />
            <textarea
              value={manual.belief}
              onChange={e => setManual({ ...manual, belief: e.target.value })}
              placeholder="限制性信念"
              rows={2}
              className={field}
            />
            <textarea
              value={manual.evidence_against}
              onChange={e => setManual({ ...manual, evidence_against: e.target.value })}
              placeholder="与信念相反的事实，一行一条"
              rows={2}
              className={field}
            />
            <textarea
              value={manual.emotion}
              onChange={e => setManual({ ...manual, emotion: e.target.value })}
              placeholder="此刻的主要情绪"
              rows={2}
              className={field}
            />
            <textarea
              value={manual.micro_action}
              onChange={e => setManual({ ...manual, micro_action: e.target.value })}
              placeholder="今天能做的一件最小的事"
              rows={2}
              className={field}
            />
            <div className="flex gap-2">
              <button
                onClick={handleSaveManualStuckPoint}
                disabled={busyId === 'manual' || !manual.title.trim()}
                className="px-3 py-1.5 bg-sage text-white rounded-lg text-xs disabled:opacity-40"
              >
                保存卡点
              </button>
              <button
                onClick={() => {
                  setShowManual(false);
                  setManual(EMPTY_MANUAL);
                }}
                className="px-3 py-1.5 border border-warm-grey/50 rounded-lg text-xs text-gray-600"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {stuckPoints.length === 0 ? (
          <p className="text-gray-400 text-sm">还没有卡点。挂载会话或手录一条。</p>
        ) : (
          <ul className="space-y-2">
            {stuckPoints.map(sp => (
              <li key={sp.id} className="border border-warm-grey/30 rounded-lg p-3">
                <p className="text-sm font-medium text-gray-800">{sp.title}</p>
                {sp.belief && <p className="text-xs text-gray-600 mt-1">信念：{sp.belief}</p>}
                {sp.emotion && <p className="text-xs text-gray-500 mt-1">情绪：{sp.emotion}</p>}
                {sp.micro_action && (
                  <p className="text-xs text-gray-500 mt-1">最小行动：{sp.micro_action}</p>
                )}
                {Array.isArray(sp.evidence_against) && sp.evidence_against.length > 0 && (
                  <ul className="text-xs text-gray-400 mt-1 list-disc pl-4">
                    {sp.evidence_against.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. 粘贴 / 上传 1v1 咨询数据 */}
      <section className="bg-white rounded-xl border border-warm-grey/20 shadow p-4">
        <h3 className="font-bold text-gray-800 mb-3">3. 粘贴 Coco 1v1 咨询数据</h3>

        <div className="flex items-center gap-2 mb-2">
          <label
            className="px-3 py-1.5 border border-warm-grey/50 rounded-lg text-xs cursor-pointer hover:bg-warm-beige/40 transition"
          >
            {busyId === 'upload' ? '提取中...' : '上传转写文件（txt / md / docx）'}
            <input
              type="file"
              accept=".txt,.md,.markdown,.docx"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) handleUpload(f);
              }}
            />
          </label>
          {transcript.length > 0 && (
            <span className="text-xs text-gray-400">已填 {transcript.length} 字</span>
          )}
        </div>

        {uploadWarnings.length > 0 && (
          <ul className="text-xs text-amber-600 space-y-0.5 mb-2">
            {uploadWarnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        )}

        <textarea
          value={transcript}
          onChange={e => setTranscript(e.target.value)}
          rows={10}
          placeholder="把 1v1 咨询的转写正文粘贴到这里。原始格式保留即可，段落结构会一起交给模型。"
          className={field}
        />

        <div className="flex flex-wrap gap-2 mt-2 items-end">
          <button
            onClick={handleSaveSession}
            disabled={!transcript.trim() || busyId === 'save'}
            className="px-4 py-2 border border-warm-grey/50 rounded-lg text-sm text-gray-700 disabled:opacity-40 hover:bg-warm-beige/40 transition"
          >
            {busyId === 'save' ? '存档中...' : '仅存档'}
          </button>
          <button
            onClick={handleGenerate}
            disabled={busyId === 'generate' || sessions.length === 0}
            className="px-4 py-2 bg-sage text-white rounded-lg text-sm disabled:opacity-40 hover:bg-olive-green transition"
          >
            {busyId === 'generate' ? '生成中...' : '生成方案草稿'}
          </button>
          <button
            onClick={handleSecondary}
            disabled={busyId === 'secondary' || !latestSessionId}
            className="px-4 py-2 border border-warm-grey/50 rounded-lg text-sm text-gray-700 disabled:opacity-40 hover:bg-warm-beige/40 transition"
          >
            {busyId === 'secondary' ? '分析中...' : '基于最近一次 1v1 做二次分析'}
          </button>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">谁是教练（可选）</label>
            <input
              value={coachSpeaker}
              onChange={e => setCoachSpeaker(e.target.value)}
              placeholder="例如：教练 Coco"
              className={field}
            />
          </div>
          <div className="space-y-1">
            <span className="block text-xs text-gray-500">本次适用的手法（可不勾 = 不限制）</span>
            <div className="flex flex-wrap gap-1.5">
              {moves.map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() =>
                    setSelectedMoves(prev =>
                      prev.includes(m.id) ? prev.filter(x => x !== m.id) : [...prev, m.id]
                    )
                  }
                  className={`px-2 py-0.5 rounded-full text-xs border ${
                    selectedMoves.includes(m.id)
                      ? 'bg-sage text-white border-sage'
                      : 'border-warm-grey/40 text-gray-500'
                  }`}
                >
                  {m.name}
                </button>
              ))}
              {moves.length === 0 && (
                <span className="text-xs text-gray-400">手法库是空的</span>
              )}
            </div>
          </div>
        </div>

        {sessions.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-gray-500">
            {sessions.map(s => (
              <li key={s.id}>
                · {new Date(s.created_at).toLocaleString('zh-CN')} — {s.transcript.slice(0, 40)}…
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4. 方案 */}
      <section className="bg-white rounded-xl border border-warm-grey/20 shadow p-4">
        <h3 className="font-bold text-gray-800 mb-3">4. 方案</h3>
        {plans.length === 0 ? (
          <p className="text-gray-400 text-sm">
            还没有方案。先粘贴 1v1 咨询数据，再点「生成方案草稿」。
          </p>
        ) : (
          <ul className="space-y-2">
            {plans.map(p => (
              <li
                key={p.id}
                className="border border-warm-grey/30 rounded-lg px-3 py-2 flex items-center justify-between gap-2"
              >
                <div>
                  <span className="text-sm text-gray-800">
                    {PLAN_STATUS_LABEL[p.status] || p.status}
                  </span>
                  <span className="text-gray-400 ml-2 text-xs">
                    v{p.version ?? 1} · {new Date(p.created_at).toLocaleString('zh-CN')}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => navigate(`/admin/plans/${p.id}`)}
                    className="px-2 py-1 text-xs border border-warm-grey/50 rounded-lg text-gray-600 hover:bg-warm-beige/40 transition"
                  >
                    编辑
                  </button>
                  {p.status === 'draft' && (
                    <button
                      onClick={() => handlePublish(p.id)}
                      disabled={busyId === `publish:${p.id}`}
                      className="px-2 py-1 text-xs bg-sage text-white rounded-lg disabled:opacity-40 hover:bg-olive-green transition"
                    >
                      {busyId === `publish:${p.id}` ? '发布中...' : '发布'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 5. 危险操作：删除客户 */}
      //
      // 放在页面**最底下**、且要**点两次**才真的删 —— 删掉的是这个人的
      // 全部方案、打卡、卡点与 1v1 记录，不可撤销。
      //
      // 「会话保留，只解除挂载」：会话里是来访者自己的对话，不跟着档案
      // 一起消失。
      {client.external_id ? (
        <section className="bg-white rounded-xl border border-warm-grey/20 shadow p-4">
          <h3 className="font-bold text-gray-800 mb-2">5. 停用</h3>
          <p className="text-xs text-gray-500 leading-relaxed">
            这个客户来自游民纪元（真实付费用户），不能在这里删除 ——
            删了身份映射就断了。要停用就在上面「编辑资料」里把状态改成
            「已归档」。
          </p>
        </section>
      ) : (
        <section className="bg-white rounded-xl border border-red-200 shadow p-4">
          <h3 className="font-bold text-gray-800 mb-2">5. 删除客户</h3>
          {!showDelete ? (
            <div className="flex items-center gap-3">
              <p className="text-xs text-gray-500 leading-relaxed flex-1">
                会连同这个客户的方案、打卡记录、卡点、1v1 记录一起删掉，
                <strong className="text-red-500">不可撤销</strong>。
                会话保留（只解除挂载）。名字若是「已归档」状态，也建议直接删。
              </p>
              <button
                onClick={() => setShowDelete(true)}
                className="px-3 py-1 border border-red-200 rounded-lg text-xs text-red-500 hover:bg-red-50 transition shrink-0"
              >
                删除客户
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-red-500 leading-relaxed">
                真的要删「{client.display_name}」？
                {plans.length > 0 && ` 现在有 ${plans.length} 份方案、`}
                {stuckPoints.length > 0 && `${stuckPoints.length} 条卡点、`}
                {sessions.length > 0 && `${sessions.length} 条 1v1 记录`}
                会被一起删掉。这一步不可撤销。
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={busyId === 'delete'}
                  className="px-3 py-1 bg-red-500 text-white rounded-lg text-xs disabled:opacity-40 hover:bg-red-600 transition"
                >
                  {busyId === 'delete' ? '删除中...' : '确认删除'}
                </button>
                <button
                  onClick={() => setShowDelete(false)}
                  disabled={busyId === 'delete'}
                  className="px-3 py-1 border border-warm-grey/50 rounded-lg text-xs text-gray-600 hover:bg-warm-beige/40 transition"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
