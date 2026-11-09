## 作業の約束（全リポジトリ共通）

- 返答・コミットメッセージ・ドキュメント・コードのコメントは日本語。結論を先に書く
- 次の場面では作業を止め、選択肢を並べた質問（AskUserQuestion）で判断を仰ぐ:
  設計や方式が分かれるとき／依頼の範囲を広げる・狭めるとき／削除・データ移行・本番に関わるとき／ADR を新しく書くとき
- 上記以外の小さな判断は自分で決め、何を決めたかを返答に書く
- コミットは差分の要約を提示してから。main への直接 push はしない。push と PR は依頼があったときだけ
- 長い報告は docs/ か報告書ファイルに書き、チャットには要点だけ
- ルールを足すときは文書ではなく検査（テスト・lint）にする。検査にできないルールは原則集に 1 行で書く

---

# Stockroom

集めたものを何でもストックしておける、ローカルの保管庫アプリ（Tauri 2 / macOS・Windows）。

## 開発の基準

開発の Standard・Recommendations・Playbook は **`../desktop-platform/ai/ONBOARDING.md`** を最初に参照すること。Web アプリ向けの ai-dev-platform は参照しない。

## このツール固有

- **画面の原則：[docs/UI.md](docs/UI.md)。** 表示（ビュー・モード・レイアウト・グループ分け）の切り替えなどを繰り返しても、主要な操作の位置やレイアウトを不必要に変化させない。画面に触れる変更の前に読む
- 設計の境界：`docs/ARCHITECTURE.md`
- 機能を絞ったビルド：`docs/LIMITS.md`。外せるものは `src/lib/limits.ts` / `src-tauri/src/limits.rs` で決め、ほかのコードはそこを見る
- **フォークで作業するとき**：`docs/CORP.md` があればフォークなので、最初に読む。フォークでは upstream と同じファイルを変えず、変更は upstream に入れてから取り込む（`docs/LIMITS.md`「フォークで使うとき」）
- 機能ごとの決定：`docs/<topic>.md`（一覧は README の「ドキュメント」）
- 操作はコマンド表 `src/lib/commands.ts` にまず足す
- Rust コマンドは `src/lib/api.ts` のラッパ経由で呼ぶ。モック `src/dev/mockBackend.ts` も同じ PR で更新する

## コマンド

```bash
bun install
bun run tauri dev      # アプリを起動
bun run dev            # ブラウザで UI だけ（モック）
bun run test           # cargo test + tsc --noEmit（`bun test` は Bun のテストランナーなので使わない）
bun run tauri build    # 配布用ビルド（署名鍵が要る）
```

## 変えないもの

`identifier`、`productName`、updater の `pubkey` と `endpoints`、待ち受けポート、CSP の緩和、capabilities の追加は人の判断なしに変えない。
