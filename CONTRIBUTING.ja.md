# aleph への貢献

[English](CONTRIBUTING.md)

英語版が正です。
CONTRIBUTING.ja.md はその機械翻訳です。

## 開発環境

[adr-guard](https://github.com/tett23/adr-guard) v0.9.1 以降を入れ、clone したあとに git の hook を有効にします。
この設定はリポジトリに保存されないので、clone ごとに実行します。

```sh
cargo install --git https://github.com/tett23/adr-guard --tag v0.9.1
git config core.hooksPath .githooks
```

アプリケーションのツールチェーン（Rust、Node.js、Tauri）は ADR で決めます。

## 変更の進め方

1. ADR を書き、レビューを受けます。レビューの前に ADR をコミットしません。
2. ADR のテスト設計のテストを書き、失敗することを確かめます。
3. 変更を実装し、テストを通します。
4. 同じプルリクエストで docs/specifications.md と README を更新します。
5. ブランチを push し、プルリクエストを開きます。
6. CI が通ったら、マージコミット（`--no-ff`）で `main` にマージします。

誤字の修正と、仕様を変えない文書の修正には ADR は要りません。

## ADR

- ADR は `docs/adr/` に置き、`0001-scope-and-formats.md` のように連番と読める kebab-case の名前を付けます。
- ADR は、`ステータス:` で始まるステータスの行をちょうど一つ持ちます。
- コミット済みの ADR は、ステータスの行とリンクを除いて変えません。adr-guard が pre-commit hook と CI でこれを強制します。決定を変えるときは、古い ADR を置きかえる新しい ADR を書きます。
- ADR を破棄するときは、ステータスを `破棄` にし、理由を docs/specifications.md に書きます。
- ADR からソースコードを参照するときは、コミットのハッシュを含む GitHub の URL で書きます。`main` は rebase しないので、この URL は変わりません。
- ADR は、決定に使った文献を末尾に挙げます。
- ADR や文書を書いたあとは、`adr-guard links --fix` を実行して ADR の参照にリンクを付けます。

## 言語

- コミットメッセージ、リリースノート、CHANGELOG は英語で書きます。
- ADR と docs/specifications.md は日本語で書きます。
- README.md と CONTRIBUTING.md は英語で書き、英語版を正とします。README.ja.md と CONTRIBUTING.ja.md はその機械翻訳です。英語版を変えるコミットは、同じコミットで翻訳も更新します。
- commit-msg hook と CI がこれを検査します。リンクの修正など、翻訳に影響しない変更では、コミットメッセージの最後の段落に `Translation-Unchanged: <理由>` のトレーラーを付けます。

## コード

- Rust では関数型のスタイルを優先します。
- TypeScript ではクラスを使いません。
- ライセンスに問題がなくここで書けるもののために、依存を足しません。ここで書き、本家と同じくらい厚いテストを付けます。
- コミットするスクリプトは、Linux の GNU 版の道具だけでなく、macOS の BSD 版の道具でも動くようにします。
- 不安定なテストを通るまで再実行しません。原因を見つけて直します。

## Git

- `main` を rebase しません。ブランチはマージされるまで rebase してかまいません。
- `--no-ff` でマージします。
- `v` で始まるタグはリリースです。`v0.1.0-rc1` のようなタグはプレリリースです。
- リリースノートは GitHub Releases に、追加、変更、削除、修正に分けて書きます。各変更には、そのプルリクエストと ADR を添え、ADR へのリンクは絶対リンクにします。
