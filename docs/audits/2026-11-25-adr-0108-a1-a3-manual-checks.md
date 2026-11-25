# [ADR 0108](../adr/0108-follow-moves-made-outside.md) A1〜A3 の手の確かめ (2026-11-25)

## 対象と環境

- 対象は [ADR 0108](../adr/0108-follow-moves-made-outside.md) の受けいれ条件 A1、A2、A3 である。
- Aleph は、main のコミット `2c040e1` から `npx tauri build --debug` で作ったデバッグ版を使った。macOS は 27.0、ファイルシステムは APFS である。
- Golem は、tett23/golem の main のコミット `4ab1b53` からビルドしたものを、設定の `golemPath` に指定した。この Golem は、初期化の応答で `experimental.golem.planMovedReferences` に `1` を返す（[tett23/golem ADR 0426: 移動し終えたファイルとフォルダの参照の編集を Golem LSP が返す](https://github.com/tett23/golem/blob/main/docs/adr/0426-plan-reference-edits-after-a-move.md) の実装）。
- 確かめには、使い捨ての Git のリポジトリをワークスペースにした。中のプロジェクト `proj` は、章 `chapters/01.gm` と `chapters/02.gm`、画像 `img/a.png` と `img/b.png` を持つ。01.gm は `@figure img/a.png alt="駅"`、02.gm は `@figure img/b.png alt="霧"` で画像を参照する。移す前に `golem build --target html` がエラーなしで通ることを確かめた。
- 01.gm、02.gm、a.png を、それぞれ別のタブで開いた状態から起こした。
- 書き手の `config.json` と `window.json` は、確かめの前に控え、後で戻した。戻した後の `config.json` の SHA-1 は、控えと同じだった。
- 画面は、画面を借りない背景の操作で見て、操作した。Finder の「フォルダへ移動」のシートだけは、全画面の操作で確定した。

## A1

ターミナルで、`git mv img/a.png fig/a.png` と `git mv chapters/02.gm part2/02.gm` を続けて実行した。

- 二つのタブのパスが、`proj/fig/a.png` と `proj/part2/02.gm` に変わった。「ディスクにありません」の通知は出なかった。
- 「2 件の移動を検出しました。2 件のファイルの参照を新しい場所に更新しますか。」の通知が、「更新する」と「更新しない」を付けて一つだけ出た。

## A2

A1 の通知で「更新する」を押した。

- 「2 件のファイルの参照を更新しました」の通知が出た。
- `chapters/01.gm` の `@figure img/a.png` が `@figure fig/a.png` に、`manifest.toml` の `chapters` の `"chapters/02.gm"` が `"part2/02.gm"` に変わった。
- その後の `golem build --target html` は、エラーと警告なしで通った（終了コード 0）。

## A3

Finder で `proj/chapters` フォルダ（開いている 01.gm を含む）を、`proj/assets` フォルダの上へドラッグした。

- 01.gm のタブのパスが `proj/assets/chapters/01.gm` に変わった。
- 「…/proj/chapters を …/proj/assets/chapters に移したことを検出しました。1 件のファイルの参照を新しい場所に更新しますか。」の通知が出た。
- 「更新する」を押すと、「1 件のファイルの参照を更新しました」の通知が出た。`manifest.toml` の `"chapters/01.gm"` が `"assets/chapters/01.gm"` に変わった。その後の `golem build --target html` は、エラーと警告なしで通った。

Finder で移したのは章を含むフォルダで、画像を含むフォルダは移していない。画像のフォルダ `fig` を背景の操作でドラッグしても、Finder は動かさなかったためである。画像の移動と参照の更新は、A1 と A2 で確かめた。

## Finder の移動の事象

[ADR 0108](../adr/0108-follow-moves-made-outside.md) のテスト設計に従い、A3 の間、[docs/research/2026-11-23-fsevents-renames](../research/2026-11-23-fsevents-renames/) の `probe.c` でワークスペースを見張った。
記録は [finder-output.txt](../research/2026-11-23-fsevents-renames/finder-output.txt) に置いた。

- Finder のドラッグは、一つのコールバックで、同じ fileID を持つ ItemRenamed の事象を二つ届けた。一つ目が移動元の `proj/chapters`、二つ目が移動先の `proj/assets/chapters` で、事象の ID は一つ目のほうが小さい。旗は `0x20800`（ItemRenamed と ItemIsDir）である。
- 同じ fileID の ItemRenamed が二つ届き、移動元の事象の ID が小さいことは、[output.txt](../research/2026-11-23-fsevents-renames/output.txt) の `mv` と `git mv` と同じである。この二つの事象は、[ADR 0108](../adr/0108-follow-moves-made-outside.md) I1 の対の条件に当てはまる。

## 残ったこと

- 手の確かめは残っていない。ただし、同梱の Golem 0.1.0-rc4 は `golem/planMovedReferences` に応じない。同梱の Golem を ADR 0426 を含む版に上げるのは、Golem と Aleph のリリースで行う。
