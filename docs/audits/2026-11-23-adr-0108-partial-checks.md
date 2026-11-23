# [ADR 0108](../adr/0108-follow-moves-made-outside.md) の手の確かめの一部 (2026-11-23)

## 対象と環境

- 対象は [ADR 0108](../adr/0108-follow-moves-made-outside.md) の A1 のうち、開いているタブが移動先に付け替わることである。参照の更新の通知と A2、A3 は、`golem/planMovedReferences` に応じる Golem が無いので、確かめていない。
- tett23/aleph#179 のブランチ（コミット `bc9d185`）から `npx tauri build --debug` で作ったデバッグ版で確かめた。macOS は 27.0、ファイルシステムは APFS である。
- Golem は、`kinsoku` を持つ Golem の main からビルドしたもの（`golem/planMovedReferences` には応じない）を、設定の `golemPath` に指定した。
- 確かめには、使い捨てのワークスペースを使い、`01-夜の駅.md` を開いた状態から起こした。
- 書き手の `config.json` と `window.json` は、確かめの前に控え、後で戻した。戻した後の `config.json` の SHA-1 は、控えと同じだった。
- 移動は、Aleph の外のシェルの `mv` で行った。画面は、画面を借りない背景の操作（ウィンドウごとの画面の取り込み）で見た。

## 結果

- `mv 01-夜の駅.md moved/01-夜の駅.md` の後、タブの題名の横のパスが `moved/01-夜の駅.md` に変わった。「ディスクにありません」の通知は出なかった。
- 同じ移動で、「Golem LSP が移動後の参照の更新に対応していません」の通知が一度出た。
- 続けて `mv moved moved2`（開いているシートを含むフォルダの移動）の後、パスが `moved2/01-夜の駅.md` に変わった。「対応していません」の通知は二度目は出なかった。

## 残ったこと

- A1 の参照の更新の通知、A2、A3。`golem/planMovedReferences` に応じる Golem ができてから確かめる。
