import { useState, FormEvent, KeyboardEvent } from 'react';

interface InputAreaProps {
  onSend: (message: string) => void;
  disabled: boolean;
}

export function InputArea({ onSend, disabled }: InputAreaProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      onSend(input.trim());
      setInput('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      // ⚠ `shrink-0`：输入框是整页唯一能发消息的地方，绝不能被消息区挤扁。
      // ⚠ 底部留出 iPhone 的 home indicator（safe-area），
      //   否则输入框的最下面那条会被系统横条盖住、点不到发送键。
      className="shrink-0 border-t border-warm-grey/30 bg-white px-4 pt-4 shadow-lg"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <div className="max-w-4xl mx-auto flex gap-3 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="分享你正在经历的..."
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-2xl border border-warm-grey/30 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-sage/50 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400 bg-warm-beige/10"
          style={{ minHeight: '48px', maxHeight: '120px' }}
          onInput={(e) => {
            const target = e.currentTarget as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = Math.min(target.scrollHeight, 120) + 'px';
          }}
        />
        <button
          type="submit"
          disabled={disabled || !input.trim()}
          className="px-6 py-3 bg-gradient-to-r from-sage to-olive-green text-white rounded-2xl text-sm font-medium hover:shadow-md transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none"
        >
          发送
        </button>
      </div>
    </form>
  );
}
