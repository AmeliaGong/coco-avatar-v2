import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { Header } from '../components/Header';
import { ChatArea } from '../components/ChatArea';
import { InputArea } from '../components/InputArea';
import { useChat } from '../hooks/useChat';

const WELCOME_MESSAGE = `你好，我是 Coco。

我曾经在阿里做着别人羡慕的工作，却每天拖着身体去上班。后来我飞到了挪威，用 2 年 Gap Year 找到了自己真正想做的事，在大理创办了 WeStream 人生学校。

现在，我想用 5-8 分钟的时间，陪你做一件小事——可以是听听我的故事，做一次认知小练习，或者体验一种新的学习方式。

你想从哪个开始？`;

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
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

  const showQuickActions = messages.length === 1 && !isLoading && !autoSentRef.current;

  return (
    <div className="flex flex-col h-screen bg-warm-beige/10">
      <Header />
      <ChatArea
        messages={messages}
        onQuickAction={sendMessage}
        showQuickActions={showQuickActions}
      />
      <InputArea onSend={sendMessage} disabled={isLoading} />
    </div>
  );
}
