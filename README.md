# Nakamaba

HTML や Markdown を簡単に公開して共有できる、身内向けの静的ホスティングアプリです。

- zip を管理画面か API から送ると、`/<ページ名>/` で公開されます。
- 公開されたページは誰でも見られます。トップにはカード形式の一覧が出ます。
- 公開できるのは、認可された人だけです（Basic 認証）。
- 新しいページを公開すると、Discord のチャンネルへ通知します。
- Claude Code のプラグイン（`plugins/nakamaba`）を入れると、AI エージェントがページを作って公開・更新できます。
- AWS のサーバーレス構成で動きます。

## インストール

AI エージェントにこのリポジトリを読ませて、聞いてください。

> このリポジトリを手元で動かす方法を教えて

> 自分の AWS アカウントへデプロイして

公開リポジトリなので、clone したら `git config core.hooksPath .githooks` だけは実行してください。commit の前に、秘密の混入を gitleaks で検査します。

## AI エージェントから公開する

Claude Code にプラグインを入れると、「ページを作って Nakamaba に公開して」「さっきのページを更新して」のように頼めます。

```sh
claude plugin install nakamaba --marketplace 4rtoflow/Nakamaba
```

初めて公開するときは、エージェントがログイン用のコマンドを示します。パスワードを会話に残さないよう、そのコマンドは別のターミナルで実行してください。

本人がターミナルを使えない環境（Bobert Agent など、AI エージェントのサンドボックス）では、ログインの代わりに、環境変数 `NAKAMABA_AUTHORIZATION` と `NAKAMABA_ADMIN_URL` を渡します。`NAKAMABA_AUTHORIZATION` は、`Basic` に続けて、「ユーザー名:パスワード」を base64 にした値です（Authorization ヘッダーの値そのもの）。`NAKAMABA_ADMIN_URL` は管理画面の URL です。値は秘密なので、サンドボックスに本物の値を入れない仕組み（Claude Managed Agents の vault など）で渡してください。

プラグインは自動では更新されません。`claude plugin update nakamaba@nakamaba` で更新するか、`/plugin` の Marketplaces で `nakamaba` の自動更新を有効にしてください。
