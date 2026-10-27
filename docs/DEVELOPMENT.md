# 開発

前提：Node.js 22+、Rust（stable）、[Tauri の前提環境](https://tauri.app/start/prerequisites/)

```bash
npm install
npm run tauri dev      # アプリを起動
npm test               # Rust のユニットテスト + 型チェック
npm run tauri build    # 配布用ビルド（.dmg / -setup.exe。署名鍵が要る、下の「リリース」）
```

- `npm run dev` でブラウザから開くと、Rust 側の代わりにインメモリのモック（`src/dev/mockBackend.ts`）で動く。UI だけ触りたいとき用（インポートは不可）。
- 画像・フォント・ファイルの分け方（モード）と、共通基盤と種類ごとのコードの境界は [ARCHITECTURE.md](ARCHITECTURE.md) にまとめてある。
- テスト用ライブラリの生成：`npm run seed -- /path/to/Test.library 10000`
  （1 万枚の取り込み 約 6 秒、検索+並び替えクエリ 約 6ms ／ Apple Silicon・release ビルド）
- フォルダの共有の開発：`cargo run --manifest-path src-tauri/Cargo.toml --example shareserver -- /path/to/Test.library [フォルダ名]` でアプリなしに共有サーバーを起動し、表示された URL をブラウザで開く（ポートはアプリの 41640 ではなく 41650）。ページは `src-tauri/src/share.html` で、ビルドし直すと反映される
- ブラウザ拡張の開発：`cargo run --manifest-path src-tauri/Cargo.toml --example webserver -- /path/to/Test.library` でアプリなしに受付サーバーを起動し（`extension/config.json` に接続キーを書く。「アプリと接続」は確認なしで許可する）、Chrome で `extension/` を読み込む。アプリと同時に動かせるよう、ポートはアプリの 41620 ではなく 41630（ほかのポートは `-- <library> <拡張のフォルダ> 41699` のように指定。`config.json` にそのポートが書かれる）。拡張機能のファイルを変えたら `chrome://extensions` で再読み込み

## 構成

```
src/                    React UI
  App.tsx               レイアウト、ファイルのドロップ・貼り付け
  store.ts              zustand ストア（モード・表示条件・選択・再読込）
  lib/api.ts            Rust コマンドの型付きラッパ（共通）
  lib/actions.ts        ダイアログを伴う操作（インポート・削除など）
  lib/layouts.ts        5 種類のレイアウト計算（位置を求めて仮想スクロール）
  lib/rule.ts           絞り込み条件の表示用ヘルパ
  components/           Sidebar / Toolbar / Grid / Inspector / Viewer ほか（共通の UI）
  features/fonts/       フォント専用の UI と API（見本行・ビューア・詳細・サイドバーの絞り込み・フォントの読み込み）
  features/files/       ファイル（PDF・オフィス文書）のビューア
  dev/mockBackend.ts    ブラウザ開発用モック
src-tauri/src/
  db.rs                 スキーマ・クエリ（＋テスト）
  import.rs             コピー・ハッシュ・サムネイル生成（rayon で並列）
  formats.rs            形式ごとのデコード（TIFF・SVG は Rust、HEIC・AVIF は OS）
  fonts/mod.rs          フォント：WOFF / WOFF2 の展開、TTC から 1 書体を取り出す、名前・文字一覧、見本の描画
  fonts/commands.rs     フォント専用のコマンド
  files/                ファイル：サムネイル（Quick Look / Windows.Data.Pdf / 中のプレビュー / 種類のカード）
  search.rs             検索構文のパーサ
  similar.rs            似ている画像の検出（dHash）
  orient.rs             回転・反転（向きの合成とサムネイルへの適用）
  library.rs            ライブラリの作成・オープン・項目のファイルの場所・ファイル削除
  bookmarks/            ブックマーク：URL のそろえ方・カードのサムネイル・登録（docs/BOOKMARKS.md）
  webimport.rs          ブラウザ拡張の受付サーバー（127.0.0.1、接続キー必須、「アプリと接続」の確認）
  mcp/                  Claude からの整理：MCP サーバー（127.0.0.1、トークン必須）、ツール、`--mcp` の stdio 中継
  changes.rs            Claude がした変更の記録と取り消し
  share.rs              フォルダの共有：LAN への待ち受け（見るだけ、URL の秘密の文字列が鍵）、`shares` テーブル、アドレス・QR コード
  share.html            フォルダの共有の閲覧ページ（スマホ向け、1 ファイル。share.rs に埋め込む）
  loopback.rs           HTTP の待ち受け（受付サーバー・MCP・フォルダの共有で共通）
  export.rs             書き出し：一覧の書き出し、ライブラリ全体をフォルダ構成どおりに（docs/EXPORT.md）
  commands.rs           フロントから呼ぶコマンド（共通）
  appdirs.rs            アプリのフォルダ（旧名 Image Library のフォルダからの移し替え）
src-tauri/windows/hooks.nsh  Windows インストーラの追加処理（旧名のアプリのアンインストール）
src-tauri/examples/seed.rs  テストデータ生成
src-tauri/examples/webserver.rs  アプリなしで拡張の受付サーバーを起動（拡張の開発用）
src-tauri/examples/mcpserver.rs  アプリなしで MCP サーバーを起動（Claude からの整理の開発用）
src-tauri/examples/shareserver.rs  アプリなしでフォルダの共有を起動（閲覧ページの開発用）
extension/              Chrome 拡張（Manifest V3、ビルド不要）。アプリに同梱され、「フォルダを用意」で書き出される
  background.js         右クリックメニュー・スクリーンショット・保存結果の表示
  content.js            Alt+右クリックで即保存
  popup.*               保存先フォルダ・タグの選択
  connect.*             「アプリと接続」（アプリで許可してもらい接続キーを受け取る）
  collect.*             ページの画像一覧（絞り込み・まとめて保存）
  shared.js             アプリとの通信・画像のダウンロード
```

アプリ内のドラッグ&ドロップは HTML5 DnD ではなく pointer イベントで実装している（Windows では Tauri のファイルドロップ受付と HTML5 DnD が両立しないため）。

## リリース

`v*` タグを push すると GitHub Actions で macOS（Apple Silicon 専用）と Windows のインストーラがビルドされ、そのタグのリリースが下書きで作られてインストーラが添付される（内容を確認して Publish）。手動実行（workflow_dispatch）の場合は Actions の Artifacts にだけ出る。

手順：

1. `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` のバージョンを上げる → `chore: vX.Y.Z` でコミット → `git tag vX.Y.Z && git push --tags`
2. ビルドが終わったら、下書きリリースの本文に**変更点を書く**（下の「リリースノート」）。ワークフローが入れる本文はインストーラの 1 行だけなので、書かないと何が変わったか分からない
3. 下書きリリースを **Publish**

アプリ内アップデートは `releases/latest/download/latest.json` を見るので（v0.31.1 までは旧名の `2204601/stockroom` を見ていて、GitHub の転送で `hamirilo/stockroom` に届く。この転送が切れると古い版に更新が届かなくなるので、`2204601` の名前で `stockroom` リポジトリを作り直したりアカウント名を変えたりしない）、**Publish するまで配信されない**（下書きのうちは旧バージョンのまま）。リリースには次が添付される。

- `Stockroom_X.Y.Z_aarch64.dmg` / `-setup.exe`：初回インストール用
- `Stockroom.app.tar.gz` と `.sig`、`-setup.exe` の `.sig`、`latest.json`：アプリ内アップデート用（tauri-action が生成）

更新ファイルの署名鍵は GitHub Actions の Secrets に置く（`TAURI_SIGNING_PRIVATE_KEY`：秘密鍵ファイルの中身、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：パスワード、未設定なら空）。対応する公開鍵は `tauri.conf.json` の `plugins.updater.pubkey`。**秘密鍵を失うと配布済みのアプリに更新を届けられなくなる**ので、必ずバックアップを取る。鍵の作り直しは `npx tauri signer generate -w ~/.tauri/image-library.key`。

ローカルで配布用ビルドをするときも署名鍵が要る（`createUpdaterArtifacts` が有効なため）。

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/image-library.key)" npm run tauri build
```

### リリースノート

アプリの「アップデート」の欄は GitHub のリリースページを開くので、利用者が変更点を知る場所はリリースの本文になる。

前回のタグからマージされた PR を元に書く。

```bash
git log --merges --oneline vPREV..vX.Y.Z   # マージされた PR（#番号とブランチ名）
gh pr view <番号>                          # 中身を確かめる
```

- 利用者から見えることだけを、日本語のですます調で書く。PR のタイトルやコミットメッセージは開発者向けの文言なので、そのまま貼らない。内部の整理・テスト・ビルドの変更は書かない
- 画面の場所ごとに `###` の見出しで分ける（例：Quick Look（ビューア）／一覧／サイドバー／設定）
- 何がどう変わったかと、必要なら前はどうだったか・どう操作するかを書く
- 最後に「インストール」の節を残す

書いたら `--notes-file` で本文を置き換える（見本は v0.28.1：`gh release view v0.28.1`）。

```bash
gh release edit vX.Y.Z --notes-file notes.md
```

```markdown
## 変更点

### Quick Look（ビューア）
- 〜できるようにしました。これまでは〜でした

### 一覧
- 〜

## インストール

インストーラ：macOS（Apple Silicon）は .dmg、Windows は -setup.exe
```

## アプリ内アップデートの仕組み

会社のネットワークなどでプロキシが必要な場合は、OS のプロキシ設定（自動プロキシ設定の PAC を含む）をそのまま使う（`src-tauri/src/proxy.rs`）。

アプリ自身が書き出したファイルには macOS の quarantine 属性が付かないので、この経路で更新すると Gatekeeper / SmartScreen の警告は出ない。更新ファイルは Tauri Updater の鍵（minisign）で署名されていて、アプリ側の公開鍵と一致しないものは適用されない。

## 旧名（Image Library）からの移行

名前と内部の ID（`com.local.imagelibrary` → `com.local.stockroom`）を変えたので、アプリ内アップデートで移れるように次の処理がある。

- `src-tauri/src/appdirs.rs`：起動時（と `--mcp` の中継の起動時）、プラグインがフォルダを開く前に、旧 ID のフォルダ（設定・ウィンドウの位置・ログ・WebView の保存領域）を新しい ID の名前へ移す。新しいフォルダがすでにあれば何もしない
- `src-tauri/windows/hooks.nsh`：製品名が変わるとインストール先とアンインストールの登録が別になるので、インストーラが先に旧 Image Library をサイレントでアンインストールする（設定は消さない）
- macOS のアプリ内アップデートは今のバンドルの場所に上書きするので、`Image Library.app` の名前は変わらない（README に利用者の手順）
