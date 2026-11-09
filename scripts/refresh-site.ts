// 公開側のトップと 404 を今のコードで置き直し、CloudFront のキャッシュを消す。CD がデプロイの後に呼ぶ。
// AWS の認証情報と、CDK の出力に対応する環境変数（下の requireEnv）が要る。

import { createAwsDeps } from '../src/app/aws.ts';
import { writeStaticPages } from '../src/app/publish.ts';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`環境変数 ${key} が必要です（cdk deploy の出力を参照）`);
    process.exit(1);
  }
  return value;
}

const deps = createAwsDeps({
  usersTable: '',
  pagesTable: requireEnv('PAGES_TABLE'),
  tokensTable: '',
  siteBucket: requireEnv('SITE_BUCKET'),
  uploadBucket: '',
  distributionId: requireEnv('DISTRIBUTION_ID'),
  publicBaseUrl: '',
  uploadOrigin: '',
  parameterPrefix: '/nakamaba',
  forcePathStyle: false,
});

await writeStaticPages(deps);
await deps.cdn.invalidate(['/index.html', '/', '/404.html']);
console.log('公開側のトップと 404 を置き直しました。');
