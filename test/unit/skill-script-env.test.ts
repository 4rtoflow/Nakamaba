// 環境変数（NAKAMABA_TOKEN か NAKAMABA_AUTHORIZATION と、NAKAMABA_ADMIN_URL）で認証するときの公開スクリプトを、
// 子プロセスで動かす。管理画面は、このテストの中の偽物（受け取った Authorization ヘッダーを記録する）
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(
  new URL('../../plugins/nakamaba/skills/nakamaba/scripts/nakamaba.mjs', import.meta.url),
);
// 秘密を預かる仕組み（vault など）が、外へ送るときに本物へ差し替える前の値に見立てた文字列。
// スクリプトは、これを組み立て直さずに、そのまま Authorization ヘッダーに入れる
const AUTHORIZATION = 'Basic placeholder-from-vault';
// トークンも同じく、ダミーに見立てた文字列。本物のトークンの形（nkmb_…）ではないが、スクリプトは形を確かめない
const TOKEN = 'placeholder-token-from-vault';
const BEARER = `Bearer ${TOKEN}`;
const PUBLIC_URL = 'https://public.example.invalid/env-page/';

interface Received {
  method: string;
  path: string;
  authorization: string | undefined;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let server: Server;
let adminUrl: string;
let workDir: string;
let received: Received[] = [];
let accepts = true;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // 中身は使わない
  }
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    received.push({
      method: request.method ?? '',
      path,
      authorization: request.headers.authorization,
    });
    await drain(request);
    // 署名付きの送り先（S3 の代わり）。管理画面の認証は付かない
    if (path === '/upload') {
      response.writeHead(204).end();
      return;
    }
    if (!accepts || ![AUTHORIZATION, BEARER].includes(request.headers.authorization ?? '')) {
      json(response, 401, { message: 'ログインが必要です。' });
      return;
    }
    if (request.method === 'GET' && path === '/api/me') {
      json(response, 200, { name: 'alice', role: 'member' });
    } else if (request.method === 'GET' && path === '/api/pages') {
      json(response, 200, { pages: [], usage: { usedBytes: 1024, maxBytes: 1024 ** 3 } });
    } else if (request.method === 'PUT' && path === '/api/pages/env-page/upload') {
      json(response, 200, {
        uploadId: 'upload-1',
        maxBytes: 50 * 1024 * 1024,
        upload: { url: `${adminUrl}/upload`, fields: { key: 'uploads/upload-1.zip' } },
      });
    } else if (request.method === 'PUT' && path === '/api/pages/env-page') {
      json(response, 200, { isNew: true, url: PUBLIC_URL });
    } else {
      json(response, 404, { message: '見つかりません。' });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  adminUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  workDir = await mkdtemp(join(tmpdir(), 'nakamaba-env-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  accepts = true;
});

/** スクリプトを動かす。login で保存するファイルは、無い場所を指す（読まないことを確かめる） */
function run(args: string[], env: Record<string, string>): Promise<RunResult> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith('NAKAMABA_') && entry[1] !== undefined,
    ),
  );
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        env: { ...base, NAKAMABA_CREDENTIALS: join(workDir, 'missing'), ...env },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
}

function fromEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { NAKAMABA_AUTHORIZATION: AUTHORIZATION, NAKAMABA_ADMIN_URL: adminUrl, ...extra };
}

async function makeSite(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(workDir, 'site-'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}

describe('環境変数で認証する', () => {
  it('list: 値をそのまま Authorization ヘッダーに使い、ユーザー名は管理画面に聞く（保存したファイルは読まない）', async () => {
    const result = await run(['list'], fromEnv());

    expect(result).toEqual({ code: 0, stdout: 'alice の使用量: 1 KB / 1 GB\n', stderr: '' });
    expect(received.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/me',
      'GET /api/pages',
    ]);
    expect(received.every((request) => request.authorization === AUTHORIZATION)).toBe(true);
  });

  it('publish: 同じ値で公開し、nakamaba.json を残す', async () => {
    const dir = await makeSite({ 'index.md': '# 環境変数で公開' });

    const result = await run(['publish', dir, '--name', 'env-page'], fromEnv());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`公開しました: ${PUBLIC_URL}`);
    expect(JSON.parse(await readFile(join(dir, 'nakamaba.json'), 'utf8'))).toEqual({
      name: 'env-page',
    });
    const apiRequests = received.filter((request) => request.path.startsWith('/api/'));
    expect(apiRequests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/pages',
      'PUT /api/pages/env-page/upload',
      'PUT /api/pages/env-page',
    ]);
    expect(apiRequests.every((request) => request.authorization === AUTHORIZATION)).toBe(true);
    // 署名付きの送り先には、管理画面の認証を送らない
    expect(received.find((request) => request.path === '/upload')?.authorization).toBeUndefined();
  });

  it('管理画面の URL が無ければ、何も送らずに NAKAMABA_ADMIN_URL を案内する', async () => {
    const result = await run(['list'], { NAKAMABA_AUTHORIZATION: AUTHORIZATION });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      '環境変数 NAKAMABA_AUTHORIZATION を使うときは、管理画面の URL を環境変数 NAKAMABA_ADMIN_URL で指定してください。',
    );
    expect(received).toEqual([]);
  });

  it('手元の開発環境のほかは、https でない URL を受け付けない', async () => {
    const result = await run(
      ['list'],
      fromEnv({ NAKAMABA_ADMIN_URL: 'http://admin.example.invalid' }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('https://');
  });

  it('値で認証できなければ、login ではなく、本人に値を確かめてもらうよう伝える', async () => {
    accepts = false;

    const result = await run(['list'], fromEnv());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      '環境変数 NAKAMABA_AUTHORIZATION の値では、ログインできませんでした。値が正しいかを、本人に確かめてもらってください。',
    );
    expect(result.stderr).not.toContain('login');
  });

  it('管理画面につながらなければ、login ではなく、URL を確かめるよう伝える', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const result = await run(['list'], fromEnv({ NAKAMABA_ADMIN_URL: `http://127.0.0.1:${port}` }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`管理画面に接続できません（http://127.0.0.1:${port}）`);
    expect(result.stderr).toContain('環境変数 NAKAMABA_ADMIN_URL の URL を確かめてください。');
    expect(result.stderr).not.toContain('login');
  });
});

describe('エージェント用のトークンで認証する', () => {
  const withToken = (extra: Record<string, string> = {}) => ({
    NAKAMABA_TOKEN: TOKEN,
    NAKAMABA_ADMIN_URL: adminUrl,
    ...extra,
  });

  it('list: トークンの形を確かめず、前に Bearer を付けるだけで送る（保存したファイルは読まない）', async () => {
    const result = await run(['list'], withToken());

    expect(result).toEqual({ code: 0, stdout: 'alice の使用量: 1 KB / 1 GB\n', stderr: '' });
    expect(received.map((request) => request.authorization)).toEqual([BEARER, BEARER]);
  });

  it('publish: 同じヘッダーで公開し、署名付きの送り先には送らない', async () => {
    const dir = await makeSite({ 'index.md': '# トークンで公開' });

    const result = await run(['publish', dir, '--name', 'env-page'], withToken());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`公開しました: ${PUBLIC_URL}`);
    const apiRequests = received.filter((request) => request.path.startsWith('/api/'));
    expect(apiRequests.map((request) => request.authorization)).toEqual([BEARER, BEARER, BEARER]);
    expect(received.find((request) => request.path === '/upload')?.authorization).toBeUndefined();
  });

  it('NAKAMABA_AUTHORIZATION もあるときは、トークンを使う', async () => {
    const result = await run(['list'], withToken({ NAKAMABA_AUTHORIZATION: AUTHORIZATION }));

    expect(result.code).toBe(0);
    expect(received.every((request) => request.authorization === BEARER)).toBe(true);
  });

  it('管理画面の URL が無ければ、何も送らずに NAKAMABA_ADMIN_URL を案内する', async () => {
    const result = await run(['list'], { NAKAMABA_TOKEN: TOKEN });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      '環境変数 NAKAMABA_TOKEN を使うときは、管理画面の URL を環境変数 NAKAMABA_ADMIN_URL で指定してください。',
    );
    expect(received).toEqual([]);
  });

  it('トークンで認証できなければ、login ではなく、取り消しと期限を本人に確かめてもらうよう伝える', async () => {
    accepts = false;

    const result = await run(['list'], withToken());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      '環境変数 NAKAMABA_TOKEN のトークンでは、ログインできませんでした。トークンが取り消されていないか、90 日使われずに使えなくなっていないかを、本人に確かめてもらってください。',
    );
    expect(result.stderr).not.toContain('login');
  });
});
