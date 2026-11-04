# 構成の方針：共通基盤と種類ごとの機能

Stockroom は、集めたもの（画像・ファイル・テキスト・動画・ブックマーク）を「探して使う」ためのアプリ。種類はサイドバーの「種類で絞る」（範囲、docs/KINDS.md）で見る。
フォントは別のアプリ（Typecase、docs/FONT_APP.md）に移した。アプリの土台をほかのアプリと共有できるように、
**共通基盤（core）** と **種類ごとの機能（features）** の境界を明確にしておく。

## 種類とデータ

- 項目が入るフォルダは 1 つまで（`item_folders` の `idx_item_folders_item`、移行 step 5）。テーブルは多対多の形のままだが、
  フォルダは置き場所で、フォルダをまたぐまとまりはタグで表す。`move_to_folder` は前のフォルダから外し、`file_unfiled` は未分類のものだけを入れる
- ライブラリの切り替えは頻度が低いのでサイドバーの一番下（`LibrarySwitcher`）
- **フォントがあった版のデータ**（docs/FONT_APP.md「Stockroom からフォントを消したとき」）：消さずに残し、読まない
  - `items` の `kind = 'font'` の行は、一覧・件数・検索・シェルフ・書き出し・共有・ライブラリ間のコピー・MCP・ゴミ箱を空にする、のどれにも出さない（`db.rs`）
  - `folders` / `tags` / `smart_folders` の `mode` 列は残し、`'stock'` のものだけを読む。新しく作るものは `'stock'`（列の既定値）。
    タグは名前と `mode` で 1 つ（`UNIQUE (name, mode)`）のまま
  - `tray_system` の表、`items` の `font_*` 列、ライブラリの設定の `lastMode` は読まない
- **種類の範囲**（docs/KINDS.md）：サイドバーの「種類で絞る」（`Sidebar.tsx` の `KindRange`、出す種類は `rangeKinds`）で
  `filter.kinds` を選ぶ。絞り込みの条件ではなく範囲：表示（フォルダ・タグなど）を移っても残り、「すべて解除」でも外さず、`activeConditions` に数えない。
  サイドバーの件数は、`byKind`（固定の場所・フォルダ・タグ・スマートフォルダの種類ごとの件数）から選んだ種類の分を足す（`inScope`）
- 一覧が持ちうる種類は `listKinds`（`lib/kinds.ts`、状態を受け取る純粋関数）の 1 か所で決める：使う種類を種類の絞り込みで狭め、
  開いているスマートフォルダの条件と重複の候補（画像だけ）でさらに狭める。問い合わせの `filter.kinds` は `queryKinds`（全種類なら空）
- 縦横を持つもの（画像と動画、`PIXEL_KINDS`）だけの機能は、一覧がそれだけのとき（`listHasPixels`）に出す。「形式」で画像・動画の形式（JPEG など）だけを選んだときも同じ（`listKinds` が選んだ形式の種類で絞る）：「サイズ（px）」の絞り込みと並び替え。
  DB でも縦横の条件は画像と動画だけに効く（`db.rs` の `PIXEL_KINDS`）。ほかの種類が混ざったら、これらの条件と並び順を外す（`fitToKinds`）。画像だけの機能（回転・重複の候補など）は今どおり `listIs(s, "image")`。重複の候補は、画像を使うライブラリに出し、
  種類の絞り込みにかかわらず画像だけを問い合わせる。回転などの `kinds` 付きの操作は `appliesTo`（`commands.ts`）で、
  一覧がその種類だけなら使え、混ざっていれば選択がその種類だけのときに使える
- ライブラリごとに「使う種類」（設定のキーは前からの `modes`）を選べる（docs/SETTINGS.md）。フォントがあった版の `"font"` は読むときに外す（`lib/librarySettings.ts`）
- 件数（`get_counts`）、形式の一覧（`list_exts`）は、種類の範囲では問い合わせ直さず、`byKind` から画面で足す
- レイアウトとグループ分けは `store.ts` の `LAYOUTS` / `GROUPS`。標準・Pinterest 風・グリッド・リストで、
  ツールバーには画像が入りうるなら標準と Pinterest 風、ファイルだけならグリッドとリストを出す。グループ分けに「種類」がある
- **シェルフ**（`components/Shelf.tsx`、`store.shelf`）：詳細パネル（`components/DetailsPanel.tsx`）のタブ。どちらのタブかは `store.panelTab`、ドラッグ中に出すのは `useShelfPeek`。中身は `tray` テーブル
  （`refresh` で一覧と一緒に取る）。一覧として開く表示ではなく、`View` の `tray` はこの問い合わせにだけ使う。
  画像の比較ビューは `components/ImageCompare.tsx`（docs/COMPARE.md）
- スマートフォルダの `filter.kinds` は、保存したときの範囲（サイドバーの「種類で絞る」）。
  開いているときは絞り込みの行の末尾に鍵付きで出し、条件を編集するときは範囲に読み込む（終えたら元の範囲に戻す。`editingSmart.kinds`）

- **場所と絞り込み**（docs/NAVIGATION.md）：サイドバーは場所（`View`）を 1 つ選ぶ。タグも場所（`View::Tag` / `{ kind: "tag", id }`）。
  絞り込みはツールバー 3 段目の `components/FilterRow.tsx` 1 か所。一覧の問い合わせは `listQuery(s)`（`store.ts`）で作り、`listQuery(s, key)` はその条件だけを外したもの。
  メニューの件数は開いたときに `facet_counts`（`db.rs`。問い合わせの WHERE は `query_where` を `query_rows` と共有）で数える。
  「5 / 13 件」の分母は `placeTotal`（サイドバーの件数から）

種類を増やすとき（例：動画は docs/VIDEO.md、ブックマークは docs/BOOKMARKS.md）：`ItemKind` と `KINDS`（`lib/api.ts`）、`features/<kind>/` を足す。
チップと「使う種類」は `KINDS` から作られる。

## コマンド

アプリの操作は `src/lib/commands.ts` の `COMMANDS` に 1 つずつ定義する（id・名前・状態に応じた表示名・キー・使える種類・
使えるか・チェック・実行）。次はすべてこの表から作るので、操作を足すときはまずここに足す（docs/MENUS.md）。

- 一覧のキー処理（`Grid.tsx` → `runKey`）。一覧の中だけの移動・評価の数字・Space / Enter は `Grid.tsx` に残す
  - ダイアログ・メニュー・パネルなど一覧の上に重なるものは、外枠に `data-modal` を付ける。それがある間、一覧のキー処理は何もしない（重複の確認中の Delete で後ろの選択がゴミ箱に入らないように）
  - 入力欄のキー処理は `lib/ime.ts` の `composing` で日本語入力の変換中を除く（macOS では確定の Enter で `isComposing` がもう false のため）
- メニューバー（`lib/menuBar.ts`）。⌘ 付きのキーはアクセラレータ、1 文字のキーは表示だけ
- 右クリックメニューの行（`lib/menuItems.ts` の `commandItem` / `commandIcon`）
- ショートカット一覧（`lib/shortcuts.ts` の `shortcutSections`）。マウス操作やビューアだけのキーは説明の行として持つ

「一覧の中身への操作」（書き出し・まとめて出力・シェルフにすべて追加・別のライブラリへ）は、対象を `ListSource`
（選択・表示中の一覧・フォルダ・スマートフォルダ・タグ・シェルフ）で受け、中身は `listTargets`（`lib/actions.ts`）で取る。

## 境界

| 層 | 場所 | 中身 |
|---|---|---|
| 共通基盤（core） | `src/lib/*`, `src/store.ts`, `src/components/*` | ライブラリ・DB・取り込み・フォルダ・タグ・スマートフォルダ・検索・一覧の骨組み（Grid / Sidebar / Toolbar / Inspector / Viewer）・Updater |
| | `src-tauri/src/{db,import,library,search,webimport,share,loopback,changes,proxy,transfer,export,commands}.rs` | スキーマ・クエリ、取り込み、受付サーバー、フォルダの共有、変更の記録と取り消し、ライブラリ間のコピー・移動、書き出し、共通コマンド |
| | `src-tauri/src/mcp/` | Claude からの整理（MCP サーバー、`--mcp` の中継）。`docs/MCP.md` |
| ファイル | `src/features/files/` | ビューア（`FileView.tsx`：PDF は `<iframe>`、ほかはサムネイルと「既定のアプリで開く」） |
| | `src-tauri/src/files/` | 対応する拡張子、サムネイル（Quick Look／Windows.Data.Pdf（`win_pdf.rs`）／中のプレビュー／種類のカード） |
| テキスト | `src/features/texts/` | ビューア（`TextView.tsx`：プレビューと自動保存の編集）、Markdown の HTML 化と掃除（`markdown.ts`）、CSV / TSV（`csv.ts`）、新規作成と貼り付け（`actions.ts`）。docs/TEXT.md |
| | `src-tauri/src/texts/` | 対応する拡張子、文字コードの判定と書き戻し（Shift_JIS）、サムネイル（先頭を紙に描く SVG）、検索用の本文、読み込み・保存・新規作成のコマンド |
| 動画 | `src/features/videos/` | ビューア（`VideoView.tsx`：`<video>` で再生） |
| | `src-tauri/src/videos/` | 対応する拡張子、ヘッダからの長さ・縦横（`probe`）。取り込みは `import.rs` の `process_video` |
| ブックマーク | `src/features/bookmarks/` | ビューア（`BookmarkView.tsx`）、URL の貼り付け（`actions.ts`）。docs/BOOKMARKS.md |
| | `src-tauri/src/bookmarks/` | URL のそろえ方・カードのサムネイル・登録（`add`。拡張の `POST /bookmark` と貼り付けで共通）、コマンド |
| 画像 | `src-tauri/src/{formats,orient,similar}.rs`、`components/DuplicateReview.tsx` ほか | デコード、回転・反転、似ている画像の検出（まだ `components/` に混ざっている） |

依存の向きは **features → core** のみ。core が種類ごとの知識を持つのは、DB に入っている語彙（`ItemKind` など）までにとどめ、振る舞いは features に置く。

## ライブラリの中のファイル

項目のファイルは `images/<id>/<元のファイル名>`（画像以外の種類も同じ。フォルダ名は前からのまま）。この場所は `library.rs` の関数だけで組み立て、
ほかで `"images"` を書かない：`file_path`（`Item` から）、`stored_file`（id とファイル名だけを問い合わせたとき）、`item_dir`（項目のフォルダ）、
`store_file`（取り込み・新規作成で書く）、`remove_item_dir`（失敗したときの後始末・削除）。アプリのフォルダ構成どおりの写しは書き出しで作る（docs/EXPORT.md）

## 外から来るファイルとセキュリティ

取り込むファイルはどこから来たか分からない（ブラウザ拡張で Web から保存したものも入る）ものとして扱う。

- 大きさはファイルに書かれた値をそのまま信じず、上限を設けて読む（zip の中のプレビュー・WIC のデコード）。
  リリースビルドは `panic = "abort"` なので、確保の失敗やパニックはアプリごと落ちる
- SVG の `<image href>` は `data:` URL だけを読む（`formats::svg_options`）。PDF は中身を確かめてから iframe に出す（`files::is_pdf`）
- Markdown は HTML にしてから、許可した要素と属性だけを残して画面に入れる（`features/texts/markdown.ts`）。リンクは `http(s):` / `mailto:` だけを既定のブラウザで開く
- Windows のバックグラウンドの Office 変換は、Web から保存したもの（`source_url` あり）を対象にしない
- フォルダの共有（`share.rs`）だけは LAN から届く。GET だけで、どの要求も共有したフォルダの中のものかを確かめてから返す。
  ファイルは `Content-Security-Policy: sandbox` 付きで返し（SVG の中のスクリプトを動かさない）、ページの文字はすべて `textContent` で入れる
- Web ビューの CSP は `tauri.conf.json` の `security.csp`。外のリソースを読み込む機能を足すときは、ここにも足す
  （開発時は `devCsp`）

## 今後

- 画像だけの機能（重複の候補・回転）も `features/images/` に寄せる
- アプリの土台を desktop-platform の共通の部品（core）に切り出す（docs/FONT_APP.md「core」）
