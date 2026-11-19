import { useEffect, useState } from 'react';
import { createConversation } from '../lib/api';
import { ChatPage } from './ChatPage';

/**
 * 探索者体验入口（`/e/explorer`）。
 *
 * 存在的理由：产品里的 ① 入口要**先听完 Coco 的四段故事**才到探索者，
 * 想单独看「挑 3 个人 → 听一则」这段交互，得先聊四轮。
 * 这个入口把那段路**跳过**：进页面第一轮就把 3 位探索者摆出来。
 *
 * ⚠️ 走的是 `scenario: 'story'` —— **不是** chat。
 * 探索者目录（15 人的画像与匹配信号）只在 story 场景里注入
 * （server/engine/explorer.js 的 `enabled: scenario === 'story'`），
 * 走错场景的话模型看不到目录，会自己编名字。
 */
const EXPLORER_OPEN = '我想听听探索者们的故事，帮我挑三位给我看看。';

export function ExplorerEntry() {
  const [convId, setConvId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    createConversation()
      .then(c => { if (alive) setConvId(c.id); })
      .catch(err => console.error('创建会话失败', err));
    return () => { alive = false; };
  }, []);

  if (!convId) {
    return (
      <div className="flex items-center justify-center h-screen bg-warm-beige/10 text-gray-500 text-sm">
        正在准备会话…
      </div>
    );
  }

  return (
    <ChatPage
      conversationId={convId}
      autoStart={{ message: EXPLORER_OPEN, scenario: 'story' }}
    />
  );
}
