# aleph

[![CI](https://github.com/tett23/aleph/actions/workflows/ci.yml/badge.svg)](https://github.com/tett23/aleph/actions/workflows/ci.yml)

aleph は、組版システム [Golem](https://github.com/tett23/golem) のための、開発中のエディタとプレビューの環境です。

[English README](README.md)

英語版が正です。
README.ja.md はその機械翻訳です。

## 概要

aleph は [Tauri](https://tauri.app/) で作るデスクトップアプリケーションです。
Golem の原稿を書き、それがどう組まれるかを見るためのものです。

次の形式を編集できるようにします。

- Markdown（`.md`）
- Golem の文書（`.gm`）と Emet（`.emet`）
- CSV（`.csv`）と TSV（`.tsv`）
- TOML（`.toml`）
- SVG（`.svg`）
- PDF（`.pdf`）
- Mermaid

## 状態

まだ何も実装していません。
設計は [docs/adr/](docs/adr/) の ADR（Architecture Decision Record）で決めているところです。
仕様は [docs/specifications.md](docs/specifications.md) にあります。

## 開発

[adr-guard](https://github.com/tett23/adr-guard) v0.9.1 以降を入れ、clone ごとに git の hook を有効にします。

```sh
cargo install --git https://github.com/tett23/adr-guard --tag v0.9.1
git config core.hooksPath .githooks
```

変更の進め方は [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を見てください。

## ライセンス

[MIT](LICENSE)
