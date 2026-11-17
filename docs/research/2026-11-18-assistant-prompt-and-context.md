# アシスタントへのプロンプトと資料の渡し方 (2026-11-18)

## 問い

この調査は、ローカルのモデルに頼みと資料を渡す形を変えると、[ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) のアシスタントの計測の正解率が上がるかを確かめる。
メンテナーは、既定のモデルを Qwen3.5-4B に仮に決めている。
そこで、Qwen3.5-4B にとってどの渡し方が最もよいかと、どれかの渡し方で Qwen3.5-2B が選び方の決まりに近づくかを問う。
選び方の決まり ([ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md)「既定のモデルの選び方」) は、三つの条件を満たすことである。
一つ目は、欠かせない課題 ([ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) が、どのモデルでも通らなければならないと決めた 10 件の課題) がすべて通ることである。
二つ目は、全体の正解率が 70% 以上で、種類ごとの正解率がどれも 50% 以上であることである。
三つ目は、予算を満たすことである。
この調査では、一つ目と二つ目だけを見る。
予算は答えの時間を含み、この調査では答えの時間を読めないためである (次の節)。
以下で「決まりに近い」と書くときは、この二つの条件に近いことを指す。

## 条件

計測は、どれもメンテナーの Mac で行った。
この Mac はほかのビルドで常に忙しく、1 分の負荷の平均は、渡し方の比べのあいだ 148 から 381 だった。
そのため、この記録からは正解率と最大の RSS を読み、答えの時間は目安のほかには読まない。

答えは、温度 0、シード値 0 で固定している。
負荷が答えを変えないことは、Qwen3.5-2B のコンテキストの長さ 4,096 トークンで確かめた。
例つきを `3892447` で計測し直すと (負荷 148 から 156)、61 件の答えが、`41e2f92` で負荷 40 から 75 のときに取った例つきの記録とすべて同じ文字列だった。
プロンプトのトークンの数も、61 件とも同じだった。
このことから、`--variant` を足しても既定の渡し方のメッセージは変わっていないと見る。
ただし、メッセージの文字列そのものは比べておらず、4B と 8,192 でも確かめていない (未確認)。

| 項目 | 値 |
| --- | --- |
| 機種 | `Mac13,1` (Apple M1 Max)、メモリ 64 GiB、macOS 27.0 |
| llama.cpp | `b12466` |
| golem と Golem のマニュアル | 0.1.0-rc4 と `v0.1.0-rc4` の三つの章 |
| 課題 | 61 件 (style 12、manifest 12、gm 12、markdown 12、command 13)。欠かせない課題は 10 件。課題の名前 (gm-strong など) は `bench/assistant/tasks/*.json` の `id` |
| モデル | unsloth の Qwen3.5-4B と Qwen3.5-2B の Q4_K_M (`bench/assistant/models.json` のリビジョン)。以下では 4B、2B と略す |
| コンテキストの長さ | 4,096 と 8,192 トークン。以下では数だけを書く |
| 起動からの答えの回数 | 渡し方の比べは構成ごとに 1 回 (`--cold-starts 1`)。基準の二つの記録は 5 回 (`--cold-starts 5`) |
| 計測のコミット | 渡し方の比べ: `3892447`。例を足した渡し方の基準: `41e2f92` |
| 計測の日時 (記録の書き出し、日本時間) | 例つき: 2026-11-18 00:31。渡し方の比べ: 最初の記録が 2026-11-18 01:32 |

比べの基準は二つある。
一つは、例を足す前の元のプロンプトの記録 [2026-11-17-assistant-models-maintainer-mac.json](../benchmarks/2026-11-17-assistant-models-maintainer-mac.json) である。
もう一つは、作業例を前の会話の順番として足し、コマンドか書き換えかを決める決まりを指示に足したプロンプト (ブランチ `assistant-prompt-examples`、`41e2f92`) の記録 [2026-11-18-assistant-variant-examples-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-examples-maintainer-mac.json) である。
以下では、前者を「元のプロンプト」、後者を「例つき」と呼ぶ。
例つきの記録は、`41e2f92` で `--cold-starts 5` で計測した四つのモデルの記録で、この調査の前に取ったものを写した。

## 渡し方の変え方

計測の道具に `--variant` を足し、渡し方を名前で選べるようにした (`bench/assistant/lib/variant.ts`)。
既定の `examples` は例つきのプロンプトそのままで、下の機能を `+` でつないだ名前は、例つきのプロンプトにその機能を加える。
どの機能も、最後の書き換えの答えの形 (`{explanation, edits:[{find, replace}]}`) を変えない。

| 名前 | 何を変えるか | 試した理由 |
| --- | --- | --- |
| `user-material` | 資料を system のメッセージから外し、最後の user のメッセージで頼みの前に置く | 資料が対象のすぐ前にあれば、小さいモデルも資料を使うと考えた |
| `kind-examples` | 作業例を、対象のファイルの種類の例とコマンドの例の二つだけにする | 例つきでは決まった部分 (資料を空にしたときのプロンプトのトークンの数) が 662 から 1,227 トークンに増え、4,096 での資料の上限が 2,410 から 1,845 トークンに減った。例を減らして資料の場所を空ける |
| `title-rank` | 頼みの言葉 (「」の中を除いた漢字とカタカナの連なり) が見出しに現れる節を先に並べ、見出しのうち言葉が占める割合の順にする。残りは [ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) の重なりの数の順 | [ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) の並べ方では、gm-strong の一番目の節が「数と式」で、「強調と圏点」は二番目になる。gm-note では、「注」の節が上位 8 節に入らない (`app/assistant/material.ts` の `rankSections` で手元で並べた) |
| `md-no-manual` | Markdown のファイルには Golem のマニュアルの節を渡さない | Golem のマニュアルは Markdown の記法を説明しない。例つきの 4B は、8,192 で md-link-space に Golem の `[link …]` の形を、md-image に Golem の `@figure` を書いた |
| `two-step` | 一度目にコマンドか書き換えかだけを `{"kind"}` の形で答えさせ、二度目にその種類だけのプロンプトで答えさせる。コマンドの側は、コマンドの ID の enum を `json_schema` で縛って一つ選ばせ、[ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) の形の答えを道具の側で作る。書き換えの側は、コマンドの一覧を外してマニュアルの節だけを渡す | 例つきの 4B は、コマンドの意味を言い当てながら ID も名前も書かない答え (command-outline の「右サイドバーのアウトラインを表示します。」など) で落ちた |
| `thinking` | 考える過程を出させる (`enable_thinking: true`、`--reasoning on`、`--reasoning-budget 1024`)。答えのためのトークンを 1,024 足し、その分だけ資料の上限を減らす | 考える過程が、記法の選び方とコマンドの選び方を直すかを見る |

組み合わせは、一度の呼び出しで考える過程を出さないまま、4B の 4,096 で例つきより正解率を上げた三つ (`kind-examples`、`user-material`、`title-rank+md-no-manual`) を合わせた `kind-examples+user-material+title-rank+md-no-manual` を計測した。
以下では、これを「組み合わせ」と呼ぶ。

課題に合わせすぎないように、次のことを守った。
プロンプトに課題の頼み、対象、正解を入れていない。
作業例が課題でないことは、`bench/assistant/lib/set.test.ts` の既存のテストが確かめている。
見出しで並べる規則は、頼みの言葉と見出しの文字列だけを使い、課題ごとの言葉の表を持たない。

## 結果

### Qwen3.5-4B

各行は、全体 61 件の計測である。
決まった部分は、資料を空にしたときのプロンプトのトークンの数の最大である (`two-step` では、二度目のプロンプトの最大で、一度目の分類のプロンプトを含まない)。
資料の上限は、課題のうちの最小である。

| 渡し方 | コンテキスト | 全体 | style | manifest | gm | markdown | command | 欠かせない課題 | 決まった部分 | 資料の上限 | 最大の RSS (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 元のプロンプト | 4096 | 69% | 75% | 75% | 75% | 58% | 62% | 7/10 | 662 | 2410 | 3162 |
| 元のプロンプト | 8192 | 67% | 67% | 83% | 67% | 58% | 62% | 6/10 | 662 | 6506 | 3299 |
| 例つき | 4096 | 61% | 75% | 75% | 50% | 67% | 38% | 5/10 | 1227 | 1845 | 3178 |
| 例つき | 8192 | 69% | 58% | 83% | 67% | 75% | 62% | 7/10 | 1227 | 5941 | 3313 |
| `user-material` | 4096 | 67% | 75% | 83% | 58% | 58% | 62% | 7/10 | 1227 | 1845 | 3430 |
| `user-material` | 8192 | 67% | 58% | 83% | 75% | 58% | 62% | 7/10 | 1227 | 5941 | 3314 |
| `kind-examples` | 4096 | 69% | 67% | 83% | 83% | 67% | 46% | 8/10 | 852 | 2220 | 3207 |
| `kind-examples` | 8192 | **77%** | 75% | 75% | 92% | 75% | 69% | **9/10** | 852 | 6316 | 3315 |
| `title-rank+md-no-manual` | 4096 | 70% | 67% | 83% | 75% | 75% | 54% | 7/10 | 1227 | 1845 | 3176 |
| `title-rank+md-no-manual` | 8192 | 74% | 67% | 83% | 83% | 75% | 62% | 8/10 | 1227 | 5941 | 3312 |
| `two-step` | 4096 | 67% | 58% | 67% | 50% | 75% | 85% | 5/10 | 1079 | 1993 | 3211 |
| `two-step` | 8192 | 69% | 58% | 67% | 58% | 75% | 85% | 6/10 | 1079 | 6089 | 3345 |
| `thinking` | 4096 | 62% | 67% | 67% | 25% | 75% | 77% | 6/10 | 1225 | 823 | 3206 |
| `thinking` | 8192 | 75% | 75% | 83% | 75% | 75% | 69% | 8/10 | 1225 | 4919 | 3309 |
| 組み合わせ | 4096 | 64% | 58% | 75% | 67% | 75% | 46% | 7/10 | 852 | 2220 | 3379 |
| 組み合わせ | 8192 | 70% | 67% | 83% | 75% | 75% | 54% | 7/10 | 852 | 6316 | 3494 |

どの渡し方も、選び方の決まりを満たさなかった。
最も近いのは `kind-examples` の 8,192 で、全体と種類ごとの正解率は決まりを満たし、欠かせない課題は md-bold-close だけが落ちた。
最大の RSS は、元のプロンプトを含むどの渡し方でも 3,162 MB から 3,494 MB のあいだにあった。

### Qwen3.5-2B

2B では、4B の 8,192 で全体と欠かせない課題の数が最もよかった `kind-examples` と、組み合わせを計測した。
4B の 4,096 の全体では、`title-rank+md-no-manual` の 70% (43 件) が `kind-examples` の 69% (42 件) を 1 件上回った。

| 渡し方 | コンテキスト | 全体 | style | manifest | gm | markdown | command | 欠かせない課題 | 決まった部分 | 資料の上限 | 最大の RSS (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 元のプロンプト | 4096 | 30% | 50% | 25% | 25% | 42% | 8% | 3/10 | 662 | 2410 | 1563 |
| 元のプロンプト | 8192 | 23% | 42% | 25% | 17% | 33% | 0% | 2/10 | 662 | 6506 | 1620 |
| 例つき | 4096 | 36% | 50% | 67% | 8% | 42% | 15% | 4/10 | 1227 | 1845 | 1581 |
| 例つき | 8192 | 38% | 42% | 67% | 25% | 42% | 15% | 3/10 | 1227 | 5941 | 1604 |
| `kind-examples` | 4096 | 31% | 58% | 33% | 17% | 42% | 8% | 3/10 | 852 | 2220 | 1590 |
| `kind-examples` | 8192 | 33% | 67% | 25% | 25% | 33% | 15% | 2/10 | 852 | 6316 | 1635 |
| 組み合わせ | 4096 | 25% | 58% | 8% | 33% | 8% | 15% | 3/10 | 852 | 2220 | 1658 |
| 組み合わせ | 8192 | 23% | 58% | 0% | 25% | 8% | 23% | 4/10 | 852 | 6316 | 1657 |

2B では、どちらの渡し方も例つきより下がった。
最もよいのは例つきの 8,192 の 38% で、選び方の決まりの 70% から遠い。
`kind-examples` では、manifest が例つきの 67% から 33% と 25% に下がり、manifest-title と manifest-blank-line が両方のコンテキストで落ちた。
組み合わせでは、markdown が 8% に下がった。

## 欠かせない課題ごとの変化

次の表は、Qwen3.5-4B の欠かせない課題の合否である (o は通過、x は不合格)。
style-line-pitch、style-size、manifest-title、md-heading-space は、元のプロンプト、例つき、どの渡し方でも 4B で通ったので、表から除いた。

| 渡し方 | コンテキスト | manifest-blank-line | gm-ruby | gm-strong | md-bold-close | command-build | command-convert-md |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 元のプロンプト | 4096 | o | o | x | x | o | x |
| 元のプロンプト | 8192 | o | o | x | x | x | x |
| 例つき | 4096 | o | x | x | x | x | x |
| 例つき | 8192 | o | x | x | x | o | o |
| `user-material` | 4096 | o | x | o | x | o | x |
| `user-material` | 8192 | o | x | o | x | o | x |
| `kind-examples` | 4096 | o | o | o | x | x | o |
| `kind-examples` | 8192 | o | o | o | x | o | o |
| `title-rank+md-no-manual` | 4096 | o | x | o | x | x | o |
| `title-rank+md-no-manual` | 8192 | o | x | o | x | o | o |
| `two-step` | 4096 | x | x | x | x | x | o |
| `two-step` | 8192 | x | o | x | x | x | o |
| `thinking` | 4096 | x | x | x | x | o | o |
| `thinking` | 8192 | o | o | o | x | x | o |
| 組み合わせ | 4096 | o | o | o | x | x | x |
| 組み合わせ | 8192 | o | x | o | x | o | x |

gm-ruby は、ルビの節が資料に入っていても落ちることがあった。
資料に入った節の名前は、渡し方の比べの記録にだけあり、元のプロンプトと例つきの記録には無い。
渡し方の比べの記録のうち、`user-material` と `title-rank+md-no-manual` では、ルビの節は両方のコンテキストで一番目に入っていた。
それでも 4B は、`{"find":"東京","replace":"東京"}` という何も変えない書き換えを答えた。
例つきも、両方のコンテキストで同じ答えだった。
`kind-examples` では、同じ節が一番目に入り、`[ruby: 東京|とうきょう]` と答えて通った。

gm-strong は、`title-rank` で通ったが、節の順だけでは通った理由を説明できない。
例つきの 4,096 では、4B は `[strong: 大切]` を書いたが「な」を消した (`大切な` を `[strong: 大切]` に置き換えた)。
`title-rank` では「強調と圏点」が一番目に入り、`大切な` を `[strong: 大切]な` に置き換えて通った。
一方で、例つきと同じ並べ方の `user-material` と `kind-examples` も、gm-strong を通した。
8,192 の記録では、「数と式」が「強調と圏点」より先に入っていた。
4,096 の記録では、「強調と圏点」の節が資料に入らないまま通った。

md-bold-close は、どの渡し方でも落ちた。
多くの答えが `{"find":"**大切な","replace":"**大切な"}` のような何も変えない書き換えだった。
`md-no-manual` で Golem のマニュアルを外しても、同じ答えが残った。
`thinking` では、`**大切な` を `[bold: 大切]` や `**[kenten: 大切]` に置き換える Golem の記法の答えになった。

command-build は、`user-material` を除くどの渡し方でも、どちらかのコンテキストで落ちた。
例つきの 4,096 と組み合わせの 4,096 は、PDF に組むコマンドが一覧に無いと説明しており、一覧にある `project.build` を見落としていた。
`kind-examples` と `title-rank+md-no-manual` の 4,096 は、`project.build` に触れながら、頼みに当たらないと退けた。
この二つの答えは、説明が長くなって 1,024 トークンで切れてもいた (`finish_reason` が `length`)。
`two-step` は command の正解率を 85% に上げたが、command-build では enum から `preview.window` を選んで落ちた。

`two-step` の一度目の分類は、command の 13 件をすべて command に分けた。
一方で、書き換えの 8 件 (style-first-line-indent、style-align、manifest-blank-line、manifest-add-chapter、manifest-split-chapter、gm-md-bold、gm-md-link、gm-tcy) を command に分け、どれも落ちた。
二つのコンテキストで、誤って分けた課題は同じだった。

判定にも、読むときに気を付けることがある。
`thinking` の 4,096 の command-build は、「Golem のビルド機能や外部ツールを使用する必要があります」という、コマンドを選ばない答えで通った。
説明が名前の「ビルド」を含むためで、[ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) の判定 (説明に名前か ID が含まれる) はこの答えを通す。
また、gm-ruby の正解はグループルビ (`[ruby: 東京|とうきょう]`) だけで、マニュアルの例が示すモノルビ (`[ruby: 東/京|とう/きょう]`) は正解に入っていない。
この調査では、モノルビの答えは出なかった。

## 考察

`kind-examples` が 4B の 8,192 で最もよく、4,096 でも欠かせない課題を最も多く通した理由は、二つの効果の和だと考える (推測)。
一つは、決まった部分が 1,227 から 852 トークンに減り、4,096 での資料の上限が 1,845 から 2,220 トークンに増えたことである。
もう一つは、対象と関係の薄い例が減ったことである。
後者は、8,192 で資料の上限に余裕があるときにも、例つきの 69% が 77% に上がったことから推し量った。

組み合わせは、`kind-examples` だけより下がった (4,096 で 69% から 64%、8,192 で 77% から 70%)。
4,096 では style、manifest、gm が、8,192 では style、gm、command が下がった。
command-convert-md は、例つきの 8,192 では通ったが、`user-material` を含む二つの渡し方 (`user-material` と組み合わせ) では両方のコンテキストで落ちた。
資料を user のメッセージに移すと、指示の「下の資料の『Aleph のコマンド』」と資料が離れるためと考える (推測)。
ただし、command-convert-md は、資料が system にある元のプロンプトの両方のコンテキストと、例つきの 4,096 でも落ちている。
そのため、資料の置き場所だけが理由ではない。

`thinking` は、8,192 では例つきより 4 件 (42 件から 46 件) 多く通したが、4,096 では資料の上限が 823 トークンに減り、gm が 25% に下がった。
4,096 の gm-ruby では、資料に入った節は「原稿の記法」と前置き (最初の見出しより前の部分) だけで、ルビの節は入らなかった。
考える過程の答えの時間は、この Mac では 8,192 で中央値 47.8 秒で、ほかの渡し方の 29.7 秒から 35.9 秒より長かった (負荷が高いので比べの目安にとどまる)。

課題に似ていることによる上振れの見込みは、渡し方ごとに違う。
`kind-examples` の gm の作業例は「「静か」に圏点を打って」の一つだけである。
この作業例は例つきにも入っているが、`kind-examples` では gm の書き換えの例がこれ一つになる。
作業例の頼みは、gm-kenten の頼み「「ここ」に圏点を打って」と形が近い。
ただし、gm-kenten は例つきでも両方のコンテキストで通っている。
作業例の答え (`静かな` を `[kenten: 静か]な` に置き換え、「な」を含めない) は、欠かせない課題の gm-strong の正解 (`大切な` を `[strong: 大切]な` に置き換える) と同じ形である。
gm の 92% と gm-strong の通過の一部は、この似かたから来ている可能性がある。
`title-rank` の見出しで並べる規則は、課題の言葉の表を持たないが、マニュアルの見出しが「強調と圏点」「注」のように課題の言葉と同じ語を使うことに頼っている。
マニュアルの見出しにない言葉で頼まれたときに、同じ効果があるかは確かめていない。
また、`title-rank` を試す理由に挙げた gm-note は、「注」の節が一番目に入っても、4B のどの記録でも落ちた。

## 結論

Qwen3.5-4B には、`kind-examples` (対象の種類の作業例とコマンドの作業例だけを渡す) を勧める。
8,192 で全体 77%、種類ごとの最小 69%、欠かせない課題 9/10 で、この調査の渡し方のうち選び方の決まりに最も近かった。
4,096 でも 69% と 8/10 で、例つきの 61% と 5/10 より高かった。
残る md-bold-close は、どの渡し方でも直らなかった。
この課題には、渡し方のほかの手当てが要る。
何も変えない書き換えを答えたときに頼み直す手当てが候補だが、この調査では試していない (未確認)。

Qwen3.5-2B は、試した渡し方のどれでも選び方の決まりに近づかなかった。
最もよい例つきの 8,192 でも全体 38% で、command は 15%、欠かせない課題は 3/10 だった。
4B で効いた `kind-examples` は、2B では例つきより全体で 5 ポイント下がった。
渡し方の変更が、二つのモデルで逆に効くことがある。
そのため、渡し方を決めるときは、既定にするモデルで計測する。

## ADR が要る変更

計測の道具の渡し方の多くは、アプリに入れるときに [ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) を変える新しい ADR が要る。

- `kind-examples` と `user-material` は、[ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) が決めていない、プロンプトの中身と置き場所を変える。アプリで作業例を使うこと自体を、まだどの ADR も決めていない。作業例を入れるなら、その選び方とあわせて ADR が要る。
- `title-rank` は、[ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) の「頼みの言葉と、対象に出るキーや命令の名前との重なりの数で並べ」を変える。I9 の「重なりの数の順」も変わる。
- `md-no-manual` は、[ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) の「`.gm` と `.md` は `03-markup`」を変える。
- `two-step` は、一度目に答えの形と違う JSON Schema で頼むので、「頼みには `json_schema` で上の JSON の形を渡し」を変える。書き手に見える答えの形は変えない。
- `thinking` は、「考える過程を出さない設定で呼ぶ」と、答えのための 1,024 トークンを変える。

## 再現のコマンド

渡し方ごとに、次のコマンドで計測した (`<名前>` は上の表の名前、`<モデル>` は `qwen3.5-4b` か `qwen3.5-2b`)。
JSON は一時のファイルに書き、記録に写した。
同じ答えになるかの確かめだけは、`--model qwen3.5-2b --context 4096 --variant examples` で動かした。

```sh
bench/assistant/run --model <モデル> --context 4096 --context 8192 --cold-starts 1 --variant <名前> --out <一時のファイル>
```

記録は次のファイルにある。

| 渡し方 | モデル | 記録 |
| --- | --- | --- |
| 例つき | 四つの候補 | [2026-11-18-assistant-variant-examples-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-examples-maintainer-mac.json) |
| `user-material` | Qwen3.5-4B | [2026-11-18-assistant-variant-user-material-qwen3.5-4b-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-user-material-qwen3.5-4b-maintainer-mac.json) |
| `kind-examples` | Qwen3.5-4B | [2026-11-18-assistant-variant-kind-examples-qwen3.5-4b-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-kind-examples-qwen3.5-4b-maintainer-mac.json) |
| `title-rank+md-no-manual` | Qwen3.5-4B | [2026-11-18-assistant-variant-title-rank-md-no-manual-qwen3.5-4b-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-title-rank-md-no-manual-qwen3.5-4b-maintainer-mac.json) |
| `two-step` | Qwen3.5-4B | [2026-11-18-assistant-variant-two-step-qwen3.5-4b-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-two-step-qwen3.5-4b-maintainer-mac.json) |
| `thinking` | Qwen3.5-4B | [2026-11-18-assistant-variant-thinking-qwen3.5-4b-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-thinking-qwen3.5-4b-maintainer-mac.json) |
| 組み合わせ | Qwen3.5-4B | [2026-11-18-assistant-variant-combined-qwen3.5-4b-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-combined-qwen3.5-4b-maintainer-mac.json) |
| `kind-examples` | Qwen3.5-2B | [2026-11-18-assistant-variant-kind-examples-qwen3.5-2b-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-kind-examples-qwen3.5-2b-maintainer-mac.json) |
| 組み合わせ | Qwen3.5-2B | [2026-11-18-assistant-variant-combined-qwen3.5-2b-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-combined-qwen3.5-2b-maintainer-mac.json) |
| 例つき (同じ答えになるかの確かめ) | Qwen3.5-2B | [2026-11-18-assistant-variant-examples-rerun-qwen3.5-2b-maintainer-mac.json](../benchmarks/2026-11-18-assistant-variant-examples-rerun-qwen3.5-2b-maintainer-mac.json) |
