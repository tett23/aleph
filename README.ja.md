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

「新しいシート」で拡張子のない名前を入力すると、Markdown (.md) と Golem (.gm) から形式を選べます。
プロジェクト内では、この操作で作った Golem の文書を章に登録します。

同じフォルダ内のプロジェクトを並べ替えるには、プロジェクトを右クリックし、「一つ上へ」か「一つ下へ」を選びます。Aleph はワークスペースごとに表示順を記憶します。
章は実際のフォルダ内に表示されます。設定で隠しファイルを表示し、`.gitignore` の対象ファイルを隠せます。
gm の文書を右クリックすると、プロジェクトの章に追加するか章から削除できます。選んだ gm の文書はツリーの表示順で一つのファイルに書き出せます。

右クリックのメニューは、ウィンドウの端で開いても内側に収まります。すべての項目が収まらないときは、メニューの中をスクロールして残りの項目を選べます。

保存時のページ更新がオンなら、⌘S で保存内容が変わったときはすぐに PDF プレビューを更新します。自動保存では入力が 5 秒止まるまで待ち、保存内容がすでに表示に反映されていれば組み直しを省きます。

`.gm`、`.md`、`.txt` の文章を検査するときは、ホストを持つ HTTP と HTTPS の絶対 URL を除きます。山括弧で囲んだ URL も除きます。

手動ビルドの実行中や終了後にステータスバーの build を押すと、コマンドと出力を確認できます。成功通知からは、そのプロジェクトの出力フォルダを Finder で表示できます。
ファイルツリーは、各プロジェクトの `build/` フォルダを中のすべてのファイルとともに表示するので、PDF などの成果物をほかのアプリケーションに渡せます。行をウィンドウの外にドラッグするか、右クリックのメニューから「コピー」を選んで Finder でペーストするか、フォルダかプロジェクトで「zip で書き出す…」を選びます。zip はファイル名を NFC に正規化した UTF-8 で書き、UTF-8 であることを示すフラグを立てます。`.DS_Store` と `.git` は入れません。

下部パネルのアシスタントは、「行送りを少し広げて」のような普通の言葉の頼みを受け、焦点のあるシート（または選択した範囲）の書き換えの案を、説明と差分つきで出します。「適用」を押すまで何も変わりません。ワークスペースにコミットしていない変更があれば、先にコミットするかを尋ねてから適用し、保存して差分のタブを開きます。リボンの「差分」のボタンで、ワークスペースの最後のコミットとの差分をいつでも見られます。
既定では、アシスタントは同梱の `llama-server` で Qwen3.5-4B を Mac の中で動かし、外には何も送りません。一覧のほかの三つのモデルは、設定からダウンロードできます。Claude Code と Codex も、入っていれば選べます。これらは、頼み、対象のテキスト、マニュアルの抜粋を、書き手自身のアカウントで Anthropic か OpenAI に送るので、Aleph はそれぞれを初めて使う前に一度尋ねます。失敗したときは、代わりにローカルのモデルに頼み、そのことを示します。

エディタで文字列を選ぶと、大小文字まで一致する同じシート内のほかの箇所を、最大 10,000 件ハイライトします。語の一部も一致の対象で、空白や改行を含む範囲も選べます。

本文エディタでは Esc または Ctrl+E でサジェストを閉じます。サジェストが閉じているときは Ctrl+E で論理行の末尾に移動します。各ショートカットの有効範囲は「キーの割り当て」で変更できます。

日本語入力で変換を取り消す Esc は、変換の取り消しだけに使います。
たとえば、新しいシートの名前は同じダイアログで続けて入力できます。
変換が終わってから Esc を押し直すと、通常の操作が働きます。

差分のタブと Git のパネルは、日本語を含む原稿の変更箇所を文字単位で示します。削除した文字には取り消し線、追加した文字には下線が付きます。

## 状態

最初の版を実装しました。横書きと縦書きを一つで書くエディタ、golem lsp、本文とページのプレビュー、保存と Git、目標とノート、プロットとガントチャート、共有ライブラリ、診断と検索、プロジェクトのビルド、Markdown からの変換、プラグインがあります。
決定はそれぞれ [docs/adr/](docs/adr/) の ADR（Architecture Decision Record）にあり、今の振る舞いは [docs/specifications.md](docs/specifications.md) にあります。サイドバー、右サイドバー、下部パネルなど、画面の要素の名前は [docs/glossary.md](docs/glossary.md) にあります。
まず Apple Silicon の macOS を対象にしています。

## 動かし方

Node.js（最新の LTS）、Rust、[Golem](https://github.com/tett23/golem) と [shem](https://github.com/tett23/shem) を入れます（または `scripts/bundle-tools.sh` で同梱したものを Aleph に使わせます）。

```sh
npm ci
npx tauri dev
```

golem、shem、アシスタントの llama-server と既定のモデル（Qwen3.5-4B、ダウンロードは約 2.7 GB）、Golem のマニュアルの章を中に入れてアプリを作るには、次のようにします。

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

変更が文書（README、CONTRIBUTING、ADR、仕様書と、`scripts/docs-only.sh` が挙げる `docs/` のほかのファイル）だけのときは、CI はこれらの検査を省きます。ADR と翻訳の検査は、どの変更でも走ります。

[adr-guard](https://github.com/tett23/adr-guard) v0.13.1 以降を入れ、clone ごとに git の hook を有効にします。

```sh
cargo install --git https://github.com/tett23/adr-guard --tag v0.13.1
git config core.hooksPath .githooks
```

変更の進め方は [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を見てください。

## ライセンス

[MIT](LICENSE)
