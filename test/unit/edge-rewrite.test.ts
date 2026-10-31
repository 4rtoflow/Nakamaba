import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface EdgeEvent {
  request: { uri: string; querystring: Record<string, unknown> };
}

const source = readFileSync(new URL('../../src/edge/rewrite.js', import.meta.url), 'utf8');
const handler = new Function(`${source}; return handler;`)() as (event: EdgeEvent) => {
  uri?: string;
  statusCode?: number;
  headers?: { location: { value: string } };
};

const run = (uri: string, querystring: Record<string, unknown> = {}) =>
  handler({ request: { uri, querystring } });

describe('CloudFront Functions の URL 書き換え', () => {
  it.each([
    ['/', '/index.html'],
    ['/my-page/', '/my-page/index.html'],
    ['/my-page/docs/', '/my-page/docs/index.html'],
  ])('%s は %s を返す', (uri, expected) => {
    expect(run(uri).uri).toBe(expected);
  });

  it.each(['/my-page/index.html', '/my-page/a.css', '/my-page/v1.2/app.min.js', '/404.html'])(
    '%s はそのまま通す',
    (uri) => {
      expect(run(uri).uri).toBe(uri);
    },
  );

  it.each([
    ['/my-page', '/my-page/'],
    ['/my-page/docs', '/my-page/docs/'],
    ['/v1.2/docs', '/v1.2/docs/'],
  ])('%s は相対リンクが壊れないよう 301 で %s へ送る', (uri, location) => {
    const result = run(uri);
    expect(result.statusCode).toBe(301);
    expect(result.headers?.location.value).toBe(location);
  });

  it('リダイレクトでクエリを保つ', () => {
    const result = run('/my-page', {
      a: { value: '1' },
      b: { value: '2', multiValue: [{ value: '2' }, { value: '3' }] },
      c: { value: '' },
    });
    expect(result.headers?.location.value).toBe('/my-page/?a=1&b=2&b=3&c');
  });
});
