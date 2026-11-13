interface QuickAction {
  label: string;
  message: string;
  /**
   * 这一条对话要走的场景。
   *
   * - `chat` ＝ 通用对话（底座 + scenario.chat）
   * - `story` ＝ 故事线（Coco 的四段故事 → 探索者故事 → CBT 练习 / 微创业想法）
   *
   * ⚠️ **场景是「粘」的**：用户一旦点了「听听 Coco 和探索者们的故事」，
   * 整个会话就留在 story 场景里（故事要一段一段讲，不能中途掉回通用对话）。
   */
  scenario: 'chat' | 'story';
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
    scenario: 'chat',
  },
  {
    label: '我有一个微创业想法',
    // ⚠️ 这条**故意把指令带在用户的话里**：微创业还没有专门的 prompt
    // （prompt 不改），所以「用跨学科的方式提问」这句话本身就是给 Coco 的指令。
    message:
      '我有一个微创业的想法，想请你用跨学科的方式对我这个想法提问，帮我拿到决策上的突破。',
    scenario: 'chat',
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
