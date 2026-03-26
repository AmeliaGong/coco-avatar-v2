import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { adminGetConversation } from '../../lib/api';

interface Message {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

interface TokenUsage {
  id: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: string;
}

interface ConvDetail {
  id: string;
  title: string | null;
  created_at: string;
  expires_at: string | null;
  status: string;
  messages: Message[];
  token_usage: TokenUsage[];
}

export function AdminConversationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [conv, setConv] = useState<ConvDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    adminGetConversation(id)
      .then(setConv)
      .catch(e => {
        if ((e as Error).message === 'Unauthorized') {
          sessionStorage.removeItem('admin_token');
          window.location.reload();
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <p className="text-gray-400">加载中...</p>;
  if (!conv) return <p className="text-gray-400">对话不存在</p>;

  const totalTokens = conv.token_usage.reduce((sum, t) => sum + t.total_tokens, 0);

  return (
    <div>
      <button
        onClick={() => navigate('/admin')}
        className="text-sm text-sage hover:underline mb-4 inline-block"
      >
        &larr; 返回列表
      </button>

      <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-4 mb-4">
        <h2 className="text-lg font-bold text-gray-800 mb-2">
          {conv.title || '无标题'}
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-500">ID: </span>
            <span className="font-mono text-xs">{conv.id}</span>
          </div>
          <div>
            <span className="text-gray-500">创建: </span>
            {new Date(conv.created_at).toLocaleString('zh-CN')}
          </div>
          <div>
            <span className="text-gray-500">状态: </span>
            <span className={conv.status === 'active' ? 'text-sage font-medium' : 'text-gray-500'}>
              {conv.status === 'active' ? '活跃' : '已过期'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Token 总消耗: </span>
            <span className="font-medium">{totalTokens.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {conv.token_usage.length > 0 && (
        <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-4 mb-4">
          <h3 className="font-bold text-gray-700 mb-2 text-sm">Token 明细</h3>
          <table className="w-full text-xs">
            <thead className="text-gray-500 bg-warm-beige/30">
              <tr>
                <th className="text-left py-1 px-2">时间</th>
                <th className="text-right py-1 px-2">Prompt</th>
                <th className="text-right py-1 px-2">Completion</th>
                <th className="text-right py-1 px-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {conv.token_usage.map(t => (
                <tr key={t.id} className="border-t border-warm-grey/20">
                  <td className="py-1 px-2">{new Date(t.created_at).toLocaleString('zh-CN')}</td>
                  <td className="py-1 px-2 text-right">{t.prompt_tokens}</td>
                  <td className="py-1 px-2 text-right">{t.completion_tokens}</td>
                  <td className="py-1 px-2 text-right font-medium">{t.total_tokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-4">
        <h3 className="font-bold text-gray-700 mb-3 text-sm">
          对话记录 ({conv.messages.length} 条)
        </h3>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {conv.messages.map(msg => (
            <div
              key={msg.id}
              className={`p-3 rounded-lg text-sm ${
                msg.role === 'user'
                  ? 'bg-warm-beige/40 ml-8'
                  : msg.role === 'assistant'
                  ? 'bg-sage/10 mr-8'
                  : 'bg-soft-apricot/30'
              }`}
            >
              <div className="flex justify-between mb-1">
                <span className="text-xs font-medium text-gray-500">
                  {msg.role === 'user' ? '用户' : msg.role === 'assistant' ? 'Coco' : '系统'}
                </span>
                <span className="text-xs text-gray-400">
                  {new Date(msg.created_at).toLocaleString('zh-CN')}
                </span>
              </div>
              <div className="text-gray-800 whitespace-pre-wrap">{msg.content}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
