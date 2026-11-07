# ADR 0043: Golem の HTML を許可リストで組み立て直す

ステータス: 採択（未実装）

## 文脈

本文のプレビュー（[ADR 0010](0010-previews.md)）は、Golem が書いた `build/html/<章>.xhtml` から本文を取り出し、`innerHTML` に入れる。
取り出すときの消毒は、正規表現で `<script>`、`on…="…"`、`javascript:` を消すもので（[app/preview/xhtml.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/preview/xhtml.ts#L12-L17)）、2026-11-08 のセキュリティ監査（[docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md) の所見 2 と 8）は、次のものが素通りすることを確かめた。

- 引用符のない属性（`<img src=x onerror=…>`）、`<svg/onload=…>`
- 単引用符と実体参照の `javascript:`
- `<iframe srcdoc>`、`<object data>`

あわせて、`<img src>` を `..` や絶対パスで書けば、ワークスペースの外のファイルを画像として読める（[app/preview/render.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/preview/render.ts#L40-L41)）。
メンテナーは、監査の修正をすべて ADR にするよう求めた（2026-11-08）。

## 実装すること

- `chapterBody` の正規表現の消毒をやめる。`DOMParser` で XHTML を読み、本文の要素を、許可リストのタグと属性だけで組み立て直す。
- 許すタグ：Golem が書く本文の要素（`section`、`div`、`p`、`span`、`h1`〜`h6`、`a`、`em`、`strong`、`i`、`b`、`ruby`、`rt`、`rp`、`br`、`hr`、`ul`、`ol`、`li`、`blockquote`、`pre`、`code`、`table`、`thead`、`tbody`、`tr`、`th`、`td`、`figure`、`figcaption`、`img`、`sup`、`sub`、`small`）と、折りたたみの `details` と `summary`。そのほかのタグは、中の文字だけを残す。`script`、`style`、`iframe`、`object`、`embed`、`form`、`base`、`meta`、`link` は中身ごと落とす。
- 許す属性：`class`、`id`、`lang`、`dir`、`title`、`alt`、`colspan`、`rowspan`、`epub:type`（`data-epub-type` に移す）、`a` の `href`、`img` の `src`、`details` の `open`。`on…`、`style`、`srcdoc` などは落とす。
- `href` は、`#…`、相対のパス、`http:`、`https:` だけを残し、ほかは落とす。リンクを押したときの扱いは [ADR 0044](0044-navigation-from-the-preview.md) に従う。
- `img` の `src` は、`build/html` からの相対のパスで、解決した結果が `build/html` の下にあるものだけを `data-src` に移す。外を指すものは落とし、代替テキストを出す。

## 実装しないこと

- 汎用の HTML の消毒の部品を依存に足すこと（DOMPurify など）。Golem の出力に要るタグは限られるので、自前の許可リストで足りる。
- Golem の側の出力の変更。

## テスト設計

`node --test` で、テストを先に書いて失敗させてから実装する。`DOMParser` のない node では、テストのための小さな XHTML の読み方を使うか、消毒の関数を、要素の木を受ける部分と読む部分に分けて、木を受ける部分を確かめる。

- 監査の迂回のペイロード（引用符のない `onerror`、`<svg/onload>`、単引用符と実体参照の `javascript:`、`<iframe srcdoc>`、`<object data>`、`<script>`、`style` 属性）が、どれも残らないこと。
- ルビ、見出し、表、図、脚注のリンク（`#…`）、折りたたみ（`details` と `summary`、`open`）が残ること。
- `img` の `src` が、`build/html` の下なら `data-src` に移り、`..` で外に出るものと絶対パスが落ちること。
- 画面の確かめ方：見本の章の本文のプレビューが今までどおり出ること（ルビ、見出し、図）。

## トレードオフ

- Golem が新しいタグや属性を書くようになると、許可リストに足すまでプレビューに出ない。危ないものを通すより、出ないほうを選ぶ。

## 参考文献

- [docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md)
- OWASP, Cross Site Scripting Prevention Cheat Sheet：https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
