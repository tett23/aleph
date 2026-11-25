# [ADR 0100](../adr/0100-move-tree-files-and-folders.md) のツリーでの移動を Golem HEAD で確かめた記録 (2026-11-26)

## 対象と環境

- 対象は [ADR 0100](../adr/0100-move-tree-files-and-folders.md) の A1 のうち、シートと、子孫を持つフォルダをツリーでドラッグして別のフォルダへ移すことである。資料と空のフォルダの移動、A2〜A5 は、この記録の対象ではない。
- Aleph は、main のコミット `2c040e1` から `npx tauri build --debug` で作ったデバッグ版を使った。このコミットから main の `dc09b70` までの変更は文書だけである。macOS は 27.0、ファイルシステムは APFS である。
- Golem は、tett23/golem の main のコミット `4ab1b53` からビルドしたものを、設定の `golemPath` に指定した。この Golem は、初期化の応答で `experimental.golem.planFileMove` に `1` を返す。同梱の Golem 0.1.0-rc4 は返さないので、移動計画を用意できず、ツリーでの移動を止める。
- 確かめには、使い捨ての Git のリポジトリをワークスペースにした。中のプロジェクト `proj` は、章 `chapters/01.gm` と `chapters/02.gm`、画像 `img/a.png` と `img/b.png`、空でないフォルダ `part2` と `assets` を持つ。`manifest.toml` の章の一覧は `["chapters/01.gm", "chapters/02.gm"]` である。01.gm は `@figure img/a.png alt="駅"`、02.gm は `@figure img/b.png alt="霧"` で画像を参照する。移す前に `golem build --target html` が終了コード 0 で通ることを確かめた。
- 02.gm をタブで開き、01.gm は開かない状態から始めた。
- 書き手の `config.json` と `window.json` は、確かめの前に控え、後で戻した。戻した直後の `config.json` の SHA-1 は、控えと同じだった。
- 画面は、画面を借りない背景の操作で見て、ドラッグした。

## シートの移動

ツリーで `chapters/02.gm` の行を `part2` フォルダの行へドラッグした。

- ファイルは `proj/part2/02.gm` に移った。
- 開いていたタブのパスが `proj/part2/02.gm` に変わった。
- 「…/proj/part2/02.gm に移動しました」の通知が出た。
- `manifest.toml` の章の一覧が `["chapters/01.gm", "part2/02.gm"]` に変わった。
- その後の `golem build --target html` は、終了コード 0 で通った。

## フォルダの移動

ツリーで `img` フォルダの行を `assets` フォルダの行へドラッグした。

- フォルダは中の `a.png` と `b.png` ごと `proj/assets/img/` に移った。
- 開いていた 02.gm の `@figure img/b.png` は、エディタの中で `@figure assets/img/b.png` に変わり、ディスクにも書かれた。
- 開いていなかった 01.gm の `@figure img/a.png` は、ファイルで `@figure assets/img/a.png` に変わった。
- その後の `golem build --target html` は、終了コード 0 で通った。

一度目のドラッグは、行の左寄りの位置から始めた。このときは何も移らず、ファイルも変わらなかった。行の名前の文字の上から始め直した二度目のドラッグで移った。一度目で移らなかった理由は確かめていない。

## 残ったこと

- この記録は A1 の一部である。資料と空のフォルダの移動、A2〜A5 は確かめていない。[ADR 0100](../adr/0100-move-tree-files-and-folders.md) のステータス (`accepted-pending`) とロードマップの項目は変えない。
- 同梱の Golem を `planFileMove` を持つ版に上げるのは、Golem と Aleph のリリースで行う。
