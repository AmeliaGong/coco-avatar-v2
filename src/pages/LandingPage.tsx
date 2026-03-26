const ENTRIES = [
  {
    label: '听听 Coco 的故事',
    desc: '从阿里到挪威到大理，一段关于天命的旅程',
    icon: '✦',
  },
  {
    label: '我遇到了卡点',
    desc: '5 分钟 CBT 练习，看清卡住你的那个想法',
    icon: '◈',
  },
  {
    label: '体验 10 倍决策力',
    desc: '用跨学科提问法，打破单一视角的局限',
    icon: '⟡',
  },
];

export function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'linear-gradient(160deg, #2C2416 0%, #3D3020 35%, #5C4A30 65%, #F5E6D3 100%)' }}>

      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full overflow-hidden border border-white/30">
            <img src="/images/coco-avatar.png" alt="Coco" className="w-full h-full object-cover" />
          </div>
          <span className="text-white/80 text-sm font-light tracking-wide">WeStream 人生学校</span>
        </div>
        <a
          href="https://westream.school"
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/50 text-xs hover:text-white/80 transition"
        >
          了解更多 →
        </a>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">

        {/* Avatar */}
        <div className="relative mb-8">
          <div className="w-28 h-28 rounded-full overflow-hidden border-2 border-white/20 shadow-2xl mx-auto"
            style={{ boxShadow: '0 0 60px rgba(245,230,211,0.15)' }}>
            <img src="/images/coco-avatar.png" alt="Coco" className="w-full h-full object-cover" />
          </div>
          <div className="absolute inset-0 rounded-full"
            style={{ background: 'radial-gradient(circle, rgba(245,230,211,0.08) 0%, transparent 70%)' }} />
        </div>

        {/* Title */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-light text-white mb-4 leading-tight tracking-wide"
          style={{ textShadow: '0 2px 20px rgba(0,0,0,0.4)' }}>
          在流动中<br />找到天命
        </h1>

        {/* Tagline */}
        <p className="text-white/60 text-base sm:text-lg font-light mb-3 tracking-wider">
          Be water, We stream
        </p>
        <p className="text-white/40 text-sm max-w-xs leading-relaxed">
          我是 Coco，WeStream 人生学校创始人。<br />
          体验需要专属链接，请联系 Coco 获取。
        </p>
      </main>

      {/* Feature Cards — preview only, no click */}
      <section className="px-4 pb-10 max-w-2xl mx-auto w-full">
        <p className="text-white/30 text-xs text-center mb-4 tracking-widest uppercase">你可以体验的内容</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {ENTRIES.map((entry) => (
            <div
              key={entry.label}
              className="text-left p-4 rounded-2xl border border-white/10"
              style={{
                background: 'rgba(255,255,255,0.05)',
                backdropFilter: 'blur(12px)',
              }}
            >
              <div className="text-warm-beige/60 text-lg mb-2">{entry.icon}</div>
              <div className="text-white text-sm font-medium mb-1">{entry.label}</div>
              <div className="text-white/40 text-xs leading-relaxed">{entry.desc}</div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}
