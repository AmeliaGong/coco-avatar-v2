import { useState, Suspense } from 'react';
import { GlobeScene } from './GlobeScene';
import { Link } from 'react-router-dom';

export function LandingPage() {
  const [nodeCount] = useState(22);

  return (
    <div
      className="min-h-screen relative overflow-hidden"
      style={{
        background:
          'linear-gradient(160deg, #0f0a05 0%, #1a1208 20%, #2C2416 50%, #3D3020 75%, #1a1208 100%)',
      }}
    >
      {/* Header */}
      <header className="relative z-10 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full overflow-hidden border border-white/20">
            <img src="/images/coco-avatar.png" alt="Coco" className="w-full h-full object-cover" />
          </div>
          <span className="text-white/70 text-sm font-light tracking-wide">WeStream 人生学校</span>
        </div>
        <Link
          to="/c/demo"
          className="text-white/40 text-xs hover:text-white/70 transition"
        >
          和 Coco 聊聊 →
        </Link>
      </header>

      {/* Globe — full screen background */}
      <div className="absolute inset-0 z-0">
        <GlobeScene />
      </div>

      {/* Overlay: title + CTA */}
      <div className="relative z-10 flex flex-col items-center justify-end min-h-screen px-6 pb-24 text-center pointer-events-none">
        {/* Brand text */}
        <div className="pointer-events-auto">
          <h1
            className="text-4xl sm:text-5xl md:text-6xl font-light text-white mb-3 leading-tight tracking-wide"
            style={{ textShadow: '0 2px 40px rgba(0,0,0,0.7), 0 0 60px rgba(245,230,211,0.05)' }}
          >
            在流动中<br />找到天命
          </h1>

          <p className="text-white/45 text-sm sm:text-base font-light mb-1 tracking-widest">
            Be water, We stream
          </p>

          <p className="text-white/30 text-xs max-w-xs mx-auto leading-relaxed mt-2">
            探索来自全球 {nodeCount} 位真实探索者的人生故事
          </p>
        </div>

        {/* Hint */}
        <p
          className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white/25 text-xs tracking-widest pointer-events-none"
          style={{ animation: 'float 3s ease-in-out infinite' }}
        >
          拖动旋转 · 点击节点探索
        </p>
      </div>

      <style>{`
        @keyframes float {
          0%, 100% { opacity: 0.25; transform: translate(-50%, 0px); }
          50% { opacity: 0.45; transform: translate(-50%, -6px); }
        }
      `}</style>
    </div>
  );
}
