import { beforeEach, describe, expect, it } from 'vitest';
import { toAppRequest } from '../../src/app/handler.ts';
import type { AppRequest, AppResponse } from '../../src/app/http.ts';
import { handleRequest } from '../../src/app/router.ts';
import { basicHeader, createFakeWorld, type FakeWorld, TEST_UPLOAD_ID } from '../support/fakes.ts';
import { buildZip } from '../support/zip-builder.ts';

let world: FakeWorld;

function send(
  method: string,
  path: string,
  options: { as?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<AppResponse> {
  const { as = 'alice', body, headers = {} } = options;
  const request: AppRequest = {
    method,
    path,
    headers: { ...(as ? { authorization: basicHeader(as) } : {}), ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  };
  return handleRequest(world.deps, request);
}

const bodyOf = (response: AppResponse) => JSON.parse(response.body);

function seedUpload(user: string, name: string, title = 'タイトル') {
  world.uploads.set(
    `uploads/${user}/${name}/${TEST_UPLOAD_ID}.zip`,
    buildZip([{ name: 'index.html', data: `<title>${title}</title>` }]),
  );
}

async function publish(user: string, name: string, title?: string) {
  seedUpload(user, name, title);
  return send('PUT', `/api/pages/${name}`, { as: user, body: { uploadId: TEST_UPLOAD_ID } });
}

beforeEach(() => {
  world = createFakeWorld();
  world.addUser('alice');
  world.addUser('bob');
  world.addUser('root', 'admin');
});

describe('別オリジンからの送信の防止', () => {
  it.each(['POST', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE'])(
    '%s は認証情報があっても 405 にし、何も変えない',
    async (method) => {
      seedUpload('alice', 'p');
      const response = await send(method, '/api/pages/p', { body: { uploadId: TEST_UPLOAD_ID } });
      expect(response.status).toBe(405);
      expect(response.headers.Allow).toBe('GET, PUT, DELETE');
      expect(world.pages.has('p')).toBe(false);
    },
  );

  it.each([
    ['POST', '/api/users/mallory'],
    ['POST', '/api/users/alice/password'],
    ['POST', '/api/pages/p'],
  ])('Admin の認証情報でも %s %s は通らない', async (method, path) => {
    const response = await send(method, path, { as: 'root' });
    expect(response.status).toBe(405);
    expect(world.users.has('mallory')).toBe(false);
  });

  it('OPTIONS（事前確認）に CORS の許可を返さない', async () => {
    const response = await send('OPTIONS', '/api/pages/p', {
      as: null,
      headers: {
        origin: 'https://public.example.invalid',
        'access-control-request-method': 'PUT',
      },
    });
    const names = Object.keys(response.headers).map((name) => name.toLowerCase());
    expect(names.filter((name) => name.startsWith('access-control-'))).toEqual([]);
  });

  it('どの応答にも CORS の許可を付けない', async () => {
    const responses = await Promise.all([
      send('GET', '/api/pages', { headers: { origin: 'https://public.example.invalid' } }),
      send('GET', '/', { as: null }),
      send('PUT', '/api/pages/p', { body: {} }),
    ]);
    for (const response of responses) {
      const names = Object.keys(response.headers).map((name) => name.toLowerCase());
      expect(names.filter((name) => name.startsWith('access-control-'))).toEqual([]);
    }
  });

  it('GET では何も変えない', async () => {
    await send('GET', '/api/users/mallory', { as: 'root' });
    await send('GET', '/api/pages/p/upload');
    expect(world.users.has('mallory')).toBe(false);
  });
});

describe('認証', () => {
  it.each([
    ['GET', '/'],
    ['GET', '/admin.js'],
    ['GET', '/admin.css'],
    ['GET', '/api/me'],
    ['GET', '/api/pages'],
    ['GET', '/api/users'],
    ['GET', '/api/users/alice/password'],
    ['PUT', '/api/pages/p'],
    ['PUT', '/api/pages/p/upload'],
    ['DELETE', '/api/pages/p'],
    ['PUT', '/api/users/x'],
    ['DELETE', '/api/users/x'],
    ['GET', '/api/unknown'],
    ['GET', '/unknown'],
  ])('%s %s は認証情報なしだと 401 にする', async (method, path) => {
    const response = await send(method, path, { as: null });
    expect(response.status).toBe(401);
    expect(response.headers['WWW-Authenticate']).toContain('Basic');
  });

  it('パスワード違いは 401 にする', async () => {
    const response = await handleRequest(world.deps, {
      method: 'GET',
      path: '/api/me',
      headers: { authorization: basicHeader('alice', 'wrong') },
      body: '',
    });
    expect(response.status).toBe(401);
  });

  it('自分の情報にハッシュを含めない', async () => {
    const response = await send('GET', '/api/me');
    expect(bodyOf(response)).toEqual({
      name: 'alice',
      role: 'member',
      createdAt: expect.any(String),
      publicBaseUrl: 'https://public.example.invalid',
    });
  });
});

describe('応答のヘッダー', () => {
  it('管理画面に CSP を付け、zip の送り先だけを許可する', async () => {
    const response = await send('GET', '/');
    expect(response.status).toBe(200);
    const csp = response.headers['Content-Security-Policy'] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://uploads.example.invalid");
  });

  it.each(['/', '/api/me', '/admin.js'])(
    '%s はキャッシュさせず、他サイトから読み込ませない',
    async (path) => {
      const { headers } = await send('GET', path);
      expect(headers['Cache-Control']).toBe('no-store');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    },
  );

  it('画面のファイルを正しい種類で返す', async () => {
    expect((await send('GET', '/admin.js')).headers['Content-Type']).toContain('text/javascript');
    expect((await send('GET', '/admin.css')).headers['Content-Type']).toContain('text/css');
    expect((await send('GET', '/')).headers['Content-Type']).toContain('text/html');
  });

  it('管理画面の HTML にインラインのスクリプトを書かない', async () => {
    const { body } = await send('GET', '/');
    expect(body).toContain('<script src="/admin.js"');
    expect(body).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
  });
});

describe('ページの API', () => {
  it('発行→公開→一覧の流れ', async () => {
    const upload = await send('PUT', '/api/pages/p/upload');
    expect(upload.status).toBe(200);
    expect(bodyOf(upload).uploadId).toBe(TEST_UPLOAD_ID);

    seedUpload('alice', 'p');
    const published = await send('PUT', '/api/pages/p', { body: { uploadId: TEST_UPLOAD_ID } });
    expect(published.status).toBe(201);
    expect(bodyOf(published).url).toBe('https://public.example.invalid/p/');

    const pages = bodyOf(await send('GET', '/api/pages', { as: 'bob' })).pages;
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ name: 'p', owner: 'alice', canModify: false });
  });

  it('上書きは 200 を返す', async () => {
    await publish('alice', 'p');
    expect((await publish('alice', 'p')).status).toBe(200);
  });

  it('一覧の canModify は本人と Admin だけ true にする', async () => {
    await publish('alice', 'p');
    const canModify = async (as: string) =>
      bodyOf(await send('GET', '/api/pages', { as })).pages[0].canModify;
    await expect(canModify('alice')).resolves.toBe(true);
    await expect(canModify('root')).resolves.toBe(true);
    await expect(canModify('bob')).resolves.toBe(false);
  });

  it('一覧は新しい順に返す', async () => {
    world.deps.now = () => new Date('2026-01-01T00:00:00.000Z');
    await publish('alice', 'old');
    world.deps.now = () => new Date('2026-06-01T00:00:00.000Z');
    await publish('alice', 'new');
    const pages = bodyOf(await send('GET', '/api/pages')).pages;
    expect(pages.map((page: { name: string }) => page.name)).toEqual(['new', 'old']);
  });

  it('権限の表', async () => {
    await publish('alice', 'p');
    expect((await publish('bob', 'p')).status).toBe(409);
    expect((await send('DELETE', '/api/pages/p', { as: 'bob' })).status).toBe(403);
    expect((await publish('root', 'p')).status).toBe(200);
    expect((await send('DELETE', '/api/pages/p', { as: 'root' })).status).toBe(200);
  });

  it.each([
    ['JSON が壊れている', 'not json'],
    ['配列', '[]'],
    ['null', 'null'],
    ['uploadId が無い', '{}'],
    ['uploadId が数値', '{"uploadId":1}'],
  ])('公開の本文: %s は 400 にする', async (_label, body) => {
    const response = await handleRequest(world.deps, {
      method: 'PUT',
      path: '/api/pages/p',
      headers: { authorization: basicHeader('alice') },
      body,
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ['GET', '/api/pages/p/upload'],
    ['DELETE', '/api/pages/p/upload'],
    ['GET', '/api/pages/p'],
    ['PUT', '/api/pages'],
    ['DELETE', '/api/pages'],
  ])('%s %s は 405 にする', async (method, path) => {
    expect((await send(method, path, { body: {} })).status).toBe(405);
  });

  it.each(['/api/pages/p/unknown', '/api/pages/p/upload/x', '/api/nothing', '/%E0%A4%A', '/x'])(
    '%s は 404 にする',
    async (path) => {
      expect((await send('GET', path)).status).toBe(404);
    },
  );

  it('エンコードされたスラッシュでページ名を偽れない', async () => {
    const response = await send('PUT', '/api/pages/..%2Fetc', {
      body: { uploadId: TEST_UPLOAD_ID },
    });
    expect(response.status).toBe(400);
    expect(bodyOf(response).error).toBe('invalid_name');
  });
});

describe('ユーザーの API', () => {
  it.each([
    ['GET', '/api/users'],
    ['PUT', '/api/users/mallory'],
    ['DELETE', '/api/users/bob'],
    ['GET', '/api/users/bob/password'],
    ['PUT', '/api/users/bob/password'],
  ])('メンバーの %s %s は 403 にする', async (method, path) => {
    const before = world.passwords.get('bob');
    const response = await send(method, path, { as: 'alice' });
    expect(response.status).toBe(403);
    expect(world.users.has('mallory')).toBe(false);
    expect(world.users.has('bob')).toBe(true);
    expect(world.passwords.get('bob')).toBe(before);
  });

  it('Admin はユーザーを追加でき、そのパスワードで入れる', async () => {
    const created = await send('PUT', '/api/users/carol', { as: 'root' });
    expect(created.status).toBe(201);
    const { password, user } = bodyOf(created);
    expect(user.role).toBe('member');
    const me = await handleRequest(world.deps, {
      method: 'GET',
      path: '/api/me',
      headers: { authorization: basicHeader('carol', password) },
      body: '',
    });
    expect(bodyOf(me).name).toBe('carol');
  });

  it('API から Admin は作れない', async () => {
    const created = await handleRequest(world.deps, {
      method: 'PUT',
      path: '/api/users/carol',
      headers: { authorization: basicHeader('root') },
      body: '{"role":"admin"}',
    });
    expect(bodyOf(created).user.role).toBe('member');
  });

  it('Admin は発行後もパスワードを確認できる', async () => {
    const { password } = bodyOf(await send('PUT', '/api/users/carol', { as: 'root' }));
    const shown = await send('GET', '/api/users/carol/password', { as: 'root' });
    expect(bodyOf(shown).password).toBe(password);
    expect(shown.headers['Cache-Control']).toBe('no-store');
  });

  it('再発行すると古いパスワードでは入れない', async () => {
    const { password: old } = bodyOf(await send('PUT', '/api/users/carol', { as: 'root' }));
    const { password } = bodyOf(await send('PUT', '/api/users/carol/password', { as: 'root' }));
    const login = (value: string) =>
      handleRequest(world.deps, {
        method: 'GET',
        path: '/api/me',
        headers: { authorization: basicHeader('carol', value) },
        body: '',
      });
    expect((await login(old)).status).toBe(401);
    expect((await login(password)).status).toBe(200);
  });

  it('削除すると入れなくなる', async () => {
    expect((await send('DELETE', '/api/users/bob', { as: 'root' })).status).toBe(200);
    expect((await send('GET', '/api/me', { as: 'bob' })).status).toBe(401);
  });

  it('一覧にハッシュもパスワードも含めない', async () => {
    const response = await send('GET', '/api/users', { as: 'root' });
    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain('-password');
    expect(bodyOf(response).users.map((user: { name: string }) => user.name)).toEqual([
      'alice',
      'bob',
      'root',
    ]);
  });

  it.each([
    ['POST', '/api/users/x', 405],
    ['GET', '/api/users/x', 405],
    ['DELETE', '/api/users/x/password', 405],
    ['PUT', '/api/users', 405],
    ['GET', '/api/users/x/unknown', 404],
    ['GET', '/api/users/x/password/y', 404],
  ])('%s %s は %i にする', async (method, path, status) => {
    expect((await send(method, path, { as: 'root' })).status).toBe(status);
  });
});

describe('予期しないエラー', () => {
  it('500 を返し、内部の情報を応答に出さない', async () => {
    world.deps.pages.list = async () => {
      throw new Error('秘密の接続文字列');
    };
    const response = await send('GET', '/api/pages');
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('秘密');
    expect(world.logs[0]?.message).toBe('unexpected_error');
  });
});

describe('toAppRequest', () => {
  const event = (overrides: object) =>
    ({
      rawPath: '/api/me',
      headers: {},
      isBase64Encoded: false,
      requestContext: { http: { method: 'get' } },
      ...overrides,
    }) as Parameters<typeof toAppRequest>[0];

  it('メソッドを大文字に、ヘッダー名を小文字にする', () => {
    const request = toAppRequest(event({ headers: { Authorization: 'Basic x' } }));
    expect(request.method).toBe('GET');
    expect(request.headers.authorization).toBe('Basic x');
  });

  it('Base64 の本文を戻す', () => {
    const body = Buffer.from('{"a":"あ"}', 'utf8').toString('base64');
    expect(toAppRequest(event({ body, isBase64Encoded: true })).body).toBe('{"a":"あ"}');
  });

  it('本文が無ければ空文字にする', () => {
    expect(toAppRequest(event({})).body).toBe('');
  });
});
