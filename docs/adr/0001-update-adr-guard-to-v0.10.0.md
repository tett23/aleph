# ADR 0001: adr-guard を v0.10.0 に上げる

ステータス: 採択

## 文脈

このリポジトリは、リポジトリを用意したコミット（a867510）で adr-guard を導入した。
CI の `adr` ジョブの action は `tett23/adr-guard@v0.9.1` で、README.md と CONTRIBUTING.md のインストール手順のタグも v0.9.1 である。
この導入を決めた ADR は無い。

その後、tett23/adr-guard は v0.10.0 に更新された（[リリース v0.10.0](https://github.com/tett23/adr-guard/releases/tag/v0.10.0)）。
v0.9.1 との差は次のとおりである。

- action は、v0.9.0 から既定で `adr-guard check-numbers` を実行する。同じディレクトリで番号が重複した ADR があれば CI が失敗する（[tett23/adr-guard ADR 0018: 重複したADRの番号の修復](https://github.com/tett23/adr-guard/blob/main/docs/adr/0018-repair-duplicate-adr-numbers.md)）。
  v0.9.1 の action もこの検査を実行しているが、手元の文書には書かれていない。
- `ADR NNNN` の直前の語を修飾子として読む。`/` を含む語はディレクトリ、`-` を含む語はモジュール（`docs/<モジュール>/adr/`）、それ以外の語はそのモジュールが存在するときだけ修飾子になる。
  `links` と pre-commit hook は、対象の無い修飾子付きの参照、リンク先が修飾子の ADR と異なるリンク、リンクの外に出た修飾子を報告する（[tett23/adr-guard ADR 0019: モジュールで修飾したADRの参照](https://github.com/tett23/adr-guard/blob/main/docs/adr/0019-module-qualified-adr-references.md)）。
- シンボリックリンクの `.md` を検査しない（[tett23/adr-guard ADR 0020: シンボリックリンクの文書を飛ばす](https://github.com/tett23/adr-guard/blob/main/docs/adr/0020-skip-symlinked-documents.md)）。

このリポジトリにはまだ ADR が無く、モジュールごとの ADR のディレクトリも無い。
手元の adr-guard はすでに v0.10.0 に更新されている。

## 実装すること

- `.github/workflows/ci.yml` の `adr` ジョブの action を `uses: tett23/adr-guard@v0.10.0` にする。入力 `base`、`head`、`allow-status: true`、`allow-links: true` はそのままとし、`check-numbers` は既定（実行する）のままとする。
- `.githooks/pre-commit` は `exec adr-guard pre-commit --allow-status --allow-links` のままとする。
- README.md と README.ja.md の開発の節、CONTRIBUTING.md と CONTRIBUTING.ja.md の開発環境の節にある adr-guard の版とインストール手順のタグを v0.10.0 にする。
- CONTRIBUTING.md と CONTRIBUTING.ja.md の ADR の節に、次を書く。
  - CI が ADR の番号の重複を検査すること。
  - ほかのリポジトリの ADR を参照するときは、`tett23/adr-guard ADR 0019` のような修飾子ごと GitHub の URL へのリンクのテキストに入れること。
- CLAUDE.md の docs/adr/ の項に、番号の重複が CI で検査されることと、ほかのリポジトリの ADR への参照の書き方を書く。
- `adr-guard links --fix --include-committed` を実行し、リンクの無い ADR の参照があれば直す。

## 実装しないこと

- action の指定方法の変更。版のタグで指定するままとする。
- Claude Code の hook の変更。全体の設定にあるものを使う。
- モジュールごとの ADR のディレクトリの導入。
- `adr-guard renumber` と `--allow-renumber` の導入。番号の重複が起きたときに一時的に使う。
- 手元の adr-guard の更新の自動化。

## テスト設計

- 変更のプルリクエストの CI で、`adr` ジョブが v0.10.0 の action で実行され、成功することを確かめる。
  - ジョブのログで、`check-range --allow-status --allow-links`、`links`、`check-status`、`check-numbers` が実行されていることを確かめる。
- 手元の adr-guard（v0.10.0）で、次を確かめる。
  - `adr-guard links`、`adr-guard check-status`、`adr-guard check-numbers` が終了コード0で終わる。
  - 各コミットで pre-commit hook と commit-msg hook が許可する。
  - `adr-guard check-range origin/main HEAD --allow-status --allow-links` が終了コード0で終わる。
- `.github/workflows/ci.yml` が YAML として読めることを確かめる。
- `sh scripts/test-check-translations.sh` と `sh scripts/check-translations.sh range origin/main HEAD` が終了コード0で終わる。

## トレードオフ

- 番号の重複で CI が失敗する。別々のブランチで同じ番号の ADR を作ると、あとからマージする側が番号を振りなおす手間が増える。その代わり、同じ番号の ADR が main に並ぶことを防げる。
- 修飾子の規則により、ほかのリポジトリの ADR を `tett23/adr-guard ADR 0019` のように裸で書くと検査が失敗する。リンクのテキストに入れる手間が増える代わりに、参照先の取り違えを防げる。
- 手元の adr-guard が v0.10.0 より古いと、pre-commit hook と CI で結果が食い違うことがある。インストール手順のタグを上げて補う。

## 参考文献

- [tett23/adr-guard リリース v0.10.0](https://github.com/tett23/adr-guard/releases/tag/v0.10.0)
- [tett23/adr-guard リリース v0.9.1](https://github.com/tett23/adr-guard/releases/tag/v0.9.1)
- [tett23/adr-guard リリース v0.9.0](https://github.com/tett23/adr-guard/releases/tag/v0.9.0)
- [tett23/adr-guard ADR 0018: 重複したADRの番号の修復](https://github.com/tett23/adr-guard/blob/main/docs/adr/0018-repair-duplicate-adr-numbers.md)
- [tett23/adr-guard ADR 0019: モジュールで修飾したADRの参照](https://github.com/tett23/adr-guard/blob/main/docs/adr/0019-module-qualified-adr-references.md)
- [tett23/adr-guard ADR 0020: シンボリックリンクの文書を飛ばす](https://github.com/tett23/adr-guard/blob/main/docs/adr/0020-skip-symlinked-documents.md)
