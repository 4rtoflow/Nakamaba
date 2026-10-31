import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '../../src/app/html.ts';
import { HttpError } from '../../src/app/http.ts';
import { contentTypeFor } from '../../src/app/mime.ts';
import { buildPage } from '../../src/app/page-content.ts';

const file = (path: string, body = '') => ({ path, body: Buffer.from(body, 'utf8') });

function htmlOf(built: ReturnType<typeof buildPage>, path: string): string {
  const found = built.files.find((item) => item.path === path);
  if (!found) throw new Error(`${path} がありません`);
  return found.body.toString('utf8');
}

describe('buildPage の必須ファイル', () => {
  it.each(['index.html', 'index.md'])('直下の %s があれば通す', (path) => {
    expect(() => buildPage([file(path, 'x')], 'p')).not.toThrow();
  });

  it.each([
    ['何も無い', []],
    ['別の HTML だけ', [file('about.html')]],
    ['フォルダの中だけ', [file('site/index.html')]],
    ['大文字', [file('INDEX.HTML')]],
  ])('%s なら 400 にする', (_label, files) => {
    try {
      buildPage(files, 'p');
      throw new Error('拒否されるはずです');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe('missing_index');
    }
  });

  it('index.html と index.md の両方があると、変換後に衝突するので 400 にする', () => {
    expect(() => buildPage([file('index.html'), file('index.md')], 'p')).toThrowError(/同じパス/);
  });

  it('a.md と a.html の衝突も 400 にする', () => {
    expect(() => buildPage([file('index.html'), file('a.md'), file('a.html')], 'p')).toThrowError(
      /同じパス/,
    );
  });
});

describe('buildPage のタイトル', () => {
  it('HTML は title を使う', () => {
    expect(buildPage([file('index.html', '<title>僕のページ</title>')], 'p').title).toBe(
      '僕のページ',
    );
  });

  it('title の属性・大文字・改行を扱う', () => {
    const html = '<TITLE lang="ja">\n  A\n  B\n</TITLE>';
    expect(buildPage([file('index.html', html)], 'p').title).toBe('A B');
  });

  it('文字参照を戻す', () => {
    expect(buildPage([file('index.html', '<title>A &amp; B</title>')], 'p').title).toBe('A & B');
  });

  it('title が無ければページ名にする', () => {
    expect(buildPage([file('index.html', '<h1>x</h1>')], 'my-page').title).toBe('my-page');
  });

  it('title が空ならページ名にする', () => {
    expect(buildPage([file('index.html', '<title> </title>')], 'my-page').title).toBe('my-page');
  });

  it('Markdown は最初の見出しを使う', () => {
    const built = buildPage([file('index.md', '本文\n\n## 二番\n\n# 一番')], 'p');
    expect(built.title).toBe('二番');
  });

  it('見出しの装飾を外す', () => {
    expect(buildPage([file('index.md', '# **太字** と `code`')], 'p').title).toBe('太字 と code');
  });

  it('Markdown に見出しが無ければページ名にする', () => {
    expect(buildPage([file('index.md', '本文だけ')], 'my-page').title).toBe('my-page');
  });

  it('長いタイトルは切り詰める', () => {
    const built = buildPage([file('index.html', `<title>${'あ'.repeat(300)}</title>`)], 'p');
    expect(Array.from(built.title)).toHaveLength(200);
  });
});

describe('buildPage の Markdown 変換', () => {
  it('HTML に変換して元の md を残さない', () => {
    const built = buildPage([file('index.md', '# 見出し\n\n**太字**')], 'p');
    expect(built.files.map((item) => item.path)).toEqual(['index.html']);
    const html = htmlOf(built, 'index.html');
    expect(html).toContain('<h1>見出し</h1>');
    expect(html).toContain('<strong>太字</strong>');
    expect(built.files[0]?.contentType).toBe('text/html; charset=utf-8');
  });

  it('title をエスケープする', () => {
    const html = htmlOf(buildPage([file('index.md', '# a&lt;script&gt;')], 'p'), 'index.html');
    expect(html).toContain('<title>a&lt;script&gt;</title>');
  });

  it('下の階層の md も変換する', () => {
    const built = buildPage([file('index.html'), file('docs/guide.md', '# Guide')], 'p');
    expect(built.files.map((item) => item.path)).toEqual(['index.html', 'docs/guide.html']);
    expect(htmlOf(built, 'docs/guide.html')).toContain('<title>Guide</title>');
  });

  it('相対の md へのリンクを html に直す', () => {
    const html = htmlOf(
      buildPage(
        [
          file('index.md', '[a](a.md) [b](docs/b.md#x) [c](c.md?y=1)'),
          file('a.md'),
          file('docs/b.md'),
          file('c.md'),
        ],
        'p',
      ),
      'index.html',
    );
    expect(html).toContain('href="a.html"');
    expect(html).toContain('href="docs/b.html#x"');
    expect(html).toContain('href="c.html?y=1"');
  });

  it('外部の md へのリンクは変えない', () => {
    const html = htmlOf(
      buildPage([file('index.md', '[a](https://example.com/a.md) [b](//example.com/b.md)')], 'p'),
      'index.html',
    );
    expect(html).toContain('href="https://example.com/a.md"');
    expect(html).toContain('href="//example.com/b.md"');
  });

  it('HTML のファイルは中身を変えない', () => {
    const source = '<!doctype html><title>x</title><script>alert(1)</script>';
    expect(htmlOf(buildPage([file('index.html', source)], 'p'), 'index.html')).toBe(source);
  });
});

describe('buildPage の画像と種類', () => {
  it('直下の thumbnail.png だけを画像として扱う', () => {
    expect(buildPage([file('index.html'), file('thumbnail.png')], 'p').hasThumbnail).toBe(true);
    expect(buildPage([file('index.html'), file('a/thumbnail.png')], 'p').hasThumbnail).toBe(false);
    expect(buildPage([file('index.html'), file('thumbnail.jpg')], 'p').hasThumbnail).toBe(false);
  });

  it('Content-Type を付ける', () => {
    const built = buildPage([file('index.html'), file('a.css'), file('b.js'), file('c.png')], 'p');
    expect(Object.fromEntries(built.files.map((item) => [item.path, item.contentType]))).toEqual({
      'index.html': 'text/html; charset=utf-8',
      'a.css': 'text/css; charset=utf-8',
      'b.js': 'text/javascript; charset=utf-8',
      'c.png': 'image/png',
    });
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['a.HTML', 'text/html; charset=utf-8'],
    ['dir.v1/a.svg', 'image/svg+xml'],
    ['dir.v1/noext', 'application/octet-stream'],
    ['a.unknown', 'application/octet-stream'],
    ['.hidden', 'application/octet-stream'],
    ['a.woff2', 'font/woff2'],
  ])('%s は %s', (path, expected) => {
    expect(contentTypeFor(path)).toBe(expected);
  });
});

describe('htmlToPlainText', () => {
  it('タグを除いて文字参照を戻す', () => {
    expect(htmlToPlainText('<b>A</b> &lt;C&gt; &#65; &#x41; &unknown;')).toBe(
      'A <C> A A &unknown;',
    );
  });

  it('範囲外の文字参照で例外にしない', () => {
    expect(htmlToPlainText('&#x110000; &#99999999;')).toBe('&#x110000; &#99999999;');
  });
});
