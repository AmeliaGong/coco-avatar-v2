export function Header() {
  return (
    <header className="bg-gradient-to-r from-warm-beige to-soft-apricot border-b border-warm-grey/30 shadow-sm">
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-3 sm:py-4 flex items-center gap-2 sm:gap-4">
        <img
          src="/images/westream-logo.png"
          alt="WeStream Logo"
          className="w-10 h-10 sm:w-14 sm:h-14 object-contain"
        />
        <div className="flex-1 min-w-0">
          <h1 className="text-base sm:text-xl font-light text-gray-800 truncate">Coco | WeStream 人生学校</h1>
          <p className="text-xs text-gray-600 mt-0.5 sm:mt-1 truncate">Be water, We stream 在流动中滋养彼此</p>
        </div>
        <img
          src="/images/coco-avatar.png"
          alt="Coco"
          className="w-10 h-10 sm:w-12 sm:h-12 rounded-full object-cover shadow-md ring-2 ring-white/60"
        />
      </div>
    </header>
  );
}
