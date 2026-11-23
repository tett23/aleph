# エディタと同じ形の要素での禁則とぶら下げ (2026-11-23)

## 問い

[WebKit の禁則とぶら下げの調査](2026-11-23-webkit-kinsoku-and-hanging.md) は、`lang` の無いページの `div` の箱で測った。
しかし、Aleph の画面は `<html lang="ja">` で、WebKit は `lang` が日本語のときだけ、`line-break` の日本語の規則を使う。
この調査は、エディタと同じ形の要素を `lang="ja"` のページに置き、Aleph が当てる値で Golem の規則を表せるかを確かめる。

## 方法

使い捨ての WKWebView (Tauri が macOS で使う WebKit の部品) で、検査のページ ([probe.html](2026-11-23-editor-kinsoku-probe/probe.html)) を開き、文字ごとの矩形を測った ([probe.swift](2026-11-23-editor-kinsoku-probe/probe.swift))。
動かし方は `swiftc -O probe.swift -o probe && ./probe "$PWD/probe.html"` である。

- ページは `<html lang="ja">` とした。
- 要素は、エディタと同じく `contenteditable` の `.ed-content` の中に、行ごとの `.ed-line` を置いた。`.ed-content` には、`app/style.css` と同じ `white-space`、`overflow-wrap`、`word-break`、`line-height`、`max-inline-size`、`padding-inline-end` を付けた。
- 1 行の字数 (`--chars`) は 4 とした。
- 値は、`app/composition.ts` の `styleOf` と同じ写し方 (`strict` は `strict`、`loose` は `auto`、ぶら下げは `allow-end`) で求め、`setProperty` で当てた。比べのために、`line-break` を指定しない場合と、`normal`、`loose` を直に当てた場合も測った。
- 字と置き方は、前の調査と同じである。行頭禁止の字を 5 字目に、行末禁止の字 (開き括弧) を 4 字目に置いた。試したのは、10 の分類の 29 字である。
- ぶら下げは、5 字目の句読点と閉じ括弧が、本文の端と、余白を含む要素の端からどれだけ出たかを測った。

環境は、前の調査と同じ macOS 27.0、WebKit 22625.1.29.11.27 である。

## 結果

横書きと縦書きは、同じ結果になった。

| `line-break` | 禁則が外れた字 (29 字のうち) |
| --- | --- |
| `strict` (Golem の `strict` の写し先) | 無し |
| `auto` (Golem の `loose` の写し先) と、指定しない場合 | ー ぁっゃァッャ |
| `normal` | 〜゠ ー ぁっゃァッャ |
| `loose` | 〜゠？！・：；々ゝヽ ー ぁっゃァッャ |

- Golem の `strict` は、`line-break: strict` と同じ振る舞いになった。
- Golem の `loose` (長音記号と小書きの仮名だけを行頭に許す) は、`line-break: auto` と同じ振る舞いになった。`normal` と `loose` は、Golem の `loose` が行頭に許さない字も行頭に置いた。
- ぶら下げ：`strict` とぶら下げでは、句点と読点 (。、．，) が同じ行に残り、文字の大きさ 20px のとき本文の端から 18px 出た。出た字は、余白を含む要素の中に収まった。閉じ括弧 (」) はぶら下げなかった。ぶら下げない `strict` では、どの字も本文の端を越えなかった。
- 前の調査が「`loose` でも小書きの仮名と長音記号は行頭に来なかった」としたのは、ページに `lang` が無かったためである。`lang` が無いと、WebKit は `line-break` の値によらず、これらを行頭に置かなかった。

## 確かめていないこと

- 試した 29 字のほかの字と、分離禁止の字 (—…‥ など)。
- `lang` を `ja` のほかにしたときの振る舞い。
