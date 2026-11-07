# ADR 0008: Golem と shem の呼び出し

ステータス: 採択

## 文脈

Aleph は、組版、診断、整形、LSP を Golem に任せ、PDF のラスタライズを shem に任せる（[ADR 0002](0002-purpose-scope-and-name.md)）。
メンテナーは、Golem の本体をアプリに同梱し、設定でバイナリの位置を指定できるようにすると決めた。
shem のバイナリの位置も指定できるようにと求めた（2026-11-07）。

プロトタイプでは、バイナリを「設定の値、アプリに同梱したもの、`~/.local/bin`、PATH」の順に探した。
`~/.local/bin` を探すのは、macOS の GUI アプリがログインシェルの PATH を受け継がず、`~/.local/bin/golem` を見つけられなかったためである。
同梱は、`src-tauri/resources/` に置いたバイナリを Tauri のリソースとして入れる形にした。

## 実装すること

### 探す順

golem と shem のそれぞれを、次の順に探し、最初に見つかったものを使う。

1. 設定の値（絶対パス）
2. アプリに同梱したもの（アプリのリソースのディレクトリの `golem`、`shem`）
3. `~/.local/bin`
4. Homebrew の場所（`/opt/homebrew/bin`）
5. PATH

設定の画面に、使っているバイナリのパスと `--version` の出力を出す。
見つからないときは、その旨と探した場所を出す。

### 同梱

- アプリの配布物に、golem と shem の両方を同梱する。同梱する版は、Aleph の版ごとに決めて、リポジトリの一か所（版を書いたファイル）に記録する。
- 同梱するバイナリは、golem と shem の GitHub Releases の配布物を、`SHA256SUMS` で照合してから入れる。照合は配布物を作るスクリプトで行う。
- 同梱した版と、使っている版（設定で別のものを指したとき）が違うときは、設定の画面に両方を出す。

### 呼び出し

- 呼び出しは Rust の側で行い、作業ディレクトリをプロジェクトのルートにする。標準出力、標準エラー出力、終了コードを画面の側に返す。
- 使う golem のサブコマンドは、`build`、`check`、`lint`、`preflight`、`fmt`、`new`、`lsp` とする。診断は `--format json` で受け取る（[ADR 0015](0015-diagnostics-and-search.md)）。
- 使う shem のサブコマンドは `render` とする（[ADR 0010](0010-previews.md)）。
- 呼び出しの引数は配列で渡し、シェルを通さない。

## 実装しないこと

- golem と shem を自動で更新する機能。版は Aleph の版と一緒に上げる。
- golem と shem の機能を Aleph の中で作り直すこと。

## テスト設計

- 探す順：一時ディレクトリに、設定、同梱、`~/.local/bin`、Homebrew の場所、PATH のそれぞれに偽のバイナリ（版を出すだけのシェルスクリプト）を置き、選ばれるものを `cargo test` で確かめる。探す場所の根（ホームのディレクトリと Homebrew の接頭辞）は引数で渡し、テストでは一時ディレクトリを指す。どこにもない場合、設定の値が存在しない場合を含める。
- 呼び出し：偽のバイナリで、引数が配列のまま渡ること（空白や日本語を含む引数）と、標準出力、標準エラー出力、終了コードがそのまま返ることを確かめる。
- 同梱のスクリプト：照合に失敗する配布物で、スクリプトが止まることを確かめる。

## トレードオフ

- 同梱すると、golem と shem を別に入れなくても使える。その代わり、配布物が大きくなり、golem と shem の版を上げるたびに Aleph を出し直す必要がある。設定でほかのバイナリを指せるので、開発中の golem を試すこともできる。
- `~/.local/bin` と Homebrew の場所を決め打ちで探すのは、GUI アプリが PATH を受け継がないことへの対処である。ほかの場所に入れた人は、設定で指す。

## 参考文献

- Golem の仕様書の CLI と配布：https://github.com/tett23/golem/blob/d0871a86d0e552bde8cd12424d78600fe753d02c/docs/specifications.md
- shem の README：https://github.com/tett23/shem/blob/8524d8d84986e16f8009b64f9fa84dd7fa3f8fdf/README.md
- Tauri のリソース：https://v2.tauri.app/develop/resources/
- プロトタイプの探索と呼び出し：https://github.com/tett23/aleph/blob/64eb1077e2daa4faeec93ae6d0f75528b0c27253/prototype/src-tauri/src/lib.rs
