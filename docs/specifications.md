# Aleph 仕様書

Aleph は、Golem（https://github.com/tett23/golem ）の原稿を書き、組まれた姿を確かめ、作品の構成を管理するためのデスクトップアプリである（[ADR 0002](adr/0002-purpose-scope-and-name.md)）。
Tauri 2 で作り、画面を TypeScript、ファイルとプロセスを Rust で扱う（[ADR 0003](adr/0003-application-architecture.md)）。
リポジトリの名前は `aleph` とする。

この文書は、Aleph の今の振る舞いを定める。
設計の決定は `docs/adr/` に連番の ADR として置く。

## 状態

本実装はまだない。
捨てる前提のプロトタイプが `prototype/` にあり、使ってわかったことをもとに次の ADR を採択した。
実装済みかどうかは、表の各 ADR のステータスで示す。

| ADR | 決めたこと |
|---|---|
| [ADR 0001](adr/0001-update-adr-guard-to-v0.10.0.md) | ADR の検査に使う adr-guard を v0.10.0 に上げる（実装済み） |
| [ADR 0002](adr/0002-purpose-scope-and-name.md) | 目的、範囲、名前、扱う形式（gm、md、txt、emet、toml、csv、tsv、svg、Mermaid、pdf、画像）、シートと章の定義 |
| [ADR 0003](adr/0003-application-architecture.md) | Tauri 2、TypeScript と Rust の受け持ち、状態の持ち方、依存の方針、テストと CI |
| [ADR 0004](adr/0004-workspaces-and-projects.md) | ワークスペース（登録したディレクトリ）とプロジェクト（`manifest.toml` のあるディレクトリ）、ツリー、アプリの設定、ウィンドウの位置と大きさの記録 |
| [ADR 0005](adr/0005-layout-and-appearance.md) | 画面の構成（リボン、左のサイドバー、エディタとプレビュー、右のパネル、ステータスバー）と見た目 |
| [ADR 0006](adr/0006-horizontal-editor.md) | 横書きのエディタ：版面の字詰め、変更と診断の印、改ページの印、不可視文字、複数の章 |
| [ADR 0007](adr/0007-vertical-editor.md) | 縦書きのエディタ：テキストエリアと行番号の影の層 |
| [ADR 0008](adr/0008-golem-and-shem-binaries.md) | golem と shem を探す順と同梱 |
| [ADR 0009](adr/0009-lsp-and-formatting.md) | golem lsp との中継、診断、semantic tokens による色付け、整形と ⌘S |
| [ADR 0010](adr/0010-previews.md) | 本文のプレビュー（Golem の HTML）、ページのプレビュー（golem と shem、自動の dpi）、ほかの形式、別ウィンドウ |
| [ADR 0011](adr/0011-saving-and-git.md) | 10 秒ごとの保存、変更の印、1 日 1 回の自動コミット、Git のパネル |
| [ADR 0012](adr/0012-sheet-goals-and-notes.md) | シートの目標、キーワード、書くこと、ノート、字数と原稿用紙の数え方 |
| [ADR 0013](adr/0013-plot-and-gantt-chart.md) | プロットの表（`plot.csv`、任意の列、並べ替え）、暦、ガントチャート |
| [ADR 0014](adr/0014-shared-library-and-assets.md) | 共有ライブラリ（フォント、プラグイン、関数）の横断の管理、画像のアセット |
| [ADR 0015](adr/0015-diagnostics-and-search.md) | check、lint、preflight の診断、ステータスバーの表示、検索 |
| [ADR 0016](adr/0016-markdown-to-gm.md) | md から gm への変換 |
| [ADR 0017](adr/0017-aleph-plugins.md) | Aleph のプラグイン |

## アプリの構成

Aleph は Tauri 2 のアプリで、画面を TypeScript（`app/`）、ファイルと外部のプロセスを Rust（`src-tauri/`）で扱う（[ADR 0003](adr/0003-application-architecture.md)）。

- 画面の状態（ワークスペース、開いているシートの並び、選択、パネルの表示）は一つの値で持ち、操作を受けて新しい状態を返す関数（リデューサー）だけで変える。開いているシートは、一つでも配列で持つ。
- Rust の側は、ファイルの読み書き、ディレクトリの一覧、外部のプロセスの実行を受け持つ。外部のプロセスは引数を配列で渡し、シェルを通さない。
- git は、設定の値、`/usr/bin`、Homebrew（`/opt/homebrew/bin`）、PATH の順に探す。設定の値があれば、ほかの場所は探さない。macOS の GUI アプリはログインシェルの PATH を受け継がないためである。
- アイコンは、使うものだけを `app/icons/` に SVG で置く（lucide、ISC ライセンス）。
- テストは、TypeScript は `node --test`（Node が型を取り除いて実行する）、Rust は `cargo test` で書く。CI の `app` のジョブが macOS で、型検査、`node --test`、Vite のビルド、rustfmt、clippy、`cargo test` を実行する。

## 画面の構成

画面は、左から次の順に並ぶ（[ADR 0005](adr/0005-layout-and-appearance.md)）。

- **リボン**：左のサイドバーに出すもの（ファイル、検索、Git、診断、共有ライブラリ）を切り替えるアイコンと、プロットを開くアイコン、設定を開くアイコン。同じアイコンをもう一度押すと、サイドバーを畳む。
- **左のサイドバー**：上にワークスペースの名前があり、押すとワークスペースを切り替えるメニューが出る。その下に、リボンで選んだものを出す。
- **中央**：上にツールバー、その下にエディタとプレビューを左右に並べ、下にステータスバーを置く。ツールバーは、エディタに効く「縦」「横」を左に、プレビューを選ぶ「原稿のみ」「本文」「ページ」を右に置く。形式が持たない切り替えは出さない。
- **右のパネル**：添付、アウトライン、そのプロジェクトの共有ライブラリを、上のアイコンで切り替える。ツールバーの右端のアイコンで畳む。

外観はライト、ダーク、OS に合わせる（既定）のどれかを設定で選ぶ。
アクセントの色は彩度を落とした黄土色とし、選択の背景は無彩色とする。
パネルの表示の状態（どのパネルか、畳んだか、縦と横、プレビュー）は、次に起動したときに戻す。

## ワークスペースとプロジェクト

**ワークスペース** は、設定で登録したディレクトリである（[ADR 0004](adr/0004-workspaces-and-projects.md)）。
複数を登録でき、左のサイドバーの上の名前から切り替える。
ワークスペースの中で `manifest.toml` を持つディレクトリを、深さによらず **プロジェクト** とする。
プロジェクトの中の `manifest.toml` は無視する。

左のサイドバーの「ファイル」には、ワークスペースのツリーを出す。

- `.` で始まるもの、`build/`、`node_modules/`、`target/`、`dist/` は出さない。Aleph が開けない形式のファイルも出さない。
- プロジェクトの中は、`manifest.toml` の `chapters` に並んだ章をその順で先に出し、次に `plot.csv` を「プロット」として、そのあとにほかのファイルとディレクトリを出す。`chapters` の項目は、文字列、`file` を持つ表、入れ子の配列のどれでもよい。
- `.gm` と `.md` は最初の見出しを名前として出し、ファイル名を小さく添える。
- 新しいシートは、プロジェクトの中なら `chapters/NN.gm` として作り、`chapters` の末尾に足す。足すときは配列の書き方（一行か、一行に一項目か）を保つ。プロジェクトの外では、開いているシートと同じディレクトリに作る。
- ファイルの名前は、ダブルクリックで変える。消す操作は持たない。

アプリの設定は、アプリの設定のディレクトリ（macOS では `~/Library/Application Support/dev.tett23.aleph/`）の `config.json` に置く。
読み込むとき、形の違う値は既定に戻し、範囲のある値（文字サイズ、行間、自動保存の間隔など）は上限と下限に丸める。

メインのウィンドウの位置と大きさは、動かしたとき、大きさを変えたとき、閉じるとき、アプリを終えるときに `window.json` に記録する。
起動したとき、記録した矩形がどれかのディスプレイに収まり、幅 400、高さ 300 の画素より大きければ戻し、そうでなければ既定の大きさで中央に置く。

## 破棄した ADR

なし。
