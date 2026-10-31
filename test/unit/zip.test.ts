import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/app/http.ts';
import { extractZip } from '../../src/app/zip.ts';
import { buildZip } from '../support/zip-builder.ts';

const LIMITS = { maxFiles: 10, maxUnzippedBytes: 1024 * 1024 };

async function rejection(buffer: Buffer, limits = LIMITS): Promise<HttpError> {
  const error = await extractZip(buffer, limits).then(
    () => {
      throw new Error('拒否されるはずの zip が通りました');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(400);
  return error as HttpError;
}

describe('extractZip の正常系', () => {
  it('圧縮あり・なしのファイルを展開する', async () => {
    const files = await extractZip(
      buildZip([
        { name: 'index.html', data: '<h1>hi</h1>' },
        { name: 'assets/app.css', data: 'body{}', method: 'store' },
      ]),
      LIMITS,
    );
    expect(files.map((file) => [file.path, file.body.toString()])).toEqual([
      ['index.html', '<h1>hi</h1>'],
      ['assets/app.css', 'body{}'],
    ]);
  });

  it('バイナリを壊さない', async () => {
    const binary = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const [file] = await extractZip(buildZip([{ name: 'a.png', data: binary }]), LIMITS);
    expect(file?.body.equals(binary)).toBe(true);
  });

  it('日本語のファイル名を扱える', async () => {
    const [file] = await extractZip(buildZip([{ name: '画像/写真.png', data: 'x' }]), LIMITS);
    expect(file?.path).toBe('画像/写真.png');
  });

  it('ディレクトリの項目は飛ばす', async () => {
    const files = await extractZip(
      buildZip([{ name: 'assets/' }, { name: 'assets/a.css', data: 'a' }]),
      LIMITS,
    );
    expect(files.map((file) => file.path)).toEqual(['assets/a.css']);
  });

  it('macOS が足すファイルは飛ばす', async () => {
    const files = await extractZip(
      buildZip([
        { name: 'index.html', data: 'x' },
        { name: '__MACOSX/._index.html', data: 'x' },
        { name: '.DS_Store', data: 'x' },
        { name: 'assets/.DS_Store', data: 'x' },
      ]),
      LIMITS,
    );
    expect(files.map((file) => file.path)).toEqual(['index.html']);
  });

  it('上限ちょうどのサイズとファイル数は通す', async () => {
    const files = await extractZip(
      buildZip([
        { name: 'a', data: 'x'.repeat(5) },
        { name: 'b', data: 'x'.repeat(5) },
      ]),
      { maxFiles: 2, maxUnzippedBytes: 10 },
    );
    expect(files).toHaveLength(2);
  });
});

describe('extractZip が拒否する zip', () => {
  it.each([
    ['親ディレクトリへ出る', '../evil.html'],
    ['途中で親ディレクトリへ出る', 'a/../../evil.html'],
    ['絶対パス', '/etc/passwd'],
    ['バックスラッシュ', 'a\\b.html'],
    ['Windows のドライブ', 'C:\\evil.html'],
    ['カレントディレクトリ', './a.html'],
    ['空のセグメント', 'a//b.html'],
    ['制御文字', 'a\u0001b.html'],
    ['改行', 'a\nb.html'],
    ['親ディレクトリのディレクトリ項目', '../evil/'],
  ])('%s', async (_label, name) => {
    await rejection(buildZip([{ name, data: 'x' }]));
  });

  it('長すぎるパス', async () => {
    await rejection(buildZip([{ name: `${'a'.repeat(901)}.html`, data: 'x' }]));
  });

  it('シンボリックリンク', async () => {
    const error = await rejection(
      buildZip([{ name: 'link', data: '/etc/passwd', method: 'store', unixMode: 0o120777 }]),
    );
    expect(error.message).toContain('シンボリックリンク');
  });

  it('暗号化された項目', async () => {
    const error = await rejection(buildZip([{ name: 'a', data: 'x', encrypted: true }]));
    expect(error.message).toContain('暗号化');
  });

  it('重複したパス', async () => {
    const error = await rejection(
      buildZip([
        { name: 'a', data: '1' },
        { name: 'a', data: '2' },
      ]),
    );
    expect(error.message).toContain('重複');
  });

  it('ファイル数が上限を超える', async () => {
    const error = await rejection(
      buildZip([
        { name: 'a', data: '1' },
        { name: 'b', data: '2' },
        { name: 'c', data: '3' },
      ]),
      { maxFiles: 2, maxUnzippedBytes: 1000 },
    );
    expect(error.message).toContain('多すぎます');
  });

  it('項目の総数が多すぎる zip は読み始める前に止める', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `d${i}/` }));
    await rejection(buildZip(entries), { maxFiles: 2, maxUnzippedBytes: 1000 });
  });

  it('展開後のサイズが上限を超える', async () => {
    const error = await rejection(buildZip([{ name: 'a', data: 'x'.repeat(11) }]), {
      maxFiles: 10,
      maxUnzippedBytes: 10,
    });
    expect(error.message).toContain('大きすぎます');
  });

  it('宣言より実際に大きいファイル（zip bomb）', async () => {
    await rejection(buildZip([{ name: 'bomb', data: 'x'.repeat(100_000), declaredSize: 10 }]));
  });

  it('宣言より実際に小さいファイル', async () => {
    await rejection(buildZip([{ name: 'a', data: 'x', method: 'deflate', declaredSize: 100 }]));
  });

  it.each([
    ['zip ではない', Buffer.from('これは zip ではありません')],
    ['空', Buffer.alloc(0)],
    ['途中で切れている', buildZip([{ name: 'a', data: 'x'.repeat(100) }]).subarray(0, 50)],
  ])('%s', async (_label, buffer) => {
    await rejection(buffer);
  });
});
