interface QuickActionsProps {
  onSelect: (message: string) => void;
}

const QUICK_ACTIONS = [
  { label: '听听 Coco 的故事', message: '我想了解 WeStream 和你的故事' },
  { label: '我想做出改变但遇到卡点', message: '我想做出改变但遇到卡点，可以带我做一次练习吗？' },
  { label: '体验 10 倍决策力', message: '我想体验一下跨学科提问的力量' },
];

export function QuickActions({ onSelect }: QuickActionsProps) {
  return (
    <div className="flex flex-col gap-3 mb-6 animate-fade-in">
      <p className="text-sm text-gray-600 text-center mb-2">或者选择一个话题开始</p>
      {QUICK_ACTIONS.map((action) => (
        <button
          key={action.label}
          onClick={() => onSelect(action.message)}
          className="w-full px-6 py-3 bg-white border border-warm-grey/40 rounded-full text-sm text-gray-800 font-medium hover:bg-warm-beige/30 hover:border-sage/50 transition-all duration-300 shadow-sm hover:shadow-md"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
