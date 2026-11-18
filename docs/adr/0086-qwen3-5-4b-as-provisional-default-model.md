# ADR 0086: Qwen3.5-4B を、アシスタントの仮の既定のモデルにする

Status: accepted

## 文脈

[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) は、アシスタントの既定のモデルを、四つの候補の計測から選ぶと決めた。
選び方の決まりは、次の三つを満たすもののうち、最大のメモリが最も小さいものを選ぶことである。

- 欠かせない課題に、すべて正解する。
- 全体の正解の割合が 70% 以上で、どの種類の正解の割合も 50% 以上である。
- 予算の三つ (起動からの最初の答えの p95、起動した後の答えの p95、最大の RSS) を満たす。

[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) は、満たすものが無いときは、実装を止め、選び方を変える ADR を書くとも決めた。
計測の結果、四つの候補のどれも、この決まりを満たさなかった (下の「調査した事項」)。
そのため、既定のモデルを同梱する作業と、それに続くアシスタントの実装が止まっている。

メンテナーは、Qwen3.5-4B を仮の既定のモデルにすると決めた (2026-11-18)。
同じ日に、次の三つも決めた。

- 選び方の決まりは残し、Qwen3.5-4B は、決まりを満たすモデルが出るまでの例外とする。
- 時間の予算は、標準の macOS のランナーで測った値をもとに決める。
- コンテキストの長さは 4,096 とし、プロンプトは、対象の種類の作業例とコマンドの作業例だけを渡す形 (以下、**種類の作業例**) にする。

この ADR は、この三つと、それに合わせた予算の値を決める。

## 調査した事項

この節には、コマンドの出力と記録で確かめたことだけを書く。

### ランナーでの Qwen3.5-4B

main のコミット [c161cd1](https://github.com/tett23/aleph/tree/c161cd12199a76030f2250940b47b1afdf7aee61) の push で動いた実行 [44122927815](https://github.com/tett23/aleph/actions/runs/44122927815) の成果物 `assistant-bench-qwen3.5-4b-4096` と `assistant-bench-qwen3.5-4b-8192` を、`gh run download` で取って読んだ。
どちらも、起動からの答えを 5 回測った記録 (`coldStarts: 5`) で、プロンプトは作業例を足す前の [ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の形である。

| コンテキスト | 全体の正解 | 落ちた欠かせない課題 | 最初の答えの p95 (ms) | 答えの中央値 (ms) | 答えの p95 (ms) | 最大の RSS (MB) |
| --- | --- | --- | --- | --- | --- | --- |
| 4096 | 68.9% | gm-strong、md-bold-close、command-convert-md | 294940 | 122271 | 153054 | 4327 |
| 8192 | 63.9% | gm-strong、md-bold-close、command-build、command-convert-md | 416605 | 283326 | 317507 | 4390 |

- 二つの記録の `selection.pick` は、どちらも `null` (決まりを満たすものが無い) だった。
- 同じ実行のほかの候補の六つの記録 (Qwen3-0.6B の 8,192、Qwen3.5-0.8B と Qwen3.5-2B の二つずつ) も、`selection.pick` は `null` だった。Qwen3-0.6B の 4,096 の計測のジョブは、1 リクエストの時間切れ (10 分) で `failure` になり、記録が無い。時間切れは、[PR 134](https://github.com/tett23/aleph/pull/134) で 30 分に延ばした。
- ジョブの時刻は、`gh run view 44122927815 --json jobs` で読んだ。
  - `measure (qwen3.5-4b, 4096)` は 17:10:21Z から 19:38:36Z まで、約 2 時間 28 分かかった。
  - `measure (qwen3.5-4b, 8192)` は 17:49:38Z から 23:06:06Z まで、約 5 時間 16 分かかった。計測のジョブの時間の上限は 360 分である。
  - `budget-measure` (予算を測るモデルは Qwen3-0.6B、コンテキスト 4096) は、約 1 時間 11 分で `success` だった。

### 手元での渡し方の比べ

[2026-11-18 の調査](../research/2026-11-18-assistant-prompt-and-context.md) は、メンテナーの Mac で、渡し方を変えて正解率を比べた。
Qwen3.5-4B の 4,096 での主な結果は次のとおりである。
この Mac は負荷が高く、時間は比べに使えない。

| 渡し方 | 全体の正解 | 種類ごとの最小 | 欠かせない課題 | 最大の RSS (MB) |
| --- | --- | --- | --- | --- |
| [ADR 0081](0081-assistant-with-local-llm-and-connectors.md) のプロンプト | 69% | 58% | 7/10 | 3162 |
| 作業例を五つ足したプロンプト | 61% | 38% | 5/10 | 3178 |
| 種類の作業例 | 69% | 46% | 8/10 | 3207 |

- 8,192 では、種類の作業例が全体 77%、種類ごとの最小 69%、欠かせない課題 9/10 で、比べた渡し方のうち最も高かった。
- 4,096 の種類の作業例では、command-build の答えが 1,024 トークンで切れた (記録の `finish_reason` が `length`)。
- ほかの三つの候補は、手元の二つの記録 ([2026-11-17](../benchmarks/2026-11-17-assistant-models-maintainer-mac.json) と [2026-11-18 の例つき](../benchmarks/2026-11-18-assistant-variant-examples-maintainer-mac.json)) のどの構成でも決まりを満たさず、全体の正解は最も高いもので 38% (Qwen3.5-2B の 8,192、例つき) だった。
- どの渡し方とコンテキストでも、md-bold-close は落ちた。
- 調査は、種類の作業例の gm の作業例が、gm-strong の正解と同じ形の書き換えであることも記録している。

### 種類の作業例のプロンプトでの、ランナーの予算の値

予算の値を決めるため、この ADR のプロンプトで、標準の macOS のランナーで予算を一度測った。
使い捨てのブランチ `tmp-bench-4b-kind` (コミット `14711fa`) で、`bench/assistant/sources.json` の `budget` のモデルを `qwen3.5-4b` にし、`docs/budgets.md` の三つの計測のコマンドに `--variant kind-examples` を足して、予算の計測のジョブだけを手で動かした (実行 [44211698861](https://github.com/tett23/aleph/actions/runs/44211698861))。ブランチは、計測の後に消した。
コンテキストは 4,096 で、起動からの答えは 5 回測る。

- `budget-measure` は 00:57:24Z から 03:19:33Z まで、約 2 時間 22 分で `success` だった。ジョブの記録のキャッシュの鍵は `assistant-bench-qwen3.5-4b-…` だった。
- 成果物 `budget-results` の値は、起動からの最初の答えの p95 が 265190 ms、答えの p95 が 164456 ms、最大の RSS が 4409 MB だった。
- 作業例を足す前のプロンプトの値 (上の表の 4096 の行) と比べると、最初の答えの p95 は短く、答えの p95 と最大の RSS は長く大きかった。

### 今のコード

- 作業例と、作業例を前の会話の順番として渡す形は、計測の道具の [`bench/assistant/lib/prompt.ts`](https://github.com/tett23/aleph/blob/4191dba1416150412a1b3e29c21c22bd5338dd57/bench/assistant/lib/prompt.ts) にある。種類の作業例は、同じ道具の `--variant kind-examples` ([`bench/assistant/lib/variant.ts`](https://github.com/tett23/aleph/blob/4191dba1416150412a1b3e29c21c22bd5338dd57/bench/assistant/lib/variant.ts) の `examplesFor`) である。
- アプリの側には、資料の選び方 ([`app/assistant/material.ts`](https://github.com/tett23/aleph/blob/4191dba1416150412a1b3e29c21c22bd5338dd57/app/assistant/material.ts)) と案の適用 ([`app/assistant/edits.ts`](https://github.com/tett23/aleph/blob/4191dba1416150412a1b3e29c21c22bd5338dd57/app/assistant/edits.ts)) だけがあり、プロンプトを組む部分は無い。
- 予算を測るモデルとコンテキストは、[`bench/assistant/sources.json`](https://github.com/tett23/aleph/blob/4191dba1416150412a1b3e29c21c22bd5338dd57/bench/assistant/sources.json) の `budget` (`{"model": "qwen3-0.6b", "context": 4096}`) である。
- 選び方の決まりの予算の条件は、`docs/budgets.md` ではなく、[`bench/assistant/lib/summary.ts`](https://github.com/tett23/aleph/blob/4191dba1416150412a1b3e29c21c22bd5338dd57/bench/assistant/lib/summary.ts) の定数 `BUDGETS` (30000、15000、2048) で当てている。この定数の注釈は `// docs/budgets.md` である。
- 決まりは、計測のジョブ (`run.ts`) が、記録ごとに `selection` として当てる。毎晩の実行の計測のジョブは、モデルとコンテキストの組ごとに一つなので、各記録の `selection` は、その一つの組が決まりを満たすかを表す。`analyze` (`regress.ts`) は回帰を探すだけで、決まりを当てない。

## 実装すること

### 仮の既定のモデル

- アシスタントの既定のモデルを、Qwen3.5-4B (Q4_K_M) とする。[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の「既定のモデルは、下の「既定のモデルの選び方」で決めたものとする」は、この ADR が置き換える。同梱、モデルの一覧の印、消せないことは、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の「モデルの管理」のとおりとする。
- [ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の選び方の決まりは、予算の条件の値 (30000、15000、2048) を含めて、そのまま残す。`BUDGETS` は変えず、注釈を「[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の選び方の決まりの予算」に直す。そのため、決まりの予算の条件と、下の「予算」(`docs/budgets.md`) は、別の値になる。
- Qwen3.5-4B は、決まりを満たさないまま選んだ、仮の既定のモデルとする。[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の A1 (既定のモデルが規則で選ばれている) は、この ADR が置き換え、満たさなくてよいものとする。
- 毎晩の計測 ([ADR 0085](0085-run-assistant-benchmark-nightly.md)) の各記録の `selection` は、今のとおり、その組が決まりを満たすかを記録する。どれかの記録が決まりを満たしたら、既定のモデルを変える ADR を書く。組をまたいで選ぶ処理は足さない。
- 仕様書には、既定のモデルが仮であること、決まりのどの条件を満たしていないか、選んだ理由を書く。

### コンテキストの長さ

- ローカルのコネクタのコンテキストの長さを、4,096 トークンとする。[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の「コンテキストの長さは、計測で 4,096 と 8,192 を比べて決める」を、この値で決める。

### プロンプトの形

- ローカルのコネクタのプロンプトは、system のメッセージ、作業例の会話、書き手の頼みの順に並べる。作業例の会話は、作業例ごとに、頼みの user のメッセージと、答えの assistant のメッセージの二つとする。
- 渡す作業例は、対象と同じ種類の作業例 (あれば) と、コマンドを答える作業例だけとする。種類は、ファイルの名前を小文字にしたうえで、`style.toml` と `manifest.toml` は名前で、ほかのファイルは拡張子で決める。作業例は `style.toml`、`manifest.toml`、`.gm`、`.md` とコマンドの五つなので、ほかの種類の対象 (`.csv`、ほかの名前の `.toml`、拡張子の無いファイルなど) には、コマンドの作業例だけを渡す。
- どの作業例も、課題の一揃いのどの課題とも頼みが同じでなく、対象のテキストとファイルの組も同じでない。
- system のメッセージの指示は、コミット `4191dba` の [`bench/assistant/lib/prompt.ts`](https://github.com/tett23/aleph/blob/4191dba1416150412a1b3e29c21c22bd5338dd57/bench/assistant/lib/prompt.ts) の `INSTRUCTION` (コマンドか書き換えかを先に決める決まりを含む) とする。資料は、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) のとおり system のメッセージに入れる。
- 指示、作業例、メッセージを組む関数を、アプリの側 (`app/assistant/prompt.ts`) に移し、計測の道具はそれを使う。
- 計測の道具の `--variant` は、次のとおりにする。既定の名前を `app` とし、このプロンプトで頼む。今の `examples` は、作業例を五つすべて渡す単独の名前として残す。機能の `kind-examples` は、既定と同じになるので消す。ほかの機能は、`app` に `+` でつなぐ (`app+thinking` など)。
- **決まった部分**を、資料を空にしたときのメッセージ (指示、作業例の会話、頼み、対象) を、チャットのテンプレートに当ててトークンに分けた数とする。[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の資料の上限の「決まった指示と頼みと対象の分」は、この決まった部分とする。上限は、今のとおり `materialLimit(context, fixed)` (コンテキストの長さから決まった部分と 1,024 を引いた数) で求め、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) I9 の上限もこれに従う。

### 予算

- 予算を測るモデルとコンテキストを、Qwen3.5-4B と 4,096 にする (`bench/assistant/sources.json` の `budget`)。
- 予算の値を、次のとおりにする。`docs/budgets.md` も同じ変更で変える。

| 名前 | 指標と単位 | 比較 | 値 |
| --- | --- | --- | --- |
| アシスタントの起動からの答え | 起動からの最初の答えまでの時間の p95 (ミリ秒) | `<=` | 320000 |
| アシスタントの答え | 起動した後の答えまでの時間の p95 (ミリ秒) | `<=` | 200000 |
| アシスタントのメモリ | `llama-server` の最大の RSS (MB) | `<=` | 5300 |

- 値は、上の「種類の作業例のプロンプトでの、ランナーの予算の値」(265190 ms、164456 ms、4409 MB) に 20% を足し、上の二桁に切り上げたものである。20% は、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) が回帰とみなす悪くなり方の幅である。
- 元の値は、一度の実行の値である。最初の答えの p95 は、5 回の起動の最大でもある。夜ごとの揺れがこの幅に収まるかは、まだ分からない。
- この予算は、書き手の Mac での速さの約束ではなく、ランナーでの回帰を見つけるためのものとする。仕様書にもそう書く。
- 毎晩の計測で予算を超えることが続いたら、値を見直す。見直すときは、新しい ADR で変える。

### 文書

- 仕様書に、仮の既定のモデル、コンテキストの長さ、プロンプトの形、予算の意味を書く。
- README には、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の実装でアシスタントを書くときに、既定のモデルが仮であることを含めて書く。この ADR の実装では、README を変えない (今の README にアシスタントの記述は無い)。
- 採択した後、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) のステータスの変更の配列に、次の要素を足す。どれも `by` はこの ADR とする。
  - 置き換え (`kind` を省く): 「モデルの管理 の、既定のモデルを選び方で決めること」、「既定のモデルの選び方 の、満たすものが無いときの扱い」、「アシスタントに渡す資料 の、コンテキストの長さ」、「予算 の値と計測するモデル」、「受けいれ条件 A1」。
  - 補足 (`"kind":"supplement"`): 「アシスタントに渡す資料 の、決まった指示の数え方」、「ローカルの推論 の、プロンプトの形」。

## 実装しないこと

- 選び方の決まりの値 (70%、50%、欠かせない課題、予算の条件の値) を変えること。
- コンテキストの長さを、書き手が設定で変えられるようにすること。
- 資料の節の並べ方を変えること (調査の `title-rank`)、`.md` にマニュアルを渡さないこと (`md-no-manual`)、二度に分けて頼むこと (`two-step`)、考える過程を出すこと (`thinking`)。
- 何も変えない書き換えを答えたときに頼み直すこと。
- 計測のジョブの時間を縮めること。4B の 8,192 のジョブが上限の 360 分に近いことは、別に扱う。
- [ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の残り (同梱、コネクタ、タブ、モデルの管理、資料の同梱) を実装すること。この ADR の後に、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の実装として行う。

## 不変条件

- I1: 作業例の会話が持つ作業例は、コマンドを答える作業例をちょうど一つ含み、ほかは対象と同じ種類の作業例だけである。
- I2: どの作業例も、課題の一揃いのどの課題とも頼みが同じでなく、対象のテキストとファイルの組も同じでない。
- I3: メッセージは、system のメッセージで始まり、作業例ごとの user と assistant の組が続き、書き手の頼みの user のメッセージで終わる。
- I4: 決まった部分は、資料を空にして同じ作業例で組んだメッセージのトークンの数に等しく、資料の上限は、4,096 から決まった部分と 1,024 を引いた数に等しい。
- I5: 予算を測るモデルとコンテキストは `qwen3.5-4b` と 4,096 で、`docs/budgets.md` の三つの値はこの ADR の表の値に等しい。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| 対象が `style.toml` | `style.toml` の作業例とコマンドの作業例だけ | I1 |
| 対象が `manifest.toml` | `manifest.toml` の作業例とコマンドの作業例だけ | I1 |
| 対象が `.gm` | `.gm` の作業例とコマンドの作業例だけ | I1 |
| 対象が `.md` | `.md` の作業例とコマンドの作業例だけ | I1 |
| 対象のパスが大文字の拡張子 (`.GM`) | `.gm` と同じ作業例 | I1 |
| 対象が `.csv` | コマンドの作業例だけ | I1 |
| 対象が `other.toml` | コマンドの作業例だけ | I1 |
| 対象が拡張子の無いファイル | コマンドの作業例だけ | I1 |
| 作業例と課題の一揃い | 頼みが同じものも、対象のテキストとファイルの組が同じものも無い | I2 |
| 作業例が二つのときのメッセージ | system、user、assistant、user、assistant、user の六つ | I3 |
| 作業例が一つのときのメッセージ | system、user、assistant、user の四つ | I3 |
| 一文字を一トークンと数える関数で、作業例が二つのとき | 決まった部分は、作業例が無いときより、作業例の会話の文字の数 (テンプレートの分を含む) だけ大きい | I4 |
| 決まった部分が 1,000 | 資料の上限は 2,072 | I4 |
| 決まった部分が 3,072 | 資料の上限は 0 | I4 |
| `sources.json` の `budget` と `docs/budgets.md` | `qwen3.5-4b`、4096、320000、200000、5300 | I5 |

## 受けいれ条件

- A1: 実装をマージした後の最初の夜の実行で、`budget-measure` と `budget-report` が `success` で終わり、`budget-measure` の記録のモデルが `qwen3.5-4b` で、コンテキストが 4096 である。

## テスト設計

- I1 から I4 は、`app/assistant/prompt.ts` の関数のテストで、境界の表の行を確かめる。名前は `ADR 0086 I1: …` のようにする。I4 は、決まった部分を数える関数に、トークンを数える関数とチャットのテンプレートを当てる関数を差し替えて渡し、確かめる。
- I2 は、`bench/assistant/lib/set.test.ts` の作業例のテストを、`app/assistant/prompt.ts` の作業例に向け直し、名前を `ADR 0086 I2: …` にする。
- I5 は、`bench/assistant/sources.json` と `docs/budgets.md` を読むテストで確かめる。
- A1 は、マージの後の夜の実行で、次の手順で確かめる。
  1. `gh run list --workflow assistant-bench.yml --event schedule --limit 1` で実行を見る。
  2. `gh run view <ID> --json jobs` で、`budget-measure` と `budget-report` が `success` であることを確かめる。
  3. `gh run view <ID> --log` の `budget-measure` の記録で、`== Qwen3.5-4B @ 4096` の行があることを確かめる。`budget-results` の成果物は、モデルとコンテキストを持たないためである。
- 予算を満たすかは、ジョブの結果 (予算を超えても `success` になる) ではなく、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) A7 として、`budget-results` の値と予算の一覧を照らして確かめる。

## トレードオフ

選び方の決まりを満たさないモデルを既定にすると、書き手は、欠かせない課題の一部 (md-bold-close など) で正しくない案を受け取る。
しかし、決まりを満たすまで止めると、アシスタントのほかの部分 (コネクタ、タブ、モデルの管理) も作れない。
案は、書き手が差分を見て「適用」を押すまで原稿を変えない ([ADR 0081](0081-assistant-with-local-llm-and-connectors.md) I4)。
そのため、正しくない案の害は、書き手が案を退ける手間にとどまる。
決まりを残して仮とすることで、決まりを満たすモデルが出たときに戻る先も残る。

Qwen3.5-4B は、候補の中で最も大きい (2,741 MB、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) のトレードオフ)。
アプリの大きさと、書き手の Mac のメモリ (ランナーで 4,409 MB) の負担は、候補の中で最も重い。
小さい候補は、手元の計測で全体の正解が 38% 以下にとどまった (上の「手元での渡し方の比べ」)。
大きさより、案が使えることを選ぶ。

時間の予算をランナーの値で決めると、予算の値は書き手の Mac での速さを表さない。
ランナーは、メンテナーの Mac (M1 Max) より約 10 倍遅かった。
この倍率は、Qwen3.5-0.8B の 4,096 で答えを書く速さ (手元の [2026-11-17 の記録](../benchmarks/2026-11-17-assistant-models-maintainer-mac.json) で 1 秒に約 39 トークン、ランナーで約 3.7 トークン) を比べたもので、手元の値は負荷が高いときのものである。
それでも、毎晩同じランナーで測れば、変更による遅れは見つけられる。
書き手の Mac での速さは、予算ではなく、手元で `bench/assistant/run` を動かして確かめる。

コンテキストを 8,192 にすれば、手元の計測で正解率は上がった (種類の作業例で 69% から 77%)。
しかし、ランナーでは答えの p95 が約 2 倍になり、最大の RSS も増えた。
書き手を待たせる時間とメモリを重く見て、4,096 を選ぶ。

種類の作業例は、課題の一揃いに似た作業例を含むので、正解率が実際より高く出ている可能性がある (調査の記録)。
作業例を課題と同じにしないこと (I2) で、そのままの重なりは防ぐ。
似かたによる上振れは、課題を足したときに確かめる。

## 参考文献

- [ADR 0081](0081-assistant-with-local-llm-and-connectors.md)
- [ADR 0085](0085-run-assistant-benchmark-nightly.md)
- [アシスタントへのプロンプトと資料の渡し方 (2026-11-18)](../research/2026-11-18-assistant-prompt-and-context.md)
- 実行 [44122927815](https://github.com/tett23/aleph/actions/runs/44122927815) の成果物 `assistant-bench-qwen3.5-4b-4096` と `assistant-bench-qwen3.5-4b-8192`
