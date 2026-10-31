import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type AwsConfig, createAwsDeps } from '../../src/app/aws.ts';
import { bootstrapAdmin } from '../../src/app/bootstrap.ts';
import type { Deps } from '../../src/app/deps.ts';
import type { AppResponse } from '../../src/app/http.ts';
import { handleRequest } from '../../src/app/router.ts';
import { basicHeader } from '../support/fakes.ts';
import { provisionLocalAws } from '../support/local-aws.ts';
import { buildZip } from '../support/zip-builder.ts';

let config: AwsConfig;
let deps: Deps;
let s3: S3Client;
let adminPassword: string;
let webhookServer: Server;
const webhookBodies: Array<{ content: string; allowed_mentions: unknown }> = [];
const logins = new Map<string, string>();

function send(method: string, path: string, as: string, body?: unknown): Promise<AppResponse> {
  return handleRequest(deps, {
    method,
    path,
    headers: { authorization: basicHeader(as, logins.get(as) ?? '') },
    body: body === undefined ? '' : JSON.stringify(body),
  });
}

async function siteObject(key: string): Promise<{ text: string; contentType: string | undefined }> {
  const object = await s3.send(new GetObjectCommand({ Bucket: config.siteBucket, Key: key }));
  return { text: (await object.Body?.transformToString()) ?? '', contentType: object.ContentType };
}

async function siteKeys(prefix: string): Promise<string[]> {
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: config.siteBucket, Prefix: prefix }),
  );
  return (result.Contents ?? []).map((object) => object.Key ?? '');
}

async function uploadAndPublish(as: string, name: string, zip: Buffer): Promise<AppResponse> {
  const upload = await send('PUT', `/api/pages/${name}/upload`, as);
  if (upload.status !== 200) return upload;
  const { uploadId, upload: presigned } = JSON.parse(upload.body);
  const form = new FormData();
  for (const [field, value] of Object.entries<string>(presigned.fields)) form.append(field, value);
  form.append('file', new Blob([new Uint8Array(zip)]));
  const sent = await fetch(presigned.url, { method: 'POST', body: form });
  expect(sent.status).toBeLessThan(300);
  return send('PUT', `/api/pages/${name}`, as, { uploadId });
}

async function createMember(name: string): Promise<void> {
  const response = await send('PUT', `/api/users/${name}`, 'root');
  expect(response.status).toBe(201);
  logins.set(name, JSON.parse(response.body).password);
}

beforeAll(async () => {
  config = await provisionLocalAws(inject('motoEndpoint'), {
    publicBaseUrl: 'https://public.example.invalid',
  });
  s3 = new S3Client({ forcePathStyle: true });
  deps = createAwsDeps(config);
  adminPassword = (await bootstrapAdmin(deps, 'root')).password;
  logins.set('root', adminPassword);
  await createMember('alice');
  await createMember('bob');

  webhookServer = createServer((request, response) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => {
      webhookBodies.push(JSON.parse(data));
      response.statusCode = 204;
      response.end();
    });
  });
  await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', resolve));
  const { port } = webhookServer.address() as AddressInfo;
  await new SSMClient({}).send(
    new PutParameterCommand({
      Name: `${config.parameterPrefix}/discord-webhook-url`,
      Value: `http://127.0.0.1:${port}/webhook`,
      Type: 'SecureString',
    }),
  );
});

afterAll(() => {
  webhookServer?.close();
});

describe('最初の Admin', () => {
  it('発行されたパスワードで入れて、Admin の権限を持つ', async () => {
    const me = await send('GET', '/api/me', 'root');
    expect(JSON.parse(me.body)).toMatchObject({ name: 'root', role: 'admin' });
  });

  it('空のトップと 404 が S3 に置かれる', async () => {
    expect((await siteObject('404.html')).text).toContain('見つかりません');
    expect((await siteObject('index.html')).contentType).toBe('text/html; charset=utf-8');
  });
});

describe('公開から削除までの流れ', () => {
  it('実際の zip を公開し、S3・ページ情報・一覧・通知に反映する', async () => {
    const zip = buildZip([
      {
        name: 'index.html',
        data: '<title>猫の写真</title><link href="style.css" rel="stylesheet">',
      },
      { name: 'style.css', data: 'body{color:red}' },
      { name: 'docs/guide.md', data: '# ガイド' },
      { name: 'thumbnail.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const response = await uploadAndPublish('alice', 'cats', zip);
    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({
      isNew: true,
      url: 'https://public.example.invalid/cats/',
      page: { owner: 'alice', title: '猫の写真', hasThumbnail: true },
    });

    expect(await siteKeys('cats/')).toEqual([
      'cats/docs/guide.html',
      'cats/index.html',
      'cats/style.css',
      'cats/thumbnail.png',
    ]);
    expect((await siteObject('cats/style.css')).contentType).toBe('text/css; charset=utf-8');
    expect((await siteObject('cats/docs/guide.html')).text).toContain('<h1>ガイド</h1>');

    const top = (await siteObject('index.html')).text;
    expect(top).toContain('猫の写真');
    expect(top).toContain('src="/cats/thumbnail.png"');

    expect(webhookBodies).toHaveLength(1);
    expect(webhookBodies[0]?.content).toContain('猫の写真');
    expect(webhookBodies[0]?.content).toContain('alice');
    expect(webhookBodies[0]?.content).toContain('https://public.example.invalid/cats/');
    expect(webhookBodies[0]?.allowed_mentions).toEqual({ parse: [] });
  });

  it('公開後は送った zip が消える', async () => {
    const result = await s3.send(
      new ListObjectsV2Command({ Bucket: config.uploadBucket, Prefix: 'uploads/alice/cats/' }),
    );
    expect(result.Contents ?? []).toEqual([]);
  });

  it('本人が上書きすると古いファイルが消え、通知しない', async () => {
    const before = webhookBodies.length;
    const response = await uploadAndPublish(
      'alice',
      'cats',
      buildZip([{ name: 'index.md', data: '# 猫の写真 2' }]),
    );
    expect(response.status).toBe(200);
    expect(await siteKeys('cats/')).toEqual(['cats/index.html']);
    expect(webhookBodies).toHaveLength(before);
    expect((await siteObject('index.html')).text).toContain('猫の写真 2');
    expect((await siteObject('index.html')).text).not.toContain('thumbnail.png');
  });

  it('他の人は上書きの URL をもらえず、削除もできない', async () => {
    expect((await send('PUT', '/api/pages/cats/upload', 'bob')).status).toBe(409);
    expect((await send('DELETE', '/api/pages/cats', 'bob')).status).toBe(403);
    expect(await siteKeys('cats/')).toEqual(['cats/index.html']);
  });

  it('他の人の zip の uploadId を使っても公開できない', async () => {
    const upload = await send('PUT', '/api/pages/alices/upload', 'alice');
    const { uploadId, upload: presigned } = JSON.parse(upload.body);
    const form = new FormData();
    for (const [field, value] of Object.entries<string>(presigned.fields))
      form.append(field, value);
    form.append('file', new Blob([new Uint8Array(buildZip([{ name: 'index.html', data: 'x' }]))]));
    await fetch(presigned.url, { method: 'POST', body: form });

    const stolen = await send('PUT', '/api/pages/alices', 'bob', { uploadId });
    expect(stolen.status).toBe(404);
  });

  it('壊れた zip は S3 にもページ情報にも残らない', async () => {
    const response = await uploadAndPublish('alice', 'broken', Buffer.from('not a zip'));
    expect(response.status).toBe(400);
    expect(await siteKeys('broken/')).toEqual([]);
    expect(await deps.pages.get('broken')).toBeNull();
  });

  it('危険なパスの zip は S3 の別の場所に書かない', async () => {
    const response = await uploadAndPublish(
      'alice',
      'escape',
      buildZip([
        { name: 'index.html', data: 'x' },
        { name: '../cats/index.html', data: 'evil' },
      ]),
    );
    expect(response.status).toBe(400);
    expect((await siteObject('cats/index.html')).text).not.toContain('evil');
  });

  it('Admin は他の人のページを消せて、一覧からも消える', async () => {
    expect((await send('DELETE', '/api/pages/cats', 'root')).status).toBe(200);
    expect(await siteKeys('cats/')).toEqual([]);
    expect((await siteObject('index.html')).text).not.toContain('href="/cats/"');
  });

  it('Discord が失敗しても公開は成功する', async () => {
    webhookServer.closeAllConnections();
    await new Promise((resolve) => webhookServer.close(resolve));
    const response = await uploadAndPublish(
      'alice',
      'no-notify',
      buildZip([{ name: 'index.html', data: '<title>x</title>' }]),
    );
    expect(response.status).toBe(201);
  });
});

describe('ユーザー管理の流れ', () => {
  it('Admin が確認したパスワードで本人が入れる', async () => {
    await createMember('dave');
    const shown = JSON.parse((await send('GET', '/api/users/dave/password', 'root')).body).password;
    expect(shown).toBe(logins.get('dave'));
    expect((await send('GET', '/api/me', 'dave')).status).toBe(200);
  });

  it('再発行すると古いパスワードは通らず、確認の値も変わる', async () => {
    await createMember('erin');
    const old = logins.get('erin') ?? '';
    const next = JSON.parse((await send('PUT', '/api/users/erin/password', 'root')).body).password;
    expect(next).not.toBe(old);
    expect((await send('GET', '/api/me', 'erin')).status).toBe(401);
    logins.set('erin', next);
    expect((await send('GET', '/api/me', 'erin')).status).toBe(200);
    expect(JSON.parse((await send('GET', '/api/users/erin/password', 'root')).body).password).toBe(
      next,
    );
  });

  it('削除すると入れなくなり、パスワードも消える', async () => {
    await createMember('frank');
    expect((await send('DELETE', '/api/users/frank', 'root')).status).toBe(200);
    expect((await send('GET', '/api/me', 'frank')).status).toBe(401);
    await expect(deps.secrets.getPassword('frank')).resolves.toBeNull();
  });
});
