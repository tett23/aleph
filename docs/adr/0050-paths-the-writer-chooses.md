# ADR 0050: 書き手が選んだパスだけを、範囲と実行ファイルに足す

ステータス: 採択（未実装）

## 文脈

[ADR 0042](0042-ipc-trust-boundary.md) は、ファイルを読み書きするコマンドの範囲をワークスペース、設定のディレクトリ、一時のディレクトリ、共有ライブラリに限り、実行ファイルのパスを IPC の引数から外して Rust の側が `config.json` から読むことにした。
実装のために今のコードを読むと、この決めごとだけでは次の三つが残る。

- `config_save` は、webview が渡した JSON をそのまま `config.json` に書く（[src-tauri/src/lib.rs](https://github.com/tett23/aleph/blob/b4ee3c4/src-tauri/src/lib.rs#L36-L39)）。注入されたスクリプトが `workspaces` に `/` を足すか、`gitPath` を自分の置いたファイルにして保存すれば、[ADR 0042](0042-ipc-trust-boundary.md) の範囲と実行ファイルの制限を両方とも越えられる。
- Finder から落としたファイルを、図版、ツリーのフォルダ、共有ライブラリに写す機能（[app/libpanel.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/libpanel.ts#L178-L200)、[app/imagedrag.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/imagedrag.ts#L51)）は、ワークスペースの外のファイルを `copy_file` で読む。[ADR 0042](0042-ipc-trust-boundary.md) の範囲では、これが拒まれる。
- 共有ライブラリを作るとき、今のコードは `config.json` を保存する前に、選んだ場所に `make_dir` する（[app/libpanel.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/libpanel.ts#L245-L251)）。[ADR 0042](0042-ipc-trust-boundary.md) の範囲では、これも拒まれる。

三つとも、範囲を広げる操作を、webview が単独でできるか、書き手の操作を Rust の側が知らないことから起きる。
[ADR 0042](0042-ipc-trust-boundary.md) のプラグインの追加と同じく、範囲を広げるのは、書き手がネイティブのダイアログか Finder からの操作で選んだパスに限ればよい。

## 実装すること

### Rust の側だけが変える設定

- `workspaces`、`libraryDir`、`gitPath`、`golemPath`、`shemPath` を、Rust の側だけが変える設定とする。
- `config_save` は、受け取った JSON のこれらの値を捨て、`config.json` に今ある値を残して書く。ただし、`workspaces` から項目を外すこと（範囲が狭まる変更）は受け付ける。
- 足すときは、引数のない Rust のコマンドを呼ぶ。コマンドは Rust の側でネイティブのダイアログを開き、選んだパスを `config.json` に書いて、新しい設定を返す。
  - `add_workspace`：フォルダを選ぶダイアログ。今の「ワークスペースを足す…」が呼ぶ。
  - `choose_library(make: bool)`：フォルダを選ぶダイアログ。`make` のときは、選んだ場所に `Aleph Library` と `fonts`、`plugins`、`functions` を作ってから設定に書く。
  - `choose_binary(name)`：ファイルを選ぶダイアログ（`name` は `git`、`golem`、`shem` のどれか）。
- 実行ファイルを手で打つ欄は残す。欄で決めると、webview は `set_binary(name, path)` を呼び、Rust の側がネイティブの確認のダイアログ（「git として <パス> を使いますか」）を出して、はいのときだけ書く。空にする（探す順に戻す）ときは確かめない。
- `libraryDir` を外す（空にする）操作も、確かめずに受け付ける。

### Finder から落としたファイル

- Rust の側で、ウィンドウのドラッグアンドドロップの `Drop` の事象を受け、落ちてきたパスを、そのアプリが動いているあいだだけ読める範囲に足す。
- `copy_file` の `from` は、[ADR 0042](0042-ipc-trust-boundary.md) の範囲か、この落ちてきたパスの下であれば通す。`to` は [ADR 0042](0042-ipc-trust-boundary.md) の範囲に限る。
- 落ちてきたパスは保存しない。アプリを終えると消える。

## 実装しないこと

- 設定の画面を webview の外（ネイティブのウィンドウ）に移すこと。
- ほかの設定（表示、キーの割り当て、プラグインの有効と無効など）の保護。これらは範囲も実行ファイルも変えない。
- 落としたファイルを、写さずにその場で開くこと（今の Aleph にない機能）。

## テスト設計

Rust の部分は `cargo test` で、テストを先に書いて失敗させてから実装する。ダイアログは、選ばれたパスを受ける関数と切り離して確かめる。

- 設定の併合：`config_save` の JSON の `workspaces` に新しいパスがあっても書かれないこと、項目を外すのは書かれること、`gitPath` などの値を変えても書かれないこと、ほかの値は書かれること。
- `add_workspace` などの、選んだパスを書く関数：新しいパスが足され、重ねて足しても一つになること、`choose_library(make)` がサブフォルダを作ること、`choose_binary` が知らない名前を拒むこと。
- 落ちてきたパス：落ちてきたファイルとフォルダの下は `copy_file` の `from` に通り、ほかの範囲の外は拒まれること、`to` は範囲の外なら拒まれること。
- 画面の確かめ方：ビルドしたアプリで、ワークスペースを足す、共有ライブラリを選ぶと作る、git と golem のバイナリを選ぶと打つ、Finder から画像を章とツリーと共有ライブラリに落とす、が今までどおり動くこと。開発者ツールの console で `invoke("config_save", ...)` に `workspaces: ["/"]` を渡しても、`config.json` に `/` が入らないことを確かめる。

## トレードオフ

- 実行ファイルのパスを手で打ったとき、ネイティブの確認のダイアログが一つ増える。
- 注入されたスクリプトも `add_workspace` を呼べるが、ネイティブのダイアログで書き手がフォルダを選ばなければ何も足されない（[ADR 0042](0042-ipc-trust-boundary.md) のプラグインの追加と同じ理由）。
- 落ちてきたパスはアプリを終えるまで読めるので、そのあいだに注入されたスクリプトが、同じファイルを読める。書き手が自分で落としたものに限るので、受け入れる。

## 参考文献

- [docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md)
- Tauri 2, WindowEvent::DragDrop：https://docs.rs/tauri/latest/tauri/enum.WindowEvent.html
