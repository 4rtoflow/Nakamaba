import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { configFromEnv, createUploads } from '../../src/app/aws.ts';

// 管理画面の CSP は zip の送り先だけを許可する。URL の形が変わると本番でだけ送れなくなる。
describe('本番の形の署名付き URL', () => {
  const bucket = 'my-upload-bucket';
  const region = 'ap-northeast-1';

  it('CDK が CSP に渡すオリジン（バケットのリージョン別ドメイン）に送る', async () => {
    const s3 = new S3Client({
      region,
      endpoint: undefined,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMIEXAMPLE' },
    });
    const { url, fields } = await createUploads(s3, bucket).createPresignedUpload(
      'uploads/a/p/1.zip',
      1024,
      60,
    );
    expect(new URL(url).origin).toBe(`https://${bucket}.s3.${region}.amazonaws.com`);
    expect(new URL(url).protocol).toBe('https:');
    expect(fields.key).toBe('uploads/a/p/1.zip');
  });
});

describe('configFromEnv', () => {
  const env = {
    USERS_TABLE: 'u',
    PAGES_TABLE: 'p',
    TOKENS_TABLE: 't',
    SITE_BUCKET: 's',
    UPLOAD_BUCKET: 'up',
    DISTRIBUTION_ID: 'd',
    PUBLIC_BASE_URL: 'https://x',
    UPLOAD_ORIGIN: 'https://y',
    PARAMETER_PREFIX: '/nakamaba',
  };

  it('環境変数から設定を作り、本番では path style にしない', () => {
    expect(configFromEnv(env)).toMatchObject({
      usersTable: 'u',
      tokensTable: 't',
      forcePathStyle: false,
    });
    expect(configFromEnv({ ...env, S3_FORCE_PATH_STYLE: 'true' }).forcePathStyle).toBe(true);
  });

  it.each(Object.keys(env))('%s が無ければ起動時に失敗する', (key) => {
    const partial: NodeJS.ProcessEnv = { ...env };
    delete partial[key];
    expect(() => configFromEnv(partial)).toThrowError(key);
  });
});
