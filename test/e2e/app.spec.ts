import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { addUser, devState, loginContext, openAdmin, publishZip } from './helpers.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test.describe.configure({ mode: 'serial' });

let adminContext: BrowserContext;
let adminPage: Page;
let aliceContext: BrowserContext;
let alicePage: Page;
let bobContext: BrowserContext;
let bobPage: Page;
let bobPassword: string;

test.beforeAll(async ({ browser }) => {
  const state = devState();
  adminContext = await loginContext(browser, state.adminName, state.password);
  adminPage = await openAdmin(adminContext);
});

test.afterAll(async () => {
  await Promise.all([adminContext?.close(), aliceContext?.close(), bobContext?.close()]);
});

test('ログインしていなければ管理画面は 401 を返す', async ({ browser }) => {
  const context = await browser.newContext();
  const response = await context.request.get(devState().adminOrigin, { maxRedirects: 0 });
  expect(response.status()).toBe(401);
  expect(response.headers()['www-authenticate']).toContain('Basic');
  await context.close();
});

test('Admin はユーザーを追加でき、後からパスワードを確認できる', async ({ browser }) => {
  const alicePassword = await addUser(adminPage, 'alice');
  bobPassword = await addUser(adminPage, 'bob');
  await expect(adminPage.locator('#status')).toContainText('追加しました');

  await adminPage.reload();
  const row = adminPage.locator('[data-user="alice"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.password')).toHaveCount(0);
  await row.getByRole('button', { name: 'パスワードを表示' }).click();
  await expect(row.locator('.password')).toHaveText(alicePassword);

  aliceContext = await loginContext(browser, 'alice', alicePassword);
  alicePage = await openAdmin(aliceContext);
  bobContext = await loginContext(browser, 'bob', bobPassword);
  bobPage = await openAdmin(bobContext);
});

test('メンバーにはユーザーの管理が出ない', async () => {
  await expect(alicePage.locator('#who')).toHaveText('alice');
  await expect(alicePage.locator('#public-link')).toHaveAttribute('href', devState().publicOrigin);
  await expect(alicePage.locator('#users-panel')).toBeHidden();
  await expect(adminPage.locator('#users-panel')).toBeVisible();
});

test('管理画面から zip を公開でき、公開側で CSS と画像つきで開ける', async () => {
  await publishZip(alicePage, 'cats', [
    {
      name: 'index.html',
      data: '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>猫の写真</title><link rel="stylesheet" href="style.css"></head><body><h1 id="h">猫</h1><a id="next" href="docs/">次へ</a></body></html>',
    },
    { name: 'style.css', data: 'h1 { color: rgb(255, 0, 0); }' },
    { name: 'thumbnail.png', data: PNG },
    { name: 'docs/index.md', data: '# 説明\n\n[戻る](../index.html)' },
  ]);
  await expect(alicePage.locator('#status')).toContainText('公開しました');
  await expect(alicePage.locator('[data-page="cats"]')).toContainText('猫の写真');

  const { publicOrigin } = devState();
  const visitor = await alicePage.context().browser()?.newContext();
  if (!visitor) throw new Error('context を作れません');
  const page = await visitor.newPage();

  // 認証なしで誰でも見られ、末尾の / が無くても相対パスの CSS が効く
  await page.goto(`${publicOrigin}/cats`);
  expect(new URL(page.url()).pathname).toBe('/cats/');
  await expect(page.locator('#h')).toHaveCSS('color', 'rgb(255, 0, 0)');

  // Markdown は公開時に HTML へ変換されている
  await page.locator('#next').click();
  await expect(page.locator('h1')).toHaveText('説明');
  await expect(page).toHaveTitle('説明');
  await visitor.close();
});

test('公開側のトップにカードの一覧が出る', async ({ browser }) => {
  const { publicOrigin } = devState();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(publicOrigin);
  const card = page.locator('a.card[href="/cats/"]');
  await expect(card).toContainText('猫の写真');
  await expect(card).toContainText('alice');
  const image = card.locator('img.thumb');
  await expect(image).toHaveAttribute('src', '/cats/thumbnail.png');
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
  await card.click();
  await expect(page.locator('#h')).toHaveText('猫');
  await context.close();
});

test('無いページは 404 を返し、一覧へ戻れる', async ({ browser }) => {
  const { publicOrigin } = devState();
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(`${publicOrigin}/does-not-exist/`);
  expect(response?.status()).toBe(404);
  await expect(page.locator('h1')).toContainText('見つかりません');
  await page.getByRole('link', { name: '一覧へ戻る' }).click();
  await expect(page.locator('a.card[href="/cats/"]')).toBeVisible();
  await context.close();
});

test('他の人のページ名では公開できず、削除ボタンも出ない', async () => {
  await bobPage.reload();
  await publishZip(bobPage, 'cats', [{ name: 'index.html', data: '乗っ取り' }]);
  await expect(bobPage.locator('#status')).toContainText('他の人が公開しています');
  await expect(bobPage.locator('#status')).toHaveClass(/error/);
  await expect(bobPage.locator('[data-page="cats"]').getByRole('button')).toHaveCount(0);
  const { publicOrigin } = devState();
  const response = await bobPage.request.get(`${publicOrigin}/cats/`);
  expect(await response.text()).not.toContain('乗っ取り');
});

test('zip の直下に index が無ければ、理由を表示する', async () => {
  await publishZip(alicePage, 'no-index', [{ name: 'site/index.html', data: 'x' }]);
  await expect(alicePage.locator('#status')).toContainText('zip の直下に index.html か index.md');
});

test('タイトルに HTML を入れても、管理画面と一覧で実行されない', async ({ browser }) => {
  const attack = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
  await publishZip(alicePage, 'xss', [
    { name: 'index.md', data: `# ${attack.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}` },
  ]);
  await expect(alicePage.locator('#status')).toContainText('公開しました');

  await adminPage.reload();
  const row = adminPage.locator('[data-page="xss"]');
  await expect(row).toContainText('<img src=x');
  expect(await row.locator('img').count()).toBe(0);
  expect(
    await adminPage.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(devState().publicOrigin);
  const card = page.locator('a.card[href="/xss/"]');
  await expect(card).toContainText('<img src=x');
  expect(await card.locator('.title img').count()).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();
  await context.close();
});

test('公開ページの JS から、管理 API を操作できない', async () => {
  const { adminOrigin, publicOrigin } = devState();

  // 友人の公開ページを、ログイン済みの Admin が開いた状況を作る
  await publishZip(alicePage, 'attacker', [
    { name: 'index.html', data: '<!doctype html><title>罠</title><h1>罠</h1>' },
  ]);
  await expect(alicePage.locator('#status')).toContainText('公開しました');

  const victim = await adminContext.newPage();
  await victim.goto(`${publicOrigin}/attacker/`);

  const results = await victim.evaluate(async (admin) => {
    const attempt = async (path: string, init: RequestInit) => {
      try {
        const response = await fetch(`${admin}${path}`, { credentials: 'include', ...init });
        return { status: response.status, type: response.type };
      } catch (error) {
        return { blocked: (error as Error).name };
      }
    };
    return {
      createUser: await attempt('/api/users/mallory', { method: 'PUT' }),
      deleteUser: await attempt('/api/users/bob', { method: 'DELETE' }),
      deletePage: await attempt('/api/pages/cats', { method: 'DELETE' }),
      readPassword: await attempt('/api/users/alice/password', { method: 'GET' }),
      noCorsPost: await attempt('/api/users/mallory', { method: 'POST', mode: 'no-cors' }),
      noCorsPut: await attempt('/api/users/mallory', { method: 'PUT', mode: 'no-cors' }),
    };
  }, adminOrigin);

  // PUT と DELETE はブラウザが事前確認で止め、読み取りは CORS で止まる
  expect(results.createUser).toEqual({ blocked: 'TypeError' });
  expect(results.deleteUser).toEqual({ blocked: 'TypeError' });
  expect(results.deletePage).toEqual({ blocked: 'TypeError' });
  expect(results.readPassword).toEqual({ blocked: 'TypeError' });
  // no-cors の PUT はブラウザが送らない。POST は届くがサーバーが 405 で拒否し、
  // 応答も Cross-Origin-Resource-Policy で読めない
  expect(results.noCorsPut).toEqual({ blocked: 'TypeError' });
  expect(results.noCorsPost).toEqual({ blocked: 'TypeError' });

  // フォームの POST でも操作できない
  await victim.goto(`${publicOrigin}/attacker/`);
  const [formResponse] = await Promise.all([
    victim.waitForResponse((response) => response.url().startsWith(adminOrigin)),
    victim.evaluate((admin) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = `${admin}/api/users/mallory`;
      document.body.append(form);
      form.submit();
    }, adminOrigin),
  ]);
  expect(formResponse.status()).toBe(405);
  // 遷移の途中で閉じると page.close() が返らないことがあるので、遷移の完了を待つ
  await victim.waitForURL(`${adminOrigin}/api/users/mallory`);
  await victim.close();

  // 実際に何も変わっていないことを、Admin の画面で確かめる
  await adminPage.reload();
  await expect(adminPage.locator('[data-user="alice"]')).toBeVisible();
  await expect(adminPage.locator('[data-user="bob"]')).toBeVisible();
  await expect(adminPage.locator('[data-user="mallory"]')).toHaveCount(0);
  await expect(adminPage.locator('[data-page="cats"]')).toBeVisible();
});

test('管理画面は iframe に埋め込めない', async () => {
  const { adminOrigin, publicOrigin } = devState();
  const page = await adminContext.newPage();
  await page.goto(`${publicOrigin}/attacker/`);
  await page.evaluate((admin) => {
    const frame = document.createElement('iframe');
    frame.src = admin;
    frame.id = 'target';
    document.body.append(frame);
  }, adminOrigin);
  await page.waitForTimeout(500);
  const frame = page.frames().find((item) => item.url().startsWith(adminOrigin));
  const content = await frame
    ?.locator('#publish-form')
    .count()
    .catch(() => 0);
  expect(content ?? 0).toBe(0);
  await page.close();
});

test('再発行すると古いパスワードでは入れない', async ({ browser }) => {
  const row = adminPage.locator('[data-user="bob"]');
  adminPage.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: '再発行' }).click();
  await expect(adminPage.locator('#status')).toContainText('再発行しました');
  const next = (await row.locator('.password').textContent()) ?? '';
  expect(next).not.toBe(bobPassword);

  const { adminOrigin } = devState();
  const old = await browser.newContext();
  const auth = (password: string) => `Basic ${Buffer.from(`bob:${password}`).toString('base64')}`;
  const denied = await old.request.get(`${adminOrigin}/api/me`, {
    headers: { Authorization: auth(bobPassword) },
  });
  expect(denied.status()).toBe(401);
  const allowed = await old.request.get(`${adminOrigin}/api/me`, {
    headers: { Authorization: auth(next) },
  });
  expect(allowed.status()).toBe(200);
  await old.close();
});

test('本人が削除すると、公開側からも消える', async () => {
  const row = alicePage.locator('[data-page="xss"]');
  await alicePage.reload();
  alicePage.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'xss を削除' }).click();
  await expect(row).toHaveCount(0);
  const { publicOrigin } = devState();
  const response = await alicePage.request.get(`${publicOrigin}/xss/`);
  expect(response.status()).toBe(404);
});

test('Admin は他の人のページを削除でき、ダイアログを断れば消えない', async () => {
  await adminPage.reload();
  const row = adminPage.locator('[data-page="attacker"]');
  adminPage.once('dialog', (dialog) => dialog.dismiss());
  await row.getByRole('button', { name: 'attacker を削除' }).click();
  await expect(row).toBeVisible();
  adminPage.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'attacker を削除' }).click();
  await expect(row).toHaveCount(0);
});

test('Admin はユーザーを削除でき、自分は削除できない', async () => {
  await expect(
    adminPage.locator('[data-user="admin"]').getByRole('button', { name: 'admin を削除' }),
  ).toHaveCount(0);
  adminPage.once('dialog', (dialog) => dialog.accept());
  await adminPage.locator('[data-user="bob"]').getByRole('button', { name: 'bob を削除' }).click();
  await expect(adminPage.locator('[data-user="bob"]')).toHaveCount(0);
});
