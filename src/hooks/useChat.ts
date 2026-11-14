import { useState, useCallback, useEffect, useRef } from 'react';
import { streamChat, getConversation, type ChatScenario, type Message } from '../lib/api';

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

  // 当前会话走哪个场景。
  //
  // ⚠️ **粘的**：用户点了「听听 Coco 和探索者们的故事」之后，整个会话留在
  // story 场景（故事要一段一段讲，中途掉回通用对话会把故事线打断）。
  // 用 ref 存是因为 sendMessage 里要**立刻**读到最新值 —— setState 是异步的，
  // 同一轮里读 state 会拿到旧值。
  const scenarioRef = useRef<ChatScenario>('chat');

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
      // ⚠️ **刷新/重进要把场景找回来**。场景存在库里的 conversations.scenario，
      // 不恢复的话，用户在故事线讲了一半刷新一下，下一轮就掉回 chat
      // （chat 的 prompt 开头是「故事模式」，等于把故事线搅乱）。
      if (conv.scenario && conv.scenario !== 'chat') {
        scenarioRef.current = conv.scenario as ChatScenario;
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

  const sendMessage = useCallback(async (userMessage: string, scenario?: ChatScenario) => {
    // 场景一旦被指定就定下来（后面几轮都沿用）。
    if (scenario) {
      scenarioRef.current = scenario;
    }
    const activeScenario = scenarioRef.current;

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
      for await (const chunk of streamChat(chatMessages, convId, activeScenario)) {
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
