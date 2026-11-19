import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { Header } from '../components/Header';
import { ChatArea } from '../components/ChatArea';
import { InputArea } from '../components/InputArea';
import { useChat } from '../hooks/useChat';
import type { ChatScenario } from '../lib/api';

const WELCOME_MESSAGE = `你好，我是 Coco。

我曾经在阿里做着别人羡慕的工作，却每天拖着身体去上班。后来我飞到了挪威，用 2 年 Gap Year 找到了自己真正想做的事，在大理创办了 WeStream 人生学校。

现在，我想用 5-8 分钟的时间，陪你做一件小事——听我和几位探索者的故事，做一次认知小练习，或者从一个你正琢磨的微创业想法开始。

你想从哪个开始？`;

interface ChatPageProps {
  /**
   * 外部建好的会话 id。
   *
   * 什么时候需要它：会话是**先创建、后进页面**的时候（体验入口）。
   * `/c/:id` 那条路由的 id 是后端建好的链接带来的；体验入口没有那种链接，
   * 所以自己 POST /api/conversations 造一个再传进来。
   */
  conversationId?: string;
  /**
   * 进页面就自动发的第一条话（带场景）。
   *
   * 体验入口用：第一轮就把 3 位探索者摆出来，省得先听四段 Coco 的故事。
   */
  autoStart?: { message: string; scenario: ChatScenario };
}

export function ChatPage({ conversationId: idProp, autoStart }: ChatPageProps) {
  const { id: routeId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const id = idProp ?? routeId;
  const { messages, sendMessage, isLoading, expired } = useChat(WELCOME_MESSAGE, id);
  const autoSentRef = useRef(false);

  useEffect(() => {
    if (expired) navigate('/expired', { replace: true });
  }, [expired, navigate]);

  // Auto-send initial message passed from LandingPage
  useEffect(() => {
    const initialMessage = (location.state as { initialMessage?: string } | null)?.initialMessage;
    if (initialMessage && messages.length === 1 && !isLoading && !autoSentRef.current) {
      autoSentRef.current = true;
      sendMessage(initialMessage);
    }
  }, [messages.length, isLoading]);

  // 体验入口：进页面就自动发第一条（**带场景** —— 不带的话会走 chat 场景）。
  useEffect(() => {
    if (autoStart && messages.length === 1 && !isLoading && !autoSentRef.current) {
      autoSentRef.current = true;
      sendMessage(autoStart.message, autoStart.scenario);
    }
  }, [autoStart, messages.length, isLoading]);

  const showQuickActions = messages.length === 1 && !isLoading && !autoSentRef.current;

  return (
    <div className="flex flex-col h-screen bg-warm-beige/10">
      <Header />
      <ChatArea
        messages={messages}
        onQuickAction={(message, scenario) => sendMessage(message, scenario)}
        showQuickActions={showQuickActions}
      />
      <InputArea onSend={sendMessage} disabled={isLoading} />
    </div>
  );
}
