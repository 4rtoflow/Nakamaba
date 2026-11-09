// 最初の Admin を作る。使い方: npm run bootstrap-admin -- <ユーザー名>
// AWS の認証情報と、CDK の出力に対応する環境変数（下の requireEnv）が要る。

import { createAwsDeps } from '../src/app/aws.ts';
import { bootstrapAdmin } from '../src/app/bootstrap.ts';

const name = process.argv[2];
if (!name) {
  console.error('使い方: npm run bootstrap-admin -- <ユーザー名>');
  process.exit(1);
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`環境変数 ${key} が必要です（cdk deploy の出力を参照）`);
    process.exit(1);
  }
  return value;
}

const deps = createAwsDeps({
  usersTable: requireEnv('USERS_TABLE'),
  pagesTable: requireEnv('PAGES_TABLE'),
  // 最初の Admin にはトークンが無いので、トークンの表は使わない
  tokensTable: '',
  siteBucket: requireEnv('SITE_BUCKET'),
  uploadBucket: '',
  distributionId: '',
  publicBaseUrl: '',
  uploadOrigin: '',
  parameterPrefix: process.env.PARAMETER_PREFIX ?? '/nakamaba',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
});

const { password } = await bootstrapAdmin(deps, name);
console.log(`Admin「${name}」を作りました。パスワード: ${password}`);
