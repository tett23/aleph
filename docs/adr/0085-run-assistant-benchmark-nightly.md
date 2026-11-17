# ADR 0085: アシスタントの計測と予算の確かめを、毎晩一度にする

Status: accepted

## 文脈

[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) は、アシスタントのローカルのモデルを、main への push と週に一度、標準の macOS のランナーで計測すると決めた。
予算 (`docs/budgets.md`) も、同じ計測の後に確かめる。

ところが、標準のランナーでの推論は遅く、計測には何時間もかかる。
main の最初の計測では、四つのモデルのうち測り終えたのは一つだけで、ほかの計測と予算の確かめは、ジョブの時間の上限で止まった。
この遅さで push ごとに計測すると、push のたびに macOS のランナーが何時間もふさがる。
さらに、このワークフローは前の実行が終わるまで次の実行を待たせる。
GitHub の文書によれば、待つ実行は一つのグループに一つだけで、新しい実行が来ると、待っていた古い実行は取り消される (このリポジトリでは確かめていない)。
そのため、push が続くと、途中の push は計測されない。

メンテナーは、予算の確かめには時間がかかりすぎるので、夜に流すよう求めた (2026-11-18)。
この ADR は、計測と予算の確かめを、push ごとではなく毎晩一度にすることを決める。

## 調査した事項

この節には、コマンドの出力で確かめたことだけを書く。
対象は、main のコミット [c86b90f](https://github.com/tett23/aleph/tree/c86b90ff564b36034a503dc5e1f3c4273608a636) の push で動いた実行 [44084622825](https://github.com/tett23/aleph/actions/runs/44084622825) である。

- ジョブの結果と時刻を、`gh run view 44084622825 --json jobs` で読んだ。時刻は UTC である。
  - `measure (qwen3.5-0.8b)` は `success` だった (12:36:03Z から 13:57:54Z)。
  - `measure (qwen3.5-2b)` と `measure (qwen3.5-4b)` は `cancelled` だった。どちらも 12:37 台に始まり、約 3 時間後の 15:38:22Z と 15:38:23Z に止まった。計測のジョブの時間の上限は 180 分だった。
  - `measure (qwen3-0.6b)` は、ほかより遅い 13:03:54Z に始まり、約 3 時間後の 16:04:18Z に `cancelled` で止まった。予算は、このモデルのコンテキスト 4096 で測る (`bench/assistant/sources.json` の `budget`)。
  - `budget-measure` は、12:36:04Z に始まり、約 2 時間後の 14:36:28Z に `cancelled` で止まった。このジョブの時間の上限は 120 分だった。
  - `analyze` は、計測の三つが止まったのに、`success` だった。`analyze` は、計測のジョブが取り消されても、飛ばされていなければ動く (ワークフローの `if: ${{ !cancelled() && … && needs.measure.result != 'skipped' }}`)。
- 0.8B のジョブの記録を、`gh api repos/tett23/aleph/actions/jobs/134043813077/logs` で読んだ。
  - コンテキスト 4096 の計測に約 26 分、8192 の計測に約 55 分かかった。
  - 課題 `style-line-pitch` は、資料を含む 3072 トークンを読むのに 14683 ms、61 トークンを書くのに 10421 ms かかった。
  - 25 の層のすべてが GPU に載ったと記録された。
- 予算の三つの指標は、`bench/assistant/run --metric <指標>` の三つのコマンドで測る。c86b90f のこのコマンドは、指標ごとに課題の一揃いをまるごと解いていた。
- [PR 129](https://github.com/tett23/aleph/pull/129) (main にマージした) は、次の三つを変えた。
  - 同じコミットの二度目からの `--metric` は、一度目の値を読む。
  - 計測のジョブを、モデルとコンテキストの組ごとに一つに分けた。
  - 計測と予算のジョブの時間の上限を 360 分にした。
- 予算の確かめを CI のどのイベントで動かすかは、各リポジトリの ADR で決める ([tett23/dotfiles ADR 0128](https://github.com/tett23/dotfiles/blob/c4afd3b2dfeaaed088398a75f98e0334cf2a4c39/docs/adr/0128-budget-check-in-ci.md))。

## 実装すること

### 動かす時

- アシスタントの計測のワークフローを、毎晩一度、`schedule` で動かす。cron は UTC で解釈されるので、`17 18 * * *` (日本時間の午前 3 時 17 分) とする。
- 手で動かすこと (`workflow_dispatch`) は残す。
- main への push と、週に一度の実行では動かさない。

### 計測を省く判定

- 毎晩の実行は、main の先頭のコミットが、最も新しい「計測を終えた実行」のコミットと同じなら、計測と予算の確かめを省く。
- 「計測を終えた実行」は、このワークフローの main の実行のうち、計測のジョブ (`measure`) のすべてと、`analyze`、`budget-measure`、`budget-report` が `success` で終わったものとする。どれかが止まったり失敗したりした実行は、計測を終えた実行に数えないので、次の夜にもう一度計測する。
- 手で動かした実行は、コミットが同じでも計測する。手で動かした main の実行も、上の条件を満たせば、計測を終えた実行に数える。
- 計測を省くかは、イベント、先頭のコミット、最も新しい計測を終えた実行のコミット (無ければ無し) を受ける純粋な関数で決める。
- 入力は、最初のジョブ (`changes` を置き換える) が `gh run list` と `gh run view` で集める。このジョブには、`actions: read` だけを与える。さかのぼるのは、このワークフローの main の実行の新しいもの 30 件までとし、その中に計測を終えた実行が無ければ、計測する。
- 計測のジョブ、`history`、`analyze`、予算のジョブは、この判定が「計測する」のときだけ動く。

### 変えないもの

- 回帰の判定は、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) のとおり、前の 4 回の計測の中央値と比べる。前の 4 回は、計測を終えた前の 4 回の実行とする。計測を省いた夜は数えない。「同じ回帰が 2 回続いたら Issue を立てる」の 2 回も、計測を終えた実行で数える。
- 予算の確かめは、同じ実行の中で、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) のとおりに行う。

### 文書

- 仕様書に、アシスタントの計測を CI で続ける説明を、この ADR に従って書く。今の仕様書には、この説明がまだ無い。

[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の「計測を CI で続ける」のうち、計測を動かす時 (main への push と週に一度、文書だけの変更では走らせないこと) は、この ADR が変える。
採択した後、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) のステータスの `part` に「計測を CI で続ける の、計測を動かす時」と書いて記録する。

## 実装しないこと

- push ごとの計測。
- 文書だけの変更かどうかで計測を省くこと ([ADR 0080](0080-skip-app-checks-for-docs-only-changes.md))。毎晩の計測は、main が前の計測から変わったかだけを見る。
- 手で動かすときに、測るコミットを入力で選ぶこと。
- 計測を速くすること。モデルの数、課題の数、計測の範囲を変えるときは、別の ADR で決める。
- 予算の値を変えること。既定のモデルと予算の値は、別の ADR で決める。

## 不変条件

- I1: このワークフローの `on` は、`schedule` と `workflow_dispatch` だけを持つ。
- I2: `schedule` の実行は、先頭のコミットが、最も新しい計測を終えた実行のコミットと同じときに限り、計測を省く。
- I3: `workflow_dispatch` の実行は、計測を省かない。
- I4: `schedule` の cron の行はちょうど一つで、分は一つの数、時は `18`、日、月、曜日は `*` である。
- I5: 計測のジョブ、`analyze`、`budget-measure`、`budget-report` のどれかが `success` でない実行は、計測を終えた実行に数えない。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| `schedule`、先頭 `a`、計測を終えた実行のコミット `a` | 省く | I2 |
| `schedule`、先頭 `b`、計測を終えた実行のコミット `a` | 計測する | I2 |
| `schedule`、計測を終えた実行が無い | 計測する | I2 |
| `workflow_dispatch`、先頭 `a`、計測を終えた実行のコミット `a` | 計測する | I3 |
| 計測のジョブが一つ `cancelled`、`analyze` は `success` | 計測を終えた実行に数えない | I5 |
| 計測のジョブと `analyze` は `success`、`budget-measure` が `cancelled` | 計測を終えた実行に数えない | I5 |
| 四つの種類のジョブがすべて `success` | 計測を終えた実行に数える | I5 |
| `on` が `schedule` と `workflow_dispatch` だけ | テストが通る | I1 |
| `on` に `push` がある | テストが落ちる | I1 |
| `on` に `pull_request` がある | テストが落ちる | I1 |
| cron が `17 18 * * *` の一行 | テストが通る | I4 |
| cron が `17 18 * * 1` | テストが落ちる | I4 |
| cron が `17 */2 * * *` | テストが落ちる | I4 |
| cron の行が二つ | テストが落ちる | I4 |

## 受けいれ条件

- A1: 前の夜の実行より後に main が変わったとき、次の夜の実行で、計測のジョブ、`analyze`、`budget-measure`、`budget-report` が時間の上限で止まらずに `success` で終わる。
- A2: 前の夜の実行が計測を終え、その後に main が変わらなかったとき、次の夜の実行は、計測のジョブと予算のジョブを `skipped` にする。

## テスト設計

- I2、I3、I5 は、計測を省くかを決める関数と、実行のジョブの結果から計測を終えたかを決める関数のテストで、境界の表の行を確かめる。名前は `ADR 0085 I2: …` のようにする。
- I1 と I4 は、ワークフローのファイルを行で読むテストで確かめる。YAML の読み込みのための依存は足さない。
- A1 と A2 は、実装をマージした後の夜の実行で、次の手順で確かめる。
  1. 実装のマージの後の最初の夜の実行を、`gh run list --workflow assistant-bench.yml --event schedule --limit 1` で見る。
  2. `gh run view <ID> --json jobs` で、計測のジョブ、`analyze`、`budget-measure`、`budget-report` が `success` であることを確かめる (A1)。
  3. A1 を確かめた夜の後に main を変えなかった次の夜の実行で、計測のジョブ、`budget-measure`、`budget-report` が `skipped` であることを確かめる (A2)。

## トレードオフ

毎晩一度にすると、main で入った回帰や予算の違反に気づくのが、最大で一日遅れる。
しかし、この計測はプルリクエストを止めない ([ADR 0081](0081-assistant-with-local-llm-and-connectors.md)) ので、push ごとに測っても、回帰を含む変更はすでに main に入っている。
一日の遅れより、push のたびに macOS のランナーが何時間もふさがり、途中の push の計測が取り消されることを避けるほうを選ぶ。

一日に何度 main を変えても、計測は一度だけである。
そのため、回帰がどのコミットで入ったかは、前の計測からその夜までのコミットまでしか絞れない。
絞るときは、手元で `bench/assistant/run` を動かす。

GitHub の文書によれば、公開のリポジトリで 60 日のあいだ動きが無いと、`schedule` のワークフローは止まる (このリポジトリでは確かめていない)。
main が長く変わらなければ測る必要も無いので、止まったときは、次に main を変えたときに手で動かすか、ワークフローを有効に戻す。

## 参考文献

- [ADR 0080](0080-skip-app-checks-for-docs-only-changes.md)
- [ADR 0081](0081-assistant-with-local-llm-and-connectors.md)
- [tett23/dotfiles ADR 0128: CI で予算を確かめる](https://github.com/tett23/dotfiles/blob/c4afd3b2dfeaaed088398a75f98e0334cf2a4c39/docs/adr/0128-budget-check-in-ci.md)
- GitHub の文書 "Workflow syntax for GitHub Actions" (`on.schedule`、`concurrency`、`jobs.<job_id>.timeout-minutes`)
- GitHub の文書 "Disabling and enabling a workflow" (60 日で止まる `schedule`)
