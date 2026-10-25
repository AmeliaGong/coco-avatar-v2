import { useState, useCallback, useEffect, useRef } from 'react';
import { streamChat, getConversation, type Message } from '../lib/api';

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
      // 只发**这一轮**新说的话 —— 不再把整段对话重发一遍。
      //
      // 为什么不再重发：
      //   - 重发的那份是**冗余**的：服务端库里已经存着完整的对话
      //     （每一轮的 user 与 assistant 都落库），模型看到的上下文
      //     由服务端从库里重建 —— 和从前一样完整。
      //   - 重发的那份会让**请求体随对话一起变长**：线上就发生过 ——
      //     那个来访者的会话涨到 103,192 字节，超过 express.json() 的默认
      //     上限（100kb）⇒ 请求在**解析阶段**就被挡掉，路由都进不去，
      //     前端只能显示「抱歉，我现在遇到了一些技术问题。」
      //   - 顺带：那份重发是**调用方可以伪造**的（假的历史进得了模型上下文）。
      //
      // 第一轮（还没有 conversation_id）把首屏问候语带上 —— 那一轮发给
      // 模型的请求体与从前逐字节相同（问候语从来没落过库）。
      const chatMessages: Message[] = [];
      if (!convId) {
        const greeting = messagesRef.current[0];
        if (greeting && greeting.role === 'assistant' && greeting.content.trim() !== '') {
          chatMessages.push({ role: 'assistant', content: greeting.content });
        }
      }
      chatMessages.push({ role: 'user', content: userMessage });

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
