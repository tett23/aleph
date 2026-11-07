# ADR 0044: プレビューのリンクからウィンドウを遷移させない

ステータス: 採択（未実装）

## 文脈

Markdown のプレビューは、`https:` などのリンクをそのまま `<a href>` にする（[app/md.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/md.ts#L346)）。
クリックを横取りするのはウィキリンクだけで（[app/wikilinkmount.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/wikilinkmount.ts#L245-L251)）、ほかのリンクを押すと、Aleph のウィンドウそのものがそのページに移りうる。
Golem の HTML のリンクと、Mermaid の `click` も同じである。
2026-11-08 のセキュリティ監査（[docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md) の所見 3）は、共有された文書のリンクで、Aleph の画面を偽の画面に置き換えられることを指摘した。
メンテナーは、監査の修正をすべて ADR にするよう求めた（2026-11-08）。

## 実装すること

- Rust の側で、すべてのウィンドウの遷移を、アプリの中のページ（`tauri://localhost`、開発のときは `devUrl`）に限る。ウィンドウを作るときに `on_navigation` で、それ以外の URL への遷移を拒む。
- プレビュー（本文、Markdown、Mermaid）の中の `a[href]` の押下を、文書の側で受けて、既定の遷移を止める。
  - `#…` は、プレビューの中のその要素へ送る。
  - `http:` と `https:` は、URL を示して「ブラウザで開きますか」と確かめ、はいなら macOS の既定のブラウザで開く。開く処理は Rust のコマンド（`open_url`）とし、`http:` と `https:` 以外は拒む。
  - ウィキリンクと埋め込みの見出しは、今までどおり Aleph の中で開く。
  - ほかの `href`（`file:`、相対のパスなど）は、何もしない。
- 新しいウィンドウを開く `target="_blank"` と `window.open` も、同じく既定の動きを止める。

## 実装しないこと

- 外部のページを Aleph の中で表示すること。
- 確かめを省く設定。

## テスト設計

`node --test` と `cargo test` で、テストを先に書いて失敗させてから実装する。

- リンクの振り分けの関数：`#…`、`http(s):`、ウィキリンク、`file:`、相対のパス、`javascript:` を、それぞれ「中で送る」「確かめてブラウザ」「Aleph で開く」「何もしない」に分けること。
- Rust：遷移を許す URL の判定（`tauri://localhost/…`、`devUrl` の下を許し、`https://example.com` と `file:` を拒む）と、`open_url` が `http(s)` 以外を拒むこと。
- 画面の確かめ方：Markdown のプレビューの外部のリンクを押すと確かめが出て、はいでブラウザが開き、Aleph の画面は変わらないこと、`#…` のリンクで送られることを確かめる。

## トレードオフ

- 外部のリンクを開くたびに確かめるので、一手増える。画面を乗っ取られる危険を避けることを優先した。

## 参考文献

- [docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md)
- Tauri 2, WebviewWindowBuilder::on_navigation：https://docs.rs/tauri/2/tauri/webview/struct.WebviewWindowBuilder.html#method.on_navigation
