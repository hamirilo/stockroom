# Stockroom

集めたものを何でもストックしておける、ローカルの保管庫アプリ（Tauri 2 / macOS・Windows）。

## 開発の基準

開発の Standard・Recommendations・Playbook は **`../desktop-platform/ai/ONBOARDING.md`** を最初に参照すること。Web アプリ向けの ai-dev-platform は参照しない。

## このツール固有

- **画面の原則：[docs/UI.md](docs/UI.md)。** 表示（ビュー・モード・レイアウト・グループ分け）の切り替えなどを繰り返しても、主要な操作の位置やレイアウトを不必要に変化させない。画面に触れる変更の前に読む
- 設計の境界：`docs/ARCHITECTURE.md`
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
