# Aleph

[![CI](https://github.com/tett23/aleph/actions/workflows/ci.yml/badge.svg)](https://github.com/tett23/aleph/actions/workflows/ci.yml)

Aleph は、組版システム [Golem](https://github.com/tett23/golem) のための、開発中のエディタとプレビューの環境です。

[English README](README.md)

英語版が正です。
README.ja.md はその機械翻訳です。

## 概要

Aleph は [Tauri](https://tauri.app/) で作るデスクトップアプリケーションです。
Golem の原稿を書き、それがどう組まれるかを見て、作品のプロットを管理するためのものです。

次の形式を編集できます。

- Markdown（`.md`）
- Golem の文書（`.gm`）と Emet（`.emet`）
- CSV（`.csv`）と TSV（`.tsv`）
- TOML（`.toml`）
- JSON（`.json`）、コメントつきの JSON（`.jsonc`）、JSON5（`.json5`）、JSON Lines（`.jsonl`）
- SVG（`.svg`）
- PDF（`.pdf`）
- Mermaid
- 画像（PNG、JPEG、GIF、WebP）、見るだけ

ファイルツリーでシート、フォルダ、プロジェクトを右クリックすると、名前を変えられます。開いているシートは新しいパスに引き継がれます。
Golem LSP がファイル操作に対応していれば、改名前にローカルの参照も更新します。参照を更新できないときは、中止するか参照を更新せず改名するかを選べます。
プロジェクトかフォルダを右クリックすると、その中にフォルダか種類を選んだ空のシートを追加できます。Markdown のシートを右クリックすると、そのシートを gm に変換できます。
同じフォルダ内のプロジェクトを並べ替えるには、プロジェクトを右クリックし、「一つ上へ」か「一つ下へ」を選びます。Aleph はワークスペースごとに表示順を記憶します。
章は実際のフォルダ内に表示されます。設定で隠しファイルを表示し、`.gitignore` の対象ファイルを隠せます。
gm の文書を右クリックすると、プロジェクトの章に追加するか章から削除できます。選んだ gm の文書はツリーの表示順で一つのファイルに書き出せます。

保存時のページ更新がオンなら、⌘S で保存内容が変わったときはすぐに PDF プレビューを更新します。自動保存では入力が 5 秒止まるまで待ち、保存内容がすでに表示に反映されていれば組み直しを省きます。

手動ビルドの実行中や終了後にステータスバーの build を押すと、コマンドと出力を確認できます。成功通知からは、そのプロジェクトの出力フォルダを Finder で表示できます。

本文エディタでは Esc または Ctrl+E でサジェストを閉じます。サジェストが閉じているときは Ctrl+E で論理行の末尾に移動します。各ショートカットの有効範囲は「キーの割り当て」で変更できます。

## 状態

最初の版を実装しました。横書きと縦書きを一つで書くエディタ、golem lsp、本文とページのプレビュー、保存と Git、目標とノート、プロットとガントチャート、共有ライブラリ、診断と検索、プロジェクトのビルド、Markdown からの変換、プラグインがあります。
決定はそれぞれ [docs/adr/](docs/adr/) の ADR（Architecture Decision Record）にあり、今の振る舞いは [docs/specifications.md](docs/specifications.md) にあります。
まず Apple Silicon の macOS を対象にしています。

## 動かし方

Node.js（最新の LTS）、Rust、[Golem](https://github.com/tett23/golem) と [shem](https://github.com/tett23/shem) を入れます（または `scripts/bundle-tools.sh` で同梱したものを Aleph に使わせます）。

```sh
npm ci
npx tauri dev
```

golem と shem を中に入れてアプリを作るには、次のようにします。

```sh
sh scripts/bundle-tools.sh
npx tauri build
```

デバッグのビルド（`npx tauri dev` または `npx tauri build --debug`）は、ツールバーの左に `dev` の印を出します。
どのビルドも同じ設定を読みます。

## 開発

CI が実行する検査は次のとおりです。

```sh
npx tsc --noEmit
npm test
(cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
```

[adr-guard](https://github.com/tett23/adr-guard) v0.10.0 以降を入れ、clone ごとに git の hook を有効にします。

```sh
cargo install --git https://github.com/tett23/adr-guard --tag v0.10.0
git config core.hooksPath .githooks
```

変更の進め方は [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を見てください。

## ライセンス

[MIT](LICENSE)
