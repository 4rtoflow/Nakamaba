import { describe, expect, it } from 'vitest';
import type { Page } from '../../src/app/deps.ts';
import {
  formatDate,
  gradientIndex,
  renderNotFoundPage,
  renderTopPage,
} from '../../src/app/top-page.ts';

function page(overrides: Partial<Page> = {}): Page {
  return {
    name: 'my-page',
    owner: 'alice',
    title: '僕のページ',
    hasThumbnail: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderTopPage', () => {
  it('カードにタイトル・公開した人・更新日・リンクを載せる', () => {
    const html = renderTopPage([page()]);
    expect(html).toContain('僕のページ');
    expect(html).toContain('alice');
    expect(html).toContain('2026-10-02');
    expect(html).toContain('href="/my-page/"');
    expect(html).toContain('1 ページ');
  });

  it('更新日は日本時間で表示する', () => {
    expect(formatDate('2026-10-31T15:30:00.000Z')).toBe('2026-11-01');
  });

  it('新しく更新した順に並べる', () => {
    const html = renderTopPage([
      page({ name: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      page({ name: 'new', updatedAt: '2026-06-01T00:00:00.000Z' }),
      page({ name: 'mid', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    const order = ['new', 'mid', 'old'].map((name) => html.indexOf(`href="/${name}/"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('thumbnail.png があれば画像を出す', () => {
    const html = renderTopPage([page({ hasThumbnail: true })]);
    expect(html).toContain('src="/my-page/thumbnail.png"');
    expect(html).not.toContain('class="placeholder');
  });

  it('画像が無ければグラデーションの上にタイトルの最初の文字を出す', () => {
    const html = renderTopPage([page({ title: '🍣 お寿司' })]);
    expect(html).toContain(
      `<div class="placeholder g${gradientIndex('my-page')}" aria-hidden="true">🍣</div>`,
    );
  });

  it('グラデーションはページ名で決まり、名前が違えば散らばる', () => {
    expect(gradientIndex('my-page')).toBe(gradientIndex('my-page'));
    const names = Array.from({ length: 50 }, (_, i) => `page-${i}`);
    expect(new Set(names.map(gradientIndex)).size).toBeGreaterThan(1);
  });

  it('タイトルとユーザー名をエスケープする', () => {
    const attack = '<script>alert(1)</script>"\'&';
    const html = renderTopPage([page({ title: attack, owner: attack })]);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;');
  });

  it('タイトルの最初の文字もエスケープする', () => {
    expect(renderTopPage([page({ title: '<b>' })])).toContain('aria-hidden="true">&lt;</div>');
  });

  it('ページが無いときはその旨を出す', () => {
    const html = renderTopPage([]);
    expect(html).toContain('まだページがありません');
    expect(html).toContain('0 ページ');
  });

  it.each([
    ['トップ', () => renderTopPage([])],
    ['404', () => renderNotFoundPage()],
  ])('%s はサイトのルートのアイコンを指す', (_label, render) => {
    const html = render();
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  });

  it('外部スクリプトを読み込まない', () => {
    expect(renderTopPage([page()])).not.toMatch(/<script[^>]*\ssrc=/);
  });

  it('カードとリストの切り替えは、ページがあるときだけ出す', () => {
    expect(renderTopPage([page()])).toContain('id="view-list"');
    expect(renderTopPage([])).not.toContain('id="view-list"');
  });

  it('引数の配列を並べ替えない', () => {
    const pages = [
      page({ name: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }),
      page({ name: 'b', updatedAt: '2026-06-01T00:00:00.000Z' }),
    ];
    renderTopPage(pages);
    expect(pages[0]?.name).toBe('a');
  });
});

describe('renderNotFoundPage', () => {
  it('一覧へ戻るリンクを出す', () => {
    const html = renderNotFoundPage();
    expect(html).toContain('ページが見つかりません');
    expect(html).toContain('href="/"');
  });
});
