import { useEffect } from 'react';

/**
 * 把「当前看得见的高度」实时写进 CSS 变量 `--app-h`。
 *
 * 为什么需要这一层（CSS 里的 dvh 挡不住的那一半）：
 *   · 手机地址栏收起/展开 ⇒ `dvh` 能跟上 ✓
 *   · **软键盘弹出** ⇒ iOS Safari 的 layout viewport **不变**（页面并没有变矮），
 *     只有 `visualViewport.height` 变 ⇒ `dvh` 挡不住 ⇒ 输入框还是会被键盘顶出去。
 *   · Android Chrome 取决于 `interactive-widget=resizes-content`（见 index.html）。
 *
 * 所以这里用 `visualViewport.height` 做实时兜底：它是"用户此刻真正看得见的
 * 那块矩形"的高度（不含键盘、不含地址栏遮挡）。
 *
 * 写的是 `documentElement` 的**行内样式** ⇒ 行内样式压过 `index.css` 里的
 * `@supports (height: 100dvh)` 规则，优先级天然正确（不需要再加 !important）。
 *
 * ⚠️ 用 rAF 节流：`visualViewport` 的 resize/scroll 在拖键盘时是连珠炮发的，
 * 不节流会每帧改一次根高度 ⇒ 整页重排。
 */
export function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    let raf = 0;

    const apply = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = vv ? vv.height : window.innerHeight;
        if (h > 0) {
          document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
        }
      });
    };

    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('orientationchange', apply);
    window.addEventListener('resize', apply);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('orientationchange', apply);
      window.removeEventListener('resize', apply);
    };
  }, []);
}
