import { useState } from 'react';
import { adminCreateLink } from '../../lib/api';

export function AdminCreateLink() {
  const [title, setTitle] = useState('');
  const [expiryOption, setExpiryOption] = useState('7');
  const [result, setResult] = useState<{ id: string; expires_at: string | null } | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    setResult(null);
    try {
      const days = expiryOption === 'never' ? null : parseInt(expiryOption);
      const data = await adminCreateLink(title, days);
      setResult(data);
      setTitle('');
    } catch (e) {
      if ((e as Error).message === 'Unauthorized') {
        sessionStorage.removeItem('admin_token');
        window.location.reload();
      }
    } finally {
      setCreating(false);
    }
  };

  const linkUrl = result ? `${window.location.origin}/c/${result.id}` : '';

  const handleCopy = () => {
    navigator.clipboard.writeText(linkUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-bold text-gray-800 mb-4">生成对话链接</h2>

      <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-6 space-y-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">标题（可选）</label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="例如：用户体验测试 #3"
            className="w-full px-3 py-2 border border-warm-grey/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-sage/40"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-600 mb-1">有效期</label>
          <select
            value={expiryOption}
            onChange={e => setExpiryOption(e.target.value)}
            className="w-full px-3 py-2 border border-warm-grey/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-sage/40"
          >
            <option value="7">7 天</option>
            <option value="30">30 天</option>
            <option value="90">90 天</option>
            <option value="never">永久有效</option>
          </select>
        </div>

        <button
          onClick={handleCreate}
          disabled={creating}
          className="w-full py-2 bg-sage text-white rounded-lg hover:bg-olive-green transition disabled:opacity-50"
        >
          {creating ? '生成中...' : '生成链接'}
        </button>
      </div>

      {result && (
        <div className="mt-4 bg-warm-beige/40 border border-warm-grey/30 rounded-xl p-4">
          <p className="text-sm text-sage font-medium mb-2">链接已生成</p>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={linkUrl}
              className="flex-1 px-3 py-2 border border-warm-grey/40 rounded-lg text-sm font-mono bg-white"
            />
            <button
              onClick={handleCopy}
              className="px-4 py-2 bg-sage text-white rounded-lg text-sm hover:bg-olive-green transition"
            >
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          {result.expires_at && (
            <p className="text-xs text-gray-500 mt-2">
              过期时间：{new Date(result.expires_at).toLocaleString('zh-CN')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
