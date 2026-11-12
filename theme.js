// 화면 테마: localStorage dshs-theme = dark | light | ocean | forest | coco | sakura.
// 고른 적이 없으면 기기 설정(다크 · 라이트)을 따릅니다. 화면을 그리기 전에 정해 깜빡이지 않게 합니다.
(() => {
  const mq = matchMedia('(prefers-color-scheme: light)');
  const TONE = { dark: 'dark', light: 'light', ocean: 'dark', forest: 'dark', coco: 'light', sakura: 'light' };
  const BG = { dark: '#0a0a0f', light: '#f5f5fa', ocean: '#07111b', forest: '#0a120d', coco: '#f2f7f3', sakura: '#fbf3f6' };
  window.applyTheme = () => {
    let t = null;
    try { t = localStorage.getItem('dshs-theme'); } catch (e) {}
    if (!TONE[t]) t = mq.matches ? 'light' : 'dark';
    const root = document.documentElement;
    root.dataset.theme = t;
    root.dataset.tone = TONE[t];
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = BG[t];
  };
  mq.addEventListener('change', window.applyTheme);
  window.applyTheme();
})();
