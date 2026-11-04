import type { Page } from './deps.ts';
import { escapeHtml } from './html.ts';

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300..700&family=Noto+Sans+JP:wght@300..700&display=swap">';

const GRADIENTS = [
  ['#f97316', '#db2777'],
  ['#6366f1', '#a855f7'],
  ['#06b6d4', '#3b82f6'],
  ['#10b981', '#0e7490'],
  ['#f59e0b', '#ef4444'],
  ['#ec4899', '#8b5cf6'],
  ['#14b8a6', '#65a30d'],
  ['#1e3a8a', '#7c3aed'],
] as const;

const STYLE = `
:root {
  color-scheme: light;
  --ink: #141414; --muted: #707070; --canvas: #fff; --soft: #f3f3f3; --hairline: #e8e8e8;
  --accent: #c2410c;
  font-family: Inter, "Noto Sans JP", -apple-system, "Hiragino Sans", "Helvetica Neue", Arial, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--canvas); color: var(--ink); font-size: 16px; line-height: 1.5; font-weight: 450; }
a { color: inherit; text-decoration: none; }
.nav { position: sticky; top: 16px; z-index: 1; display: flex; justify-content: space-between; align-items: center; gap: 16px; width: fit-content; min-width: min(420px, calc(100% - 32px)); margin: 16px auto 0; padding: 10px 20px; border-radius: 9999px; background: var(--soft); }
.brand { font-weight: 650; letter-spacing: 0; }
.count { color: var(--muted); font-size: 14px; }
.hero { width: 100%; max-width: 1120px; margin: 0 auto; padding: 80px 24px 48px; }
.hero h1 { margin: 0; font-size: clamp(36px, 7vw, 64px); line-height: 1.1; font-weight: 650; }
.hero h1 span { color: var(--accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 24px; width: 100%; max-width: 1120px; margin: 0 auto; padding: 0 24px 80px; }
.card { display: flex; flex-direction: column; min-width: 0; overflow: hidden; border: 1px solid var(--hairline); border-radius: 24px; background: var(--canvas); transition: background-color .15s; }
.card:hover, .card:focus-visible { background: var(--soft); }
.card:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.thumb { aspect-ratio: 16 / 10; width: 100%; object-fit: cover; display: block; background: var(--soft); }
.placeholder { aspect-ratio: 16 / 10; display: flex; align-items: center; justify-content: center; background: radial-gradient(circle at 20% 15%, rgb(255 255 255 / .35), transparent 55%), linear-gradient(135deg, var(--from), var(--to)); color: rgb(255 255 255 / .92); font-size: 56px; font-weight: 650; }
${GRADIENTS.map(([from, to], i) => `.g${i} { --from: ${from}; --to: ${to}; }`).join('\n')}
.body { padding: 20px 24px 24px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.title { margin: 0; font-size: 20px; line-height: 1.35; font-weight: 600; overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.meta { margin: 0; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.empty { width: 100%; max-width: 1120px; margin: 0 auto 80px; padding: 0 24px; }
.empty p { margin: 0; padding: 48px 24px; border-radius: 24px; background: var(--soft); color: var(--muted); text-align: center; }
footer { margin-top: auto; padding: 32px 24px; border-radius: 24px 24px 0 0; background: var(--ink); color: #adadad; font-size: 14px; }
footer div { max-width: 1072px; margin: 0 auto; }
footer strong { display: block; color: #fff; font-size: 20px; font-weight: 650; margin-bottom: 4px; }
.notfound { width: 100%; max-width: 720px; margin: 0 auto; padding: 120px 24px; text-align: center; }
.notfound h1 { margin: 0; font-size: clamp(28px, 5vw, 44px); font-weight: 650; line-height: 1.2; text-wrap: balance; }
.notfound p { color: var(--muted); }
.pill { display: inline-block; margin-top: 16px; padding: 10px 20px; border-radius: 9999px; background: var(--ink); color: #fff; font-weight: 600; }
`;

const DATE_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso));
}

// ページ名から決めるので、同じページは開き直しても同じ色になる。
export function gradientIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (Math.imul(hash, 31) + name.charCodeAt(i)) >>> 0;
  return hash % GRADIENTS.length;
}

function renderCard(page: Page): string {
  const href = `/${page.name}/`;
  const visual = page.hasThumbnail
    ? `<img class="thumb" src="${href}thumbnail.png" alt="" loading="lazy">`
    : `<div class="placeholder g${gradientIndex(page.name)}" aria-hidden="true">${escapeHtml(Array.from(page.title)[0] ?? '')}</div>`;
  return `<a class="card" href="${href}">
${visual}
<div class="body">
<h2 class="title">${escapeHtml(page.title)}</h2>
<p class="meta">${escapeHtml(page.owner)} ・ ${formatDate(page.updatedAt)}</p>
</div>
</a>`;
}

function layout(title: string, main: string, headerRight: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${FONTS}
<style>${STYLE}</style>
</head>
<body>
<nav class="nav"><a class="brand" href="/">Nakamaba</a>${headerRight}</nav>
${main}
<footer><div><strong>Nakamaba</strong>HTML と Markdown の静的ホスティング。</div></footer>
</body>
</html>
`;
}

export function renderTopPage(pages: Page[]): string {
  const sorted = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const list =
    sorted.length > 0
      ? `<section class="grid">\n${sorted.map(renderCard).join('\n')}\n</section>`
      : '<section class="empty"><p>まだページがありません。</p></section>';
  const main = `<header class="hero"><h1>公開中のページ<span>。</span></h1></header>
${list}`;
  return layout('Nakamaba', main, `<span class="count">${sorted.length} ページ</span>`);
}

export function renderNotFoundPage(): string {
  const main = `<main class="notfound"><h1>ページが見つかりません<span>。</span></h1><p>削除されたか、URL が間違っている可能性があります。</p><a class="pill" href="/">一覧へ戻る</a></main>`;
  return layout('ページが見つかりません - Nakamaba', main, '');
}
