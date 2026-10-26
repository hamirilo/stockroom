# 動画

ストックの種類 `video`（`ItemKind` / `db::Kind::Video`）。MP4・M4V・MOV・WebM を取り込み、一覧・ビューアで見る。
編集はしない（ファイルはそのまま保管する）。ロードマップのフェーズ 7 を実装したもの。

## 決めたこと

| 論点 | 決定 |
|---|---|
| モード | ストック（`modeOf`）。画像・ファイルと同じフォルダ・タグに並べる |
| 取り込み | ファイルを丸ごとメモリに読まない。ディスクからハッシュを取り（重複判定）、そのままコピーする（`import.rs` の `process_video`、`library::copy_file`）。数 GB でも落ちない |
| サムネイル | OS の 1 コマ（macOS は Quick Look）。取れなければ種類のカード。**Windows は未対応でカードのまま**（シェルのサムネイル API は今後） |
| 長さ・縦横 | ファイル自身のヘッダから読む（`videos/mod.rs` の `probe`：MP4/MOV は `mvhd`・`tkhd`、WebM は EBML）。ffmpeg は同梱しない。長さは `items.duration_ms`（step 24）、縦横は `width` / `height` |
| 再生 | ビューアの `<video>`（`features/videos/VideoView.tsx`）。Web ビューが読める形式だけ。再生できなければサムネイルと「既定のアプリで開く」 |
| CSP | `media-src 'self' asset: http://asset.localhost` を足した（`tauri.conf.json`。ユーザー承認済み） |
| 一覧 | サムネイルの右下に再生時間。ホバーのコマ送りは後回し |
| 似ている画像 | 対象外（`phash` なし） |

## 触るところ

- 拡張子：`videos::EXTS` と `lib/api.ts` の `VIDEO_EXTS`、`formats::SUPPORTED_EXTS`
- ビューアのキー：どこをクリックしたあとでも、Space・Enter・Esc は閉じる、矢印は前後の項目へ（ほかの種類と同じ）。プレーヤーの操作は K（再生 / 一時停止）、J / L（10 秒戻す / 進める）、, / .（一時停止中に 1 コマ）。YouTube と同じ割り当て。
  シークバーなどを操作するとプレーヤーにフォーカスが移り、そのままだと Space・矢印がプレーヤーに取られる（クリックの前後で Space の意味が変わる）ので、ポインタを離したらフォーカスを外す（`VideoView.tsx`）
- 範囲再生（Range）は asset プロトコルが受ける
