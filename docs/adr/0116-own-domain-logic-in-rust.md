# ADR 0116: 変換とドメインロジックを Rust に集約する

Status: proposed

## 文脈

Markdown から gm への変換を広げる [draft PR #92](https://github.com/tett23/aleph/pull/92) では、Markdown の構文解析、gm の生成、出力ファイルとマニフェストの更新を TypeScript で実装している。
画面の外でも同じ結果を求められる処理を Rust に集め、変換の画面と Markdown のプレビューが同じ構文規則を使えるようにする。

## 調査した事項

PR #92 の HEAD は `946dc802ee771be0e964398e1d55100fd434a61e` である。
同 PR は Markdown のパーサーとエンティティ表を広げ、パーサーの結果を gm の生成に使う。
ファイルの変換では、画面から存在確認、上書きの確認、出力の書き込み、マニフェストの更新を順に行う。
[draft の構文解析](https://github.com/tett23/aleph/blob/946dc802ee771be0e964398e1d55100fd434a61e/app/md.ts)、[draft の gm 生成](https://github.com/tett23/aleph/blob/946dc802ee771be0e964398e1d55100fd434a61e/app/mdgm.ts)、[draft のファイル変換](https://github.com/tett23/aleph/blob/946dc802ee771be0e964398e1d55100fd434a61e/app/mdconvertfile.ts)

現在の `main` でも、Markdown の構文解析は TypeScript にあり、本文のプレビューと gm への変換で共有している。
変換コマンドは、開いているシートがあれば編集時点の本文を取り、閉じていればファイルを読む。
一方、ワークスペースの検索・置換や Git の操作には、用途を限った Rust の呼び出し口がある。
[現在の変換コマンド](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/mdconvert.ts)、[現在の gm 生成](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/mdgm.ts)、[Rust の置換](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/src-tauri/src/replace.rs)、[Git の呼び出し口](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/git-ipc.ts)

## 実装すること

### Rust と TypeScript の分担

文書やプロジェクトのデータを解釈、変換、検査し、同じ入力から同じ結果を求める規則を、この ADR では **ドメインロジック** と呼ぶ。
ドメインロジックと、ファイルや外部コマンドを扱う操作の本体は Rust に置く。
Golem が受け持つ組版と文書の検査には、既存の Golem の機能を使う。

TypeScript は、入力イベント、IME と DOM の連携、カーソルとスクロールの表示、タブやダイアログの状態、表示に必要なデータの受け渡しを受け持つ。
画面から Rust を呼ぶときは、型付きの操作と結果を使う。
ファイルを扱う操作は、既存のワークスペースとパスの検査を Rust で通す。 [ADR 0003](0003-application-architecture.md)、[ADR 0042](0042-ipc-trust-boundary.md)、[ADR 0062](0062-run-programs-off-the-main-thread.md)
この決定は [ADR 0003](0003-application-architecture.md) のフロントエンドとバックエンドの担当を具体化する。

### Markdown から移す順序

最初に Markdown の構文解析、gm の生成、変換先の計画と書き込み、章登録を Rust へ移す。
Markdown のプレビューにも同じ Rust の構文解析結果を使い、画面側では現在の表示と操作へつなぐ。
Markdown の埋め込みやリンクは今の解決規則を保ち、画像とリンクの表示時の検査を通す。 [ADR 0016](0016-markdown-to-gm.md)、[ADR 0029](0029-embeds.md)、[ADR 0035](0035-markdown-line-breaks-and-gfm.md)、[ADR 0047](0047-no-remote-images-in-previews.md)

変換先を上書きするかは、Rust が返した情報を使って画面で確認する。
Rust は書き込む前に、確認の対象となった出力先とマニフェストをその時点の状態と照合する。
元の Markdown ファイルを保ち、開いているシートでは未保存の本文を変換に使う。
出力の後に Golem の検査を行い、診断は既存の画面へ渡す。

PR #92 の変換仕様の候補とテスト素材は Rust 側の作業で検討する。
変換できる構文と生成結果を変える決定は、対応する仕様を採択してから実装する。
移行そのものは、今の仕様を維持する。

### TypeScript に残っている移行対象

次の表は、現在のコードで見つかった移行対象を示す。
Markdown の移行後は、共通の構文やデータを使う処理から順に移し、表にない処理にも同じ分担を適用する。

| 対象 | 確認した実装 | Rust が返す結果 |
| --- | --- | --- |
| プロジェクトの設定と章登録 | [manifest.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/manifest.ts)、[workspace.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/workspace.ts) | 章順、段落様式、組版設定、変更後のマニフェスト |
| ウィキリンクと字数 | [wikilink.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/wikilink.ts)、[count.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/count.ts) | 参照の解決、索引、参照の変更案、字数と段落の集計 |
| 文法と文章の検査 | [ed/json.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/ed/json.ts)、[proofread.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/proofread.ts)、[diag/parse.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/diag/parse.ts) | 診断、診断の範囲、整形の結果 |
| 差分、外部変更、アシスタントの変更案 | [diff.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/diff.ts)、[merge3.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/merge3.ts)、[assistant/tab.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/assistant/tab.ts) | 差分、競合の範囲、応答の検査結果と編集案 |
| プロットのデータ | [plot/data.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/plot/data.ts) | CSV の解釈結果と書き出すデータ |
| エディタの文書モデル | [ed/core.ts](https://github.com/tett23/aleph/blob/fd0067b19dc3d0194220ce1e4892b13ab3e3156d/app/ed/core.ts) | 文字の変更、範囲の写し替え、取り消しとやり直しの結果 |

### 移行中に保つ振る舞い

処理の呼び出し口は、シートや操作の単位でまとめる。
編集中の文書を Rust で処理する場合は、リクエストに本文の版を添え、応答を受けた時点で対象の版が合う結果だけを使う。
エディタと LSP へ返す位置は、各仕様が決めた単位を保つ。UTF-16 の位置を使う箇所では、Rust のバイト位置との変換を境界で行う。

ポインタの移動やキー入力ごとに動く純粋な処理は、移行前後に応答時間と IPC の回数を計測する。
その計測と既存の入力および IME のテストで、通常の編集を保てる呼び出し方を確かめてから切り替える。
別の実行方式が必要になった場合は、その方式を ADR で決める。
切り替えを終えた処理の TypeScript 実装は取り除き、実行時の規則を一箇所に保つ。

## 実装しないこと

変換で受け付ける構文の追加、Golem の組版の再実装、DOM や IME のイベント処理の Rust への移植。

## 不変条件

- I1: 移行済みの形式の構文規則は Rust の一つの実装で決まり、本文のプレビューと変換は同じ解析結果を使う。
- I2: 移行前後で、既存の入力に対する変換結果、診断、参照先、編集案と、それらの位置が一致する。
- I3: 変換は元の Markdown ファイルを変更せず、確認を取り消した場合は変換先とマニフェストに書き込まない。
- I4: 編集中の版を指定して求めた結果は、一致する版にだけ反映する。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| 改行方式の異なる Markdown と、コード中に命令に似た文字を含む Markdown | プレビューと変換が同じ構文の解釈を使い、既存の変換例と一致する | I1, I2 |
| 絵文字を挟んだ行で診断または編集案を返す | 画面で元の UTF-16 の位置と同じ文字を指す | I2 |
| 未保存の Markdown から新規の gm に変換 | 編集中の本文から生成し、元ファイルには書かない | I3 |
| 上書きを取り消す | 変換先とマニフェストを保つ | I3 |
| 二つの本文の版に対する診断が逆順で届く | 現在の版の診断だけを出す | I4 |

## 受けいれ条件

- A1: ツールバーとツリーの「gm に変換」から、Rust の共通処理で変換し、出力を Golem で検査できる。
- A2: 変換と Markdown のプレビューの構文規則を変更するときは、Rust の共通処理とそのテストを直せばよい。
- A3: 移行対象ごとの検証で振る舞いの一致を確かめ、切り替え後の画面は Rust の結果を使う。

## テスト設計

移行する処理の既存テストを Rust 側へ移し、移行前後の比較に使う入力と出力を残す。
先に Rust のテストを書き、結果が一致してから画面の呼び出し先を切り替える。
変換では未保存の本文、上書きの承認と取消、章の有無、失敗、Unicode の位置を確かめ、Golem を使う結合テストで出力を検査する。
画面では版の違う応答、変換後に開くシートと診断、入力と IME の操作を確かめる。
テスト名には `ADR 0116 I1: ` のように ADR と条件の番号を付ける。

実装した範囲を仕様書と両言語の README に反映する。

## トレードオフ

Rust が結果をまとめて返すと、TypeScript が文書の構文やファイルの規則を再現する必要がなくなる。
一方、短い操作のたびに IPC を行うと入力に待ち時間が加わるため、移行は呼び出し方の計測と合わせて行う。

## 参考文献

- [Aleph の draft PR #92](https://github.com/tett23/aleph/pull/92)
