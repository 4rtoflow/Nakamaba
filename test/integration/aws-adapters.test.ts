import { CloudFrontClient, ListInvalidationsCommand } from '@aws-sdk/client-cloudfront';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type AwsConfig,
  createCdn,
  createPageStore,
  createSecrets,
  createSiteFiles,
  createUploads,
  createUserStore,
} from '../../src/app/aws.ts';
import type { PageClaim, User } from '../../src/app/deps.ts';
import { provisionLocalAws } from '../support/local-aws.ts';

let config: AwsConfig;
let documents: DynamoDBDocumentClient;
let s3: S3Client;
let ssm: SSMClient;
let cloudFront: CloudFrontClient;

beforeAll(async () => {
  config = await provisionLocalAws(inject('motoEndpoint'), {
    publicBaseUrl: 'https://public.example.invalid',
  });
  documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  s3 = new S3Client({ forcePathStyle: true });
  ssm = new SSMClient({});
  cloudFront = new CloudFrontClient({});
});

const user = (name: string): User => ({
  name,
  role: 'member',
  passwordHash: 'hash',
  createdAt: '2026-11-01T00:00:00.000Z',
});

describe('UserStore（DynamoDB）', () => {
  it('作成・取得・一覧・削除ができ、余分な属性を足さない', async () => {
    const store = createUserStore(documents, config.usersTable);
    await expect(store.create(user('crud'))).resolves.toBe(true);
    await expect(store.get('crud')).resolves.toEqual(user('crud'));
    expect((await store.list()).map((item) => item.name)).toContain('crud');
    await store.delete('crud');
    await expect(store.get('crud')).resolves.toBeNull();
  });

  it('同じ名前の作成は false を返し、元の値を変えない', async () => {
    const store = createUserStore(documents, config.usersTable);
    await store.create(user('dup'));
    await expect(store.create({ ...user('dup'), passwordHash: 'other' })).resolves.toBe(false);
    expect((await store.get('dup'))?.passwordHash).toBe('hash');
  });

  it('同時に作成しても 1 人だけが通る', async () => {
    const store = createUserStore(documents, config.usersTable);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.create(user('race-user'))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('パスワードのハッシュを更新する。居ないユーザーは作らない', async () => {
    const store = createUserStore(documents, config.usersTable);
    await store.create(user('hash-user'));
    await expect(store.setPasswordHash('hash-user', 'new')).resolves.toBe(true);
    expect((await store.get('hash-user'))?.passwordHash).toBe('new');
    await expect(store.setPasswordHash('nobody', 'new')).resolves.toBe(false);
    await expect(store.get('nobody')).resolves.toBeNull();
  });
});

describe('PageStore（DynamoDB の条件付き書き込み）', () => {
  const claim = (overrides: Partial<PageClaim>): PageClaim => ({
    name: 'page',
    actor: 'alice',
    overrideOwner: false,
    title: 'タイトル',
    hasThumbnail: false,
    now: '2026-11-01T00:00:00.000Z',
    ...overrides,
  });

  it('新規なら isNew で、公開した人と作成日を記録する', async () => {
    const store = createPageStore(documents, config.pagesTable);
    const result = await store.claim(claim({ name: 'new-page' }));
    expect(result).toMatchObject({
      claimed: true,
      isNew: true,
      page: { owner: 'alice', createdAt: '2026-11-01T00:00:00.000Z' },
    });
    await expect(store.get('new-page')).resolves.toMatchObject({
      owner: 'alice',
      title: 'タイトル',
    });
  });

  it('本人の上書きは作成日を保ち、更新日とタイトルを変える', async () => {
    const store = createPageStore(documents, config.pagesTable);
    await store.claim(claim({ name: 'own' }));
    const result = await store.claim(
      claim({ name: 'own', title: '新', now: '2026-12-01T00:00:00.000Z', hasThumbnail: true }),
    );
    expect(result).toMatchObject({ claimed: true, isNew: false });
    await expect(store.get('own')).resolves.toEqual({
      name: 'own',
      owner: 'alice',
      title: '新',
      hasThumbnail: true,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-12-01T00:00:00.000Z',
    });
  });

  // 同時に書いたときに 1 人だけ通るのは DynamoDB が保証する。moto は要求を並行に処理して
  // 条件の確認と書き込みの間に割り込まれるため、同時の書き込みでは確かめない
  it('他の人の書き込みは通さず、元の値を変えない', async () => {
    const store = createPageStore(documents, config.pagesTable);
    await store.claim(claim({ name: 'taken' }));
    await expect(
      store.claim(claim({ name: 'taken', actor: 'bob', title: '奪う' })),
    ).resolves.toEqual({
      claimed: false,
    });
    await expect(store.get('taken')).resolves.toMatchObject({ owner: 'alice', title: 'タイトル' });
  });

  it('Admin は上書きでき、公開した人は変わらない', async () => {
    const store = createPageStore(documents, config.pagesTable);
    await store.claim(claim({ name: 'admin-edit' }));
    const result = await store.claim(
      claim({ name: 'admin-edit', actor: 'root', overrideOwner: true, title: '直す' }),
    );
    expect(result).toMatchObject({ claimed: true, isNew: false, page: { owner: 'alice' } });
    await expect(store.get('admin-edit')).resolves.toMatchObject({ owner: 'alice', title: '直す' });
  });

  it('一覧に全件を返す（1 MB を超えてページングされても）', async () => {
    const store = createPageStore(documents, config.pagesTable);
    const padding = 'x'.repeat(100_000);
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        documents.send(
          new PutCommand({
            TableName: config.pagesTable,
            Item: { name: `big-${i}`, owner: 'alice', title: padding },
          }),
        ),
      ),
    );
    const names = (await store.list()).map((page) => page.name);
    for (let i = 0; i < 15; i += 1) expect(names).toContain(`big-${i}`);
  });

  it('削除できる', async () => {
    const store = createPageStore(documents, config.pagesTable);
    await store.claim(claim({ name: 'gone' }));
    await store.delete('gone');
    await expect(store.get('gone')).resolves.toBeNull();
  });
});

describe('SiteFiles（S3）', () => {
  it('Content-Type つきで置き、前方一致で一覧し、削除できる', async () => {
    const files = createSiteFiles(s3, config.siteBucket);
    await files.put('a/index.html', '<h1>日本語</h1>', 'text/html; charset=utf-8');
    await files.put('ab/index.html', Buffer.from([1, 2, 3]), 'application/octet-stream');
    const object = await s3.send(
      new GetObjectCommand({ Bucket: config.siteBucket, Key: 'a/index.html' }),
    );
    expect(object.ContentType).toBe('text/html; charset=utf-8');
    expect(await object.Body?.transformToString()).toBe('<h1>日本語</h1>');

    await expect(files.list('a/')).resolves.toEqual(['a/index.html']);
    await files.delete(['a/index.html']);
    await expect(files.list('a/')).resolves.toEqual([]);
    await expect(files.list('ab/')).resolves.toEqual(['ab/index.html']);
  });

  it('前方一致するファイルの合計サイズを返す', async () => {
    const files = createSiteFiles(s3, config.siteBucket);
    await files.put('size/index.html', Buffer.alloc(10), 'text/html');
    await files.put('size/a/b.png', Buffer.alloc(32), 'image/png');
    await files.put('size2/index.html', Buffer.alloc(100), 'text/html');
    await expect(files.totalBytes('size/')).resolves.toBe(42);
    await expect(files.totalBytes('no-such-page/')).resolves.toBe(0);
    await files.delete(['size/index.html', 'size/a/b.png', 'size2/index.html']);
  });

  it('空の配列を渡しても削除の API を呼ばない', async () => {
    const files = createSiteFiles(s3, config.siteBucket);
    await expect(files.delete([])).resolves.toBeUndefined();
  });

  it('日本語や空白のファイル名を扱える', async () => {
    const files = createSiteFiles(s3, config.siteBucket);
    await files.put('jp/画像 1.png', Buffer.from([1]), 'image/png');
    await expect(files.list('jp/')).resolves.toEqual(['jp/画像 1.png']);
    await files.delete(['jp/画像 1.png']);
    await expect(files.list('jp/')).resolves.toEqual([]);
  });

  it('1000 件を超えても全件を一覧して削除できる', async () => {
    const files = createSiteFiles(s3, config.siteBucket);
    const keys = Array.from({ length: 1005 }, (_, i) => `many/${String(i).padStart(4, '0')}.txt`);
    for (let start = 0; start < keys.length; start += 50) {
      await Promise.all(
        keys.slice(start, start + 50).map((key) => files.put(key, 'x', 'text/plain')),
      );
    }
    const listed = await files.list('many/');
    expect(listed).toHaveLength(1005);
    await files.delete(listed);
    await expect(files.list('many/')).resolves.toEqual([]);
  }, 60_000);
});

describe('Uploads（S3 の署名付き URL）', () => {
  async function post(key: string, body: Buffer): Promise<Response> {
    const uploads = createUploads(s3, config.uploadBucket);
    const { url, fields } = await uploads.createPresignedUpload(key, 1024, 60);
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append('file', new Blob([new Uint8Array(body)]));
    return fetch(url, { method: 'POST', body: form });
  }

  it('発行した URL へ送った zip を読める', async () => {
    const uploads = createUploads(s3, config.uploadBucket);
    const response = await post('uploads/a/p/1.zip', Buffer.from('zip-body'));
    expect(response.status).toBeLessThan(300);
    await expect(uploads.size('uploads/a/p/1.zip')).resolves.toBe(8);
    expect((await uploads.read('uploads/a/p/1.zip')).toString()).toBe('zip-body');
    await uploads.delete('uploads/a/p/1.zip');
    await expect(uploads.size('uploads/a/p/1.zip')).resolves.toBeNull();
  });

  it('署名の条件にサイズの上限と、発行したキーを入れる', async () => {
    const uploads = createUploads(s3, config.uploadBucket);
    const { fields } = await uploads.createPresignedUpload('uploads/a/p/2.zip', 1024, 60);
    expect(fields.key).toBe('uploads/a/p/2.zip');
    const policy = JSON.parse(Buffer.from(fields.Policy ?? '', 'base64').toString('utf8'));
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 1024]);
    expect(policy.conditions).toContainEqual({ key: 'uploads/a/p/2.zip' });
    expect(new Date(policy.expiration).getTime()).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it('無いキーの size は null を返す', async () => {
    await expect(
      createUploads(s3, config.uploadBucket).size('uploads/none.zip'),
    ).resolves.toBeNull();
  });
});

describe('Secrets（Parameter Store）', () => {
  it('パスワードを SecureString で保存して読める', async () => {
    const secrets = createSecrets(ssm, config.parameterPrefix);
    await secrets.putPassword('alice', 'secret-1');
    await expect(secrets.getPassword('alice')).resolves.toBe('secret-1');
    const raw = await ssm.send(
      new GetParameterCommand({ Name: `${config.parameterPrefix}/users/alice/password` }),
    );
    expect(raw.Parameter?.Type).toBe('SecureString');
    expect(raw.Parameter?.Value).not.toBe('secret-1');
  });

  it('再発行で上書きできる', async () => {
    const secrets = createSecrets(ssm, config.parameterPrefix);
    await secrets.putPassword('bob', 'old');
    await secrets.putPassword('bob', 'new');
    await expect(secrets.getPassword('bob')).resolves.toBe('new');
  });

  it('無いパスワードは null を返し、削除を 2 回しても例外にしない', async () => {
    const secrets = createSecrets(ssm, config.parameterPrefix);
    await secrets.putPassword('carol', 'x');
    await secrets.deletePassword('carol');
    await secrets.deletePassword('carol');
    await expect(secrets.getPassword('carol')).resolves.toBeNull();
  });

  it('Discord の Webhook URL を読む。未設定なら null を返す', async () => {
    const secrets = createSecrets(ssm, `${config.parameterPrefix}-webhook`);
    await expect(secrets.getDiscordWebhookUrl()).resolves.toBeNull();
    await ssm.send(
      new PutParameterCommand({
        Name: `${config.parameterPrefix}-webhook/discord-webhook-url`,
        Value: 'https://hooks.example.invalid/x',
        Type: 'SecureString',
      }),
    );
    await expect(secrets.getDiscordWebhookUrl()).resolves.toBe('https://hooks.example.invalid/x');
  });
});

describe('Cdn（CloudFront の invalidation）', () => {
  it('指定した配信に invalidation を作る', async () => {
    const cdn = createCdn(cloudFront, config.distributionId, () => 'ref-1');
    await cdn.invalidate(['/a/*', '/index.html']);
    const { InvalidationList } = await cloudFront.send(
      new ListInvalidationsCommand({ DistributionId: config.distributionId }),
    );
    expect(InvalidationList?.Quantity).toBe(1);
  });
});

describe('HeadObject の確認', () => {
  it('存在しないオブジェクトは NotFound で返る（Uploads.size の前提）', async () => {
    const error = await s3
      .send(new HeadObjectCommand({ Bucket: config.uploadBucket, Key: 'none' }))
      .catch((e: unknown) => e);
    expect((error as { name: string }).name).toBe('NotFound');
  });
});
