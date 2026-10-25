// 用户端方案页 —— 给来访者本人看的。
//
// 三件事：
//   1. 今天做哪张卡（方案页顶部那一张展开，其余折叠）
//   2. 做完写一句（打卡回填）
//   3. 我走到哪儿了（第 N / 共 M 天、连续天数、已写下的记录）
//
// **这一页不出现任何教练内部术语** —— 「诊断」「信念系统」「靶子」这些东西
// 在这里是用户的日常语言：想改掉的那个念头、这一期想变好的部分。
//
// **绝不显示 clients.notes**（教练私有备注）。后端已经过滤，前端也不去找。

import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  userGetPlan,
  userStartPlan,
  userSubmitEvidence,
  type UserPlanResponse,
} from '../../lib/api';
import { PlanCard, type PlanCardData } from './PlanCard';

interface BeliefSystem {
  core_new?: string | null;
  peripheral?: Array<{ name?: string; statement?: string; new_voice?: string }> | null;
  deferred?: string[] | null;
}

/**
 * 进度数字。
 *
 * 后端 Task 6 算出来的是 `{ total, completed, ratio, streak_days }`；
 * src/lib/api.ts 里的类型写的是 `{ done, total, percent, streak }`。
 * 两边字段名对不上（见报告），这里两种都读，谁给什么算什么 ——
 * 前端不能因为一个字段名对不上就显示不出进度。
 */
function readProgress(progress: UserPlanResponse['progress']) {
  const raw = progress as any;
  const total = typeof raw?.total === 'number' ? raw.total : 0;
  const completed =
    typeof raw?.completed === 'number'
      ? raw.completed
      : typeof raw?.done === 'number'
        ? raw.done
        : 0;
  const ratio =
    typeof raw?.ratio === 'number'
      ? raw.ratio
      : typeof raw?.percent === 'number'
        ? raw.percent
        : total > 0
          ? completed / total
          : 0;
  const streak =
    typeof raw?.streak_days === 'number'
      ? raw.streak_days
      : typeof raw?.streak === 'number'
        ? raw.streak
        : 0;
  return { total, completed, ratio, streak };
}

function toCardData(p: any): PlanCardData {
  return {
    id: String(p.id),
    day: typeof p.day === 'number' ? p.day : null,
    title: p.title || '练习',
    intent: p.intent || '',
    action: p.action || '',
    evidence_prompt: p.evidence_prompt || '',
    success_criteria: p.success_criteria || '',
    circle: p.circle ?? null,
    scenario: p.scenario ?? null,
    target_belief: p.target_belief ?? null,
    done: !!p.done,
    evidence_count: typeof p.evidence_count === 'number' ? p.evidence_count : 0,
  };
}

export function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [view, setView] = useState<UserPlanResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = () => {
    if (!id) return;
    setLoadError('');
    userGetPlan(id)
      .then(setView)
      .catch((e) => {
        setLoadError((e as Error).message);
        setView(null);
      });
  };

  useEffect(load, [id]);

  const cards = useMemo<PlanCardData[]>(
    () => (view?.practices || []).map(toCardData),
    [view]
  );

  /** 当前该做的那张 —— 取后端指的 current_practice，但用完整卡片数据（带圈/情景/念头）。 */
  const currentCard = useMemo<PlanCardData | null>(() => {
    if (!view?.current_practice) return null;
    const full = cards.find((c) => c.id === view.current_practice!.id);
    return full || toCardData(view.current_practice);
  }, [view, cards]);

  const progress = readProgress(view?.progress);
  const isPending = view?.status === 'pending_activation';
  const isActive = view?.status === 'active';
  const isAllDone = progress.total > 0 && progress.completed >= progress.total;

  /**
   * 「这一期只交付诊断」—— 练习列表是空的。
   *
   * 契约 2 允许 `worth_practicing: false`：模型判断这位来访者现在最需要的
   * 不是长期练习。那种方案**不是坏数据**，但不能显示成「给你准备了一份
   * 练习」再让人点「开始练习」—— 点了之后没有卡可做、也没法打卡，死路。
   *
   * 判断用两个信号（任一成立即是）：后端说 worth_practicing=false，
   * 或者这张方案确实一张卡都没有。
   */
  const isDiagnosisOnly = view?.worth_practicing === false || cards.length === 0;

  // 展开状态：默认展开今天那张；用户手动点开别的卡时以用户为准。
  const expandedId = openId ?? currentCard?.id ?? null;

  const handleStart = async () => {
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      setView(await userStartPlan(id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !currentCard || !answer.trim()) return;
    setBusy(true);
    setError('');
    try {
      setView(await userSubmitEvidence(id, currentCard.id, answer.trim()));
      setAnswer('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full px-3 py-2 border border-warm-grey/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage/40';

  if (loadError) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-warm-beige/10 gap-3 px-6">
        <p className="text-gray-500 text-sm">打不开这份方案：{loadError}</p>
        <Link to={`/c/${id}`} className="px-4 py-2 bg-sage text-white rounded-lg text-sm">
          回到对话
        </Link>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="h-screen flex items-center justify-center bg-warm-beige/10 text-gray-400">
        加载中...
      </div>
    );
  }

  if (!view.has_plan) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-warm-beige/10 gap-3 px-6">
        <p className="text-gray-500">还没有给你安排练习。</p>
        <Link to={`/c/${id}`} className="px-4 py-2 bg-sage text-white rounded-lg text-sm">
          回到对话
        </Link>
      </div>
    );
  }

  const beliefSystem = (view.diagnosis?.belief_system || null) as BeliefSystem | null;
  const evidences = view.evidences || [];

  return (
    <div className="h-screen flex flex-col bg-warm-beige/10">
      {/* 全局 html/body 是 overflow:hidden —— 页面必须自建滚动容器 */}
      <div className="flex-1 min-h-0 overflow-y-auto touch-auto">
        <div className="max-w-2xl mx-auto px-5 py-8 space-y-6">
          <button
            onClick={() => navigate(`/c/${id}`)}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← 回到对话
          </button>

          {/* 状态条 */}
          <section className="bg-white rounded-2xl border border-warm-grey/20 shadow-sm p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs px-2 py-0.5 rounded-full bg-sage/20 text-sage shrink-0">
                {isPending ? '还没开始' : isAllDone ? '这一轮完成了' : isActive ? '进行中' : '准备中'}
              </span>
              {progress.total > 0 && (
                <span className="text-xs text-gray-500">
                  {isAllDone
                    ? `已完成 ${progress.completed} / ${progress.total} 天`
                    : `第 ${progress.completed + 1} / ${progress.total} 天`}
                </span>
              )}
            </div>
            {progress.total > 0 && (
              <>
                <div className="h-1.5 rounded-full bg-warm-grey/40 overflow-hidden">
                  <div
                    className="h-full bg-sage transition-all"
                    style={{ width: `${Math.round(progress.ratio * 100)}%` }}
                  />
                </div>
                <div className="text-xs text-gray-400">
                  已完成 {progress.completed}/{progress.total} · 连续 {progress.streak} 天
                </div>
              </>
            )}
          </section>

          {/* 愿景 */}
          {view.vision && (
            <section className="bg-white rounded-2xl shadow-sm border border-warm-grey/20 p-6">
              <div className="text-xs text-gray-400 mb-1">你要走向的样子</div>
              <h1 className="text-xl font-bold text-gray-800">{view.vision.title}</h1>
              <p className="text-gray-600 mt-3 whitespace-pre-wrap leading-relaxed">
                {view.vision.narrative}
              </p>
            </section>
          )}

          {/* 这一期想变好的部分 */}
          {beliefSystem && (
            <section className="bg-white rounded-2xl border border-warm-grey/20 shadow-sm p-4 space-y-3">
              <h3 className="text-sm font-bold text-gray-800">这一期想变好的部分</h3>
              {beliefSystem.core_new && (
                <p className="text-sm text-gray-700">
                  <span className="text-gray-400 text-xs mr-2">想长出来的念头</span>
                  {beliefSystem.core_new}
                </p>
              )}
              {beliefSystem.peripheral && beliefSystem.peripheral.length > 0 && (
                <div>
                  <span className="text-gray-400 text-xs">这几条具体念头</span>
                  <ul className="mt-1 space-y-1">
                    {beliefSystem.peripheral.map((p, i) => (
                      <li key={i} className="text-sm text-gray-700">
                        <span className="font-medium">{p.name}</span>
                        {p.statement && <span className="text-gray-500"> — {p.statement}</span>}
                        {p.new_voice && (
                          <span className="block text-xs text-sage mt-0.5">
                            换成这句话：{p.new_voice}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {beliefSystem.deferred && beliefSystem.deferred.length > 0 && (
                <div>
                  <span className="text-gray-400 text-xs">这一期先不碰</span>
                  <ul className="mt-1 list-disc list-inside text-sm text-gray-500">
                    {beliefSystem.deferred.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* 还没开始 */}
          {isPending && (
            <section className="bg-white rounded-2xl shadow-sm border border-warm-grey/20 p-6 text-center space-y-4">
              {isDiagnosisOnly ? (
                <>
                  <p className="text-gray-700">这一期先只做诊断，暂时不用打卡。</p>
                  <p className="text-sm text-gray-500">
                    教练会在对话里跟你一起过一遍这次看到的东西 ——
                    等练习准备好了，这里会出现今天要做的卡。
                  </p>
                </>
              ) : (
                <>
                  <p className="text-gray-700">给你准备了一份练习，随时可以开始。</p>
                  {view.diagnosis?.core_belief && (
                    <p className="text-sm text-gray-500">
                      这次主要松动的是：{view.diagnosis.core_belief}
                    </p>
                  )}
                  <button
                    onClick={handleStart}
                    disabled={busy}
                    className="px-6 py-2.5 bg-sage text-white rounded-xl text-sm disabled:opacity-40 hover:bg-olive-green transition"
                  >
                    开始练习
                  </button>
                </>
              )}
            </section>
          )}

          {isActive && isAllDone && (
            <section className="bg-white rounded-2xl shadow-sm border border-warm-grey/20 p-6">
              <p className="text-gray-700">
                这一轮练习都做完了。你可以在对话里跟我说说它的感觉。
              </p>
            </section>
          )}

          {/* 已开始、但这一期没有练习可做 —— 说清楚，而不是留一个空页 */}
          {isActive && isDiagnosisOnly && (
            <section className="bg-white rounded-2xl shadow-sm border border-warm-grey/20 p-6">
              <p className="text-gray-700">这一期先只做诊断，暂时不用打卡。</p>
              <p className="text-sm text-gray-500 mt-2">
                教练会在对话里跟你一起过一遍这次看到的东西 ——
                等练习准备好了，这里会出现今天要做的卡。
              </p>
            </section>
          )}

          {/* 14 张卡：今天那张展开，其余折叠 */}
          {cards.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-bold text-gray-700">
                这一轮的练习（共 {cards.length} 天）
              </h3>
              {cards.map((card, i) => {
                const isCurrent = currentCard?.id === card.id;
                return (
                  <PlanCard
                    key={card.id}
                    card={card}
                    index={i}
                    total={cards.length}
                    isCurrent={isCurrent}
                    expanded={isCurrent || expandedId === card.id}
                    onToggle={() => setOpenId(openId === card.id ? null : card.id)}
                  >
                    {isCurrent && isActive && !isAllDone && (
                      <form onSubmit={handleSubmit} className="space-y-2 pt-1">
                        <label className="block text-sm text-gray-700">
                          {card.evidence_prompt || '做完之后，写下你注意到了什么'}
                        </label>
                        <textarea
                          value={answer}
                          onChange={(e) => setAnswer(e.target.value)}
                          rows={3}
                          placeholder="只写事实：发生了什么、你的感受"
                          className={field}
                        />
                        {error && <p className="text-red-500 text-sm">{error}</p>}
                        <button
                          type="submit"
                          disabled={busy || !answer.trim()}
                          className="px-5 py-2 bg-sage text-white rounded-lg text-sm disabled:opacity-40 hover:bg-olive-green transition"
                        >
                          写下这一条
                        </button>
                      </form>
                    )}
                  </PlanCard>
                );
              })}
            </section>
          )}

          {/* 我写下的记录 */}
          {evidences.length > 0 && (
            <section className="bg-white rounded-2xl shadow-sm border border-warm-grey/20 p-6">
              <h3 className="text-sm font-bold text-gray-700 mb-3">你写下的</h3>
              <ul className="space-y-3">
                {evidences.map((ev) => (
                  <li key={ev.id} className="text-sm">
                    <div className="text-gray-700 whitespace-pre-wrap">{ev.content}</div>
                    <div className="text-xs text-gray-400">
                      {new Date(ev.created_at).toLocaleString('zh-CN')}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 链接即凭证（增补 I.2）——
              这一页的访问凭证就是**这个链接本身**：没有账号、没有二次验证。
              拿到链接的人能读这份方案、能打卡。所以必须让来访者自己知道
              别转发 —— 否则是「替他做决定」。 */}
          <p className="text-xs text-gray-400 text-center leading-relaxed">
            这个链接就是你的凭证 —— 谁拿到它，谁就能看这份方案。
            <br />
            别转发给别人。
          </p>
        </div>
      </div>
    </div>
  );
}
