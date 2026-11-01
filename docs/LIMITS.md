# 機能を絞ったビルド

ビルドするときの環境変数で、扱う種類や一部の機能を外したビルドを作れる。何も指定しなければ、すべてが入ったいつものビルドになる。

使う場面の例：

- 画像だけを扱う人に配るので、ほかの種類やフォントのモードを出したくない
- 配る前にセキュリティの検査があるので、ポートを開く機能やアプリ内の自動更新を外したい

## 環境変数

| 変数 | 値の例 | 外れるもの |
|---|---|---|
| `STOCKROOM_KINDS` | `image`、`image,video` | 挙げていない種類。種類の名前は `KINDS`（`src/lib/api.ts`）のもの |
| `STOCKROOM_NO_CONNECT` | `1` | ブラウザ拡張と Claude との連携（MCP） |
| `STOCKROOM_NO_UPDATE` | `1` | アプリ内アップデート |
| `STOCKROOM_NAME` | `Stockroom（〇〇用）` | 外れるものはない。アップデートの欄の代わりに出す版の表示の名前 |

`STOCKROOM_NO_CONNECT` と `STOCKROOM_NO_UPDATE` は、空や `0` なら指定していないのと同じ。

Rust（`option_env!`）とフロントエンド（`vite.config.ts` の `envPrefix`）が、どちらもビルドのときにこの変数を読む。そのため、`tauri build` / `tauri dev` を実行するシェルで設定する。

```bash
STOCKROOM_KINDS=image STOCKROOM_NO_CONNECT=1 STOCKROOM_NO_UPDATE=1 bun run tauri dev
STOCKROOM_KINDS=image bun run dev   # ブラウザで UI だけ（モック）
```

製品名・ID・インストーラの種類・updater の設定は、この変数では変えない。変えたいときは、別の設定ファイルを `tauri build --config <file>` で重ねる。元の `tauri.conf.json` はそのままにしておく。

## それぞれで外れるもの

### `STOCKROOM_KINDS`

- 取り込み：挙げていない種類のファイルは、対応していない形式と同じように飛ばす（`limits::accepts`、`import.rs` の `ext_of`）。`supported_exts` も挙げた種類の形式だけを返す
- ライブラリの「使う種類」は、挙げた種類の中からしか選べない（`librarySettings.ts`）。1 種類だけなら、設定の「種類」のページを出さない。フォントがなければ、フォントのモードも出ない
- テキストやブックマークを挙げていなければ、それを作るコマンドを断る。新規テキストのコマンドを外し、貼り付けても作らない

### `STOCKROOM_NO_CONNECT`

- ブラウザ拡張の受付サーバーと MCP サーバーを起動しない。設定で前にオンにしていても始めない
- 設定のブラウザ拡張・Claude のページと、ヘルプメニューの項目を外す。設定を変えるコマンドも断る
- `--mcp` の中継は動かない

### `STOCKROOM_NO_UPDATE`

- updater プラグインを読み込まず、起動したときの確認もしない
- メニューの「アップデートを確認」「このバージョンの更新内容」を外す。設定の「一般」には、アップデートの欄の代わりに版の表示を出す

更新ファイル（`createUpdaterArtifacts`）と updater の設定は、この変数では止まらない。要らなければ、重ねる設定ファイルで外す。

## コードの置き場所

- フロントエンド：`src/lib/limits.ts`（`LIMITED_KINDS`・`buildHas`・`NO_CONNECT`・`NO_UPDATE`・`OFF_COMMANDS`・`OFF_SETTINGS`）
  - `OFF_COMMANDS` に入れたコマンドは、コマンド表（`src/lib/commands.ts`）から外れる。そのため、メニュー・キー・ショートカット一覧からも消える
- Rust：`src-tauri/src/limits.rs`（`accepts`・`has`・`require_kind`・`require_connect`・`NO_CONNECT`・`NO_UPDATE`）
- モック：`src/dev/mockBackend.ts` も同じように断る

画面では、外したものの場所を詰めるだけにする。並びの組み替えはしない（docs/UI.md）。外せるものを足すときは、上の 2 つのファイルに足し、ほかのコードからはそこを見る。

## テスト

```bash
cargo test --manifest-path src-tauri/Cargo.toml
STOCKROOM_KINDS=image STOCKROOM_NO_CONNECT=1 STOCKROOM_NO_UPDATE=1 cargo test --manifest-path src-tauri/Cargo.toml
```

ある種類の取り込みを確かめるテストは、その種類を外したビルドでは何もしない。逆に、外した種類を飛ばすことを確かめるテスト（`a_build_with_fewer_kinds_skips_the_others`）は、`STOCKROOM_KINDS=image` のときだけ確かめる。
