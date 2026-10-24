import { useState, useCallback, useEffect, useRef } from 'react';
import { streamChat, getConversation } from '../lib/api';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function useChat(initialMessage: string, conversationId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: initialMessage },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [convId, setConvId] = useState<string | undefined>(conversationId);
  const [expired, setExpired] = useState(false);
  const messagesRef = useRef(messages);

  // Keep ref updated
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Load existing conversation messages
  useEffect(() => {
    if (!conversationId) return;
    getConversation(conversationId).then(conv => {
      if (!conv) {
        setExpired(true);
        return;
      }
      if (conv.messages && conv.messages.length > 0) {
        const loaded: ChatMessage[] = conv.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
        if (loaded.length > 0) {
          setMessages([{ role: 'assistant', content: initialMessage }, ...loaded]);
        }
      }
    });
  }, [conversationId]);

  const sendMessage = useCallback(async (userMessage: string) => {
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    try {
      // Use ref to get latest messages
      const currentMessages = messagesRef.current;
      const chatMessages = [
        ...currentMessages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMessage },
      ];

      let fullResponse = '';
      for await (const chunk of streamChat(chatMessages, convId)) {
        fullResponse += chunk;
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1] = {
            role: 'assistant',
            content: fullResponse,
          };
          return newMessages;
        });
      }

      // Pick up auto-created conversation ID
      if (!convId) {
        const newId = (streamChat as any)._lastConversationId;
        if (newId) setConvId(newId);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages(prev => {
        const newMessages = [...prev];
        newMessages[newMessages.length - 1] = {
          role: 'assistant',
          content: '抱歉，我现在遇到了一些技术问题。请稍后再试。',
        };
        return newMessages;
      });
    } finally {
      setIsLoading(false);
    }
  }, [convId]);

  return { messages, sendMessage, isLoading, conversationId: convId, expired };
}
