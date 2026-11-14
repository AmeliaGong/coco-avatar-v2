import type { ChatScenario } from '../lib/api';

interface QuickAction {
  label: string;
  message: string;
  /**
   * 这一条对话要走的场景。
   *
   * - `story` ＝ 故事线（Coco 的四段故事 → 探索者故事 → CBT 练习 / 微创业想法）
   * - `cbt_quick` ＝ 认知急救箱（5 步 CBT 小练习）
   * - `idea`   ＝ 微创业想法线（只提问，不讲故事）
   *
   * ⚠️ **三个入口必须是三个不同的场景**：
   * `chat`（通用对话）的 prompt 开头就是「【故事模式】+ Coco 的故事素材」，
   * 让②③走 chat ⇒ 真模型会照着讲起故事来（本地预览时真的复现过）。
   *
   * ⚠️ **场景是「粘」的**：用户一旦点了某个入口，
   * 整个会话就留在那个场景里（故事要一段一段讲，不能中途掉回通用对话）。
   */
  scenario: ChatScenario;
}

interface QuickActionsProps {
  onSelect: (message: string, scenario: QuickAction['scenario']) => void;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: '听听 Coco 和探索者们的故事',
    // 这句话**不动** —— 它是场景自己的开场（"我想了解 WeStream 和你的故事"）。
    message: '我想了解 WeStream 和你的故事',
    scenario: 'story',
  },
  {
    label: '我想做出改变但遇到卡点',
    message: '我想做出改变但遇到卡点，可以带我做一次练习吗？',
    // ⚠️ 走 cbt_quick（认知急救箱），**不走 chat** —— chat 的 prompt 以「故事模式」开头。
    scenario: 'cbt_quick',
  },
  {
    label: '我有一个微创业想法',
    // ⚠️ 这条**故意把指令带在用户的话里**：即使 prompt 已经有专门的
    // 「一次只问一个问题 + 跨学科视角」，把用户的话也带上，
    // 第一轮就能对上号（prompt 不会被误当成通用闲聊）。
    message:
      '我有一个微创业的想法，想请你用跨学科的方式对我这个想法提问，帮我拿到决策上的突破。',
    // ⚠️ 走 idea（prompts/scenario.idea.md），**不走 chat** —— chat 的 prompt
    // 开头是「【故事模式】+ Coco 的 9 段故事素材」，模型会先去讲故事。
    scenario: 'idea',
  },
];

export function QuickActions({ onSelect }: QuickActionsProps) {
  return (
    <div className="flex flex-col gap-3 mb-6 animate-fade-in">
      <p className="text-sm text-gray-600 text-center mb-2">或者选择一个话题开始</p>
      {QUICK_ACTIONS.map((action) => (
        <button
          key={action.label}
          onClick={() => onSelect(action.message, action.scenario)}
          className="w-full px-6 py-3 bg-white border border-warm-grey/40 rounded-full text-sm text-gray-800 font-medium hover:bg-warm-beige/30 hover:border-sage/50 transition-all duration-300 shadow-sm hover:shadow-md"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
