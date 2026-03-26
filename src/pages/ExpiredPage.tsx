import { useNavigate } from 'react-router-dom';

export function ExpiredPage() {
  const navigate = useNavigate();

  return (
    <div className="flex items-center justify-center h-screen bg-warm-beige/10">
      <div className="text-center p-8 max-w-md">
        <div className="text-6xl mb-4">&#128337;</div>
        <h1 className="text-2xl font-bold text-gray-800 mb-2">
          此链接已失效
        </h1>
        <p className="text-gray-500 mb-6">
          对话链接已过期或不存在。请联系管理员获取新的对话链接。
        </p>
        <button
          onClick={() => navigate('/')}
          className="px-6 py-2 bg-warm-coral text-white rounded-full hover:bg-warm-coral/90 transition"
        >
          开始新对话
        </button>
      </div>
    </div>
  );
}
