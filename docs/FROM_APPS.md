# ほかのアプリから受け取る（Feedability ほか）

**状態**：受け口は対応済み（2026-10-18。`webimport.rs` の `Peer`）。相手側の計画は Feedability の `docs/STOCKROOM.md` と ADR-0004（採用）。

困っていること：Feedability（同じ作りのフィードリーダー）で読んだ記事のうち、取っておきたいものを stockroom に入れる手段が無い。
フィードの記事は流れていくもので、Feedability は古い記事を消すし、元のページも書き換わったり消えたりする。
stockroom はストック、Feedability はフローと役割を分け、**取っておきたいものだけを stockroom へ送る**。

## 決定

| 論点 | 決定 |
|---|---|
| 受け口 | **今のブラウザ拡張の受付（`webimport.rs`、127.0.0.1:41620）を使う**。待ち受けポートは増やさない |
| 足すもの | 拡張以外のアプリも `/pair` で接続の許可を求められるようにする。それ以外の API（`/info` `/folders` `/tags` `/import`）は変えない |
| 届く形 | ファイル。Feedability の記事は Markdown（`.md`）1 件で、`page` に記事の URL が入る。新しい種類は足さない（テキストとして入る。docs/TEXT.md） |
| 入る場所 | ストックモードのフォルダとタグ（拡張と同じ。docs/MODES.md） |
| データ | 相手のアプリは stockroom の `library.db` やライブラリのフォルダを直接触らない。書き込むのは stockroom だけ（MCP と同じ） |
| 初期状態 | 受付が今どおりオフなら、相手のアプリには「stockroom で受付をオンにしてください」と返る |

URL（ブックマーク）の種類（docs/ARCHITECTURE.md「今後」）を作ったら、「リンクだけ送る」もこの受け口で受ける。それまでは待たない。

## 接続の許可（`/pair`）を拡張以外にも開く

今は `Origin: chrome-extension://…` の要求だけが `/pair` を使える（`handle` の 2 つ目の検査と `/pair` の中）。
アプリ（Rust の HTTP クライアント）からの要求には `Origin` が付かないので、ここで 403 になる。

- `Origin` が無く、`X-Stockroom-Client: <アプリ名>` が付いた `POST /pair?code=1234` を、アプリからの接続の要求として受ける
  - 拡張の要求（`chrome-extension://`）は今のまま
  - `Origin` が付いていて拡張のものでない要求（Web ページ）は今のまま 403。ブラウザは POST に必ず `Origin` を付けるので、ページがヘッダーを偽ってもここで止まる
  - `Host` の検査（DNS rebinding よけ）も今のまま
- 許可のダイアログ（`WebImportDialog.tsx` の接続の確認、イベント `web-pair`）に、拡張の ID の代わりに **アプリ名** を出す：
  「アプリ「Feedability」が接続を求めています。番号 1234」。番号は相手のアプリにも出し、同じ要求だと分かるようにする
  - アプリ名は自己申告。ダイアログには「名前は相手が名乗ったもの」と分かる書き方をし、番号の一致で確かめてもらう
  - 名前は 40 文字まで、制御文字を落としてから出す
- 拒否したときの待ち時間（`refused`）は、拡張の ID の代わりにアプリ名で数える
- 渡すトークンは拡張と同じもの（受付のトークンは 1 つ）。「トークンを作り直す」で拡張もアプリもまとめて切れる。
  相手ごとに切りたくなったら、トークンを相手ごとに分ける（今はやらない）

守る範囲は今と同じで、**Web ページから使われないこと**。同じ PC で動くほかのプログラムは、もともと `library.db` を直接読めるので守る対象にしていない。
ただし許可なしには書き込ませない（トークンが無ければ 401）。

## Feedability から届く Markdown

ファイル名は `<記事のタイトル>.md`。`import::run` が同名を連番にする。中身：

```markdown
# 記事のタイトル

- 元のページ：https://example.com/post/1
- フィード：Example Blog
- 公開：2026-10-17
- 保存：2026-10-17（Feedability から）

---

本文（記事の HTML を Markdown にしたもの）
```

- `POST /import?name=<タイトル>.md&page=<記事の URL>&folder=&tag=` で送る。`page` は詳細パネルの「取り込み元」になり、MCP の `find_items` にも出る
- 本文の画像は Markdown の画像にせず `[画像](URL)` のリンクにする（stockroom の画面は外の画像を読まない）。画像も残したいときは、別に画像として送る（下の「あとで」）
- 表示は今の Markdown の安全化（`features/texts/markdown.ts`）を通るので、届いた Markdown を信用しなくてよい
- 本文の検索に入る（docs/TEXT.md）
- 同じ記事を 2 回送ると、中身が同じなら重複として数え、タグだけ足す（今の `/import` と同じ）。記事が更新されて中身が違えば別の項目になる

## 実装のとき触るところ

- `src-tauri/src/webimport.rs`：`Head` に `X-Stockroom-Client` を足し、`handle` の Origin の検査と `/pair` を上のとおりに。テスト（アプリからの接続の許可、Origin 付きでアプリ名を名乗る要求の拒否）
- `Host::approve_pairing` の引数を「拡張の ID」から「相手」（拡張 / アプリ名）へ
- `src/components/WebImportDialog.tsx` の接続の確認、`App.tsx` の `web-pair` の受け取り
- 設定の「連携」の「ブラウザ拡張」のページに、受付をオンにするとほかのアプリ（Feedability）からも保存できることを 1 行足す（名前を変えるかは画面を作るときに決める。docs/SETTINGS.md）
- docs/FEATURES.md に使い方を足す
- モック（`src/dev/mockBackend.ts`）：接続の確認のイベントにアプリ名の形を足す

## 人の判断（2026-10-17 に決定）

- 受付を拡張以外のアプリにも **開く**。守る範囲は上の「守る範囲」のとおり
- 受付のトークンは拡張と **共通**（相手ごとには分けない）。分けたくなったら、そのとき決め直す

## あとで

- 記事の画像を画像として送る（`page` は記事の URL。Feedability は画像をすでに Rust で取っている）
- URL の種類ができたら、Feedability に「リンクだけ送る」を足す
- 送り先のフォルダを送るたびに選ぶ（最初は Feedability の設定で 1 つ決める）
