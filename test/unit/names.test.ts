import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/app/http.ts';
import { assertValidName, isValidName } from '../../src/app/names.ts';

describe('isValidName', () => {
  it.each(['a', '0', 'my-page', 'a1-b2', 'a'.repeat(63)])('%s は使える', (name) => {
    expect(isValidName(name)).toBe(true);
  });

  it.each([
    ['空文字', ''],
    ['大文字', 'Page'],
    ['先頭のハイフン', '-a'],
    ['末尾のハイフン', 'a-'],
    ['ドット', 'index.html'],
    ['スラッシュ', 'a/b'],
    ['親ディレクトリ', '..'],
    ['アンダースコア', '_assets'],
    ['日本語', 'ページ'],
    ['空白', 'a b'],
    ['改行', 'a\n'],
    ['64 文字', 'a'.repeat(64)],
  ])('%s は使えない', (_label, name) => {
    expect(isValidName(name)).toBe(false);
  });
});

describe('assertValidName', () => {
  it('不正な名前は 400 にする', () => {
    expect(() => assertValidName('NG')).toThrowError(HttpError);
    try {
      assertValidName('NG');
    } catch (error) {
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe('invalid_name');
    }
  });
});
