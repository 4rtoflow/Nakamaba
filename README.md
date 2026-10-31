# Nakamaba

友人同士で、各自が作った HTML や Markdown などを公開できるホスティングアプリです。

- 公開されたページは誰でも見られます。トップにはカード形式の一覧が出ます。
- ページを足す管理画面と API は、認可された人だけが使えます（Basic 認証）。
- 新しいページを公開すると、Discord のチャンネルへ通知します。
- AWS のサーバーレス構成で動きます。

## 構成

| 役割                                            | 使うもの                        |
| ----------------------------------------------- | ------------------------------- |
| 公開ページの保存と配信                          | S3 と CloudFront                |
| 管理画面と API                                  | Lambda の関数 URL               |
| ページ情報とユーザー                            | DynamoDB                        |
| パスワードの確認用の値と Discord の Webhook URL | Parameter Store（SecureString） |
| 送られた zip の一時置き場                       | S3（1 日で自動削除）            |

公開ページでは友人が書いた JavaScript が動くので、公開ページ（`*.cloudfront.net`）と管理画面（`*.lambda-url.*.on.aws`）はオリジンを分けています。さらに、変更の API は `PUT` と `DELETE` だけを受け付け、CORS を許可しません。

### ページの公開の流れ

1. `PUT /api/pages/<ページ名>/upload` で、S3 への署名付きの送り先を受け取る。
2. 受け取った URL へ zip を `POST` する。
3. `PUT /api/pages/<ページ名>` に `{"uploadId": "..."}` を送ると、展開して公開する。

zip の直下に `index.html` か `index.md` が必要です。`.md` は公開時に HTML へ変換します。直下に `thumbnail.png` があると、一覧のカードに表示します。上限は zip が 50 MB、展開後が 200 MB、ファイル数が 1,000 個です。

## 開発

Node.js 24 以上と Docker が要ります。

```bash
npm ci

# 公開リポジトリのため、commit の前に gitleaks で秘密の混入を検査します。clone したら一度だけ実行します。
brew install gitleaks
git config core.hooksPath .githooks
```

| コマンド                   | 内容                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`              | 手元で動かす。AWS の模擬サーバー（moto）に接続し、管理画面を `http://127.0.0.1:4100`、公開側を `http://127.0.0.1:4200` で起動する。実際の AWS へは接続しない |
| `npm run lint`             | Biome の検査                                                                                                                                                 |
| `npm run typecheck`        | TypeScript の型の検査                                                                                                                                        |
| `npm test`                 | 単体テスト。AWS も Docker も要らない                                                                                                                         |
| `npm run test:coverage`    | 単体テストとカバレッジ                                                                                                                                       |
| `npm run test:integration` | 結合テスト。実際の AWS SDK を moto に接続し、デプロイされるバンドルも動かす                                                                                  |
| `npm run test:e2e`         | E2E。Chrome で管理画面と公開側を操作する。別オリジンからの攻撃が止まることも確かめる                                                                         |
| `npm run synth`            | CDK の合成                                                                                                                                                   |

push のたびに、GitHub Actions が上の検査と、全履歴の秘密の検査を実行します。

## デプロイ

AWS の認証情報を用意してから実行します。

```bash
# 初回だけ
npx cdk bootstrap

npx cdk deploy
```

新しいアカウントで同時実行数の枠が足りず失敗するときは、`-c reservedConcurrency=none` を付けます。

デプロイの出力を使って、最初の Admin を作ります。パスワードは一度だけ表示されますが、ログイン後は管理画面でも確認できます。

```bash
USERS_TABLE=<UsersTableName> PAGES_TABLE=<PagesTableName> SITE_BUCKET=<SiteBucketName> \
  npm run bootstrap-admin -- <ユーザー名>
```

Discord へ通知するには、Webhook URL を Parameter Store に置きます。

```bash
aws ssm put-parameter --type SecureString --name /nakamaba/discord-webhook-url --value '<Webhook URL>'
```

出力の `AdminUrl` が管理画面、`PublicUrl` が公開側です。
