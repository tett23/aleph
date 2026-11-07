# aleph

aleph は、Golem（https://github.com/tett23/golem ）の原稿を書くためのエディタとプレビューの環境である。
Tauri で作る。ライセンスは MIT とする。
編集できる形式は md、gm、emet、csv、tsv、toml、json、jsonc、json5、jsonl、svg、pdf、mermaid である。

## ディレクトリ構成

- **docs/specifications.md** 今の振る舞いを定める仕様書。日本語で書く。ADR を参照するときはリンクを付ける。
- **docs/adr/** ADR を置く。ファイル名は `0001-feature-details.md` のように連番の prefix と kebab-case の名前を付ける。内容はグローバルの CLAUDE.md の構成（ステータス、文脈、実装すること、実装しないこと、テスト設計、トレードオフ、参考文献）に従う。日本語で書く。
  - コミット済みの ADR はステータスの行とリンクを除き変更不可（adr-guard が強制する）。変更が必要な場合は新たな ADR を作成する。
  - 同じディレクトリで ADR の番号を重複させない（CI が `adr-guard check-numbers` で検査する）。
  - ほかのリポジトリの ADR を参照するときは、`[tett23/adr-guard ADR 0019: ...](https://github.com/...)` のように修飾子ごとリンクのテキストに入れる（adr-guard は `ADR NNNN` の直前の語を修飾子として読む）。
  - ADR は行頭が `ステータス:` のステータスの行をちょうど一つ持つ。
  - ADR からソースコードを参照するときは、コミットのハッシュを含む GitHub の URL で書く。Golem のコードを参照するときも同じ。
- **docs/audit/**、**docs/benchmarks/** 監査と性能計測の記録。コミット済みのものは変更、削除、移動不可。
- **scripts/** 検査の道具。コミットするスクリプトは macOS の BSD 版の道具でも動くように書く。

## 文書の言語

- README.md と CONTRIBUTING.md は英語で書き、英語版を正とする。
- README.ja.md と CONTRIBUTING.ja.md は英語版の機械翻訳である。英語版を変えるときは、同じコミットで日本語版も訳し直す（commit-msg hook と CI が検査する）。日本語版だけを直すのは、訳の誤りを直すときに限る。
- ADR と docs/specifications.md は日本語で書く。コミットメッセージ、リリースノート、CHANGELOG は英語で書く。

## 実装の約束

- Rust の側は関数型のスタイルを優先する。TypeScript の側ではクラスを使わない。
- 依存は増やさない。ライセンスに問題がなく再実装が容易なものは、自前で書き、テストを厚く書く。
- Golem の機能（組版、LSP など）は Golem の側にあるものを使い、このリポジトリで作り直さない。

## skills

- 日本語の文章を書くときは cognitive-rhythm-writing と japanese-tech-writing のスキルを使用する。
