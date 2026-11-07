# ADR 0042: IPC の信頼の境界と CSP

ステータス: 採択（未実装）

## 文脈

2026-11-08 のセキュリティ監査（[docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md) の所見 1、重さ「高」）は、Aleph が webview を完全に信頼していることを指摘した。

- CSP がない（[src-tauri/tauri.conf.json](https://github.com/tett23/aleph/blob/b4ee3c4/src-tauri/tauri.conf.json#L16) の `"csp": null`）。
- `git`、`tool`、`lsp_start`、`tool_info` は、起動する実行ファイルのパス（`bin`）を webview から受け取り、引数と作業ディレクトリもそのまま使う（[src-tauri/src/lib.rs](https://github.com/tett23/aleph/blob/b4ee3c4/src-tauri/src/lib.rs#L150-L158)）。
- ファイルを読み書きするコマンド（`read_text`、`read_bytes`、`write_text`、`write_bytes`、`make_dir`、`rename_path`、`move_path`、`remove_path`、`copy_file`、`list_dir`、`list_tree`、`exists`、`search_files`、`replace_files`）は、どのパスでも受け付ける。
- 権限は、すべてのウィンドウに同じものを与える（[src-tauri/capabilities/default.json](https://github.com/tett23/aleph/blob/b4ee3c4/src-tauri/capabilities/default.json#L4) の `"windows": ["*"]`）。

このため、プレビューなどで HTML を一か所注入できれば、任意のコマンドの実行と、プラグインのフォルダへの `.js` の書き込みによる居座りに届く。
メンテナーは、監査の修正をすべて ADR にするよう求めた（2026-11-08）。

## 実装すること

### CSP

- `tauri.conf.json` に CSP を設定する。`default-src 'self'`、`script-src 'self' blob:`（プラグインの `import` に blob を使う）、`style-src 'self' 'unsafe-inline'`（エディタと Mermaid が要素の `style` を使う）、`img-src 'self' blob: data:`、`font-src 'self' blob: data:`、`frame-src blob:`（PDF）、`connect-src ipc: http://ipc.localhost`、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`。
- 開発の `devUrl`（`http://localhost:1420`）では、Vite の HMR のために `devCsp` で `connect-src` に `ws://localhost:1420` を足す。

### 実行ファイル

- `git`、`tool`、`lsp_start`、`tool_info` から `bin` の引数を外す。Rust の側が `config.json` の `gitPath`、`golemPath`、`shemPath` を読み、今と同じ探す順（[ADR 0008](0008-golem-and-shem-binaries.md)）で実行ファイルを決める。
- 引数の初めの語（サブコマンド）を、Aleph が使うものに限る。
  - git：`add`、`branch`、`commit`、`diff`、`log`、`pull`、`push`、`rev-parse`、`show`、`status`。
  - golem：`build`、`check`、`fmt`、`lint`、`new`、`preflight`、`lsp`（`lsp_start` から）、`--version`。
  - shem：`render`、`--version`。
- 許されないサブコマンドは、実行せずに誤りを返す。

### ファイルとディレクトリ

- ファイルを読み書きするコマンドと、`git`、`tool`、`search_files`、`replace_files` の作業ディレクトリと根は、Rust の側で `canonicalize` したうえで、次の下に限る。
  - `config.json` の `workspaces` に書かれたワークスペース。
  - アプリの設定のディレクトリ（`config.json`、`plugins/`、`trash/`）。
  - アプリの一時のディレクトリ（`temp_dir` が返すもの）。
  - 共有ライブラリのディレクトリ（`config.json` の `libraryDir`）。
- まだ存在しないパス（新しく書くファイル）は、親のディレクトリを `canonicalize` して確かめる。
- 範囲の外のパスは、読み書きせずに誤りを返す。`exists` は `false` を返す。
- ワークスペースの一覧と設定の値は、Rust の側が `config.json` から読み、`config_save` のたびに読み直す。webview から渡された一覧は信じない。
- プラグインのフォルダ（`plugins/`）への書き込みは、webview の `write_text`、`write_bytes`、`copy_file`、`move_path` からは拒む（webview の注入から居座りへの経路を断つ）。

### プラグインの追加と削除

[ADR 0017](0017-aleph-plugins.md) のプラグインは、Finder でフォルダに置かなくても、設定の「Aleph のプラグイン」の節から足せるようにする。
webview にパスを渡させると、注入されたスクリプトがワークスペースに仕込んだ `.js` を入れられるので、ファイルを選ぶことと確かめることは Rust の側で行う。

- 節に「追加…」のボタンを置く。押すと、webview は引数のない Rust のコマンド（`install_plugin`）を呼ぶ。
- `install_plugin` は、Rust の側で macOS のファイルを選ぶダイアログを開き、`.js` のファイルを一つ選ばせる。選んだあと、Rust の側の確認のダイアログ（ネイティブのもの）に、ファイル名と、「プラグインは Aleph と同じ権限で動き、ファイルを読み書きできます。自分で書いたか、読んで信頼したものだけを入れてください」を出す。はいのときだけ、選んだファイルをプラグインのフォルダに写す。同じ名前があれば、上書きするかを同じダイアログで確かめる。
- 写したあと、プラグインを読み直す（今の「読みなおす」と同じ）。
- 各プラグインの行に「外す」を置く。押すと、webview はプラグインの名前だけを渡して Rust のコマンド（`remove_plugin`）を呼び、Rust の側の確認のダイアログのあと、プラグインのフォルダの中のそのファイルを消す。名前に `/` や `..` を含むものは拒む。
- 「フォルダを開く」のボタンで、プラグインのフォルダを Finder で開く（Rust の側のコマンドで、パスは webview から受け取らない）。ここに置いたファイルも、今までどおり読み直しで読む。
- 入れたプラグインを編集する機能は持たない。編集するときは、元のファイルを直して入れ直すか、フォルダの中のファイルを別のエディタで直す。

### 権限

- capability の `windows` を、使うウィンドウの名前（`main`、`plain-*`、`plot-*`、`imelog-*`）に限る。

## 実装しないこと

- webview の中のコードの分離（iframe のサンドボックスなど）。CSP と Rust の側の制限で足りるとする。
- ワークスペースの外のファイルを、ファイルのダイアログで選んで開くこと（今の Aleph にない機能）。
- git や golem に渡すサブコマンド以外の引数の検査（オプションの差し込みは [ADR 0048](0048-paths-in-arguments-and-data-files.md) で扱う）。

## テスト設計

Rust の部分は `cargo test` で、テストを先に書いて失敗させてから実装する。

- パスの範囲：ワークスペースの中、設定のディレクトリの中、一時のディレクトリの中が通ること。外の絶対パス、`..` で外へ出るパス、ワークスペースの中からワークスペースの外へのシンボリックリンクを通ったパスが拒まれること。存在しないファイルの親で確かめること。プラグインのフォルダへの webview のコマンドからの書き込みが拒まれること。
- プラグインの追加と削除：写す処理と消す処理を、ダイアログから切り離した関数として確かめる（`.js` 以外を拒むこと、同じ名前のときに上書きの確かめを要すること、`remove_plugin` が `/` と `..` を含む名前を拒み、フォルダの外を消さないこと）。
- サブコマンド：許可したものが通り、ほかのもの（`git -c`、`git config`、`golem` の未知のもの、空の引数）が拒まれること。
- 実行ファイル：`config.json` の値から決まり、IPC からは変えられないこと（コマンドの引数に `bin` がないこと）。
- 画面の確かめ方：ビルドしたアプリで、ワークスペース、プレビュー、プロットのウィンドウ、PDF、Mermaid、プラグイン、設定、ゴミ箱、画像の貼り付けが今までどおり動くこと、開発者ツールの console で `invoke("read_text", { path: "/etc/hosts" })` が拒まれることを確かめる。設定からプラグインを追加すると Rust のファイルのダイアログと確認のダイアログが出て、はいで読み込まれ、「外す」で消えることを確かめる。

## トレードオフ

- ワークスペースに登録していないフォルダのファイルは、Aleph から読み書きできなくなる。Aleph はワークスペースの中で書く道具なので、この制限を受け入れる。
- サブコマンドを許可リストにするので、Aleph が新しく golem や git の機能を使うときは、Rust の側のリストも直す必要がある。
- プラグインの追加は、注入されたスクリプトからも `install_plugin` を呼べるが、ファイルを選ぶことと確かめることを書き手がネイティブのダイアログで行うので、書き手の操作なしには入らない。webview で描いた確認の画面にしないのは、注入されたスクリプトが押せてしまうためである。

## 参考文献

- [docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md)
- Tauri 2, Content Security Policy：https://v2.tauri.app/security/csp/
- Tauri 2, Capabilities：https://v2.tauri.app/security/capabilities/
