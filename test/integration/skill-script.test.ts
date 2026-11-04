// プラグインの公開スクリプトを子プロセスで動かし、moto につないだ API へ実際に公開する
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type AwsConfig, createAwsDeps } from '../../src/app/aws.ts';
import { bootstrapAdmin } from '../../src/app/bootstrap.ts';
import type { Deps } from '../../src/app/deps.ts';
import { handleRequest } from '../../src/app/router.ts';
import { basicHeader } from '../support/fakes.ts';
import { provisionLocalAws } from '../support/local-aws.ts';

const SCRIPT = fileURLToPath(
  new URL('../../plugins/nakamaba/skills/nakamaba/scripts/nakamaba.mjs', import.meta.url),
);
const PUBLIC_BASE_URL = 'https://public.example.invalid';

let config: AwsConfig;
let deps: Deps;
let s3: S3Client;
let server: Server;
let adminUrl: string;
let workDir: string;
const passwords = new Map<string, string>();

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function credentialsFor(username: string, password?: string): Promise<string> {
  const path = join(workDir, `credentials-${username}-${password ? 'custom' : 'ok'}`);
  const value = { adminUrl, username, password: password ?? passwords.get(username) };
  await writeFile(path, JSON.stringify(value));
  return path;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], credentials: string, input = ''): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, NAKAMABA_CREDENTIALS: credentials } },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
    child.stdin?.end(input);
  });
}

async function makeSite(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(workDir, 'site-'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}

async function siteKeys(prefix: string): Promise<string[]> {
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: config.siteBucket, Prefix: prefix }),
  );
  return (result.Contents ?? []).map((object) => object.Key ?? '').sort();
}

async function siteText(key: string): Promise<string> {
  const object = await s3.send(new GetObjectCommand({ Bucket: config.siteBucket, Key: key }));
  return (await object.Body?.transformToString()) ?? '';
}

async function savedName(dir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, 'nakamaba.json'), 'utf8'));
}

beforeAll(async () => {
  config = await provisionLocalAws(inject('motoEndpoint'), { publicBaseUrl: PUBLIC_BASE_URL });
  s3 = new S3Client({ forcePathStyle: true });
  deps = createAwsDeps(config);
  const root = await bootstrapAdmin(deps, 'root');
  for (const name of ['alice', 'bob']) {
    const created = await handleRequest(deps, {
      method: 'PUT',
      path: `/api/users/${name}`,
      headers: { authorization: basicHeader('root', root.password) },
      body: '',
    });
    passwords.set(name, JSON.parse(created.body).password);
  }

  server = createServer(async (request, response) => {
    const result = await handleRequest(deps, {
      method: request.method ?? 'GET',
      path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      headers: { authorization: request.headers.authorization },
      body: await readBody(request),
    });
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  adminUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  workDir = await mkdtemp(join(tmpdir(), 'nakamaba-skill-'));
});

afterAll(async () => {
  server?.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('publish', () => {
  it('初回は nakamaba.json を残し、. で始まるものと node_modules は送らない', async () => {
    const css = 'body { color: #141414; }\n'.repeat(200);
    const dir = await makeSite({
      'index.html': '<title>スキル</title><link href="style.css" rel="stylesheet">',
      'a.txt': 'a',
      'style.css': css,
      'sub/notes.md': '# メモ',
      '.env': 'SECRET=1',
      '.git/config': '[core]',
      'node_modules/x/index.js': 'x',
    });

    const result = await run(
      ['publish', dir, '--name', 'skill-new'],
      await credentialsFor('alice'),
    );

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain(`公開しました: ${PUBLIC_BASE_URL}/skill-new/`);
    expect(result.stdout).toContain('送らなかったもの: .env, .git, node_modules/');
    expect(await savedName(dir)).toEqual({ name: 'skill-new' });
    expect(await siteKeys('skill-new/')).toEqual([
      'skill-new/a.txt',
      'skill-new/index.html',
      'skill-new/style.css',
      'skill-new/sub/notes.html',
    ]);
    // 圧縮したファイル（style.css）と、圧縮しないファイル（a.txt）の両方がそのまま戻る
    expect(await siteText('skill-new/style.css')).toBe(css);
    expect(await siteText('skill-new/a.txt')).toBe('a');
  });

  it('2 回目は nakamaba.json のページを更新し、消したファイルは公開側からも消える', async () => {
    const credentials = await credentialsFor('alice');
    const dir = await makeSite({ 'index.html': '<title>一</title>', 'old.txt': 'old' });
    expect((await run(['publish', dir, '--name', 'skill-update'], credentials)).code).toBe(0);

    await rm(join(dir, 'old.txt'));
    await writeFile(join(dir, 'index.html'), '<title>二</title>');
    const result = await run(['publish', dir], credentials);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`更新しました: ${PUBLIC_BASE_URL}/skill-update/`);
    expect(await siteKeys('skill-update/')).toEqual(['skill-update/index.html']);
    expect(await siteText('skill-update/index.html')).toContain('二');
  });

  it('nakamaba.json が無いフォルダで既にある自分のページ名を指定すると、--overwrite まで上書きしない', async () => {
    const credentials = await credentialsFor('alice');
    const first = await makeSite({ 'index.html': '<title>最初</title>' });
    expect((await run(['publish', first, '--name', 'skill-own'], credentials)).code).toBe(0);
    const second = await makeSite({ 'index.html': '<title>別のフォルダ</title>' });

    const stopped = await run(['publish', second, '--name', 'skill-own'], credentials);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain('--overwrite');
    expect(await siteText('skill-own/index.html')).toContain('最初');
    await expect(stat(join(second, 'nakamaba.json'))).rejects.toThrow();

    const overwritten = await run(
      ['publish', second, '--name', 'skill-own', '--overwrite'],
      credentials,
    );
    expect(overwritten.code).toBe(0);
    expect(overwritten.stdout).toContain('更新しました');
    expect(await siteText('skill-own/index.html')).toContain('別のフォルダ');
    expect(await savedName(second)).toEqual({ name: 'skill-own' });
  });

  it('他の人のページ名は、--overwrite を付けても使えない', async () => {
    const alices = await makeSite({ 'index.html': '<title>alice のページ</title>' });
    const published = await run(
      ['publish', alices, '--name', 'skill-alice'],
      await credentialsFor('alice'),
    );
    expect(published.code).toBe(0);
    const bobs = await makeSite({ 'index.html': '<title>bob のページ</title>' });

    const result = await run(
      ['publish', bobs, '--name', 'skill-alice', '--overwrite'],
      await credentialsFor('bob'),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('alice が公開しています');
    expect(await siteText('skill-alice/index.html')).toContain('alice のページ');
  });

  it('nakamaba.json と違うページ名を指定すると、ログインを確かめる前に止まる', async () => {
    const dir = await makeSite({
      'index.html': '<title>x</title>',
      'nakamaba.json': '{"name": "skill-one"}',
    });
    const result = await run(['publish', dir, '--name', 'skill-two'], join(workDir, 'missing'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('「skill-one」として公開済み');
  });

  it('直下に index.html も index.md も無いと送らない', async () => {
    const dir = await makeSite({ 'site/index.html': '<title>x</title>' });
    const result = await run(['publish', dir, '--name', 'skill-noindex'], join(workDir, 'missing'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('直下に index.html か index.md が必要です');
  });

  it('URL に使えないページ名は送らない', async () => {
    const dir = await makeSite({ 'index.md': '# x' });
    const result = await run(['publish', dir, '--name', 'Bad_Name'], join(workDir, 'missing'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('英小文字・数字・ハイフン');
  });

  it('ファイルが 1000 個を超えるフォルダは、読み込む前に止める', async () => {
    const files: Record<string, string> = { 'index.html': '<title>x</title>' };
    for (let i = 0; i < 1000; i += 1) files[`f/${i}.txt`] = '';
    const dir = await makeSite(files);
    const result = await run(['publish', dir, '--name', 'skill-many'], join(workDir, 'missing'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ファイルが多すぎます');
  });

  it('ログインしていないと、本人が別のターミナルで実行する login を案内する', async () => {
    const dir = await makeSite({ 'index.md': '# x' });
    const result = await run(['publish', dir, '--name', 'skill-nologin'], join(workDir, 'missing'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('まだログインしていません');
    expect(result.stderr).toContain(`node "${SCRIPT}" login`);
  });

  it('パスワードが違うと、login のやり直しを案内する', async () => {
    const dir = await makeSite({ 'index.md': '# x' });
    const result = await run(
      ['publish', dir, '--name', 'skill-wrong'],
      await credentialsFor('alice', 'wrong-password'),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ユーザー名かパスワードが違います');
    expect(result.stderr).toContain('login');
    expect(await siteKeys('skill-wrong/')).toEqual([]);
  });
});

describe('login', () => {
  it('正しいパスワードなら、本人だけが読める権限で保存する', async () => {
    const path = join(workDir, 'login-ok', 'credentials');
    const password = passwords.get('alice') ?? '';

    const result = await run(['login'], path, `${adminUrl}/\nalice\n${password}\n`);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(password);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      adminUrl,
      username: 'alice',
      password,
    });
  });

  it('パスワードが違うと保存しない', async () => {
    const path = join(workDir, 'login-wrong', 'credentials');
    const result = await run(['login'], path, `${adminUrl}\nalice\nwrong-password\n`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ユーザー名かパスワードが違います');
    await expect(stat(path)).rejects.toThrow();
  });

  it('手元の開発環境のほかは、https でない URL を受け付けない', async () => {
    const path = join(workDir, 'login-http', 'credentials');
    const result = await run(['login'], path, 'http://admin.example.invalid\nalice\npassword\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('https://');
    await expect(stat(path)).rejects.toThrow();
  });
});
