# ADR 0048: 引数とデータのファイルのパスをワークスペースの中に限る

ステータス: 採択（未実装）

## 文脈

2026-11-08 のセキュリティ監査（[docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md) の所見 7 と 9、重さ「低」）は、次の二つを指摘した。

- `golem fmt` には、プロジェクトからの相対のパスをそのまま渡す（[app/lsp/mount.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/lsp/mount.ts#L182)）。`-` で始まる名前のファイル（`-x.gm`）は、オプションとして読まれる。git には `--` を置いている。
- `.aleph/bookmarks.json` のパス（[app/bookmarkpanel.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/bookmarkpanel.ts#L43)）と、`plot.csv` の `file` 列（[app/plot/mount.ts](https://github.com/tett23/aleph/blob/b4ee3c4/app/plot/mount.ts#L30)）は、`../../..` でワークスペースの外を指せる。開いて見えるだけだが、書くには書き手の編集が要る。

メンテナーは、監査の修正をすべて ADR にするよう求めた（2026-11-08）。

## 実装すること

- golem と shem に渡すファイルのパスは、`./` を付けて、`-` で始まらない形にする。`golem fmt`、`golem new` の名前、`shem render` の PDF と出力のディレクトリが対象である。`golem new` の名前が `-` で始まるときは、作らずに知らせる。
- `.aleph/bookmarks.json` の `path`、`plot.csv` の `file`、ゴミ箱の `entry.json` の `original` は、読むときに正規化し、`..` でルートの外へ出るもの、絶対パス、`~` で始まるものを捨てる。捨てたものは、ブックマークでは「見つかりません」と同じ薄い行で出す。
- 正規化とルートの下かの判定は、DOM に触れない一つの関数（`underRoot(root, rel)`）にまとめ、ブックマーク、plot、ゴミ箱、[ADR 0043](0043-golem-html-sanitizer.md) の画像、[ADR 0047](0047-no-remote-images-in-previews.md) の画像で使う。

## 実装しないこと

- ファイル名に `-` で始まる名前を使えなくすること（作るのは書き手の自由）。
- 既存の `.aleph/bookmarks.json` を書き直して、外を指す項目を消すこと（読むときに捨てるだけ）。

## テスト設計

`node --test` で、テストを先に書いて失敗させてから実装する。

- `underRoot`：ルートの下の相対のパスを返すこと、`..` で外に出るもの、途中の `..` で一度外に出て戻るもの、絶対パス、`~` を拒むこと、`./` や `a/../b` を正規化すること。
- golem と shem の引数を組み立てる関数：`-x.gm` が `./-x.gm` になること。
- ブックマークと plot の `file` の読み込みで、外を指す項目が捨てられること。

## トレードオフ

- ワークスペースの外の原稿を指すブックマークや plot の行は使えなくなる。ブックマークと plot はワークスペースの中のものだけを扱う（[ADR 0025](0025-bookmarks.md)、[ADR 0013](0013-plot-and-gantt-chart.md) のとおり）。

## 参考文献

- [docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md)
