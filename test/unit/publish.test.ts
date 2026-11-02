import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/app/deps.ts';
import { HttpError } from '../../src/app/http.ts';
import { createUpload, deletePage, publishPage, writeStaticPages } from '../../src/app/publish.ts';
import { createFakeWorld, type FakeWorld, TEST_UPLOAD_ID } from '../support/fakes.ts';
import { buildZip, type ZipEntryInput } from '../support/zip-builder.ts';

const SITE: ZipEntryInput[] = [
  { name: 'index.html', data: '<title>僕のページ</title>' },
  { name: 'style.css', data: 'body{}' },
];

let world: FakeWorld;
let alice: User;
let bob: User;
let admin: User;

function uploadAs(user: User, name: string, entries: ZipEntryInput[] = SITE) {
  world.uploads.set(`uploads/${user.name}/${name}/${TEST_UPLOAD_ID}.zip`, buildZip(entries));
}

async function publishAs(user: User, name: string, entries?: ZipEntryInput[]) {
  uploadAs(user, name, entries);
  return publishPage(world.deps, user, name, TEST_UPLOAD_ID);
}

async function errorOf(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => {
      throw new Error('失敗するはずの処理が成功しました');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

function expectSiteFiles() {
  expect(world.siteFiles.get('404.html')?.contentType).toContain('text/html');
  // バイナリは全体を比べる（文字列として読むと壊れるが、先頭だけでは気付けない）
  for (const [key, contentType] of [
    ['favicon.svg', 'image/svg+xml'],
    ['favicon.ico', 'image/x-icon'],
    ['apple-touch-icon.png', 'image/png'],
  ] as const) {
    const file = world.siteFiles.get(key);
    const source = readFileSync(new URL(`../../src/app/admin-assets/${key}`, import.meta.url));
    expect(file?.contentType).toBe(contentType);
    expect(file?.body.equals(source)).toBe(true);
  }
}

beforeEach(() => {
  world = createFakeWorld();
  alice = world.addUser('alice');
  bob = world.addUser('bob');
  admin = world.addUser('root', 'admin');
});

describe('公開側の共通ファイル', () => {
  it('公開すると 404 とアイコンを置き直す', async () => {
    await publishAs(alice, 'my-page');
    expectSiteFiles();
  });

  it('削除しても 404 とアイコンを置き直す', async () => {
    await publishAs(alice, 'my-page');
    world.siteFiles.clear();
    await deletePage(world.deps, alice, 'my-page');
    expectSiteFiles();
  });
});

describe('createUpload', () => {
  it('発行する人とページ名を含むキーで、サイズの上限つきの URL を返す', async () => {
    const result = await createUpload(world.deps, alice, 'my-page');
    expect(result.uploadId).toBe(TEST_UPLOAD_ID);
    expect(result.upload.fields).toMatchObject({
      key: `uploads/alice/my-page/${TEST_UPLOAD_ID}.zip`,
      maxBytes: String(world.deps.limits.maxZipBytes),
    });
  });

  it('不正なページ名を拒否する', async () => {
    expect((await errorOf(createUpload(world.deps, alice, '../x'))).status).toBe(400);
  });

  it('他の人のページ名では発行しない', async () => {
    await publishAs(alice, 'my-page');
    expect((await errorOf(createUpload(world.deps, bob, 'my-page'))).code).toBe('name_taken');
  });

  it.each([
    ['本人', () => alice],
    ['Admin', () => admin],
  ])('%s なら既存のページ名でも発行する', async (_label, user) => {
    await publishAs(alice, 'my-page');
    await expect(createUpload(world.deps, user(), 'my-page')).resolves.toBeDefined();
  });
});

describe('publishPage の新規公開', () => {
  it('ファイルを S3 に置き、ページ情報を記録する', async () => {
    const result = await publishAs(alice, 'my-page');
    expect(result.isNew).toBe(true);
    expect(result.url).toBe('https://public.example.invalid/my-page/');
    expect(world.siteFiles.get('my-page/index.html')?.contentType).toContain('text/html');
    expect(world.siteFiles.get('my-page/style.css')?.body.toString()).toBe('body{}');
    expect(world.pages.get('my-page')).toMatchObject({
      owner: 'alice',
      title: '僕のページ',
      hasThumbnail: false,
    });
  });

  it('トップの一覧を作り直す', async () => {
    await publishAs(alice, 'my-page');
    expect(world.siteFiles.get('index.html')?.body.toString()).toContain('僕のページ');
  });

  it('ページとトップのキャッシュを消す', async () => {
    await publishAs(alice, 'my-page');
    expect(world.invalidations).toEqual([['/my-page/*', '/index.html', '/']]);
  });

  it('送られた zip を消す', async () => {
    await publishAs(alice, 'my-page');
    expect(world.uploads.size).toBe(0);
  });

  it('Discord へ 1 回通知する', async () => {
    await publishAs(alice, 'my-page');
    expect(world.notices).toEqual([
      { title: '僕のページ', owner: 'alice', url: 'https://public.example.invalid/my-page/' },
    ]);
  });

  it('thumbnail.png を記録する', async () => {
    await publishAs(alice, 'my-page', [...SITE, { name: 'thumbnail.png', data: 'png' }]);
    expect(world.pages.get('my-page')?.hasThumbnail).toBe(true);
    expect(world.siteFiles.get('my-page/thumbnail.png')?.contentType).toBe('image/png');
  });

  it('index.html を最後に置く', async () => {
    await publishAs(alice, 'my-page', [
      { name: 'index.html', data: 'x' },
      { name: 'a.css', data: 'x' },
      { name: 'b.js', data: 'x' },
    ]);
    const pageKeys = world.putOrder.filter((key) => key.startsWith('my-page/'));
    expect(pageKeys.at(-1)).toBe('my-page/index.html');
  });
});

describe('publishPage の上書き', () => {
  it('本人は上書きでき、通知はしない', async () => {
    await publishAs(alice, 'my-page');
    world.notices.length = 0;
    const result = await publishAs(alice, 'my-page', [
      { name: 'index.html', data: '<title>新</title>' },
    ]);
    expect(result.isNew).toBe(false);
    expect(world.notices).toEqual([]);
    expect(world.pages.get('my-page')?.title).toBe('新');
  });

  it('新しい zip に無いファイルを消す', async () => {
    await publishAs(alice, 'my-page');
    await publishAs(alice, 'my-page', [{ name: 'index.html', data: 'x' }]);
    expect([...world.siteFiles.keys()].filter((key) => key.startsWith('my-page/'))).toEqual([
      'my-page/index.html',
    ]);
  });

  it('前方一致する別のページのファイルは消さない', async () => {
    await publishAs(alice, 'my-page');
    await publishAs(alice, 'my-page-2');
    await publishAs(alice, 'my-page', [{ name: 'index.html', data: 'x' }]);
    expect(world.siteFiles.has('my-page-2/style.css')).toBe(true);
  });

  it('他の人は上書きできず、中身も変わらない', async () => {
    await publishAs(alice, 'my-page');
    const before = world.siteFiles.get('my-page/index.html')?.body.toString();
    const error = await errorOf(publishAs(bob, 'my-page', [{ name: 'index.html', data: 'evil' }]));
    expect(error.status).toBe(409);
    expect(error.code).toBe('name_taken');
    expect(world.siteFiles.get('my-page/index.html')?.body.toString()).toBe(before);
    expect(world.pages.get('my-page')?.owner).toBe('alice');
  });

  it('Admin は上書きでき、公開した人は変わらない', async () => {
    await publishAs(alice, 'my-page');
    const result = await publishAs(admin, 'my-page', [
      { name: 'index.html', data: '<title>管理</title>' },
    ]);
    expect(result.page.owner).toBe('alice');
    expect(world.pages.get('my-page')?.owner).toBe('alice');
    expect(world.pages.get('my-page')?.title).toBe('管理');
  });

  it('確認と書き込みの間に他の人が公開しても、条件付きの書き込みで止める', async () => {
    uploadAs(bob, 'race');
    const { claim } = world.deps.pages;
    world.deps.pages.claim = async (input) => {
      await claim({ ...input, actor: 'alice' });
      return claim(input);
    };
    const error = await errorOf(publishPage(world.deps, bob, 'race', TEST_UPLOAD_ID));
    expect(error.code).toBe('name_taken');
    expect(world.siteFiles.has('race/index.html')).toBe(false);
  });
});

describe('publishPage の入力の検査', () => {
  it('不正なページ名を拒否する', async () => {
    expect((await errorOf(publishPage(world.deps, alice, 'NG', TEST_UPLOAD_ID))).code).toBe(
      'invalid_name',
    );
  });

  it.each(['../x', 'not-a-uuid', '', `${TEST_UPLOAD_ID}/../../x`])(
    'uploadId「%s」を拒否する',
    async (id) => {
      expect((await errorOf(publishPage(world.deps, alice, 'p', id))).code).toBe(
        'invalid_upload_id',
      );
    },
  );

  it('zip が届いていなければ 404 にする', async () => {
    expect((await errorOf(publishPage(world.deps, alice, 'p', TEST_UPLOAD_ID))).status).toBe(404);
  });

  it('他の人が送った zip は使えない', async () => {
    uploadAs(alice, 'p');
    expect((await errorOf(publishPage(world.deps, bob, 'p', TEST_UPLOAD_ID))).status).toBe(404);
  });

  it('別のページ名で送った zip は使えない', async () => {
    uploadAs(alice, 'p');
    expect((await errorOf(publishPage(world.deps, alice, 'q', TEST_UPLOAD_ID))).status).toBe(404);
  });

  it('上限より大きい zip は読まずに消す', async () => {
    const small = createFakeWorld({
      limits: { ...world.deps.limits, maxZipBytes: 10 },
    });
    const user = small.addUser('alice');
    small.uploads.set(`uploads/alice/p/${TEST_UPLOAD_ID}.zip`, Buffer.alloc(11));
    const error = await errorOf(publishPage(small.deps, user, 'p', TEST_UPLOAD_ID));
    expect(error.status).toBe(413);
    expect(small.uploads.size).toBe(0);
  });

  it('壊れた zip ならページ情報を作らない', async () => {
    world.uploads.set(`uploads/alice/p/${TEST_UPLOAD_ID}.zip`, Buffer.from('not zip'));
    expect((await errorOf(publishPage(world.deps, alice, 'p', TEST_UPLOAD_ID))).code).toBe(
      'invalid_zip',
    );
    expect(world.pages.has('p')).toBe(false);
    expect(world.notices).toEqual([]);
  });

  it('index が無い zip ならページ情報を作らない', async () => {
    const error = await errorOf(publishAs(alice, 'p', [{ name: 'a.html', data: 'x' }]));
    expect(error.code).toBe('missing_index');
    expect(world.pages.has('p')).toBe(false);
  });
});

describe('publishPage の失敗時', () => {
  it('新規公開で S3 への書き込みに失敗したら、名前を解放して通知しない', async () => {
    world.failSiteFilePut.key = 'my-page/style.css';
    await expect(publishAs(alice, 'my-page')).rejects.toThrow('S3 に書けません');
    expect(world.pages.has('my-page')).toBe(false);
    expect(world.notices).toEqual([]);
  });

  it('上書きで失敗してもページ情報は消さない', async () => {
    await publishAs(alice, 'my-page');
    world.failSiteFilePut.key = 'my-page/style.css';
    await expect(publishAs(alice, 'my-page')).rejects.toThrow();
    expect(world.pages.get('my-page')?.owner).toBe('alice');
  });
});

describe('deletePage', () => {
  beforeEach(async () => {
    await publishAs(alice, 'my-page');
    await publishAs(alice, 'my-page-2');
    world.invalidations.length = 0;
  });

  it.each([
    ['本人', () => alice],
    ['Admin', () => admin],
  ])('%s は削除でき、一覧とキャッシュも更新する', async (_label, user) => {
    await deletePage(world.deps, user(), 'my-page');
    expect(world.pages.has('my-page')).toBe(false);
    expect(world.siteFiles.has('my-page/index.html')).toBe(false);
    expect(world.siteFiles.has('my-page-2/index.html')).toBe(true);
    expect(world.siteFiles.get('index.html')?.body.toString()).not.toContain('href="/my-page/"');
    expect(world.invalidations).toEqual([['/my-page/*', '/index.html', '/']]);
  });

  it('他の人は削除できない', async () => {
    const error = await errorOf(deletePage(world.deps, bob, 'my-page'));
    expect(error.status).toBe(403);
    expect(world.pages.has('my-page')).toBe(true);
    expect(world.siteFiles.has('my-page/index.html')).toBe(true);
  });

  it('無いページは 404 にする', async () => {
    expect((await errorOf(deletePage(world.deps, alice, 'none'))).status).toBe(404);
  });

  it('不正な名前は 400 にする', async () => {
    expect((await errorOf(deletePage(world.deps, admin, '..'))).status).toBe(400);
  });
});

describe('writeStaticPages', () => {
  it('トップと 404 を置く', async () => {
    await writeStaticPages(world.deps);
    expect(world.siteFiles.get('index.html')?.body.toString()).toContain('まだページがありません');
    expect(world.siteFiles.get('404.html')?.body.toString()).toContain('見つかりません');
  });
});
