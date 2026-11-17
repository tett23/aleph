# ADR 0080: 文書だけの変更では CI のビルドとテストを省く

Status: proposed

## 文脈

本人の全リポジトリ共通の決まり (dotfiles の CLAUDE.md の「GitHub actions」と「docs/ の構成」、dotfiles ADR 0129) は、CI について次のことを定めている。

- 文書だけの変更では、ビルドとテストを省く。README と CONTRIBUTING (英語版と日本語版) も、文書に含む。
- ビルドやテストの入力になるファイル、コード、依存、設定、CI のワークフローを変えたときは、省かない。
- 標準の構成の `docs/` のパスの中だけの変更は、省いてよい。ほかの `docs/` のファイルは、ビルドやテストの入力になるかで決める。
- 文書だけの変更でも、文書の検査と、ADR と記録の変更不可の検査は省かない。
- Node は最新の LTS を使い、actions は Node 24 以降で動く最新のメジャー版を使う。

このリポジトリの CI は、このうち最初の決まりを満たしていない。
ADR だけを足すプルリクエストでも、macOS でアプリのビルドとテストが走る。
この ADR は、どの変更を文書だけの変更とみなし、CI のどのジョブを省くかを決める。

## 調査した事項

この節には、コマンドとソースで確かめたことだけを書く。
調べたコミットは [0966994](https://github.com/tett23/aleph/tree/0966994371f0b672f1be72231b7ce372859dbceb) である。

CI のワークフローは、`ci.yml` と `audit.yml` の二つである。
`ci.yml` は、main への push とプルリクエストで、次の三つのジョブを走らせる ([ci.yml](https://github.com/tett23/aleph/blob/0966994371f0b672f1be72231b7ce372859dbceb/.github/workflows/ci.yml))。

| ジョブ | 中身 | 決まりでの扱い |
| --- | --- | --- |
| `adr` | adr-guard で、コミット済みの ADR と記録の変更を拒む | 省かない |
| `translations` | README と CONTRIBUTING の日本語版が英語版と同じコミットで変わったかを検査する | 文書の検査なので省かない |
| `app` | `npm ci`、型検査、`node --test`、Vite のビルド、rustfmt、clippy、`cargo test` | 文書だけの変更では省く |

どのジョブにも、変更したファイルで走るかを決める条件は無い。
そのため、文書だけの変更でも `app` が走る。
PR 92 の CI では、`app` のジョブの TypeScript のテストだけで 11 秒を超えるテストがあった。

`audit.yml` は、アプリが同梱する依存の既知の脆弱性を、プルリクエスト、main への push、週に一度に検査する ([ADR 0049](0049-dependency-audit-in-ci.md))。
これは依存の検査で、ビルドとテストではない。

使っている actions と Node は、決まりを満たしている。

- `actions/checkout` v7.0.1、`actions/setup-node` v7.1.0、`actions/cache` v6.1.0 は、それぞれの最新のリリースで (`gh api repos/<repo>/releases/latest`)、`action.yml` の `runs.using` は `node24` である。
- コミットのハッシュは、それぞれのタグのコミットと一致する。
- Node は `lts/*` である。
- `tett23/adr-guard` は v0.13.1 で、最新のリリースと一致する。

ビルドとテストの入力は、`docs/` と README、CONTRIBUTING を読まない。
`app/`、`scripts/`、`src-tauri/src/` で `docs/`、`README`、`CONTRIBUTING`、`specifications` を探した結果は、ADR を指すコメントだけで、ファイルを読む箇所は無かった。
Rust の `include_str!` と `include_bytes!` も、`docs/` と README を取りこまない。

このリポジトリの `docs/` にあるのは、`docs/adr/`、`docs/audit/`、`docs/roadmap.md`、`docs/specifications.md` である。
記録は、単数形の `docs/audit/` に置いている。
予算の一覧 (`docs/budgets.md`) と、予算の確かめ (`bin/budget-check`) は無い。

main の ruleset は無効 (`enforcement: disabled`) で、必須のステータスチェックを持たない。
そのため、`app` を省いても、マージを止める設定は無い。

## 実装すること

この節は、[ADR 0003](0003-application-architecture.md) の「CI」の節の `app` のジョブに、走る条件を補う。

`ci.yml` に、変更したファイルを調べるジョブ `changes` を足す。
`changes` は、プルリクエストでは基点と先端のコミットのあいだ、main への push では push の前と後のコミットのあいだの、変更したファイルの名前を `git diff --name-only` で並べる。
変更したファイルがすべて次の文書のパスに入るとき、`changes` は「文書だけ」と出力する。

- `README.md`、`README.ja.md`、`CONTRIBUTING.md`、`CONTRIBUTING.ja.md`
- `docs/adr/` の下
- `docs/specifications.md`、`docs/roadmap.md`、`docs/glossary.md`
- `docs/research/` の下
- `docs/audits/`、`docs/audit/`、`docs/benchmarks/`、`docs/benchmark/` の下

表のほかの `docs/` のファイルと、上に無いファイルは、文書とみなさない。
`docs/budgets.md` は、予算の確かめが無いあいだは文書とみなさない。
予算の確かめを足すときは、別の ADR で扱いを決める。

`app` は `changes` を待ち、「文書だけ」のときは走らない。
次のときは、「文書だけ」とみなさず、`app` を走らせる。

- 変更したファイルの一覧を作れない (push の前のコミットが無い、`git diff` が失敗した、など)。
- 変更したファイルが一つも無い。
- `.github/workflows/` の下のファイルを変えた。

`adr` と `translations` は、今までどおり、どの変更でも走る。
`audit.yml` は変えない。

仕様書の CI の記述 (`app` のジョブが何を実行するか) に、文書だけの変更では `app` を省くことを書き足す。
README の「The checks CI runs」の節に、同じことを書き足し、README.ja.md も同じコミットで訳し直す。

## 実装しないこと

- `audit.yml` を文書だけの変更で省くこと。
- `paths-ignore` などで、ワークフロー全体を省くこと。`adr` と `translations` まで省かれるからである。
- 予算の確かめを足すこと。
- 記録を単数形の `docs/audit/` から複数形の `docs/audits/` に移すこと。コミット済みの記録は移せない。新しい記録を複数形に書くかは、別に決める。

## 不変条件

- I1: 変更したファイルの集合が空でなく、すべてが文書のパスに入るとき、そのときに限り、`changes` は「文書だけ」と出力する。
- I2: `changes` が「文書だけ」と出力しないとき、`app` は走る。
- I3: `adr` と `translations` は、変更したファイルによらず走る。
- I4: 変更したファイルの一覧を作れないとき、`changes` は「文書だけ」と出力しない。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| `docs/adr/0080-….md` だけ | 文書だけ、`app` は走らない | I1, I3 |
| `README.md` と `README.ja.md` | 文書だけ | I1 |
| `docs/specifications.md` と `app/main.ts` | 文書だけではない、`app` が走る | I1, I2 |
| `docs/budgets.md` だけ | 文書だけではない | I1, I2 |
| `docs/notes.md` (表に無い `docs/` のファイル) だけ | 文書だけではない | I1, I2 |
| `.github/workflows/ci.yml` だけ | 文書だけではない | I1, I2 |
| 変更したファイルが無い | 文書だけではない | I1, I2 |
| push の前のコミットが `0000000…` | 文書だけではない | I4 |
| `docs/audit/2026-11-08-security.md` だけ | 文書だけ (コミット済みの記録の変更は adr-guard が拒む) | I1, I3 |
| `docs/adrs/x.md` (`docs/adr/` に似た別の名前) | 文書だけではない | I1 |
| `README.md.bak` | 文書だけではない | I1 |

## 受けいれ条件

- A1: ADR だけを変えるプルリクエストで、`adr` と `translations` が走り、`app` が skipped になる。
- A2: コードを変えるプルリクエストで、`app` が走る。
- A3: 文書だけを変えたプルリクエストを main にマージしたときの push でも、`app` が skipped になる。

## テスト設計

変更したファイルの一覧から「文書だけ」かを決める部分を、`scripts/` のシェルスクリプトにする。
スクリプトは、ファイルの名前を一行ずつ標準入力から読み、文書だけなら `true`、そうでなければ `false` を出す。
ほかの検査のスクリプトと同じく、macOS の BSD の道具でも動くように書く。

- 境界の表の各行を、そのスクリプトのテスト (`scripts/test-docs-only.sh` のような名前) で確かめる。各テストの名前に `ADR 0080 I1` などの番号を入れる。
- テストのスクリプトは、`translations` と同じく、ubuntu と macOS の両方で走らせる。このテストは文書の検査と同じ扱いにし、文書だけの変更でも走らせる。
- I2、I3、I4 のうちワークフローの条件にかかわる部分は、自動のテストにできないので、A1 から A3 で手で確かめる。

## トレードオフ

文書のパスを並べる (許すものを並べる) と、新しい種類の文書を足したときに、並べ直すまで `app` が走る。
逆に、コードのパスを並べる (省かないものを並べる) と、新しい種類の入力を足したときに、並べ忘れると `app` が省かれ、壊れた変更がマージされうる。
省きすぎより、走らせすぎの方が害が小さいので、文書のパスを並べる。

ジョブを `if` で省くと、GitHub はそのジョブを skipped と表示する。
後で必須のステータスチェックを設定するときは、skipped を通ったとみなすかを確かめる必要がある。
今は必須のチェックが無いので、この ADR では扱わない。

## 参考文献

- [ADR 0003](0003-application-architecture.md)
- [ADR 0049](0049-dependency-audit-in-ci.md)
- [ADR 0076](0076-update-adr-guard-to-v0.13.1.md)
- dotfiles の CLAUDE.md の「GitHub actions」と「docs/ の構成」(dotfiles ADR 0129)
- GitHub Docs, Using conditions to control job execution. https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/using-conditions-to-control-job-execution
