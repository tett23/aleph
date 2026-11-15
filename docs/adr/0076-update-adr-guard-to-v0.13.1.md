# ADR 0076: adr-guard を v0.13.1 に上げ、ADR のステータスの行を新形式に移す

Status: accepted

## 文脈

このリポジトリは、コミット済みの ADR の変更を [adr-guard](https://github.com/tett23/adr-guard) で拒否している。
[ADR 0001](0001-update-adr-guard-to-v0.10.0.md) で、CI の `adr` ジョブの action を `tett23/adr-guard@v0.10.0` にし、README.md、README.ja.md、CONTRIBUTING.md、CONTRIBUTING.ja.md のインストール手順のタグを v0.10.0 にした。
pre-commit hook（`.githooks/pre-commit`）は `adr-guard pre-commit --allow-status --allow-links` を実行し、手元に入っている adr-guard の版で動く。

その後、tett23/adr-guard は v0.11.0、v0.12.0、v0.13.0、v0.13.1 に更新された。
v0.10.0 との差は次のとおりである。

- v0.11.0：Codex の PreToolUse hook として動くサブコマンド `adr-guard codex-hook` が加わった（[tett23/adr-guard ADR 0021](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0021-codex-hook.md)）。
- v0.12.0：ステータスの行の新形式と、状態遷移の検査が加わった（[tett23/adr-guard ADR 0022](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0022-status-transitions.md)）。
  - 新形式は `Status: <トークン>` である。トークンは `proposed`、`accepted`、`accepted-pending`、`rejected`、`discarded`、`deprecated` のいずれか、または `superseded [<変更の JSON 配列>]` である。変更は `{"part":<部分名か null>,"by":[<リポジトリのルートからのパス>]}` と書く。
  - 追加した ADR と、ステータスの行を書き換えた ADR には、新形式が要る。新しい ADR は、最初のコミットで `Status: proposed` でなければならない。
  - pre-commit hook と `check-range` は、HEAD からの状態遷移を検査する。遷移の違反は `--allow-status`、環境変数 `ADR_GUARD_ALLOW`、コミットのトレーラーでも免除されない。
  - 旧形式（`ステータス: 採択` など）の行は、書き換えない限りそのまま読める。
  - 旧形式を新形式に書き換える移行スクリプト `scripts/migrate-adr-status` が adr-guard のソースにある。リリースのアーカイブには入らない。
  - 修正先を辿るサブコマンド `adr-guard trace` が加わった（[tett23/adr-guard ADR 0023](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0023-trace-amendments.md)）。
- v0.13.0：
  - 移行スクリプトに `--dry-run` が加わり、移行できない ADR を全件数えるようになった（[tett23/adr-guard ADR 0024](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0024-migration-dry-run-and-error-count.md)）。
  - 状態 `superseded-pending`（実装を待つ ADR が修正を受けた状態）、変更の `kind` と `note`、`https://` の修正先、`trace --list` の6列が加わった（[tett23/adr-guard ADR 0025](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0025-extend-canonical-status-amendments.md)）。
  - 旧形式の参照の読み方が広がった（[tett23/adr-guard ADR 0026](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0026-read-more-legacy-references.md)、[tett23/adr-guard ADR 0027](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0027-read-legacy-replaced-status.md)）。
- v0.13.1：移行スクリプトが旧形式の行から部分名を作るときに、修飾子（`ADR NNNN` の直前の語）、先頭の「。」、末尾の「→」を残さなくなった。部分名を規則で決められない行は、「部分名を決められません」と報告し、書き換えない（[tett23/adr-guard ADR 0028](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0028-fix-legacy-part-names.md)）。

手元の adr-guard はすでに v0.13.1 に更新されている。
CI だけが v0.10.0 のままで、手元と CI で版が食い違う。

このリポジトリの ADR は、すべて旧形式のステータスの行を持つ。
CLAUDE.md と CONTRIBUTING.md は、ADR のステータスの行が `ステータス:` で始まると書いている。
CONTRIBUTING.md の変更の進め方は、レビューの前に ADR をコミットしないと書くが、最初のコミットのステータスは書いていない。

## 調査した事項

次は、この ADR の worktree（origin/main から作ったブランチ `adr-guard-v0.13.0`）で実行して確かめた。

- `adr-guard -V` は `adr-guard 0.13.1` を出力した。
- `.github/workflows/ci.yml` の26行目は `- uses: tett23/adr-guard@v0.10.0` で、入力は `base`、`head`、`allow-status: true`、`allow-links: true` の4つである。
- `.githooks/pre-commit` は `exec adr-guard pre-commit --allow-status --allow-links` を実行する。
- adr-guard の v0.13.1 のタグはコミット `ab55769152ed0f8a3465ee3435a2df43ab9d067f` を指す。v0.13.1 の `action.yml` の入力は `base`、`head`、`version`、`allow-status`、`allow-links`、`links`、`check-status`、`check-numbers`、`allow-renumber` である。
- adr-guard の版を書いた文書は、README.md の77行目と80行目、README.ja.md の77行目と80行目、CONTRIBUTING.md の10行目と14行目、CONTRIBUTING.ja.md の10行目と14行目である。
- ステータスの行の書き方を書いた文書は、CLAUDE.md の14行目（`ステータス:`）、CONTRIBUTING.md と CONTRIBUTING.ja.md の34行目（`ステータス:`）と37行目（破棄したときの `破棄`）である。
- `docs/specifications.md` の「状態」の表の18行目に、[ADR 0001](0001-update-adr-guard-to-v0.10.0.md) の行がある。
- この ADR を足す前に、`adr-guard links`、`adr-guard check-status`、`adr-guard check-numbers` は、いずれも終了コード0で終わった。
- worktree のルートで、adr-guard の v0.13.1 のソースの `scripts/migrate-adr-status`（ビルドしたもの）を `--dry-run` で実行した。この ADR を足す前は、終了コード0で、標準エラーに `移行できる: 72件、移行済み: 0件、移行できない: 0件` を出力した。72件の内訳は `Status: accepted` が64件、`Status: accepted-pending` が1件（[ADR 0075](0075-file-character-count.md)）、`Status: superseded [...]` が7件である。
- v0.13.1 の移行スクリプトの `--dry-run` が出す新形式のステータスの行は、v0.13.0 の移行スクリプトの出力とすべて同じだった（`diff` で差が無かった）。
- worktree を `$TMPDIR` に clone し、実装の手順を試した。この ADR を `Status: proposed` で足したインデックスで、`adr-guard pre-commit --allow-status --allow-links` は終了コード0で終わった。それをコミットし、ステータスを `Status: accepted-pending` にしたインデックスでも、終了コード0で終わった。
- 続けて、移行スクリプトの `--dry-run` は `移行できる: 72件、移行済み: 1件、移行できない: 0件`（移行済みの1件はこの ADR）を出力した。`--write` で書き換え、[ADR 0001](0001-update-adr-guard-to-v0.10.0.md) のステータスの行を「実装すること」の行にしたインデックスで、pre-commit は終了コード0で終わった。
- そのコミットの後、`--dry-run` は `移行できる: 0件、移行済み: 73件、移行できない: 0件` を出力した。`adr-guard check-status`、`adr-guard links`、`adr-guard check-numbers`、`adr-guard check-range origin/main HEAD --allow-status --allow-links` は、いずれも終了コード0で終わった。`^ステータス:` で始まる行は残らなかった。`adr-guard unimplemented` は [ADR 0075](0075-file-character-count.md) とこの ADR を出力した。
- 旧形式の ADR を足した main のコミット 124a06d（[ADR 0075](0075-file-character-count.md) を `ステータス: 採択（未実装）` で足したもの）で `adr-guard check-range 124a06d^ 124a06d --allow-status --allow-links` を実行すると、「新形式のステータス行は `Status: ` で始めてください」 を出して終了コード1で終わった。[ADR 0074](0074-reorder-workspace-projects.md) のステータスを `採択（未実装）` から `採択` に書き換えたコミット fba11b6 でも、同じ診断を出した。

## 実装すること

- `.github/workflows/ci.yml` の `adr` ジョブの action を `uses: tett23/adr-guard@v0.13.1` にする。入力 `base`、`head`、`allow-status: true`、`allow-links: true` はそのままとし、`check-numbers` は既定（実行する）のままとする。
- `.githooks/pre-commit` は `exec adr-guard pre-commit --allow-status --allow-links` のままとする。
- worktree のルートで、adr-guard の v0.13.1 のソースの `scripts/migrate-adr-status` を `--dry-run` で実行し、移行できない ADR が0件であることを確かめてから、`--write` ですべての ADR のステータスの行を新形式に書き換える。
- [ADR 0001](0001-update-adr-guard-to-v0.10.0.md) のステータスの行を `Status: superseded [{"part":"adr-guard の版","by":["docs/adr/0076-update-adr-guard-to-v0.13.1.md"]}]` にする。
- README.md と README.ja.md の開発の節、CONTRIBUTING.md と CONTRIBUTING.ja.md の開発環境の節にある adr-guard の版とインストール手順のタグを v0.13.1 にする。
- CONTRIBUTING.md と CONTRIBUTING.ja.md を、次のように直す。
  - 変更の進め方：レビューで認められた ADR を `Status: proposed` でコミットし、続くコミットでステータスを `accepted-pending`（実装の要る ADR）か `accepted`（実装の要らない ADR）にする。実装のプルリクエストで `accepted-pending` を `accepted` にする。
  - ADR の節：ステータスの行は `Status:` で始まる。値は `proposed`、`accepted-pending`、`accepted`、`superseded [...]`、`superseded-pending [...]`、`rejected`、`discarded` のいずれかとする。決定を変えられた ADR は `superseded`（実装を待つ ADR なら `superseded-pending`）にし、変わった部分と変えた ADR のパスを JSON で書く。ADR を破棄するときは、ステータスを `discarded` にする。pre-commit hook と CI は状態遷移を検査する。
- CLAUDE.md の docs/adr/ の項の、ステータスの行の書き方を `Status:` にする。
- `docs/specifications.md` の「状態」の表にこの ADR の行を足す。
- `adr-guard links --fix` を実行し、リンクの無い ADR の参照があれば直す。

## 実装しないこと

- action の指定方法の変更。版のタグで指定するままとする。
- Claude Code の hook の変更。全体の設定にあるものを使う。
- Codex の hook（v0.11.0 の `adr-guard codex-hook`）の導入。
- 変更の `kind`（`supplement`、`note`）と `note`、`https://` の修正先の利用。
- 移行スクリプトをこのリポジトリに置くこと。移行は一度だけ行い、adr-guard の v0.13.1 のソースから実行する。
- 手元の adr-guard の更新の自動化。

## 不変条件

なし。
この ADR は、CI の版、ADR のステータスの行の書き方、変更の進め方の手順だけを決め、アプリの振る舞いを変えない。

## テスト設計

- 変更のプルリクエストの CI で、`adr` ジョブが v0.13.1 の action で実行され、成功することを確かめる。
  - ジョブのログで、`check-range --allow-status --allow-links`、`links`、`check-status`、`check-numbers` が実行されていることを確かめる。
- 手元の adr-guard（v0.13.1）で、次を確かめる。
  - 移行スクリプトの `--write` の後に `--dry-run` を実行すると、`移行できる: 0件` で、移行できない ADR が0件である。
  - `rg -n '^ステータス:' docs/adr` が何も出力しない。
  - `adr-guard links`、`adr-guard check-status`、`adr-guard check-numbers` が終了コード0で終わる。
  - 各コミットで pre-commit hook と commit-msg hook が許可する。
  - `adr-guard check-range origin/main HEAD --allow-status --allow-links` が終了コード0で終わる。
  - `adr-guard unimplemented` が [ADR 0075](0075-file-character-count.md) を出力する。
- `.github/workflows/ci.yml` が YAML として読めることを確かめる。
- `sh scripts/test-check-translations.sh` と `sh scripts/check-translations.sh range origin/main HEAD` が終了コード0で終わることを確かめる。

## トレードオフ

- 手元と CI の版がそろい、新しい ADR を新形式で書ける。その代わり、ADR を足すたびに `proposed` のコミットと採択のコミットの二つが要る。
- 状態遷移の違反は `--allow-status` でも免除されないので、誤ったステータスの書き換えを手元と CI で止められる。その代わり、誤って入れたステータスを戻すには、許された遷移を辿る必要がある。
- CI を上げた後は、旧形式のステータスの行で ADR を足すコミットと、旧形式の行を旧形式のまま書き換えるコミット（`採択（未実装）` から `採択` など）が、CI で失敗する。移行より前に分けたブランチにそのようなコミットがあれば、マージの前にステータスの行を新形式に直す。
- 72件の ADR のステータスの行を一度に書き換えるので、差分は大きい。書き換えはステータスの行だけで、`--allow-status` の範囲に収まる。
- 手元の adr-guard が v0.13.1 より古いと、pre-commit hook と CI で結果が食い違うことがある。インストール手順のタグを上げて補う。

## 参考文献

- [tett23/adr-guard リリース v0.13.1](https://github.com/tett23/adr-guard/releases/tag/v0.13.1)
- [tett23/adr-guard リリース v0.13.0](https://github.com/tett23/adr-guard/releases/tag/v0.13.0)
- [tett23/adr-guard リリース v0.12.0](https://github.com/tett23/adr-guard/releases/tag/v0.12.0)
- [tett23/adr-guard リリース v0.11.0](https://github.com/tett23/adr-guard/releases/tag/v0.11.0)
- [tett23/adr-guard ADR 0021: Codex の PreToolUse hook で、コミット済みのADRと記録の編集を拒否する](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0021-codex-hook.md)
- [tett23/adr-guard ADR 0022: 状態と遷移を別々の代数的データ型で表す](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0022-status-transitions.md)
- [tett23/adr-guard ADR 0023: trace で元の決定から修正ADRをたどる](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0023-trace-amendments.md)
- [tett23/adr-guard ADR 0024: 移行スクリプトに --dry-run を設け、失敗を最後まで数える](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0024-migration-dry-run-and-error-count.md)
- [tett23/adr-guard ADR 0025: 新形式のステータス行に、実装待ちの修正、補足、注記、別のリポジトリの修正先を加える](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0025-extend-canonical-status-amendments.md)
- [tett23/adr-guard ADR 0026: 旧形式のステータス行の修正先を、リンク先と裸の番号からも読む](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0026-read-more-legacy-references.md)
- [tett23/adr-guard ADR 0027: 旧形式の `置換（…）` を、修正を受けた状態として読む](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0027-read-legacy-replaced-status.md)
- [tett23/adr-guard ADR 0028: 旧形式の部分名から修飾子と区切りの記号を除き、決められない部分名を移行しない](https://github.com/tett23/adr-guard/blob/v0.13.1/docs/adr/0028-fix-legacy-part-names.md)
- [tett23/adr-guard README（v0.13.1）](https://github.com/tett23/adr-guard/blob/v0.13.1/README.md)
