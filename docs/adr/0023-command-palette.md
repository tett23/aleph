# ADR 0023: コマンドパレットとコマンドの登録

ステータス: 採択

## 文脈

Aleph の操作は、リボン、ツールバーのボタン、ツールバーのメニュー（「…」）、設定の画面、エディタのキー、いくつかの画面ごとのキー（⌘⇧K、⌘⇧F）に散らばっている（[ADR 0005](0005-layout-and-appearance.md)）。
ツールバーのメニューの項目は、`ctx.commands` に名前とアイコンと実行の処理で登録している（[app/ctx.ts](https://github.com/tett23/aleph/blob/556db161917fdf32808b5b5153fdce0a99c65c71/app/ctx.ts#L22)）。
キーの割り当ては、エディタのもの（[app/ed/editor.ts](https://github.com/tett23/aleph/blob/556db161917fdf32808b5b5153fdce0a99c65c71/app/ed/editor.ts#L151-L170)）、LSP のもの、Git のパネルと検索のパネルの `keydown` に分かれて書かれ、一か所から見られない。

Obsidian は、すべての操作を名前で探して実行する画面（コマンドパレット、⌘P）を持つ。
メンテナーは、Obsidian と Ulysses にあって Aleph にない機能を比べ、これを ADR にするよう求めた（2026-11-07）。
下書きのレビューでは、VS Code と同じく、⌘P の入力欄（[ADR 0022](0022-quick-open.md) のシートを開く画面）の先頭に `>` を打つと、コマンドを絞り込むようにするよう求められた（2026-11-08）。
VS Code では、ファイルを名前で開く Quick Open（⌘P）とコマンドパレット（⇧⌘P）が、一つの入力欄を共有している。
キーの割り当てを変えられるようにすること（[ADR 0034](0034-key-bindings.md)）も同時に求められた。
割り当てを変えるには、割り当てる先の操作に名前（ID）が要る。

## 実装すること

### コマンドの登録

- 操作をコマンドとして一か所に登録する。コマンドは、ID、名前、アイコン（省略可）、使えるかどうかの判定、実行の処理、既定のキー（省略可）、ツールバーのメニューに出すかどうかを持つ。今の `ctx.commands` の形を広げ、今の項目はツールバーのメニューに出すものとして登録し直す。
- ID は `<領域>.<操作>` の形の英語の小文字とする。最初に次のものを登録する。
  - ファイル：`file.quickOpen`（⌘P、[ADR 0022](0022-quick-open.md)）、`file.newSheet`、`file.newFolder`、`file.newProject`、`file.save`（⌘S）、`file.closeTab`（⌘W、[ADR 0024](0024-tabs-and-split.md)）。
  - 表示：`view.left.files`、`view.left.search`（⌘⇧F）、`view.left.git`、`view.left.diagnostics`、`view.left.library`、`view.left.bookmarks`（[ADR 0025](0025-bookmarks.md)）、`view.toggleLeft`、`view.right.attach`、`view.right.outline`、`view.right.library`、`view.toggleRight`、`view.plot`、`view.vertical`、`view.horizontal`、`view.split`（[ADR 0024](0024-tabs-and-split.md)）。
  - プレビュー：`preview.none`、`preview.plain`、`preview.pages`、`preview.window`。
  - エディタ：`editor.undo`（⌘Z）、`editor.redo`（⇧⌘Z）、`editor.selectAll`（⌘A）、`editor.find`（⌘F）、`editor.indent`（Tab）、`editor.outdent`（⇧Tab）、`editor.complete`（⌃Space）、`editor.format`（⌥⇧F）。
  - Git：`git.commit`（⌘⇧K）、`git.push`、`git.pull`。
  - そのほか：`palette.open`（⇧⌘P）、`settings.open`（⌘,）、`md.convertToGm`、`library.copyFonts`、`bookmark.toggle`（[ADR 0025](0025-bookmarks.md)）、`dev.recordIme`。
  - 設定の画面の各節：`settings.<節の ID>`（その節を開いた設定の画面を出す）。
- Aleph のプラグイン（[ADR 0017](0017-aleph-plugins.md)）が `registerCommand` で足したものは、`plugin.<プラグインの名前>.<連番>` の ID で登録し、名前にプラグインの名前を添える。
- キーを押したときは、登録したコマンドの既定のキー（[ADR 0034](0034-key-bindings.md) で変えたときはそのキー）を引き、使えるコマンドがあれば実行する。今は画面ごとに書いている `keydown` の処理（⌘⇧K、⌘⇧F）をここに移す。エディタの中のキー（取り消し、字下げなど）は、エディタがフォーカスを持つときだけ使えるコマンドとして登録する。

### コマンドパレット

- コマンドパレットは、[ADR 0022](0022-quick-open.md) の入力欄を共有する。入力欄の先頭が `>` のとき、一覧はコマンドの一覧になり、`>` の後の文字（先頭の空白は読み飛ばす）でコマンドを絞り込む。`>` を消すと、シートの一覧に戻る。
- ⇧⌘P（`palette.open`）は、入力欄に `>` を入れた状態で開く。
- 一覧には、今使えるコマンドだけを出す。各行に、名前と、割り当てたキー（⌘、⇧、⌥、⌃ の記号で、macOS の順に並べる）を出す。
- 照らし合わせは [ADR 0022](0022-quick-open.md) のあいまいな照らし合わせを使い、名前と ID の両方と照らす。入力が空のときは、最近実行したコマンドを新しい順に先に出し、残りを名前の順に出す。最近実行したコマンドは、`config.json` の `ui` に 20 件まで残す。
- ↑↓ で選び、↩ で実行して閉じる。Esc か一覧の外を押すと閉じる。

## 実装しないこと

- コマンドに引数を渡すこと（行の番号を打って移る、など）。
- コマンドを続けて実行するマクロ。
- ツールバーのメニューの並びを書き手が変えること。

## テスト設計

DOM に触れない部分を関数に分け、`node --test` で確かめる。テストを先に書いて失敗させてから実装する。

- 登録：ID が重ならないこと（重なる登録は失敗すること）、ID の形の検査、使えるかどうかの判定で一覧が絞られること、ツールバーのメニューに出すものだけが選ばれること。
- 最初に登録するコマンド：上の一覧の ID がすべて登録されていること（登録の表を一つの値にし、テストで照らす）。
- キーの表示：`Mod-Shift-k` が `⇧⌘K` に、`Shift-Alt-f` が `⌥⇧F` に、`Ctrl-Space` が `⌃Space` になること（macOS の修飾キーの順）。
- キーから引く：押したキーに割り当てたコマンドのうち、使えるものが選ばれること、使えないときは何もしないこと、エディタがフォーカスを持たないときはエディタのコマンドが選ばれないこと。
- パレットの並べ方：最近実行したものが先に出ること、20 件で切ること、名前と ID のどちらでも一致すること。`>` の後の空白を読み飛ばすこと（`> 整形` と `>整形` が同じになる）。
- 画面の確かめ方：⌘P で `>` と名前の一部を打って、また ⇧⌘P から名前の一部を打って、パネルの切り替え、縦と横の切り替え、整形、コミットを実行できること、各行にキーが出ることを確かめる。今まで動いていたキー（⌘S、⌥⇧F、⌘⇧K、⌘⇧F、⌘Z）がそのまま動くことを確かめる。

## トレードオフ

- 散らばっていたキーの処理を一か所に集めるので、今の振る舞いを変えないよう移し替える手間がかかる。その代わり、どのキーが何をするかを一か所で見られ、[ADR 0034](0034-key-bindings.md) で割り当てを変えられる。
- コマンドの ID は、割り当てを残すときの名前になるので、一度決めたら変えにくい。変えるときは古い ID を新しい ID に読み替える表を置く。

## 参考文献

- VS Code の画面の説明（Quick Open とコマンドパレット）：https://code.visualstudio.com/docs/getstarted/userinterface
