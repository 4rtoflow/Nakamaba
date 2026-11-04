import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { NakamabaStack } from '../../infra/stack.ts';
import { createAwsDeps } from '../../src/app/aws.ts';
import { bootstrapAdmin } from '../../src/app/bootstrap.ts';
import { basicHeader } from '../support/fakes.ts';
import { provisionLocalAws } from '../support/local-aws.ts';
import { buildZip } from '../support/zip-builder.ts';

// テストのコードではなく、デプロイされるファイルそのものが動くことを確かめる
let outdir: string;
let assetDir: string;
let adminPassword: string;
let handler: (
  event: unknown,
) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;

function event(method: string, path: string, authorization?: string) {
  return {
    rawPath: path,
    headers: authorization ? { authorization } : {},
    isBase64Encoded: false,
    requestContext: { http: { method } },
  };
}

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), 'nakamaba-bundle-'));
  const app = new App({ outdir });
  const stack = new NakamabaStack(app, 'Bundle', {
    env: { region: 'ap-northeast-1', account: '111111111111' },
    reservedConcurrency: undefined,
  });
  Template.fromStack(stack);

  const dir = readdirSync(outdir).find(
    (name) =>
      name.startsWith('asset.') &&
      statSync(join(outdir, name)).isDirectory() &&
      readdirSync(join(outdir, name)).includes('index.mjs'),
  );
  if (!dir) throw new Error('バンドルが見つかりません');
  assetDir = join(outdir, dir);

  const config = await provisionLocalAws(inject('motoEndpoint'), {
    publicBaseUrl: 'https://public.example.invalid',
  });
  Object.assign(process.env, {
    USERS_TABLE: config.usersTable,
    PAGES_TABLE: config.pagesTable,
    SITE_BUCKET: config.siteBucket,
    UPLOAD_BUCKET: config.uploadBucket,
    DISTRIBUTION_ID: config.distributionId,
    PUBLIC_BASE_URL: config.publicBaseUrl,
    UPLOAD_ORIGIN: config.uploadOrigin,
    PARAMETER_PREFIX: config.parameterPrefix,
    S3_FORCE_PATH_STYLE: 'true',
  });
  adminPassword = (await bootstrapAdmin(createAwsDeps(config), 'root')).password;
  const module = await import(/* @vite-ignore */ join(assetDir, 'index.mjs'));
  handler = module.handler;
});

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe('デプロイされるバンドル', () => {
  it('管理画面のファイルを同梱している', () => {
    expect(readdirSync(join(assetDir, 'admin-assets')).sort()).toEqual([
      'admin.css',
      'admin.js',
      'apple-touch-icon.png',
      'favicon.ico',
      'favicon.svg',
      'index.html',
      'theme.js',
    ]);
  });

  it('Lambda の形のイベントで認証を求める', async () => {
    const response = await handler(event('GET', '/api/me'));
    expect(response.statusCode).toBe(401);
    expect(response.headers['WWW-Authenticate']).toContain('Basic');
  });

  it('管理画面を認証なしで返し、API では AWS SDK も動く', async () => {
    const page = await handler(event('GET', '/'));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('login-form');

    const script = await handler(event('GET', '/admin.js'));
    expect(script.body).toContain('textContent');

    const authorization = basicHeader('root', adminPassword);

    const me = await handler(event('GET', '/api/me', authorization));
    expect(JSON.parse(me.body)).toMatchObject({ name: 'root', role: 'admin' });

    const upload = await handler(event('PUT', '/api/pages/p/upload', authorization));
    expect(JSON.parse(upload.body).upload.fields.Policy).toBeTruthy();
  });

  it('CommonJS の依存（zip の展開）と Markdown の変換も ESM のバンドルで動く', async () => {
    const authorization = basicHeader('root', adminPassword);
    const upload = JSON.parse(
      (await handler(event('PUT', '/api/pages/from-bundle/upload', authorization))).body,
    );
    const form = new FormData();
    for (const [field, value] of Object.entries<string>(upload.upload.fields)) {
      form.append(field, value);
    }
    form.append(
      'file',
      new Blob([new Uint8Array(buildZip([{ name: 'index.md', data: '# バンドルから公開' }]))]),
    );
    expect((await fetch(upload.upload.url, { method: 'POST', body: form })).status).toBeLessThan(
      300,
    );

    const published = await handler({
      ...event('PUT', '/api/pages/from-bundle', authorization),
      body: JSON.stringify({ uploadId: upload.uploadId }),
    });
    expect(published.statusCode).toBe(201);
    expect(JSON.parse(published.body).page.title).toBe('バンドルから公開');
  });
});
