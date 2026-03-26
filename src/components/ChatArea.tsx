import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { QuickActions } from './QuickActions';
import type { ChatMessage } from '../hooks/useChat';

interface ChatAreaProps {
  messages: ChatMessage[];
  onQuickAction: (message: string) => void;
  showQuickActions: boolean;
}

export function ChatArea({ messages, onQuickAction, showQuickActions }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 bg-gradient-to-b from-warm-beige/20 to-white">
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
