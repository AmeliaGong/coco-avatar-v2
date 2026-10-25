import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { adminLogin } from '../../lib/api';

export function AdminLayout() {
  const [authed, setAuthed] = useState(!!sessionStorage.getItem('admin_token'));
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const token = await adminLogin(password);
    if (token) {
      sessionStorage.setItem('admin_token', token);
      setAuthed(true);
    } else {
      setError('密码错误');
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem('admin_token');
    setAuthed(false);
  };

  if (!authed) {
    return (
      <div className="flex items-center justify-center h-screen bg-warm-beige/30">
        <form onSubmit={handleLogin} className="bg-white p-8 rounded-xl shadow-md w-80 border border-warm-grey/30">
          <h1 className="text-xl font-bold mb-4 text-gray-800">管理后台</h1>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="请输入管理密码"
            className="w-full px-3 py-2 border border-warm-grey/50 rounded-lg mb-3 focus:outline-none focus:ring-2 focus:ring-sage/50"
            autoFocus
          />
          {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
          <button
            type="submit"
            className="w-full py-2 bg-sage text-white rounded-lg hover:bg-olive-green transition"
          >
            登录
          </button>
        </form>
      </div>
    );
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-4 py-2 rounded-lg text-sm transition ${isActive ? 'bg-sage text-white' : 'text-gray-600 hover:bg-warm-beige/60'}`;

  return (
    <div className="h-screen bg-warm-beige/20 flex flex-col">
      <header className="shrink-0 bg-gradient-to-r from-warm-beige to-soft-apricot border-b border-warm-grey/30 shadow-sm px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="font-bold text-gray-800">Coco Admin</h1>
          <nav className="flex gap-1">
            <NavLink to="/admin" end className={linkClass}>对话列表</NavLink>
            <NavLink to="/admin/clients" className={linkClass}>客户</NavLink>
            <NavLink to="/admin/coach-moves" className={linkClass}>手法库</NavLink>
            <NavLink to="/admin/create-link" className={linkClass}>生成链接</NavLink>
            <NavLink to="/admin/stats" className={linkClass}>统计面板</NavLink>
          </nav>
        </div>
        <button onClick={handleLogout} className="text-sm text-gray-500 hover:text-red-400 transition">
          退出
        </button>
      </header>
      {/* The global stylesheet locks html/body to overflow:hidden for the 3D
          landing page, so the admin area scrolls inside this container. */}
      <main className="flex-1 min-h-0 overflow-y-auto touch-auto">
        <div className="p-6 max-w-6xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
