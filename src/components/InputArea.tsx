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
      className="border-t border-warm-grey/30 bg-white px-4 py-4 shadow-lg"
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
            const target = e.target as HTMLTextAreaElement;
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
