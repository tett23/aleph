# ADR 0089: Claude Code と Codex の承認を、設定から取り消す

Status: accepted

## 文脈

[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) のアシスタントは、Claude Code と Codex のコネクタを初めて使うときに、何をどの会社に送るかを Rust の側のネイティブのダイアログで示し、書き手が認めたときだけ使う。
承認は、`config.json` の、Rust の側だけが変える鍵 `assistantApproved` に残る。
しかし、一度認めた承認を取り消す手段は、どの ADR も決めていない。
書き手が取り消したくなったときは、`config.json` を手で書きかえるしかない。

メンテナーは、設定の「アシスタント」の節から、Claude Code と Codex の承認を取り消せるようにするよう求めた (2026-11-18)。

## 調査した事項

この節には、コードを読んで確かめたことだけを書く。
コードは、main のコミット [97fe794](https://github.com/tett23/aleph/tree/97fe7948aec7209704cd5b51d8973801547a1190) のものである。

- 承認は、`config.json` の `assistantApproved` (承認したコネクタの ID の配列) に置く。[`src-tauri/src/guard.rs`](https://github.com/tett23/aleph/blob/97fe7948aec7209704cd5b51d8973801547a1190/src-tauri/src/guard.rs) の `approved` は、配列の文字列の要素に ID があるかで承認を読み、`approve` は、文字列の要素だけを残した列に ID を一度だけ足して書く。`merge` は、画面からの保存でこの鍵を変えない。
- [`src-tauri/src/lib.rs`](https://github.com/tett23/aleph/blob/97fe7948aec7209704cd5b51d8973801547a1190/src-tauri/src/lib.rs) の Tauri のコマンド `assistant_connectors` は、ローカル、Claude Code、Codex の三つについて `{ id, name, found, approved }` を返す。見つけるために、コネクタごとにログインシェルを起こすことがある (10 秒で打ち切る、[`src-tauri/src/connectors.rs`](https://github.com/tett23/aleph/blob/97fe7948aec7209704cd5b51d8973801547a1190/src-tauri/src/connectors.rs))。
- `assistant_ask` は、見つからないコネクタをエラーにし、承認の無いコネクタを起こさず、初めて使うときにダイアログを出す ([ADR 0081](0081-assistant-with-local-llm-and-connectors.md) I6)。承認は頼みの初めに一度だけ読み、その後に CLI を最長 120 秒走らせる。頼みを途中で止める仕組みは無い。
- 設定の書き込みは、Rust の側で、今の設定を読み、変えて書く。読んでから書くまでのあいだのロックは無い。
- 設定の「アシスタント」の節 ([`app/assistant/models.ts`](https://github.com/tett23/aleph/blob/97fe7948aec7209704cd5b51d8973801547a1190/app/assistant/models.ts)) は、使うモデルの選択と、モデルごとのダウンロードと削除を出し、失敗を節の頭に出す。コネクタの行は無い。
- アシスタントのタブ (`app/assistant/mount.ts`) は、コネクタの一覧を、タブを作ったときと頼みが終わるたびに読みなおす。

## 実装すること

### 設定の行

- 設定の「アシスタント」の節の、モデルの行の後に、Claude Code と Codex の行を一つずつ置く。行は `assistant_connectors` の結果から、ローカルを除いて作る。
- 行は、コネクタの名前と、`found` と `approved` から決まる一つの状態の文言を出す。

| `found` | `approved` | 状態の文言 | 「承認を取り消す」のボタン |
| --- | --- | --- | --- |
| 真 | 真 | 承認しています | 出す |
| 真 | 偽 | 承認していません | 出さない |
| 偽 | 真 | 見つかりません (承認しています) | 出す |
| 偽 | 偽 | 見つかりません | 出さない |

- 見つからないが承認しているコネクタにもボタンを出す。CLI を消した後に取り消せず、入れなおすとダイアログなしで使える、ということを避けるためである。
- ボタンを押すと、確かめずに取り消す。取り消しは、外に送るものを減らす操作なので、確かめのダイアログは出さない。取り消せたら、`assistant_connectors` を呼びなおさずに、その行だけを `approved` が偽の状態で描きなおす。
- 取り消しに失敗したときは、行を変えず、モデルの操作と同じく節の頭にエラーを出す。
- 取り消した後に、アシスタントのタブのコネクタの一覧を読みなおし、選ぶ欄の文言 (「初めて使うときに承認を求めます」) を合わせる。

### 取り消しのコマンド

- Rust の側に、`approve` と対になる純粋な関数 `revoke(current, id) -> Value` を足す。`revoke` は、`assistantApproved` を、文字列の要素だけを残した列から、`id` に等しい要素をすべて除いた列で書く。文字列でない要素と、配列でない値は、`approve` と同じく捨てる。ほかの鍵は変えない。
- Tauri のコマンド `assistant_revoke(connector: String)` を足す。中身は、`claude` と `codex` のほかを `Err` にし、そうでなければ `revoke` の結果を返す純粋な関数 `revoked(current, id) -> Result<Value, String>` とする。コマンドは、その結果を `config.json` に書き、何も返さない。`Err` のときは書かない。
- 画面の側から `assistantApproved` を変えられないことは、今のとおりとする。取り消しも、このコマンドを通してだけ行う。
- 取り消した後に、そのコネクタで頼むと、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) のとおり、もう一度承認のダイアログを出す。

### 文書

- 仕様書のアシスタントの節に、取り消しを書く。
- 用語集に、「コネクタの行」と「承認を取り消す」のボタンの名前を足す ([ADR 0082](0082-ui-names-and-glossary.md) の「新しい画面の要素を足す ADR は、その実装で用語集にも名前を足す」)。
- README は変えない。README は承認を書いていない。

## 実装しないこと

- 設定から承認すること。承認は、今のとおり、初めて使うときのダイアログで行う。
- 送っている最中の頼みを止めること。取り消しは、次の頼みから効く。
- 設定の書き込みの、承認と取り消しが重なったときの順を守ること (今のコードの性質のまま。トレードオフを参照)。
- Claude Code と Codex のログインの状態を出すことや、ログアウトすること。
- ローカルのコネクタの承認 (ローカルは外に送らないので、承認は無い)。

## 不変条件

- I1: `revoke(current, id)` の `assistantApproved` は、`current` の `assistantApproved` の文字列の要素の列から、`id` に等しい要素をすべて除いた列に等しい。ほかの鍵は変わらない。
- I2: `revoke(current, id)` の後に `approved(…, id)` は偽である。
- I3: `revoked(current, id)` は、`id` が `claude` か `codex` でなければ `Err` を返す。
- I4: 画面からの保存 (`merge`) は、取り消した後の `assistantApproved` を変えない。
- I5: 設定の行の状態の文言とボタンの有無は、`found` と `approved` から、上の表のとおりに決まる。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| `["claude", "codex"]` から `claude` | `["codex"]` | I1, I2 |
| `["claude"]` から `claude` | `[]` | I1, I2 |
| `["codex"]` から `claude` (承認していない) | `["codex"]` | I1, I2 |
| `["claude", "claude", "codex"]` から `claude` | `["codex"]` | I1, I2 |
| `["claude", 1, null]` から `claude` | `[]` | I1, I2 |
| `assistantApproved` が配列でない (`"claude"`) | `[]` | I1, I2 |
| `assistantApproved` が無い | `assistantApproved` は `[]` (鍵を足す)、ほかの鍵は同じ | I1, I2 |
| ID `local` か `other` | `Err` | I3 |
| 取り消した後に、画面が `assistantApproved: ["claude"]` を含めて保存する | `assistantApproved` は取り消した後のまま | I4 |
| `found` 真、`approved` 真 | 「承認しています」、ボタンあり | I5 |
| `found` 真、`approved` 偽 | 「承認していません」、ボタンなし | I5 |
| `found` 偽、`approved` 真 | 「見つかりません (承認しています)」、ボタンあり | I5 |
| `found` 偽、`approved` 偽 | 「見つかりません」、ボタンなし | I5 |

## 受けいれ条件

- A1: Claude Code を承認した後、設定の「アシスタント」の節で「承認を取り消す」を押すと、行が「承認していません」になる。そのあとアシスタントのタブで Claude Code を選んで送ると、承認のダイアログがもう一度出る。

## テスト設計

- I1 から I4 は、`guard.rs` の `revoke` と `revoked` の Rust のテストで、境界の表の行を確かめる。名前は `adr0089_i1_…` のようにする。
- I5 は、行を描く TypeScript の純粋な関数のテストで、四通りの行を確かめる。名前は `ADR 0089 I5: …` とする。
- A1 は、デバッグ版で手で確かめる。

## トレードオフ

取り消しに確かめのダイアログを出さないと、誤って押したときに、次に使うときにもう一度承認することになる。
しかし、取り消しは外に送るものを減らす向きの操作で、誤りの害は承認をやりなおす手間にとどまる。
確かめのダイアログを置くと、その手間が、取り消すたびに増える。
同じ理由で、画面に注入されたスクリプトが `assistant_revoke` を呼んでも、できるのは承認を減らすことだけである ([ADR 0042](0042-ipc-trust-boundary.md))。

設定の節を開くと、`assistant_connectors` がコネクタごとにログインシェルを起こすことがあり、二つとも見つからない環境では最長で約 20 秒、行が出るのを待つ。
取り消した後は呼びなおさないので、この待ちは節を開くときだけである。

承認は頼みの初めに一度だけ読むので、送っている最中に取り消しても、その頼みは最後まで走る。
また、承認のダイアログと取り消しが同時に設定を書くと、後に書いたほうが残る。
どちらも、書き手が数秒のあいだに二つの操作をしたときにだけ起こり、取り消しをもう一度押せば直る。

## 参考文献

- [ADR 0042](0042-ipc-trust-boundary.md)
- [ADR 0081](0081-assistant-with-local-llm-and-connectors.md)
- [ADR 0082](0082-ui-names-and-glossary.md)
