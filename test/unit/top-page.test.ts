import { describe, expect, it } from 'vitest';
import type { Page } from '../../src/app/deps.ts';
import { formatDate, renderNotFoundPage, renderTopPage } from '../../src/app/top-page.ts';

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
    expect(html).not.toContain('class="placeholder"');
  });

  it('画像が無ければタイトルの最初の文字を出す', () => {
    const html = renderTopPage([page({ title: '🍣 お寿司' })]);
    expect(html).toContain('<div class="placeholder" aria-hidden="true">🍣</div>');
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

  it('外部スクリプトを読み込まない', () => {
    expect(renderTopPage([page()])).not.toContain('<script');
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
