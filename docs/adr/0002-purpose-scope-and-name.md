# ADR 0002: 目的と範囲と名前

ステータス: 採択

## 文脈

Golem（https://github.com/tett23/golem ）の原稿は、プレーンテキストの `.gm` と、関数を書く `.emet` と、設定の TOML からなる。
書き手は今、汎用のエディタで原稿を書き、`golem build` で組んで、別のビューアーで PDF を見ている。
原稿の字詰めや改ページは組んでみるまでわからず、プロットやメモは原稿と別の場所で管理している。

メンテナーは、Obsidian と Ulysses の中間のような Golem 専用のエディタを作ると決めた（2026-11-07）。
手順は、まず UI の画像でプロトタイピングし、捨てる前提のプロトタイプを作って使い、そのあと ADR とロードマップを書く、というものである。
プロトタイプは `prototype/` に置き、捨てる前提で書いた（[prototype/README.md](https://github.com/tett23/aleph/blob/64eb1077e2daa4faeec93ae6d0f75528b0c27253/prototype/README.md)）。
この ADR から始まる一連の ADR は、プロトタイプを使ってわかったことをもとに、本実装の決定を書く。

## 実装すること

### 名前

- アプリの名前は **Aleph**（アレフ）とする。リポジトリの名前は `aleph` とし、Golem 関連のリポジトリ（golem、shem など）とそろえる。
- 名前は、無限があることを表す記号 ℵ に由来する。アイコンは、黒に近い地に白に近い色の ℵ を置いたものとする。ℵ はヒラギノ明朝 W6 の字形を輪郭にしたパスで持ち、フォントに頼らない（[prototype/icon/aleph.svg](https://github.com/tett23/aleph/blob/64eb1077e2daa4faeec93ae6d0f75528b0c27253/prototype/icon/aleph.svg)）。

### 目的

Aleph は、Golem の原稿を書き、組まれた姿を確かめ、作品の構成を管理するためのデスクトップアプリである。
Aleph でエディタに開いて編集する一つのファイルを **シート** と呼ぶ（Ulysses の語に倣う）。
`manifest.toml` の `chapters` に並んだ `.gm` のシートを、**章** と呼ぶ。
次のことを一つのウィンドウで行えるようにする。

- 原稿（`.gm`）を、組版の版面と同じ字詰めで、横書きでも縦書きでも書く。
- 命令と式の結果を反映した本文と、組んだページを、書きながら横に見る。
- Golem の LSP による診断、補完、整形を受ける。
- プロット（シーンの表とガントチャート）と、シートごとの目標とノートを、原稿と結びつけて管理する。
- 原稿を Git で保存し、変更を行ごとに見る。

### 扱う形式

次の形式のファイルを開いて編集する。

- **原稿**：`.gm`、`.md`、`.txt`
- **関数と設定**：`.emet`、`.toml`
- **表**：`.csv`、`.tsv`
- **図**：`.svg`、Mermaid（`.mmd`、`.mermaid`）
- **見るだけのもの**：`.pdf`、画像（PNG、JPEG、GIF、WebP）

`.md` から `.gm` への変換も行う（[ADR 0016](0016-markdown-to-gm.md)）。

### 対象とする環境

- 最初の版は macOS（Apple Silicon）を対象とする。Tauri は Linux と Windows でも動くが、確かめるのは macOS だけとし、ほかの環境は後の ADR で加える。
- 書き手は一人を想定する。同時編集や共有の機能は持たない。

### 一連の ADR

本実装の決定は、次の ADR に分けて書く。

- アプリの構成：[ADR 0003](0003-application-architecture.md)
- ワークスペースとプロジェクト：[ADR 0004](0004-workspaces-and-projects.md)
- 画面の構成と見た目：[ADR 0005](0005-layout-and-appearance.md)
- 横書きのエディタ：[ADR 0006](0006-horizontal-editor.md)
- 縦書きのエディタ：[ADR 0007](0007-vertical-editor.md)
- Golem と shem の呼び出し：[ADR 0008](0008-golem-and-shem-binaries.md)
- LSP と整形：[ADR 0009](0009-lsp-and-formatting.md)
- プレビュー：[ADR 0010](0010-previews.md)
- 保存と Git：[ADR 0011](0011-saving-and-git.md)
- シートの目標とノート：[ADR 0012](0012-sheet-goals-and-notes.md)
- プロットとガントチャート：[ADR 0013](0013-plot-and-gantt-chart.md)
- 共有ライブラリと画像のアセット：[ADR 0014](0014-shared-library-and-assets.md)
- 診断と検索：[ADR 0015](0015-diagnostics-and-search.md)
- md から gm への変換：[ADR 0016](0016-markdown-to-gm.md)
- Aleph のプラグイン：[ADR 0017](0017-aleph-plugins.md)

## 実装しないこと

- 組版そのもの。組版、診断、整形は Golem に任せ、Aleph は Golem を呼ぶ（[ADR 0008](0008-golem-and-shem-binaries.md)）。Golem の機能を Aleph の中で作り直さない。
- 汎用のコードエディタとしての機能（デバッガー、ターミナル、多言語の LSP）。
- 原稿の同期とクラウドの保存。Git のリモートへの push で代える（[ADR 0011](0011-saving-and-git.md)）。
- モバイル版。

## テスト設計

この ADR は目的と範囲を決めるだけで、それ自体のテストはない。
各機能のテストは、それぞれの ADR のテスト設計に書く。

## トレードオフ

- Golem 専用にすることで、`.gm` の字詰め、改ページ、命令と式の扱いを UI に深く組み込める。その代わり、Golem 以外の原稿の形式（Markdown だけで書く人など）には、汎用のエディタほど便利にならない。
- 対象を macOS に絞ると、確かめる手間が減る。Linux と Windows で動かすときに見つかる不具合は後に回る。

## 参考文献

- Golem の仕様書：https://github.com/tett23/golem/blob/d0871a86d0e552bde8cd12424d78600fe753d02c/docs/specifications.md
- Aleph のプロトタイプ：https://github.com/tett23/aleph/tree/64eb1077e2daa4faeec93ae6d0f75528b0c27253/prototype
- UI のモックアップ：https://github.com/tett23/aleph/tree/64eb1077e2daa4faeec93ae6d0f75528b0c27253/prototype/mockups
