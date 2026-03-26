import { marked } from 'marked';
import { useMemo } from 'react';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const html = useMemo(() => {
    if (role === 'assistant') {
      return marked.parse(content) as string;
    }
    return '';
  }, [content, role]);

  const isUser = role === 'user';

  return (
    <div
      className={`flex gap-3 mb-4 animate-fade-in ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
      style={{
        animation: 'fadeIn 0.4s ease-in',
      }}
    >
      {!isUser && (
        <img
          src="/images/coco-avatar.png"
          alt="Coco"
          className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-sm ring-1 ring-warm-grey/20"
        />
      )}
      <div
        className={`max-w-[85%] sm:max-w-[70%] rounded-2xl px-4 py-3 shadow-sm ${
          isUser
            ? 'bg-gradient-to-br from-sage to-olive-green text-white'
            : 'bg-white border border-warm-grey/20'
        }`}
      >
        {isUser ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
        ) : (
          <div
            className="text-sm leading-relaxed text-gray-800 prose prose-sm max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
}
