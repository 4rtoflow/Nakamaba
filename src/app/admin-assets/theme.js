// 選んだ配色を描画より前に戻すため、head で同期して読み込む。公開側のトップにも埋め込む。
(() => {
  const KEY = 'nakamaba:theme';
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch {
    // 読めなければ OS の設定に従う
  }
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('#theme-toggle')) return;
    const isDark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = isDark ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, root.dataset.theme);
    } catch {
      // 保存できなくても、このページを開いている間は切り替わる
    }
  });
})();
