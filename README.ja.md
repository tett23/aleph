# Aleph

[![CI](https://github.com/tett23/aleph/actions/workflows/ci.yml/badge.svg)](https://github.com/tett23/aleph/actions/workflows/ci.yml)

Aleph は、組版システム [Golem](https://github.com/tett23/golem) のための、開発中のエディタとプレビューの環境です。

[English README](README.md)

英語版が正です。
README.ja.md はその機械翻訳です。

## 概要

Aleph は [Tauri](https://tauri.app/) で作るデスクトップアプリケーションです。
Golem の原稿を書き、それがどう組まれるかを見て、作品のプロットを管理するためのものです。

次の形式を編集できるようにします。

- Markdown（`.md`）
- Golem の文書（`.gm`）と Emet（`.emet`）
- CSV（`.csv`）と TSV（`.tsv`）
- TOML（`.toml`）
- SVG（`.svg`）
- PDF（`.pdf`）
- Mermaid
- 画像（PNG、JPEG、GIF、WebP）、見るだけ

## 状態

本実装はまだ始めていません。
捨てる前提のプロトタイプが [prototype/](prototype/) にあり、動かし方はその README にあります。
プロトタイプからわかった設計は、[docs/adr/](docs/adr/) の ADR（Architecture Decision Record）で採択しました。
どれもまだ実装していません。
仕様は [docs/specifications.md](docs/specifications.md) にあります。

## 開発

[adr-guard](https://github.com/tett23/adr-guard) v0.10.0 以降を入れ、clone ごとに git の hook を有効にします。

```sh
cargo install --git https://github.com/tett23/adr-guard --tag v0.10.0
git config core.hooksPath .githooks
```

変更の進め方は [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を見てください。

## ライセンス

[MIT](LICENSE)
