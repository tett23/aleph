# ADR 0046: 自動で走らせる git に、リポジトリの設定の命令を使わせない

ステータス: 採択

## 文脈

Aleph は、起動のときと 1 時間ごとに、すべてのワークスペースで `git status` を走らせ、1 日 1 回の自動コミットで `git add -A` と `git commit` を走らせる（[ADR 0011](0011-saving-and-git.md)、[app/gitpanel.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/gitpanel.ts#L57-L72)）。
2026-11-08 のセキュリティ監査（[docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md) の所見 5）は、`.git` ごと受け取ったワークスペース（zip や共有フォルダ）では、`.git/config` の `core.fsmonitor` や `core.hooksPath` と hook で、書き手が何もしなくてもコマンドが走ることを指摘した。
通常のクローンでは `.git/config` と hook は伝わらないので、この条件に限る。
メンテナーは、監査の修正をすべて ADR にするよう求めた（2026-11-08）。

## 実装すること

- Aleph が走らせるすべての git に、リポジトリの設定よりも先に効く次の指定を付ける。付けるのは Rust の側の `git` のコマンドとし、webview からは外せない。
  - `-c core.fsmonitor=false`
  - `-c core.hooksPath=/dev/null`
- 書き手が Git のパネルから押す `commit`、`push`、`pull` も同じとする。hook を使いたい書き手は、ターミナルから git を使う。
- 状態を読むだけの `status`、`diff`、`log`、`show`、`rev-parse` には、`--no-optional-locks` も付ける。

## 実装しないこと

- 初めて開くワークスペースで自動コミットを尋ねること。監査の修正の案にあったが、hook と fsmonitor を止めれば、自動コミットで外のコマンドは走らない。
- `.git/config` のほかの項目（`core.pager`、`diff.external` など）の個別の無効化。Aleph は pager を使わず（出力を読むだけ）、`diff` には `--no-ext-diff` を付ける。
- `core.sshCommand` などの、`push` と `pull` が使う書き手の設定の無効化（リモートとのやりとりは書き手の設定に従う）。

## テスト設計

`cargo test` で、テストを先に書いて失敗させてから実装する。

- git の引数を組み立てる関数：すべてのサブコマンドの前に `-c core.fsmonitor=false -c core.hooksPath=/dev/null` が付くこと、読むだけのサブコマンドに `--no-optional-locks` が付くこと、`diff` に `--no-ext-diff` が付くこと。
- 一時のディレクトリのリポジトリで、`core.fsmonitor` に印のファイルを作るコマンドを設定し、`pre-commit` の hook にも同じものを置いて、Aleph の `status` と `commit` を走らせても印のファイルができないこと。

## トレードオフ

- Git のパネルからのコミットでは、リポジトリの hook（書式の検査など）が走らない。hook を当てにする書き手は、ターミナルからコミットする。

## 参考文献

- [docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md)
- git-config(1), core.fsmonitor, core.hooksPath：https://git-scm.com/docs/git-config
