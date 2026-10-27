# Stockroom

集めたものを何でもストックしておける、ローカルの保管庫アプリ（Tauri 2 / Mac・Windows）。
種類の違うものを 1 つのライブラリにしまい、フォルダ・タグ・評価・検索で同じように整理して、必要なときに取り出す。

いま扱えるのは画像・フォント・ファイル（PDF・オフィス文書）・テキスト（Markdown・テキスト・CSV）。URL など、ほかの種類も順に増やしていく。旧名は Image Library。

## 主な機能

- **取り込み**：ドラッグ&ドロップ・貼り付け・ブラウザ拡張（Chrome / Edge）から。同じファイルは重複として除く
- **一覧**：画像・ファイル・テキストの「ストック」と「フォント」の 2 つのモード。ストックは種類（画像・ファイル・テキスト）で絞り込む。標準・Pinterest 風・グリッド・リスト、フォントは専用のモードで見本を並べ、ファミリーごとに見比べる
- **整理**：入れ子フォルダ・タグ・★評価・お気に入り・ピン留め・メモ・色分け、スマートフォルダ、親子の紐づけ（動画にサムネイル案を付けるなど。設定で有効にする）
- **テキスト**：Markdown は整形、CSV は表で見る。アプリの中で書き換えられ、⌘N で新しく作る・文字を貼り付けて作る（Shift_JIS の CSV もそのまま）
- **検索・絞り込み**：名前・メモ・タグ・テキストの本文で検索（除外・OR・語句）、形式・縦横・サイズ・追加日・容量で絞り込み
- **重複の整理**：見た目が似ている画像をまとめて、残す 1 枚を選ぶ
- **シェルフ**：一覧の下に、比べたいフォントや書き出し前のファイルを一時的に置いておく。フォントは並べて比較できる
- **Claude から整理**（MCP）：タグ付け・フォルダ分けなどを Claude に頼める（削除はできず、元に戻せる）
- **フォルダの共有**：同じ Wi-Fi・社内 LAN の人や自分のスマホに、フォルダを見るだけで共有する（URL・QR コード）

詳しい使い方・キー操作・ライブラリの構造とバックアップは [docs/FEATURES.md](docs/FEATURES.md)。

## インストール

[Releases](https://github.com/hamirilo/stockroom/releases) から入手する。署名なしのビルドなので、**初回インストール時だけ**警告が出る。

- **macOS（Apple Silicon 専用）**：`.dmg` を開いて「アプリケーション」へコピー → 起動して「開発元を検証できない」と出たら「完了」→ **システム設定 › プライバシーとセキュリティ** の「このまま開く」。
  ターミナルで `xattr -dr com.apple.quarantine "/Applications/Stockroom.app"` を実行しても良い
- **Windows**：`-setup.exe` を実行 → SmartScreen が出たら「詳細情報」→「実行」

2 回目以降はアプリ内で更新する（起動時に確認。手動では設定（⌘,）→「一般」の「アップデート」→「アップデートを確認」）。何が変わったかは [Releases](https://github.com/hamirilo/stockroom/releases) の各版のページにある（更新のダイアログと設定の「更新内容」からも開ける）。

### Image Library から更新した場合

アプリ内アップデートでそのまま移れる。設定は初回の起動時に引き継がれ、Windows では古い Image Library はインストーラが取り除く。次の 3 つだけは手作業が要る。

- **macOS**：アプリが `Image Library.app` の名前のまま置き換わるので、Finder で `Stockroom.app` に名前を変える（または `.dmg` から入れ直す）
- **ブラウザ拡張**：設定（⌘,）→「連携」→「拡張機能のフォルダを用意して表示」で出るフォルダを Chrome で読み込み直し、古い拡張機能は削除する
- **Claude Desktop**：設定（⌘,）→「連携」の「Claude と連携」に出る設定を貼り直し、古い `image-library` の項目を消す（Claude Code はそのまま使える）

## 開発

前提：Node.js 22+、Rust（stable）、[Tauri の前提環境](https://tauri.app/start/prerequisites/)

```bash
npm install
npm run tauri dev      # アプリを起動
npm test               # Rust のユニットテスト + 型チェック
```

ブラウザ用のモック・構成・リリースの手順は [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## ドキュメント

| | |
|---|---|
| [FEATURES.md](docs/FEATURES.md) | 機能と使い方、キー操作、ライブラリの構造、バックアップ |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | 開発環境、ソースの構成、リリース |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | モードの考え方、共通基盤と種類ごとのコードの境界 |
| [MCP.md](docs/MCP.md) | Claude との連携 |
| [FROM_APPS.md](docs/FROM_APPS.md) | ほかのアプリ（Feedability）から受け取る（計画） |
| [SETTINGS.md](docs/SETTINGS.md) | 設定画面とライブラリごとの設定 |
| [MENUS.md](docs/MENUS.md) | メニューの構成 |
| [UI.md](docs/UI.md) | 画面の原則（表示を切り替えても操作の位置を不必要に変えない） |
| [NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | 知らせ方（その場・HUD・トースト・OS の通知・ダイアログの使い分け、トーストの秒数） |
| [NAVIGATION.md](docs/NAVIGATION.md) | サイドバーとツールバーの役割（場所・絞り込み・表示） |
| [MODES.md](docs/MODES.md) | モードを分ける（ストックとフォント） |
| [FONT_UI.md](docs/FONT_UI.md) | フォントの画面（見本・グループ分け・シェルフ・比較） |
| [COMPARE.md](docs/COMPARE.md) | 画像の比較（シェルフの画像を並べ、一緒に拡大して見比べる） |
| [SYSTEM_FONTS.md](docs/SYSTEM_FONTS.md) | この端末のフォント（ライブラリに取り込まない読み取り専用の一覧） |
| [TEXT.md](docs/TEXT.md) | テキスト（Markdown・テキスト・CSV）：見る・編集・新規作成・文字コード |
| [VIDEO.md](docs/VIDEO.md) | 動画（MP4・MOV・WebM）：取り込み・サムネイル・再生 |
| [LINKS.md](docs/LINKS.md) | 親子の紐づけ：動画にサムネイル案を付ける、ライブラリごとに有効・無効 |
| [EXPORT.md](docs/EXPORT.md) | ライブラリ全体の書き出し（すべてのファイルをフォルダ構成どおりに） |
| [ROADMAP.md](docs/ROADMAP.md) | 今後の予定 |
