import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { QuickActions } from './QuickActions';
import type { ChatMessage } from '../hooks/useChat';

interface ChatAreaProps {
  messages: ChatMessage[];
  /**
   * 快捷入口被点了。
   *
   * 第二个参数是**场景**：点「听听 Coco 和探索者们的故事」会给 'story'，
   * 其余是 'chat'。场景由 useChat 记着（粘的），后面的轮次都沿用。
   */
  onQuickAction: (message: string, scenario: 'chat' | 'story') => void;
  showQuickActions: boolean;
}

export function ChatArea({ messages, onQuickAction, showQuickActions }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    // ⚠ `min-h-0`：flex 子项默认 `min-height: auto`（= 内容高度），
    // 不给它放开的话，消息一多就把整列撑高 ⇒ 输入框被顶出屏幕。
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6 bg-gradient-to-b from-warm-beige/20 to-white">
      <div className="max-w-4xl mx-auto">
        {messages.map((message, index) => (
          <MessageBubble key={index} role={message.role} content={message.content} />
        ))}
        {showQuickActions && <QuickActions onSelect={onQuickAction} />}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
