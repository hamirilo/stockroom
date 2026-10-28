# 構成の方針：共通基盤と種類ごとの機能

画像・ファイルは「探して使う」、フォントは「比べて選ぶ」と使う場面が違う。そこでモードを **［ストック｜フォント］** に分け、
フォルダ・タグ・スマートフォルダも **モードごとに別々に持つ**（docs/MODES.md）。画像とファイルはストックの中で種類の絞り込みで見る。
フォントを別アプリに切り出す案は保留中で、そうなっても困らないように、
**共通基盤（core）** と **種類ごとの機能（features）** の境界を明確にしておく。

## モード

- `store.ts` の `mode`（`"stock" | "font"`、型は `lib/api.ts`、`MODES` は `lib/modes.ts`）。項目のモードは種類で決まる
  （`modeOf`：フォントはフォント、ほかはストック。Rust は `db::Mode::of`）。
  サイドバー上部の切替、⌘1 ストック / ⌘2 フォント（`MODES` の順）。
  ライブラリの切り替えは頻度が低いのでサイドバーの一番下（`LibrarySwitcher`）
- **モードごとのデータ**：`folders` / `tags` / `smart_folders` の `mode` 列（`db.rs`）。一覧は `list_folders(mode)` などで
  そのモードのものだけを取る。
  - 項目が入るフォルダは 1 つまで（`item_folders` の `idx_item_folders_item`、移行 step 5）。テーブルは多対多の形のままだが、
    フォルダは置き場所で、フォルダをまたぐまとまりはタグで表す。`move_to_folder` は前のフォルダから外し、`file_unfiled` は未分類のものだけを入れる
  - フォルダにはそのモードの項目しか入らない（`move_to_folder` / `file_unfiled` がほかを無視する）。サブフォルダは親のモード、
    並び順はモードごとの最上位で別々（`sibling_ids`）。別のモードのフォルダの下へは移せない（`place_folder`）
  - タグは名前と `mode` で 1 つ（`UNIQUE (name, mode)`）。`add_tags` は項目ごとにそのモードのタグを付ける（無ければ作る）ので、
    画像とフォントを一緒に選んで同じ名前を付けると、両方のモードに同じ名前のタグができる
  - スマートフォルダは作ったモードのもの。件数・中身はそのモードの項目の中だけで数える
  - 取り込み・ライブラリ間のコピー・ブラウザ拡張（ストックのフォルダとタグだけを見せる）・MCP も、項目のモードのフォルダとタグを使う。
    フォルダへドロップしたときにほかのモードの項目が混ざっていたら、それは未分類のまま入る（取り込み後に `notifyOtherMode` で知らせる）
  - 分ける前のライブラリは、開いたときに移行する（step 21。`split_modes`）。その前に `library.before-modes.db` へ複製を残す
    （`back_up_before_modes`）
- **種類の絞り込み**：ストックでは、絞り込みの行の「種類」（`FilterRow.tsx` の `KindCondition`、`KINDS` のうちストックの種類から作る）で
  `filter.kinds` を選ぶ。ほかの条件と違い、表示（フォルダ・タグなど）を移っても残る（モードの代わり）。「すべて解除」では外す
- 一覧が持ちうる種類は `listKinds`（`lib/modes.ts`、状態を受け取る純粋関数）の 1 か所で決める：モードの種類（使う種類のうちそのモードのもの、
  `kindsOfMode`）を種類の絞り込みで狭め、開いているスマートフォルダの条件と重複の候補（画像だけ）でさらに狭める。
  問い合わせの `filter.kinds` は `queryKinds`（全種類なら空。ストックとフォントはどちらも全種類にはならない）
- 画像だけの機能は、一覧が画像だけのとき（`listIs(s, "image")`）に出す。「形式」で画像の形式（JPEG など）だけを選んだときも画像だけとみなす（`listKinds` が選んだ形式の種類で絞る）：縦横・画像サイズの絞り込み、画像サイズの並び替え。
  ほかの種類が混ざったら、これらの条件と並び順を外す（`fitToKinds`）。重複の候補は、画像を使うライブラリのストックに出し、
  種類の絞り込みにかかわらず画像だけを問い合わせる。回転などの `kinds` 付きの操作は `appliesTo`（`commands.ts`）で、
  一覧がその種類だけなら使え、混ざっていれば選択がその種類だけのときに使える
- **ライブラリごとに記憶する**：ライブラリは最後に開いていたモードで開く（`library.db` の `settings` テーブルの `lastMode`。
  無ければフォントがほかの種類より多いときだけフォント、ほかはストック。`lib/librarySettings.ts` の `openingMode`）。
  ライブラリごとに「使う種類」（`modes`）を選べ、使う種類のあるモードだけが切り替えに出る（`modesFor`）。docs/SETTINGS.md
  - 前の版の `lastMode: "all"` と `hidden:all` はストックのものとして読む。画像・ファイルのモードがあった版の `lastMode: "image"` などは、
    ストックをその種類に絞って開く。サイドバーで隠した項目は `hidden:stock`、`hidden:all`、`hidden:image` / `hidden:file` の順に引き継ぐ
    （`parseLibrarySettings`。アプリ全体の設定は `parseSidebarHidden`）
- 件数（`get_counts`）、形式の一覧（`list_exts`）は `mode` 引数でそのモードの項目だけを数える（`db.rs` の `mode_where`）。
  種類の絞り込みでは変えない
  - `Counts.kinds` だけは常に全種類の件数（モード切替のバッジ用）
- レイアウトとグループ分けはモードごとに保存する（`layout:<mode>`, `groupBy:<mode>`。ストックは `layout:all`、以前の画像モードのものを引き継ぐ）。
  使える組み合わせは `MODE_LAYOUTS` / `MODE_GROUPS`（`store.ts`）。ストックは標準・Pinterest 風・グリッド・リストで、
  ツールバーには画像が入りうるなら標準と Pinterest 風、ファイルだけならグリッドとリストを出す。グループ分けに「種類」がある。
  フォントは見本・グリッドで、グループ分けは書体・言語など。一覧は常に 1 ファミリー 1 行（`groupItems` の `families`、代表の行の
  `familyIds` が全スタイル）で、見本では ▸ で開いたファミリー（`openFamilies`）の太さ違いを行の下に出す（`familyMember`）。
  行が表す ID は `rowIds` で取る（選択・範囲選択・見出しのクリック）。docs/FONT_UI.md
- **シェルフ**（`components/Shelf.tsx`、`store.shelf`）：詳細パネル（`components/DetailsPanel.tsx`）のタブ。どちらのタブかは `store.panelTab`、ドラッグ中に出すのは `useShelfPeek`。中身は `tray` テーブルを、モードの種類で問い合わせる
  （`refresh` で一覧と一緒に取る）ので、モードごとに別のシェルフになる。一覧として開く表示ではなく、`View` の `tray` はこの問い合わせにだけ使う。
  フォントモードは `FONT_SHELF_MAX`（8）件までで、比較ビュー（`features/fonts/CompareView.tsx`、`store.comparing`）を一覧の場所に出す。
  ストックは画像の比較ビュー（`components/ImageCompare.tsx`、docs/COMPARE.md）。
  ファミリーの行をシェルフに置くと代表の 1 件になる（`shelfIds`）
- スマートフォルダの `filter.kinds` はほかと同じ条件（絞り込みの行の「種類」で選んだもの）。フォントモードで作ったものは `kinds` が空。
  条件を編集するときは、`kinds` を「種類」に読み込む

- **場所と絞り込み**（docs/NAVIGATION.md）：サイドバーは場所（`View`）を 1 つ選ぶ。タグも場所（`View::Tag` / `{ kind: "tag", id }`）。
  絞り込みはツールバー 3 段目の `components/FilterRow.tsx` 1 か所（フォントの言語・書体・太さ・特徴は `features/fonts/FontFilters.tsx` の
  `FontConditions` が同じ部品で出す）。一覧の問い合わせは `listQuery(s)`（`store.ts`）で作り、`listQuery(s, key)` はその条件だけを外したもの。
  メニューの件数は開いたときに `facet_counts`（`db.rs`。問い合わせの WHERE は `query_where` を `query_rows` と共有）で数える。
  「5 / 13 件」の分母は `placeTotal`（サイドバーの件数から）

種類を増やすとき（例：動画は docs/VIDEO.md、ブックマークは docs/BOOKMARKS.md）：`ItemKind` と `KINDS`（`lib/api.ts`）、`features/<kind>/` を足し、`modeOf` と
`db::Mode::of` でどのモードのものかを決める。チップと「使う種類」は `KINDS` から作られる。見え方が根本的に違うならモードにする
（`Mode`、`MODES`、`MODE_LAYOUTS` / `MODE_GROUPS`、サイドバーの `ModeSwitch`、`db.rs` の `Mode` と移行）。

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
| フォント | `src/features/fonts/` | この端末のフォントの一覧・絞り込み・件数・シェルフへの差し込み・ライブラリとの照合（`system.ts`）、詳細パネル（`SystemFontPanel.tsx`）、照合の印（`FontLink.tsx`）、フォント専用コマンドのラッパ（`api.ts`）、フォントの読み込み（`loader.ts`）、見本の行とグリッドのタイル（`FontRows.tsx`）、ビューア（`FontView.tsx`）、詳細パネルの行（`FontDetails.tsx`）、絞り込みの行の言語・書体・太さ・特徴（`FontFilters.tsx`）、見本の文字の行と大きさ（`SpecimenControls.tsx`）、見本のパターン（`patterns.ts`）、比較ビュー（`CompareView.tsx`）、シェルフの行（`ShelfChip.tsx`）、ウェイト名（`weights.ts`） |
| | `src-tauri/src/fonts/` | パース・分類・見本の描画（`mod.rs`）、フォント専用コマンド（`commands.rs`）、この端末のフォントの読み込みとキャッシュ（`system.rs`） |
| ファイル | `src/features/files/` | ビューア（`FileView.tsx`：PDF は `<iframe>`、ほかはサムネイルと「既定のアプリで開く」） |
| | `src-tauri/src/files/` | 対応する拡張子、サムネイル（Quick Look／Windows.Data.Pdf（`win_pdf.rs`）／中のプレビュー／種類のカード） |
| テキスト | `src/features/texts/` | ビューア（`TextView.tsx`：プレビューと自動保存の編集）、Markdown の HTML 化と掃除（`markdown.ts`）、CSV / TSV（`csv.ts`）、新規作成と貼り付け（`actions.ts`）。docs/TEXT.md |
| | `src-tauri/src/texts/` | 対応する拡張子、文字コードの判定と書き戻し（Shift_JIS）、サムネイル（先頭を紙に描く SVG）、検索用の本文、読み込み・保存・新規作成のコマンド |
| 動画 | `src/features/videos/` | ビューア（`VideoView.tsx`：`<video>` で再生） |
| | `src-tauri/src/videos/` | 対応する拡張子、ヘッダからの長さ・縦横（`probe`）。取り込みは `import.rs` の `process_video` |
| ブックマーク | `src/features/bookmarks/` | ビューア（`BookmarkView.tsx`）、URL の貼り付け（`actions.ts`）。docs/BOOKMARKS.md |
| | `src-tauri/src/bookmarks/` | URL のそろえ方・カードのサムネイル・登録（`add`。拡張の `POST /bookmark` と貼り付けで共通）、コマンド |
| 画像 | `src-tauri/src/{formats,orient,similar}.rs`、`components/DuplicateReview.tsx` ほか | デコード、回転・反転、似ている画像の検出（まだ `components/` に混ざっている） |

依存の向きは **features → core** のみ。core が種類ごとの知識を持つのは、DB に入っている語彙（`ItemKind`、`FONT_SCRIPTS` /
`FONT_CATEGORIES` のラベル、`Item` のフォント列、`Filter.fontScripts` など）までにとどめ、振る舞いは features に置く。

この端末のフォント（`View` の `{ kind: "system" }`、ID が `sys:` で始まる行）はライブラリの項目ではない（[SYSTEM_FONTS.md](SYSTEM_FONTS.md)）。
core が持つのはその語彙（`isSystemId` / `libraryIds`、`lib/api.ts`）まで。一覧と絞り込みの件数は `store.ts` の `refresh` と `FilterRow.tsx` の
`useFacets` で `features/fonts/system.ts` へ振り分ける。書き込みの操作は `commands.ts` の `mine` / `library` で無効にし、`actions.ts` の各操作の入口でも
`libraryIds` で外して、`sys:` の ID をライブラリのコマンドへ渡さない。例外はシェルフで、フォントのシェルフには端末のフォントも置く
（`tray_system`。`actions.ts` の `addToTray` が振り分け、`refresh` で `fontShelf` が差し込む）。

共通の UI（`Grid.tsx` / `Sidebar.tsx` / `Shelf.tsx` / `App.tsx`）が features の部品を描く箇所（見本の行、言語・書体の節、シェルフの行、比較ビュー）では、
features 側が core の部品（`Row` / `Section`、`CellProps` / `showItemMenu`）を使うので import が循環する。
いずれも描画時にしか参照しないので問題ないが、core 側の部品を独立したファイルに出せばほどける。

## ライブラリの中のファイル

項目のファイルは `images/<id>/<元のファイル名>`（画像以外の種類も同じ。フォルダ名は前からのまま）。この場所は `library.rs` の関数だけで組み立て、
ほかで `"images"` を書かない：`file_path`（`Item` から）、`stored_file`（id とファイル名だけを問い合わせたとき）、`item_dir`（項目のフォルダ）、
`store_file`（取り込み・新規作成で書く）、`remove_item_dir`（失敗したときの後始末・削除）。アプリのフォルダ構成どおりの写しは書き出しで作る（docs/EXPORT.md）

## 外から来るファイルとセキュリティ

取り込むファイルはどこから来たか分からない（ブラウザ拡張で Web から保存したものも入る）ものとして扱う。

- 大きさはファイルに書かれた値をそのまま信じず、上限を設けて読む（WOFF / WOFF2・zip の中のプレビュー・WIC のデコード）。
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
- 別アプリに分ける場合は、`features/fonts/` と `src-tauri/src/fonts/` をそのまま持ち出し、core をパッケージとして共有する
