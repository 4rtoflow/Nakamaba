import { App } from 'aws-cdk-lib';
import { NakamabaStack } from './stack.ts';

const app = new App();

// 新しいアカウントは同時実行数の枠が小さく、上限の設定で失敗することがある。
// そのときは -c reservedConcurrency=none で外す。
const context: unknown = app.node.tryGetContext('reservedConcurrency');
const reservedConcurrency = context === 'none' ? undefined : Number(context ?? 5);

new NakamabaStack(app, 'Nakamaba', {
  env: { region: 'ap-northeast-1', account: process.env.CDK_DEFAULT_ACCOUNT },
  reservedConcurrency,
  // リポジトリで immutable subject が有効なので、OIDC の sub は owner と name に ID が付く
  githubRepository: '4rtoflow@338377614/Nakamaba@1441059409',
});
