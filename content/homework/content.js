/* 作业页入口：仅顶层框架加载悬浮面板 */
(function () {
  if (window.top !== window.self) return;
  if (window.__HW_LOADED__) return;
  window.__HW_LOADED__ = true;
  const boot = () => window.HW?.Panel?.init?.();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
