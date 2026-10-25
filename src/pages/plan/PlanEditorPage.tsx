// 方案编辑器（教练侧）—— 素材 / 结构化表单 / 预览 三栏。
//
// 三栏各管一件事：
//   左「素材」：这一轮依据的东西 —— 1v1 咨询记录、来访者说过的话、已经回填的证据。
//   中「结构化表单」：方案本身 —— 诊断、愿景、练习项。改完「保存」写回 payload。
//   右「预览」：用户端会看到的样子（跟 PlanPage 同一套结构）。
//
// **两套内容各有一个真相源，不要混：**
//   - 方案内容（诊断/愿景/练习的标题与动作）存在 plans.payload，保存时整体覆盖。
//   - 每条练习的 circle / scenario / target_belief 存在 practices 表（执行层），
//     失焦即存 —— 因为用户端读的是 practices 行，不是 payload。
//   所以这三个字段既改 payload（保存时）也即时写行（失焦时），两边始终一致。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  adminGetPlan,
  adminUpdatePlan,
  adminUpdatePractice,
  adminPublishPlan,
  adminListSessions,
  adminListCoachMoves,
  adminGetClient,
  type DeliveryPlan,
  type DeliveryPractice,
} from '../../lib/api';

interface PracticePayload {
  day: number;
  title: string;
  intent?: string;
  action?: string;
  evidence_prompt?: string;
  success_criteria?: string;
  circle?: string | null;
  scenario?: string | null;
  target_belief?: string | null;
}

interface BeliefSystem {
  core_new?: string | null;
  peripheral?: Array<{ name?: string; statement?: string; new_voice?: string }> | null;
  deferred?: string[] | null;
}

interface PlanPayload {
  diagnosis: {
    core_belief: string;
    pattern: string;
    root_cause: string;
    belief_system?: BeliefSystem;
  };
  vision: { title: string; narrative: string; horizon: string };
  practices: PracticePayload[];
  worth_practicing: boolean;
}

interface EvidenceRow {
  id: string;
  practice_id: string;
  content: string;
  created_at: string;
  practice_title?: string;
}

interface SessionRow {
  id: string;
  transcript: string;
  created_at?: string;
}

interface StuckPoint {
  id: string;
  title: string;
  belief: string;
  emotion: string;
  micro_action: string;
}

const EMPTY_PAYLOAD: PlanPayload = {
  diagnosis: { core_belief: '', pattern: '', root_cause: '' },
  vision: { title: '', narrative: '', horizon: '1_year' },
  practices: [],
  worth_practicing: true,
};

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  pending_activation: '待用户开始',
  active: '进行中',
  archived: '已归档',
};

/** payload 里的一条练习 ↔ practices 表里的一行。
 *
 * 14 天 Circle 天然是 14 张同名卡，只按 title 匹配会把它们全对到第一行上。
 * 这里跟后端 pickPracticeMatch 同一套分级：(title, day) → title → day。
 */
function matchRows(practices: DeliveryPractice[], payload: PracticePayload[]) {
  const rows = practices.filter((r) => r.sort_order >= 0);
  const used = new Set<string>();
  return payload.map((p) => {
    const t = (p.title || '').trim();
    const d = Number.isInteger(p.day) ? p.day : null;
    let match = rows.find((r) => !used.has(r.id) && r.title === t && r.day === d);
    if (!match) match = rows.find((r) => !used.has(r.id) && r.title === t);
    if (!match && d !== null) match = rows.find((r) => !used.has(r.id) && r.day === d);
    if (match) used.add(match.id);
    return match || null;
  });
}

export function PlanEditorPage() {
  const { planId } = useParams<{ planId: string }>();
  const navigate = useNavigate();

  const [plan, setPlan] = useState<DeliveryPlan | null>(null);
  const [rows, setRows] = useState<DeliveryPractice[]>([]);
  const [evidences, setEvidences] = useState<EvidenceRow[]>([]);
  const [payload, setPayload] = useState<PlanPayload>(EMPTY_PAYLOAD);
  const [diagnosisMd, setDiagnosisMd] = useState('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [stuckPoints, setStuckPoints] = useState<StuckPoint[]>([]);
  const [moveNames, setMoveNames] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!planId) return;
    try {
      const bundle: any = await adminGetPlan(planId);
      const p: DeliveryPlan = bundle.plan;
      setPlan(p);
      setRows(bundle.practices || []);
      setEvidences(bundle.evidences || []);
      let parsed: any = {};
      try {
        parsed = JSON.parse(p.payload || '{}');
      } catch {
        parsed = {};
      }
      const parsedPractices: PracticePayload[] = Array.isArray(parsed.practices)
        ? parsed.practices
        : [];
      // payload 与 practices 行各存一份圈/情景/靶子 —— 这里以「行」为准回填进
      // payload。行是执行层（用户端读的就是它），也总是最新的一次改动；
      // 否则「保存」时 materialize 会用 payload 的旧值盖掉行里刚改好的内容。
      const rowMatches = matchRows(bundle.practices || [], parsedPractices);
      const mergedPractices = parsedPractices.map((p, i) => {
        const row = rowMatches[i];
        if (!row) return p;
        return {
          ...p,
          circle: row.circle ?? p.circle ?? null,
          scenario: row.scenario ?? p.scenario ?? null,
          target_belief: row.target_belief ?? p.target_belief ?? null,
        };
      });
      setPayload({
        diagnosis: {
          ...EMPTY_PAYLOAD.diagnosis,
          ...(parsed.diagnosis || {}),
        },
        vision: { ...EMPTY_PAYLOAD.vision, ...(parsed.vision || {}) },
        practices: mergedPractices,
        worth_practicing: parsed.worth_practicing !== false,
      });
      setDiagnosisMd(p.diagnosis_md || '');
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
      setLoaded(true);
    }
  }, [planId]);

  useEffect(() => {
    load();
  }, [load]);

  // 素材：咨询记录 + 来访者说过的卡点 + 手法库。
  // 拉不到就算了 —— 素材栏只是参考，不该挡住教练干活。
  useEffect(() => {
    let cancelled = false;
    if (!plan?.client_id) return;
    adminListSessions(plan.client_id)
      .then((r: any) => {
        if (!cancelled) setSessions(r.sessions || []);
      })
      .catch(() => {});
    adminGetClient(plan.client_id)
      .then((r: any) => {
        if (!cancelled) setStuckPoints(r?.client?.stuck_points || []);
      })
      .catch(() => {});
    adminListCoachMoves()
      .then((r: any) => {
        if (!cancelled) setMoveNames((r || []).map((m: any) => m.name).filter(Boolean));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plan?.client_id]);

  const matchedRows = useMemo(() => matchRows(rows, payload.practices), [rows, payload.practices]);
  const readOnly = !!plan && plan.status !== 'draft';

  const setPracticeField = (index: number, key: keyof PracticePayload, value: string) => {
    setPayload((prev) => {
      const practices = [...prev.practices];
      practices[index] = { ...practices[index], [key]: value };
      return { ...prev, practices };
    });
  };

  /** 单条练习的圈/情景/靶子 —— 失焦即存到 practices 行。
   *
   * 存行而不是只存 payload：用户端读的是 practices 行。
   */
  const persistPracticeRow = async (row: DeliveryPractice, patch: Partial<DeliveryPractice>) => {
    if (!planId) return;
    setBusy(true);
    setError('');
    try {
      await adminUpdatePractice(planId, row.id, patch);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!planId) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await adminUpdatePlan(planId, { payload, diagnosis_md: diagnosisMd });
      setMessage('已保存');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!planId) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await adminUpdatePlan(planId, { payload, diagnosis_md: diagnosisMd });
      await adminPublishPlan(planId);
      setMessage('已发布给用户');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full px-3 py-2 border border-warm-grey/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage/40 disabled:opacity-60';
  const label = 'block text-xs text-gray-500 mb-1';

  if (!loaded) {
    return <p className="text-gray-400">加载中...</p>;
  }
  if (!plan) {
    return (
      <div className="space-y-3">
        <p className="text-red-500 text-sm">{error || '方案不存在'}</p>
        <button onClick={() => navigate(-1)} className="text-sm text-gray-500 hover:text-gray-700">
          ← 返回
        </button>
      </div>
    );
  }

  const beliefSystem = payload.diagnosis.belief_system;

  // 自建滚动容器：全局 html/body 是 overflow:hidden，不自建容器就滚不动。
  // 挂在 admin 布局下时外层已经有滚动区，这里高度是 auto，不会多出滚动条。
  return (
    <div className="h-full overflow-y-auto touch-auto space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <button onClick={() => navigate(-1)} className="text-sm text-gray-500 hover:text-gray-700">
            ← 返回
          </button>
          <h2 className="text-lg font-bold text-gray-800 mt-1">
            方案编辑器
            <span className="ml-2 text-xs font-normal text-gray-400">
              {STATUS_TEXT[plan.status] || plan.status}
            </span>
          </h2>
        </div>
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={busy || readOnly}
            className="px-4 py-2 border border-warm-grey/50 rounded-lg text-sm disabled:opacity-40 hover:bg-warm-beige/40 transition"
          >
            保存
          </button>
          <button
            onClick={publish}
            disabled={busy || readOnly}
            className="px-4 py-2 bg-sage text-white rounded-lg text-sm disabled:opacity-40 hover:bg-olive-green transition"
          >
            发布给用户
          </button>
        </div>
      </div>

      {error && <p className="text-red-500 text-sm">{error}</p>}
      {message && <p className="text-sage text-sm">{message}</p>}
      {readOnly && (
        <p className="text-xs text-gray-400">
          方案已经不是草稿，内容不能整体改了（要改请新建一份草稿）。单条练习的圈 / 情景 / 靶子仍可微调。
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* 左：素材 */}
        <section className="bg-white rounded-xl border border-warm-grey/20 shadow p-4 space-y-4">
          <h3 className="font-bold text-gray-800 text-sm">素材</h3>

          <div>
            <h4 className="text-xs text-gray-500 mb-1">1v1 咨询记录（{sessions.length}）</h4>
            {sessions.length === 0 ? (
              <p className="text-xs text-gray-400">（还没有粘贴过咨询记录）</p>
            ) : (
              <div className="space-y-2">
                {sessions.map((s) => (
                  <details key={s.id} className="text-xs">
                    <summary className="cursor-pointer text-gray-500">
                      {s.created_at ? new Date(s.created_at).toLocaleString('zh-CN') : '一条记录'}
                    </summary>
                    <p className="text-gray-400 whitespace-pre-wrap max-h-40 overflow-y-auto mt-1">
                      {s.transcript}
                    </p>
                  </details>
                ))}
              </div>
            )}
          </div>

          <div>
            <h4 className="text-xs text-gray-500 mb-1">来访者说过的卡点（{stuckPoints.length}）</h4>
            {stuckPoints.length === 0 ? (
              <p className="text-xs text-gray-400">（没有导入卡点）</p>
            ) : (
              <ul className="space-y-1 text-xs text-gray-600 max-h-48 overflow-y-auto">
                {stuckPoints.map((sp) => (
                  <li key={sp.id}>
                    <span className="font-medium text-gray-700">{sp.title}</span>
                    {sp.belief && <span className="text-gray-500"> — {sp.belief}</span>}
                    {sp.micro_action && (
                      <span className="block text-gray-400">小动作：{sp.micro_action}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="text-xs text-gray-500 mb-1">已回填的证据（{evidences.length}）</h4>
            {evidences.length === 0 ? (
              <p className="text-xs text-gray-400">（还没有回填）</p>
            ) : (
              <ul className="space-y-1 text-xs text-gray-600 max-h-48 overflow-y-auto">
                {evidences.map((ev) => (
                  <li key={ev.id}>
                    <span className="text-gray-400">[{ev.practice_title || '练习'}]</span>{' '}
                    {ev.content}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 中：结构化表单 */}
        <section className="bg-white rounded-xl border border-warm-grey/20 shadow p-4 space-y-3">
          <h3 className="font-bold text-gray-800 text-sm">诊断</h3>
          <div>
            <label className={label}>核心限制性信念</label>
            <textarea
              disabled={readOnly}
              rows={2}
              value={payload.diagnosis.core_belief}
              onChange={(e) =>
                setPayload({
                  ...payload,
                  diagnosis: { ...payload.diagnosis, core_belief: e.target.value },
                })
              }
              className={field}
            />
          </div>
          <div>
            <label className={label}>反复出现的行为模式</label>
            <textarea
              disabled={readOnly}
              rows={2}
              value={payload.diagnosis.pattern}
              onChange={(e) =>
                setPayload({
                  ...payload,
                  diagnosis: { ...payload.diagnosis, pattern: e.target.value },
                })
              }
              className={field}
            />
          </div>
          <div>
            <label className={label}>更深一层的成因</label>
            <textarea
              disabled={readOnly}
              rows={2}
              value={payload.diagnosis.root_cause}
              onChange={(e) =>
                setPayload({
                  ...payload,
                  diagnosis: { ...payload.diagnosis, root_cause: e.target.value },
                })
              }
              className={field}
            />
          </div>

          {beliefSystem && (
            <div className="border border-warm-grey/30 rounded-lg p-2 space-y-1">
              <div className="text-xs text-gray-500">这一期的信念系统（用户端会看到）</div>
              {beliefSystem.core_new && (
                <p className="text-xs text-gray-600">核心新信念：{beliefSystem.core_new}</p>
              )}
              {beliefSystem.peripheral && beliefSystem.peripheral.length > 0 && (
                <ul className="text-xs text-gray-600 list-disc list-inside">
                  {beliefSystem.peripheral.map((p, i) => (
                    <li key={i}>
                      {p.name}
                      {p.statement ? ` — ${p.statement}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {beliefSystem.deferred && beliefSystem.deferred.length > 0 && (
                <p className="text-xs text-gray-500">
                  本期不主攻：{beliefSystem.deferred.join('、')}
                </p>
              )}
            </div>
          )}

          <h3 className="font-bold text-gray-800 text-sm pt-2">愿景</h3>
          <div>
            <label className={label}>一句话标题</label>
            <input
              disabled={readOnly}
              value={payload.vision.title}
              onChange={(e) =>
                setPayload({ ...payload, vision: { ...payload.vision, title: e.target.value } })
              }
              className={field}
            />
          </div>
          <div>
            <label className={label}>叙事（写给来访者看）</label>
            <textarea
              disabled={readOnly}
              rows={5}
              value={payload.vision.narrative}
              onChange={(e) =>
                setPayload({
                  ...payload,
                  vision: { ...payload.vision, narrative: e.target.value },
                })
              }
              className={field}
            />
          </div>
          <div>
            <label className={label}>周期</label>
            <select
              disabled={readOnly}
              value={payload.vision.horizon}
              onChange={(e) =>
                setPayload({ ...payload, vision: { ...payload.vision, horizon: e.target.value } })
              }
              className={field}
            >
              <option value="3_months">三个月</option>
              <option value="1_year">一年</option>
              <option value="life">一生</option>
            </select>
          </div>

          <h3 className="font-bold text-gray-800 text-sm pt-2">练习项（{payload.practices.length}）</h3>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={payload.worth_practicing}
              onChange={(e) => setPayload({ ...payload, worth_practicing: e.target.checked })}
            />
            这一轮安排练习（不勾选 = 只交付诊断）
          </label>

          {payload.practices.map((p, i) => {
            const row = matchedRows[i];
            return (
              <div key={i} className="border border-warm-grey/30 rounded-lg p-2 space-y-1">
                <div className="text-xs text-gray-400">
                  第 {p.day ?? i + 1} 天
                  {row ? ' · 已落库' : ' · 新增（保存后落库）'}
                </div>
                <input
                  disabled={readOnly}
                  value={p.title}
                  placeholder="标题"
                  onChange={(e) => setPracticeField(i, 'title', e.target.value)}
                  className={field}
                />
                <textarea
                  disabled={readOnly}
                  rows={2}
                  placeholder="今天就能做的具体动作"
                  value={p.action || ''}
                  onChange={(e) => setPracticeField(i, 'action', e.target.value)}
                  className={field}
                />
                <textarea
                  disabled={readOnly}
                  rows={2}
                  placeholder="回填时的引导问句"
                  value={p.evidence_prompt || ''}
                  onChange={(e) => setPracticeField(i, 'evidence_prompt', e.target.value)}
                  className={field}
                />
                <textarea
                  disabled={readOnly}
                  rows={2}
                  placeholder="做到什么算完成"
                  value={p.success_criteria || ''}
                  onChange={(e) => setPracticeField(i, 'success_criteria', e.target.value)}
                  className={field}
                />

                {/* 圈 / 情景 / 靶子 —— 教练最常改的三样。
                    失焦即存到 practices 行（用户端读的是行）。 */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                  <div>
                    <label className={label}>用哪个圈</label>
                    <input
                      list="coach-move-names"
                      value={p.circle || ''}
                      placeholder="（不指定圈）"
                      onChange={(e) => setPracticeField(i, 'circle', e.target.value)}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (row && v !== (row.circle || '')) {
                          persistPracticeRow(row, { circle: v || null });
                        }
                      }}
                      className={field}
                    />
                    <datalist id="coach-move-names">
                      {moveNames.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className={label}>今天切入的情景</label>
                    <input
                      value={p.scenario || ''}
                      placeholder="今天切入的情景"
                      onChange={(e) => setPracticeField(i, 'scenario', e.target.value)}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (row && v !== (row.scenario || '')) {
                          persistPracticeRow(row, { scenario: v || null });
                        }
                      }}
                      className={field}
                    />
                  </div>
                  <div>
                    <label className={label}>针对哪条信念</label>
                    <input
                      list="peripheral-beliefs"
                      value={p.target_belief || ''}
                      placeholder="外周信念的名字"
                      onChange={(e) => setPracticeField(i, 'target_belief', e.target.value)}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (row && v !== (row.target_belief || '')) {
                          persistPracticeRow(row, { target_belief: v || null });
                        }
                      }}
                      className={field}
                    />
                    <datalist id="peripheral-beliefs">
                      {(beliefSystem?.peripheral || []).map((per, i) => (
                        <option key={i} value={per.name || ''} />
                      ))}
                    </datalist>
                  </div>
                </div>

                {row && row.custom_data && (
                  <div>
                    <label className={label}>教练手工补充（不会被 AI 草稿覆盖）</label>
                    <textarea
                      defaultValue={row.custom_data || ''}
                      rows={2}
                      onBlur={(e) => {
                        if (e.target.value !== (row.custom_data || '')) {
                          persistPracticeRow(row, { custom_data: e.target.value });
                        }
                      }}
                      className={field}
                    />
                  </div>
                )}
              </div>
            );
          })}

          <div>
            <label className={label}>教练手写补充（Markdown）</label>
            <textarea
              disabled={readOnly}
              rows={4}
              value={diagnosisMd}
              onChange={(e) => setDiagnosisMd(e.target.value)}
              className={field}
            />
          </div>
        </section>

        {/* 右：用户端预览 */}
        <section className="bg-warm-beige/20 rounded-xl border border-warm-grey/20 p-4">
          <h3 className="font-bold text-gray-800 text-sm mb-3">用户端预览</h3>
          <div className="bg-white rounded-lg p-4 space-y-3 text-sm">
            <div>
              <div className="text-xs text-gray-400">你要走向的样子</div>
              <div className="font-semibold text-gray-800">
                {payload.vision.title || '（未填）'}
              </div>
              <p className="text-gray-600 whitespace-pre-wrap mt-1">{payload.vision.narrative}</p>
            </div>

            {beliefSystem && (
              <div>
                <div className="text-xs text-gray-400 mb-1">这一期想变好的部分</div>
                {beliefSystem.core_new && (
                  <p className="text-gray-700">想长出来的念头：{beliefSystem.core_new}</p>
                )}
                {beliefSystem.deferred && beliefSystem.deferred.length > 0 && (
                  <p className="text-xs text-gray-500">
                    这一期先不碰：{beliefSystem.deferred.join('、')}
                  </p>
                )}
              </div>
            )}

            {payload.worth_practicing ? (
              <div>
                <div className="text-xs text-gray-400 mb-1">
                  这一轮的练习（共 {payload.practices.length} 天）
                </div>
                <ul className="space-y-2">
                  {payload.practices.map((p, i) => (
                    <li key={i} className="border-l-2 border-sage pl-2">
                      <div className="font-medium text-gray-800">
                        第 {p.day ?? i + 1} 天 · {p.title}
                      </div>
                      {p.circle && <div className="text-xs text-gray-500">方法：{p.circle}</div>}
                      {p.scenario && <div className="text-xs text-gray-500">情景：{p.scenario}</div>}
                      {p.target_belief && (
                        <div className="text-xs text-gray-400">想改掉的念头：{p.target_belief}</div>
                      )}
                      <div className="text-gray-600 whitespace-pre-wrap">{p.action}</div>
                      {p.success_criteria && (
                        <div className="text-xs text-gray-400">
                          做到什么算完成：{p.success_criteria}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-gray-500">这一轮只交付诊断，不安排练习。</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
