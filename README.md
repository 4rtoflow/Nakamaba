# Nakamaba

友人同士で、各自が作った HTML や Markdown などを公開できるホスティングアプリです。

- 公開されたページは誰でも見られます。ページを足す管理画面は、認可された人だけが使えます。
- ページが足されると、Discord のチャンネルへ通知します。
- 認可された人は、API と Skills を使って AI エージェントからもページを公開できます。
- AWS のサーバーレス構成で動かす予定です。

現在は開発を始める前の段階です。

## 開発

公開リポジトリのため、commit の前に gitleaks で秘密の混入を検査します。clone したら一度だけ次を実行してください。

```bash
brew install gitleaks
git config core.hooksPath .githooks
```
