# 予算

Aleph の性能の予算の一覧である。
予算を決めるのは ADR で、この一覧と ADR が食い違うときは ADR が正である。
値を変えるときは、ADR と同じ変更でこの一覧も変える。

| 名前 | 指標と単位 | 比較 | 値 | 計測のコマンド | ADR |
| --- | --- | --- | --- | --- | --- |
| アシスタントの起動からの答え | 起動からの最初の答えまでの時間の p95 (ミリ秒) | `<=` | 30000 | `bench/assistant/run --metric first-answer-ms-p95` | [ADR 0081](adr/0081-assistant-with-local-llm-and-connectors.md) A7 |
| アシスタントの答え | 起動した後の答えまでの時間の p95 (ミリ秒) | `<=` | 15000 | `bench/assistant/run --metric answer-ms-p95` | [ADR 0081](adr/0081-assistant-with-local-llm-and-connectors.md) A7 |
| アシスタントのメモリ | `llama-server` の最大の RSS (MB) | `<=` | 2048 | `bench/assistant/run --metric peak-rss-mb` | [ADR 0081](adr/0081-assistant-with-local-llm-and-connectors.md) A7 |
