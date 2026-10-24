import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import type { Story } from '../data/stories';

export function StoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [story, setStory] = useState<Story | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/stories/${id}`)
      .then((r) => r.json())
      .then((data) => {
        setStory(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [id]);

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'linear-gradient(160deg, #2C2416 0%, #3D3020 50%, #5C4A30 100%)' }}
      >
        <p className="text-white/40 text-sm tracking-widest">Loading...</p>
      </div>
    );
  }

  if (!story) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-6"
        style={{ background: 'linear-gradient(160deg, #2C2416 0%, #3D3020 50%, #5C4A30 100%)' }}
      >
        <p className="text-white/50 text-base">故事未找到</p>
        <Link to="/" className="text-warm-beige/70 text-sm hover:text-warm-beige transition">
          ← 返回地球
        </Link>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen"
      style={{
        background: 'linear-gradient(160deg, #2C2416 0%, #3D3020 35%, #5C4A30 65%, #F5E6D3 100%)',
      }}
    >
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 text-white/60 hover:text-white/90 transition text-sm"
        >
          <span>←</span>
          <span>返回故事地球</span>
        </button>
        <span className="text-white/40 text-xs">WeStream 人生学校</span>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-6 py-12">
        {/* Location tag */}
        <div className="flex items-center gap-2 mb-6">
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: story.isCoco ? '#F5E6D3' : '#A8B5A0' }}
          />
          <span className="text-white/50 text-xs tracking-wider">
            {story.city}，{story.country}
          </span>
        </div>

        {/* Title */}
        <h1
          className="text-3xl sm:text-4xl font-light text-white mb-4 leading-snug tracking-wide"
          style={{ textShadow: '0 2px 20px rgba(0,0,0,0.4)' }}
        >
          {story.title}
        </h1>

        {/* Author */}
        <p className="text-white/40 text-sm mb-10">
          {story.isCoco ? 'Coco' : story.name} 的故事
        </p>

        {/* Divider */}
        <div
          className="h-px mb-10"
          style={{
            background: 'linear-gradient(to right, rgba(245,230,211,0.2), rgba(168,181,160,0.1), transparent)',
          }}
        />

        {/* Story content */}
        <div className="space-y-6">
          {story.content.split('\n\n').map((para, i) => (
            <p key={i} className="text-white/75 text-base leading-relaxed font-light">
              {para}
            </p>
          ))}
        </div>

        {/* CTA */}
        <div className="mt-16 pt-10" style={{ borderTop: '1px solid rgba(245,230,211,0.1)' }}>
          <p className="text-white/40 text-sm mb-6 text-center">
            探索更多人生故事
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              to="/"
              className="flex-1 text-center py-3 px-6 rounded-full text-sm transition"
              style={{
                border: '1px solid rgba(245,230,211,0.3)',
                color: 'rgba(245,230,211,0.8)',
                background: 'rgba(245,230,211,0.05)',
              }}
            >
              回到故事地球
            </Link>
            <Link
              to="/c/demo"
              className="flex-1 text-center py-3 px-6 rounded-full text-sm transition"
              style={{
                background: 'rgba(245,230,211,0.15)',
                color: '#F5E6D3',
              }}
            >
              和 Coco 聊聊
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
