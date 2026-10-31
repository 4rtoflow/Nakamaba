import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { type AwsConfig, createAwsDeps } from '../../src/app/aws.ts';
import { handleRequest } from '../../src/app/router.ts';
import { basicHeader } from '../support/fakes.ts';
import { provisionLocalAws } from '../support/local-aws.ts';

let config: AwsConfig;

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync('node', ['--import', 'tsx', 'scripts/bootstrap-admin.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function configEnv(): Record<string, string> {
  return {
    USERS_TABLE: config.usersTable,
    PAGES_TABLE: config.pagesTable,
    SITE_BUCKET: config.siteBucket,
    PARAMETER_PREFIX: config.parameterPrefix,
    S3_FORCE_PATH_STYLE: 'true',
  };
}

beforeAll(async () => {
  config = await provisionLocalAws(inject('motoEndpoint'), {
    publicBaseUrl: 'https://public.example.invalid',
  });
});

describe('npm run bootstrap-admin', () => {
  it('Admin を作り、表示されたパスワードで入れる', async () => {
    const result = runCli(['first-admin'], configEnv());
    expect(result.status).toBe(0);
    const password = /パスワード: (\S+)/.exec(result.stdout)?.[1] ?? '';
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const deps = createAwsDeps(config);
    const me = await handleRequest(deps, {
      method: 'GET',
      path: '/api/me',
      headers: { authorization: basicHeader('first-admin', password) },
      body: '',
    });
    expect(JSON.parse(me.body)).toMatchObject({ name: 'first-admin', role: 'admin' });
    await expect(deps.secrets.getPassword('first-admin')).resolves.toBe(password);
    expect(await deps.siteFiles.list('404.html')).toEqual(['404.html']);
  });

  it('同じ名前で実行しても失敗し、パスワードを変えない', async () => {
    const deps = createAwsDeps(config);
    const before = await deps.secrets.getPassword('first-admin');
    const result = runCli(['first-admin'], configEnv());
    expect(result.status).not.toBe(0);
    await expect(deps.secrets.getPassword('first-admin')).resolves.toBe(before);
  });

  it('ユーザー名が無ければ使い方を出して失敗する', () => {
    const result = runCli([], configEnv());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('使い方');
  });

  it('環境変数が足りなければ、どれが無いかを出して失敗する', () => {
    const result = runCli(['someone'], { USERS_TABLE: '', PAGES_TABLE: 'x', SITE_BUCKET: 'y' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('USERS_TABLE');
  });
});
