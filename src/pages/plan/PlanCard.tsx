// 用户端方案页里的「一张卡」。
//
// 一张卡写清五件事：第几天、用哪个方法、今天什么情景、想改掉哪个念头、做什么。
// 当前那张展开，其余折叠 —— 14 张卡全展开会把页面撑到没法看。
//
// **这一层只负责渲染**，不负责取数：数据在 PlanPage，展开/折叠状态也归 PlanPage。

import type { ReactNode } from 'react';

export interface PlanCardData {
  id: string;
  day: number | null;
  title: string;
  intent: string;
  action: string;
  evidence_prompt: string;
  success_criteria: string;
  circle?: string | null;
  scenario?: string | null;
  target_belief?: string | null;
  done?: boolean;
  evidence_count?: number;
}

interface PlanCardProps {
  card: PlanCardData;
  index: number;
  total: number;
  /** 是不是「今天该做的那张」 */
  isCurrent: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** 展开后的额外内容（回填表单等） */
  children?: ReactNode;
}

export function PlanCard({
  card,
  index,
  total,
  isCurrent,
  expanded,
  onToggle,
  children,
}: PlanCardProps) {
  const day = card.day ?? index + 1;
  const done = !!card.done;

  return (
    <div
      className={`rounded-2xl border shadow-sm overflow-hidden ${
        isCurrent ? 'border-sage bg-white' : 'border-warm-grey/30 bg-white/70'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-4 space-y-1 touch-auto"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>
            第 {day} 天 / 共 {total} 天
          </span>
          {done && <span className="text-sage">已完成</span>}
          {isCurrent && !done && <span className="text-sage">今天做这个</span>}
        </div>
        <h3 className="text-sm font-bold text-gray-800">{card.title}</h3>
        {/* 圈 = 今天用的方法；情景 = 今天切入的那个场面；靶子 = 想改掉的那个念头。 */}
        {card.circle && <p className="text-xs text-gray-500">今天用的方法：{card.circle}</p>}
        {card.scenario && <p className="text-xs text-gray-500">今天的情境：{card.scenario}</p>}
        {card.target_belief && (
          <p className="text-xs text-gray-400">想改掉的那个念头：{card.target_belief}</p>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-warm-grey/20 pt-3">
          {card.action && (
            <div>
              <p className="text-xs text-gray-400 mb-1">今天做什么</p>
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{card.action}</p>
            </div>
          )}
          {card.intent && (
            <div>
              <p className="text-xs text-gray-400 mb-1">做这一步是为了看什么</p>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{card.intent}</p>
            </div>
          )}
          {card.success_criteria && (
            <div>
              <p className="text-xs text-gray-400 mb-1">做到什么算完成</p>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{card.success_criteria}</p>
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
