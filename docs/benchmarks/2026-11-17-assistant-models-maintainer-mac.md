# アシスタントのローカルのモデルの計測 2026-11-17 (メンテナーの Mac)

[ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) の「既定のモデルの選び方」の計測のうち、メンテナーの Mac で行った一回の記録である。
同じ ADR は、GitHub Actions の標準の macOS のランナーでも計測することを求めている。
既定のモデルは、その計測の結果と合わせて決める。
各課題の答えを含む全体の結果は、[2026-11-17-assistant-models-maintainer-mac.json](2026-11-17-assistant-models-maintainer-mac.json) にある。

## 条件

| 項目 | 値 |
| --- | --- |
| 機種 | `Mac13,1` (Apple M1 Max) |
| メモリ | 68,719,476,736 バイト (64 GiB) |
| macOS | 27.0 |
| Aleph のコミット | `c3d953a` (計測の道具と課題の一揃いの版) |
| llama.cpp | `b12466`、`llama-b12466-bin-macos-arm64.tar.gz` (SHA-256 `1940fb9b…63441`) |
| golem | 0.1.0-rc4 (`golem check` の判定に使った) |
| Golem のマニュアル | `v0.1.0-rc4` の `03-markup.gm`、`04-manifest.gm`、`05-style.gm` |
| 課題 | 61 件 (style 12、manifest 12、gm 12、markdown 12、command 13)。欠かせない課題は各種類 2 件の 10 件 |
| 起動からの答えの回数 | 構成ごとに 5 回 |
| 計測の日時 | 2026-11-17 19:44 から 21:26 (日本時間) |

モデルは、unsloth の GGUF の Q4_K_M を、次のリビジョンで取った。
SHA-256 は、`bench/assistant/models.json` の値と一致した。

| モデル | リポジトリ | リビジョン |
| --- | --- | --- |
| Qwen3-0.6B | unsloth/Qwen3-0.6B-GGUF | `50968a4468ef4233ed78cd7c3de230dd1d61a56b` |
| Qwen3.5-0.8B | unsloth/Qwen3.5-0.8B-GGUF | `6ab461498e2023f6e3c1baea90a8f0fe38ab64d0` |
| Qwen3.5-2B | unsloth/Qwen3.5-2B-GGUF | `f6d5376be1edb4d416d56da11e5397a961aca8ae` |
| Qwen3.5-4B | unsloth/Qwen3.5-4B-GGUF | `e87f176479d0855a907a41277aca2f8ee7a09523` |

計測のコマンドは次のとおりである。
JSON は一時のファイルに書き、この記録に写した。

```sh
bench/assistant/run --out <一時のファイル>
```

## 結果

| モデル | コンテキスト | 起動からの答え 中央値 / p95 (ms) | 答え 中央値 / p95 (ms) | 最大の RSS (MB) | 待ちの RSS (MB) | 正解 | style | manifest | gm | markdown | command | 欠かせない課題 | GPU の層 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3-0.6B | 4096 | 4775 / 5643 | 2761 / 3955 | 999 | 999 | 11% | 8% | 42% | 0% | 8% | 0% | 2/10 | 29/29 |
| Qwen3-0.6B | 8192 | 9202 / 10227 | 8976 / 11836 | 1439 | 1416 | 8% | 0% | 33% | 0% | 8% | 0% | 1/10 | 29/29 |
| Qwen3.5-0.8B | 4096 | 5835 / 6743 | 3292 / 4049 | 845 | 805 | 21% | 50% | 33% | 0% | 17% | 8% | 2/10 | 25/25 |
| Qwen3.5-0.8B | 8192 | 7710 / 8097 | 7049 / 9629 | 910 | 910 | 20% | 33% | 42% | 0% | 17% | 8% | 3/10 | 25/25 |
| Qwen3.5-2B | 4096 | 7029 / 8561 | 6630 / 8858 | 1563 | 1525 | 30% | 50% | 25% | 25% | 42% | 8% | 3/10 | 25/25 |
| Qwen3.5-2B | 8192 | 11391 / 11495 | 12396 / 18435 | 1620 | 1577 | 23% | 42% | 25% | 17% | 33% | 0% | 2/10 | 25/25 |
| Qwen3.5-4B | 4096 | 18976 / 19173 | 15556 / 19486 | 3162 | 3114 | 69% | 75% | 75% | 75% | 58% | 62% | 7/10 | 33/33 |
| Qwen3.5-4B | 8192 | 28179 / 38356 | 33106 / 40363 | 3299 | 3243 | 67% | 67% | 83% | 67% | 58% | 62% | 6/10 | 33/33 |

「GPU の層」は、`llama-server` の記録の `offloaded N/M layers to GPU` である。
どの構成でも、すべての層が Metal (MTL0) に載った。

落ちた欠かせない課題は次のとおりである。

| モデル | コンテキスト | 落ちた欠かせない課題 |
| --- | --- | --- |
| Qwen3-0.6B | 4096 | style-size, manifest-title, gm-ruby, gm-strong, md-heading-space, md-bold-close, command-build, command-convert-md |
| Qwen3-0.6B | 8192 | style-line-pitch, style-size, manifest-title, gm-ruby, gm-strong, md-heading-space, md-bold-close, command-build, command-convert-md |
| Qwen3.5-0.8B | 4096 | style-size, manifest-blank-line, gm-ruby, gm-strong, md-heading-space, md-bold-close, command-build, command-convert-md |
| Qwen3.5-0.8B | 8192 | style-size, gm-ruby, gm-strong, md-heading-space, md-bold-close, command-build, command-convert-md |
| Qwen3.5-2B | 4096 | manifest-title, manifest-blank-line, gm-ruby, md-heading-space, md-bold-close, command-build, command-convert-md |
| Qwen3.5-2B | 8192 | style-size, manifest-blank-line, gm-ruby, gm-strong, md-heading-space, md-bold-close, command-build, command-convert-md |
| Qwen3.5-4B | 4096 | gm-strong, md-bold-close, command-convert-md |
| Qwen3.5-4B | 8192 | gm-strong, md-bold-close, command-build, command-convert-md |

## 選び方の規則を当てた結果

[ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) の規則 (欠かせない課題にすべて正解し、全体の正解が 70% 以上、どの種類も 50% 以上で、予算の三つを満たすもののうち、最大のメモリが最も小さいもの) を満たす構成は、この Mac では無かった。

- どの構成も、欠かせない課題のどれかに落ちた。
- 全体の正解の割合が 70% に最も近いのは、Qwen3.5-4B の 4096 (69%) である。
- Qwen3.5-4B は、最大の RSS が予算の 2048 MB を超えた (3162 MB と 3299 MB)。8192 では、答えの p95 も予算の 15000 ms を超えた。
- Qwen3.5-2B 以下は、予算の三つを満たした (Qwen3.5-2B の 8192 は、答えの p95 が 18435 ms で超えた) が、正解の割合が 30% 以下だった。

[ADR 0081](../adr/0081-assistant-with-local-llm-and-connectors.md) は、満たすものが無いときは実装を止め、選び方を変える ADR を書くと決めている。
ただし、標準の macOS のランナーの計測がまだ無いので、この記録だけでは結論にしない。

## 計測の注意

計測のあいだ、この Mac では別の作業 (ほかのリポジトリのビルド) が走っていた。
ロードアベレージは、計測の始めに 124.8 / 177.9 / 146.1 (1 分 / 5 分 / 15 分)、計測のあいだに最大で 236 前後、終わりに 135.8 / 145.0 / 146.4 だった。
各構成の始めと終わりのロードアベレージは、JSON の `loadAverage` にある。
同じ Qwen3-0.6B の 4096 の起動からの答えは、負荷の小さいときの試しの計測で 3.4 秒、この計測で中央値 4.8 秒だったので、時間の値は負荷のない Mac より大きく出ている見込みである。
正解の割合とメモリの値は、負荷の影響を受けにくい。

最大の RSS は、`ps -o rss=` を 100 ms ごとに読んだ最大値である。
Metal の GPU のメモリに置いた分が RSS にどう数えられるかは、確かめていない。
待ちの RSS は、最後の答えの 5 秒後の値である。
