# ADR 0003: アプリの構成

ステータス: 採択

## 文脈

Aleph はデスクトップアプリであり、ファイル、プロセス（golem、shem、git）、ウィンドウを扱う（[ADR 0002](0002-purpose-scope-and-name.md)）。
プロトタイプは Tauri 2 で作り、画面を TypeScript、ファイルとプロセスを Rust で書いた。
画面の側は CodeMirror 6 のエディタを使い、ほかの画面は DOM を直に組んだ。

プロトタイプを作り、使う中で、次のことがわかった。
一つ目に、Tauri の WebView では、落とされたファイルのパスを HTML のドロップのイベントからは得られず、Tauri のドラッグアンドドロップのイベントで受け取る（Tauri の文書による）。プロトタイプはこの方式で書いたが、Finder からのドロップは確かめていない。
二つ目に、macOS の GUI アプリはログインシェルの PATH を受け継がないので、`~/.local/bin` の golem を見つけられなかった。
三つ目に、画面の状態（開いている文書、選択、パネル）を一つのファイルに書いたため、機能を足すたびに、文書が一つであるといった前提が崩れた（複数の章をまとめて開く機能で、保存と自動保存の処理を書き直した）。

## 実装すること

### 技術の土台

- **Tauri 2** でアプリを作る。macOS では WKWebView で画面を描く。
- **画面**：TypeScript で書く。クラスは使わない。状態は関数と不変のデータで扱い、状態を変える場所を一つの層に集める（下の「画面の状態」）。
- **バックエンド**：Rust で書き、関数型のスタイルを優先する。受け持つのは、ファイルの読み書き、ディレクトリの一覧、検索、外部のプロセス（golem、shem、git）の実行、LSP のサーバーとの標準入出力の中継、ウィンドウの位置の記録である。
- **ビルド**：画面は Vite でまとめる。テストは、TypeScript は Node の `node --test`（Node 26 は型の注釈を取り除いてそのまま読む）、Rust は `cargo test` で書く。テストのための依存は足さない。

### CI

- GitHub Actions の CI に、アプリを検査する `app` のジョブを置く。macOS（[ADR 0002](0002-purpose-scope-and-name.md) の対象）で、次の順に実行する。
  1. `npm ci`
  2. `tsc --noEmit`
  3. `*.test.ts` を `node --test` で実行する
  4. Vite のビルド（`tauri::generate_context!` が組んだ画面を取り込むので、Rust のコンパイルの前に要る）
  5. `cargo fmt --check`
  6. `cargo clippy --all-targets --locked -- -D warnings`
  7. `cargo test --locked`
- Node は最新の LTS を使い、actions は Node 24 以降で動く最新のメジャー版をコミットのハッシュで固定する。
- 本実装（根の `src-tauri/`）ができるまでは、`prototype/` を同じ手順で検査する。

### 画面の状態

- アプリの状態（ワークスペース、開いている文書の並び、選択、パネルの表示）を一つの値で持ち、変更は「操作を受けて新しい状態を返す」関数（リデューサー）を通す。
- 開いている文書は、最初から配列で持つ。一つの文書を開くのは、長さ 1 の配列の場合とする。複数の章をまとめて開く機能（[ADR 0006](0006-horizontal-editor.md)）で、前提を書き直さずに済むようにする。
- 画面の各部分（ツリー、ツールバー、エディタ、プレビュー、右のパネル、ステータスバー）は、状態から DOM を作る関数とし、状態が変わったら描き直す。CodeMirror のエディタのように描き直しで作り直せないものは、状態との対応を一つの層で管理する。

### 依存の方針

- 依存は増やさない。ライセンスに問題がなく、再実装が容易なものは自前で書き、本家を参考に厚くテストする。
- 依存として使うのは次のものとする。どれも自前で書き直すのが容易でないか、仕様に追従する必要がある。
  - Tauri（`tauri`、`@tauri-apps/api`、`tauri-plugin-dialog`）
  - CodeMirror 6（エディタ）
  - Rust の `regex` と `ignore`（検索と、`.gitignore` に従う走査）
  - Mermaid（図のプレビュー）
- プロトタイプが使った `marked`（Markdown のプレビュー）、`lucide-static`（アイコン）は、本実装では見直す。Markdown のプレビューは md から gm への変換（[ADR 0016](0016-markdown-to-gm.md)）と同じ字句の読み方を使えるので、自前で書く。アイコンは使うものだけを SVG としてリポジトリに置く（lucide のライセンスは ISC で、置いてよい）。

### ディレクトリ

- 本実装は、リポジトリの根の `app/`（画面）と `src-tauri/`（Rust）に置く。
- `prototype/` は、本実装が同じ機能に追いついたら消す。それまでは参照のために残す。

### PATH の扱い

- 外部のプロセスは、Rust の側で絶対パスを決めてから起動する（[ADR 0008](0008-golem-and-shem-binaries.md)）。GUI アプリが PATH を受け継がないことに頼らない。git も同じく、`/usr/bin/git` と Homebrew の場所を順に探し、設定で変えられるようにする。

### ファイルのドロップ

- ファイルのドロップは Tauri のドラッグアンドドロップのイベントで受け、落とされた位置の要素で行き先を決める（[ADR 0014](0014-shared-library-and-assets.md)）。
- 画面の中のドラッグ（表の行の並べ替えなど）は、HTML のドラッグアンドドロップを使わず、マウスの動きを自前で追う。Tauri の文書は、Tauri がファイルのドロップを受ける設定のとき、Windows では HTML のドラッグアンドドロップが効かないとしている。ほかの OS で動かすことを考え、どの環境でも同じに動く方法を選ぶ。

## 実装しないこと

- 画面のフレームワーク（React、Vue など）。状態から DOM を作る関数で足りる規模であり、依存を増やさない。
- E2E のテストの自動化。macOS の WKWebView には WebDriver がなく、tauri-driver が使えない。画面の動きは各 ADR のテスト設計に確かめ方を書き、手で確かめる。

## テスト設計

- リデューサーは、操作の列を与えて、期待する状態になることを `node --test` で確かめる。開く、閉じる、複数を開く、選択を変える、パネルを切り替える、の各操作を含める。
- Rust のコマンドは、一時ディレクトリを作って `cargo test` で確かめる（ファイルの読み書き、ディレクトリの一覧、外部のプロセスの実行と終了コードの受け渡し）。
- PATH の扱い：PATH を空にした環境で、設定と探索順のとおりに golem と git が見つかることを `cargo test` で確かめる。

## トレードオフ

- Tauri を使うと、アプリは小さく、Rust でファイルとプロセスを扱える。その代わり、WebView の違い（macOS の WKWebView と、ほかの OS の WebView）の影響を受け、ほかの OS で動かすときに確かめ直しが要る。
- フレームワークを使わないと依存は減るが、描き直しの範囲を自分で管理する手間がかかる。

## 参考文献

- Tauri 2：https://v2.tauri.app/
- CodeMirror 6：https://codemirror.net/docs/
- Node.js のテストランナー：https://nodejs.org/api/test.html
- プロトタイプの Rust の側：https://github.com/tett23/aleph/blob/64eb1077e2daa4faeec93ae6d0f75528b0c27253/prototype/src-tauri/src/lib.rs
- プロトタイプの画面の状態：https://github.com/tett23/aleph/blob/64eb1077e2daa4faeec93ae6d0f75528b0c27253/prototype/src/app.ts
