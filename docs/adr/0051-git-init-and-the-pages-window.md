# ADR 0051: git の許可に init を足し、ページのウィンドウを権限の対象に書く

ステータス: 採択（未実装）

## 文脈

[ADR 0042](0042-ipc-trust-boundary.md) は、git のサブコマンドを Aleph が使うものに限り、`add`、`branch`、`commit`、`diff`、`log`、`pull`、`push`、`rev-parse`、`show`、`status` を挙げた。
ところが Git のパネルは、Git のリポジトリでないワークスペースに「git init」のボタンを出す（[app/gitpanel.ts](https://github.com/tett23/aleph/blob/f70c4e8/app/gitpanel.ts#L90)）。
許可リストに `init` がないので、[ADR 0042](0042-ipc-trust-boundary.md) を実装してから（2026-11-08）、このボタンは誤りを返すだけになった。
[ADR 0042](0042-ipc-trust-boundary.md) を書いたとき、使っているサブコマンドの洗い出しから `init` が漏れていた。

あわせて、[ADR 0042](0042-ipc-trust-boundary.md) は capability の `windows` を `main`、`plain-*`、`plot-*`、`imelog-*` とした。
ページのプレビューの別ウィンドウは `pages-*` の名前で開く（[app/preview/mount.ts](https://github.com/tett23/aleph/blob/f70c4e8/app/preview/mount.ts#L261)）。
実装では `pages-*` も足したが、ADR には書かれていない。

## 実装すること

- git の許可リストに `init` を足す。[ADR 0046](0046-safe-automatic-git.md) の上書き（`core.fsmonitor`、`core.hooksPath`）は `init` にも付ける。
- capability の `windows` に `pages-*` があることを、この ADR で決めたことにする（実装は済んでいる）。

## 実装しないこと

- ほかのサブコマンド（`clone`、`checkout` など）の追加。Aleph はこれらを使わない。

## テスト設計

`cargo test` で、テストを先に書いて失敗させてから実装する。

- 許可リストの関数が `git init` を通すこと。
- 画面の確かめ方：Git のリポジトリでないフォルダをワークスペースに足し、Git のパネルの「git init」で `.git` ができ、パネルがリポジトリの表示に変わることを確かめる。

## トレードオフ

- `init` は、作業のディレクトリ（[ADR 0042](0042-ipc-trust-boundary.md) の範囲に限る）に `.git` を作るだけで、外のコマンドは走らせないので、許可しても境界は広がらない。

## 参考文献

- [docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md)
