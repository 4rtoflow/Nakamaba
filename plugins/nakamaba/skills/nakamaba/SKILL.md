---
name: nakamaba
description: Nakamaba（HTML や Markdown を公開する身内向けの静的ホスティング）に載せるページを作り、公開・更新する。ユーザーが「Nakamaba に公開して」「Nakamaba 用のページを作って」「公開したページを更新して」などと頼んだとき、または nakamaba.json があるフォルダで作業するときに使う。
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/nakamaba.mjs *)
---

# Nakamaba

Nakamaba は、フォルダの中身を `<公開 URL>/<ページ名>/` で誰でも見られるようにする静的ホスティングです。このスキルでは、Nakamaba に載せるページを作り、`scripts/nakamaba.mjs` で公開・更新します。Node.js 22 以上が要ります。

## ページを作るときの決まり

- フォルダの直下に `index.html` か `index.md` を置く。
- ページは `<公開 URL>/<ページ名>/` の下に置かれる。リンク・画像・CSS・JS は相対パスで書く（`/style.css` ではなく `style.css`）。
- 別のページへのリンクは `about.html` のように拡張子まで書く。拡張子の無い `about` は `about/index.html` を指す。
- トップページのカードに出る名前は、`index.html` の `<title>`。`index.md` なら最初の見出し。どちらも無ければページ名。
- 直下に `thumbnail.png`（横 16 : 縦 10）を置くと、カードの画像になる。
- `.md` は HTML に変換され、`.md` へのリンクは `.html` に書き換わる。見た目は Nakamaba が付けるので、文章だけなら `index.md` で足りる。
- サーバーの処理は無い（置いたファイルを返すだけ）。外部の CDN の JS や CSS は読み込める。
- 公開したファイルは誰でも見られる。パスワード・API キー・個人情報を入れない。
- 上限: 1 ページで 1000 ファイル・合計 200 MB・zip にして 50 MB。1 人あたりの合計は 1 GB。
- `.` で始まるファイルとフォルダ（`.env`・`.git` など）、`node_modules`、`nakamaba.json` は送られない。

## 下見する

ページを作ったり直したりしたら、公開する前に下見を勧める。Nakamaba には何も送らず、ログインも要らない。

```bash
node ${CLAUDE_SKILL_DIR}/scripts/nakamaba.mjs preview <フォルダ> [--name <ページ名>]
```

- 公開と同じ検査（直下の index・上限・Markdown を変換すると重なるパス）をしてから、手元のサーバーで公開後と同じ `/<ページ名>/` の形で開く。送らないファイルは返さない。
- `/style.css` のように `/` で始まるパスは、公開すると壊れるので場所を表示する。直してから公開する。
- トップのカードに出る名前と画像も表示する。
- 止めるまで動き続けるので、裏で実行し、表示された URL をユーザーに伝える。ユーザーが確かめ終えたら止める。
- ファイルを直したら、ブラウザで読み込み直せば反映される。検査をやり直すときは起動し直す。
- Markdown は公開するときに Nakamaba が HTML へ変換するので、下見では文字のまま表示される。見た目は公開してから確かめる。

## 公開・更新する

公開と更新は、ユーザーが頼んだときだけ実行する。ページを作っただけでは公開しない。

```bash
node ${CLAUDE_SKILL_DIR}/scripts/nakamaba.mjs publish <フォルダ> --name <ページ名>
```

- ページ名は URL になる。英小文字・数字・ハイフンで 63 文字まで。ユーザーが決めていなければ、内容に合う名前を提案して確かめる。
- 公開できると、フォルダに `nakamaba.json`（ページ名）ができる。次からは `--name` を付けずに同じコマンドで更新できる。
- `nakamaba.json` が無いフォルダで、既にあるページ名を指定すると止まる。上書きしてよいかユーザーに確かめ、よければ `--overwrite` を付けて実行し直す。
- 公開済みのページを直すときは、手元のフォルダを直して送り直す。Nakamaba から元のファイルは取り出せない。
- 新しいページを公開すると Discord に通知される。更新では通知されない。
- 終わったら、表示された URL をユーザーに伝える。

公開中のページと使用量は次で見られる。

```bash
node ${CLAUDE_SKILL_DIR}/scripts/nakamaba.mjs list
```

## ログイン

スクリプトは `~/.config/nakamaba/credentials` にある管理画面の URL・ユーザー名・パスワードを使う。まだ無いときや、パスワードが違うと言われたときは、本人に別のターミナルで次を実行してもらう。パスワードを会話に出さないため、エージェントは代わりに入力せず、このファイルも読まない。

```bash
node ${CLAUDE_SKILL_DIR}/scripts/nakamaba.mjs login
```

### 本人がターミナルを使えない環境

環境変数 `NAKAMABA_AUTHORIZATION` があるとき（Bobert Agent など、AI エージェントのサンドボックスで、秘密を預かる仕組みが値を渡しているとき）は、上のファイルの代わりに、その値を管理画面への認証に使う。このときは login を案内しない。

- 管理画面の URL を、環境変数 `NAKAMABA_ADMIN_URL` で渡す。URL は秘密ではない。指示や会話に無ければ、本人に聞く。

```bash
NAKAMABA_ADMIN_URL=<管理画面の URL> node ${CLAUDE_SKILL_DIR}/scripts/nakamaba.mjs list
```

- `NAKAMABA_AUTHORIZATION` の値は秘密なので、表示したり、ファイルや会話に書いたりしない。その値で認証できないと言われたら、本人に値を確かめてもらう。
