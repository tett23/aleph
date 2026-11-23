# WebKit の禁則とぶら下げが Golem の規則を表せるか (2026-11-23)

## 問い

[ADR 0090](../adr/0090-editor-composition-settings.md) は、エディタの折り返しに、Golem が解決した禁則とぶら下げ組を反映すると決めた。
その前に、Golem の既存の呼び出し口と WebKit の描画を確かめ、設定値から表示への対応を固めることを求めている。
この調査は、そのうち WebKit の側として、CSS の `line-break` と `hanging-punctuation` で Golem の規則を表せるかを確かめる。

## Golem の規則

Golem のソース (`tett23/golem` のコミット `dc8bf92ec3`) を読んで確かめた規則は次のとおりである。

- `style.toml` の `[composition]` の `kinsoku` は `strict` か `loose` で、既定は `strict`。`hanging-punctuation` は真偽で、既定は偽 (`Style.hs` の `defaultComposition`)。
- 行頭禁止は、閉じ括弧、ハイフン類 (〜゠ など)、区切り約物 (？！)、中点類 (・：；)、句点 (。．)、読点 (、，)、繰り返し記号 (々ゝヽ など) である。`strict` のときだけ、長音記号 (ー) と小書きの仮名も行頭禁止にする (`Japanese.hs` の `lineStartProhibited`)。
- 行末禁止は、開き括弧である (`lineEndProhibited`)。
- ぶら下げの対象は、句点 (。．) と読点 (、，) だけである (`Japanese.hs` の `hang`)。

## 方法

使い捨ての WKWebView で、検査のページ ([probe.html](2026-11-23-webkit-kinsoku-probe/probe.html)) を開き、文字ごとの矩形を測った ([probe.swift](2026-11-23-webkit-kinsoku-probe/probe.swift))。

- 字の幅 (20px) から、ちょうど 4 文字が入る箱を作った。
- 行頭禁止の字は、5 文字目に置いた (「あいうえ」の後)。その字が行頭に来たら、禁則が外れたとみなした。
- 行末禁止の字 (開き括弧) は、4 文字目に置いた。その字の次が次の行に行ったら、禁則が外れたとみなした。
- `line-break` を `auto`、`strict`、`normal`、`loose`、`anywhere` に変え、横書きと縦書き (`writing-mode: vertical-rl`) で測った。
- ぶら下げは、`line-break: strict` のもとで `hanging-punctuation` を変え、5 文字目の句読点が箱の外にはみ出した幅を測った。

環境は macOS 27.0、WebKit 22625.1.29.11.27 である。
Tauri のアプリの中ではなく、同じ WebKit の WKWebView を単独で起こして測った。

## 結果

### 禁則

| `line-break` | 横書き | 縦書き |
| --- | --- | --- |
| `auto` | どの字も禁則が保たれた | どの字も禁則が保たれた |
| `strict` | どの字も禁則が保たれた | どの字も禁則が保たれた |
| `normal` | どの字も禁則が保たれた | どの字も禁則が保たれた |
| `loose` | どの字も禁則が保たれた | どの字も禁則が保たれた |
| `anywhere` | すべての字で禁則が外れた | すべての字で禁則が外れた |

- 禁則が保たれた場合は、前の字 (「え」) を次の行に送った (追い出し)。
- `loose` でも、小書きの仮名 (ぁっゃァッャ) と長音記号 (ー) は行頭に来なかった。そのため、Golem の `loose` (これらを行頭に許す) は、WebKit の `line-break: loose` では表せない。
- Golem の `strict` は、試したすべての字で WebKit の `strict` (と `auto`、`normal`) と同じ振る舞いになった。

### ぶら下げ

| `hanging-punctuation` | 横書き | 縦書き |
| --- | --- | --- |
| `none`、`last` | ぶら下げない (前の字を送る) | ぶら下げない |
| `allow-end`、`force-end`、`first allow-end last` | 句点と読点 (。．、，) が箱の外に 1 文字分ぶら下がる | 同じ |

- `allow-end` と `force-end` のどちらも、行に収まる句点はぶら下げなかった。
- 閉じ括弧 (」）) はぶら下げず、前の字を送った。
- ぶら下げる字は、Golem のぶら下げの対象 (句点と読点) と同じだった。

## 考察

- `kinsoku = "strict"` は `line-break: strict` で表せる見込みが高い。ただし、試したのは分類ごとに数文字ずつで、分類のすべての字ではない。
- `kinsoku = "loose"` は、WebKit の CSS だけでは表せない。小書きの仮名と長音記号を行頭に許すには、別の仕組みが要る。
- `hanging-punctuation = true` は `hanging-punctuation: allow-end` で表せる見込みが高い。ただし、囲みを持つ段落ではぶら下げない、という Golem の規則は、CSS の側で段落ごとに切り替える必要がある。
- いずれも、Aleph が Golem の解決した設定を受け取る口は、まだ無い (Golem の CLI と LSP に、`[composition]` を返す口が無い)。そのため、[ADR 0090](../adr/0090-editor-composition-settings.md) の実装には、先に Golem の側でその口を決める ADR が要る。

## 確かめていないこと

- 分類のすべての字と、分離禁止の字 (—…‥ など)。
- 欧文の語の境界と空白での禁則。
- Tauri のアプリの中の、実際のエディタの要素 (`.ed-content`) での振る舞い。
- 文字の大きさと書体を変えたときの振る舞い。

## 追記：`lang` の影響 (2026-11-23)

この調査の検査のページには `lang` が無かった。
Aleph の画面と同じ `lang="ja"` で測り直すと、`loose` と `normal` は小書きの仮名と長音記号を行頭に置き、`auto` が Golem の `loose` と同じ振る舞いになった。
そのため、上の「`kinsoku = "loose"` は、WebKit の CSS だけでは表せない」は、`lang` の無いページでの結果である。
測り直した結果は [エディタと同じ形の要素での禁則とぶら下げ](2026-11-23-editor-kinsoku-probe.md) にある。
