# ADR 0084: テストが読む文書の変更では、CI のビルドとテストを省かない

Status: accepted

## 文脈

[ADR 0080](0080-skip-app-checks-for-docs-only-changes.md) は、変更したファイルがすべて文書のパスに入るとき、CI の `app` のジョブ (ビルドとテスト) を省くと決めた。
決めた当時、ビルドとテストは `docs/` と README を読んでいなかった。

その後、[ADR 0082](0082-ui-names-and-glossary.md) の実装で、用語集のテストが文書を読むようになった。
このテストは、用語集の名前が画面の文字列とそろっているかと、仕様書に使わない名前が残っていないかを確かめる。
ところが、用語集や仕様書だけを変えるプルリクエストは、[ADR 0080](0080-skip-app-checks-for-docs-only-changes.md) で文書だけの変更とみなされ、`app` のジョブが走らない。
そのため、用語集や仕様書だけを変えて名前の決まりを破っても、CI はそれを見つけない。

本人の全リポジトリ共通の決まり (dotfiles ADR 0129) は、標準の構成の `docs/` のパスの中だけの変更でも、ビルドやテストの入力になるファイルの変更ではビルドとテストを省かないとしている。
この ADR は、テストが読む文書を、文書だけの変更から外すことを決める。

## 調査した事項

この節には、ソースで確かめたことだけを書く。
調べたコミットは [123f164](https://github.com/tett23/aleph/tree/123f16463585ec63f12bf8416a59ab7ac237676d) である。

- 用語集のテスト [glossary.test.ts](https://github.com/tett23/aleph/blob/123f16463585ec63f12bf8416a59ab7ac237676d/app/glossary.test.ts) は、`docs/glossary.md`、`docs/specifications.md`、`docs/adr/0082-ui-names-and-glossary.md` を読む (10 行、14 行、81 行)。
- ほかのテストの中の `docs/` は、`(docs/adr/0034)` のようにテストの名前やコメントで ADR を指すだけで、ファイルを読まない (`rg -n "docs/" app scripts --glob '*.test.ts'`)。
- 文書だけかを決める [scripts/docs-only.sh](https://github.com/tett23/aleph/blob/123f16463585ec63f12bf8416a59ab7ac237676d/scripts/docs-only.sh) は、`docs/glossary.md`、`docs/specifications.md`、`docs/adr/` の下を、文書のパスとして扱う。

## 実装すること

- テストが読む文書のパスを、文書のパスから外す。今は `docs/glossary.md`、`docs/specifications.md`、`docs/adr/0082-ui-names-and-glossary.md` である。これらを変えた変更では、`app` のジョブが走る。
- `scripts/docs-only.sh` は、これらのパスを、文書のパスの決まりより先に「文書でない」と判定する。
- テストが読む文書のパスを、テストのソースから拾うテストを足す。拾うのは、テストのファイル (`*.test.ts`) の中の、引用符で囲んだ `docs/` か `README` で始まり `.md` で終わる文字列とする。拾ったパスごとに、`scripts/docs-only.sh` が「文書でない」と判定することを確かめる。
- これで、新しいテストが文書を読むようになったときに `scripts/docs-only.sh` を直し忘れると、テストが落ちる。
- 仕様書の、文書だけの変更の説明に、テストが読む文書を外すことを書く。

[ADR 0080](0080-skip-app-checks-for-docs-only-changes.md) の文書のパスの一覧は、この ADR が補う。
採択した後、[ADR 0080](0080-skip-app-checks-for-docs-only-changes.md) のステータスに、補った部分を記録する。

## 実装しないこと

- テストが読む文書を、テストのソースから自動で `scripts/docs-only.sh` に足すこと。パスの一覧は手で書き、テストで食い違いを見つける。
- テストの名前やコメントの中の ADR の番号を、テストの入力とみなすこと。

## 不変条件

- I1: テストのファイルの中の、引用符で囲んだ `docs/` か `README` で始まり `.md` で終わる文字列のパスについて、`scripts/docs-only.sh` は `false` を出す。
- I2: テストが読まない文書のパスだけの変更について、`scripts/docs-only.sh` は今までどおり `true` を出す。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| `docs/glossary.md` だけ | `false` | I1 |
| `docs/specifications.md` だけ | `false` | I1 |
| `docs/adr/0082-ui-names-and-glossary.md` だけ | `false` | I1 |
| `docs/adr/0080-skip-app-checks-for-docs-only-changes.md` だけ | `true` | I2 |
| `docs/roadmap.md` と `README.md` | `true` | I2 |
| テストに `read("docs/roadmap.md")` を足し、`scripts/docs-only.sh` を直さない | I1 のテストが落ちる | I1 |
| テストのコメントに `(docs/adr/0034)` がある | 拾わない | I1 |

## 受けいれ条件

- A1: 用語集だけを変えるプルリクエストで、CI の `app` のジョブが走る。

## テスト設計

- I1 は、テストのファイルからパスを拾う関数と、拾ったパスを `scripts/docs-only.sh` に渡すテストで確かめる。拾う関数は、コメントの中の ADR の番号を拾わないことを、入力の例でテストする。名前は `ADR 0084 I1: …` とする。
- I2 と境界の表の行は、`scripts/test-docs-only.sh` に足す。
- A1 は、この ADR の実装のプルリクエストの後の、用語集だけを変える最初のプルリクエストで確かめる。それまでは、`scripts/docs-only.sh` に `docs/glossary.md` を渡したときに `false` を出すことで代える。

## トレードオフ

テストが読む文書の変更で `app` のジョブを走らせると、仕様書だけの直しでもビルドとテストに時間がかかる。
しかし、仕様書は用語集のテストの入力であり、省くと、決まりを破った仕様書がマージされる。
時間より、テストの意味を保つことを選ぶ。

## 参考文献

- [ADR 0080](0080-skip-app-checks-for-docs-only-changes.md)
- [ADR 0082](0082-ui-names-and-glossary.md)
- 本人の全リポジトリ共通の決まり (dotfiles の CLAUDE.md の「docs/ の構成」と「GitHub actions」、dotfiles ADR 0129)
