# ADR 0083: サイドバーのパネルのコマンドの ID を view.sidebar に変える

Status: accepted

## 文脈

[ADR 0082](0082-ui-names-and-glossary.md) は、画面の要素の名前を用語集にそろえ、コードの名前とコマンドの ID も変えた。
右サイドバーのパネルを開くコマンドは `view.right.<パネル>` から `view.rightSidebar.<パネル>` に変えた。
しかし、サイドバーのパネルを開くコマンド `view.left.<パネル>` は、[ADR 0082](0082-ui-names-and-glossary.md) の表に無かったので、そのまま残った。
「左」という古い呼び方がコマンドの ID に残ると、[ADR 0082](0082-ui-names-and-glossary.md) が避けたかった、二つの名前を対応づける負債が残る。

また、[ADR 0082](0082-ui-names-and-glossary.md) の実装は、コマンドパレットの最近使ったコマンドの記録 (`config.json` の `ui.recentCommands`) の古い ID も読みかえた。
この読みかえは [ADR 0082](0082-ui-names-and-glossary.md) に書かれていないので、この ADR で決めたことにする。

## 調査した事項

この節には、ソースで確かめたことだけを書く。
調べたコミットは [123f164](https://github.com/tett23/aleph/tree/123f16463585ec63f12bf8416a59ab7ac237676d) である。

- `view.left.<パネル>` の ID は、[palette.ts:197](https://github.com/tett23/aleph/blob/123f16463585ec63f12bf8416a59ab7ac237676d/app/palette.ts#L197) (ファイル、Git、診断、共有ライブラリ) と、[searchpanel.ts:237](https://github.com/tett23/aleph/blob/123f16463585ec63f12bf8416a59ab7ac237676d/app/searchpanel.ts#L237)、[keywordpanel.ts:119](https://github.com/tett23/aleph/blob/123f16463585ec63f12bf8416a59ab7ac237676d/app/keywordpanel.ts#L119)、[bookmarkpanel.ts:162](https://github.com/tett23/aleph/blob/123f16463585ec63f12bf8416a59ab7ac237676d/app/bookmarkpanel.ts#L162)、[trashpanel.ts:214](https://github.com/tett23/aleph/blob/123f16463585ec63f12bf8416a59ab7ac237676d/app/trashpanel.ts#L214) で登録している。
- 仕様書は、コマンドの ID の例に `view.left.search` を挙げている。
- 古い名前の読みかえは、[legacy-names.ts](https://github.com/tett23/aleph/blob/123f16463585ec63f12bf8416a59ab7ac237676d/app/legacy-names.ts) の一つのモジュールにある。キーの割り当て (`keyBindings`) と、最近使ったコマンド (`ui.recentCommands`) の ID を読みかえる。
- [ADR 0023](0023-command-palette.md) は、`view.left.*` の ID を決めた。

## 実装すること

- サイドバーのパネルを開くコマンドの ID を、`view.left.<パネル>` から `view.sidebar.<パネル>` に変える。
- 読みかえのモジュールに、`view.left.` から `view.sidebar.` への読みかえを足す。キーの割り当てと、最近使ったコマンドの両方で読みかえる。両方の ID があるときは、新しい ID を使う。
- 最近使ったコマンドの古い ID の読みかえを、この ADR の決定とする。読みかえた結果、同じ ID が二つになるときは、最初の一つだけを残す。
- 仕様書のコマンドの ID の例を `view.sidebar.search` に直し、読みかえの説明に `view.left.` を足す。
- [ADR 0023](0023-command-palette.md) の `view.left.*` の ID は、この ADR が変える。採択した後、[ADR 0023](0023-command-palette.md) のステータスに、変えた部分を記録する。

## 実装しないこと

- ほかのコマンドの ID を変えること。

## 不変条件

- I1: `app/` のソース (テストと読みかえのモジュールを除く) に、`view.left.` は現れない。
- I2: 古い ID `view.left.<パネル>` のキーの割り当ては、`view.sidebar.<パネル>` の割り当てとして読まれる。両方あるときは、新しい ID の割り当てが残る。
- I3: 最近使ったコマンドの古い ID は新しい ID として読まれ、同じ ID は一つだけ残る。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| `keyBindings` が `{ "view.left.search": ["Mod-Shift-f"] }` | `{ "view.sidebar.search": ["Mod-Shift-f"] }` | I2 |
| `keyBindings` に `view.left.git` と `view.sidebar.git` の両方 | `view.sidebar.git` の割り当てだけが残る | I2 |
| `recentCommands` が `["view.left.git", "view.sidebar.git"]` | `["view.sidebar.git"]` | I3 |
| `recentCommands` が空 | 空 | I3 |
| `app/searchpanel.ts` に `view.left.search` が残る | テストが落ちる | I1 |

## 受けいれ条件

- A1: `view.left.search` に ⌘⇧F 以外のキーを割り当てた `config.json` で起動すると、そのキーで検索のパネルが開く。

## テスト設計

- I2 と I3 は、読みかえのモジュールのテストで、境界の表の行を確かめる。名前は `ADR 0083 I2: …` とする。
- I1 は、`app/` のソースから `view.left.` を探すテストで確かめる。
- A1 は、古い ID のキーの割り当てを持つ `config.json` を読み込み、そのキーから引いたコマンドが `view.sidebar.search` になることを、キーの割り当ての表を組む関数のテストで自動で確かめる。名前は `ADR 0083 A1: …` とする。

## トレードオフ

ID を変えると、書き手がプラグインや手で書いた設定で `view.left.*` を使っていれば、その設定は読みかえを通るまで効かない。
読みかえは `config.json` のキーの割り当てと最近使ったコマンドだけに当たるので、プラグインが ID を名指しして呼ぶ場合は、プラグインの側を直す必要がある。
今のプラグインの口 ([ADR 0017](0017-aleph-plugins.md)) は、コマンドを登録する `registerCommand` だけを持ち、ほかのコマンドを ID で呼ぶ手段を持たない ([host.ts:36](https://github.com/tett23/aleph/blob/123f16463585ec63f12bf8416a59ab7ac237676d/app/plugins/host.ts#L36))。そのため、プラグインへの影響は無い。

## 参考文献

- [ADR 0017](0017-aleph-plugins.md)
- [ADR 0023](0023-command-palette.md)
- [ADR 0082](0082-ui-names-and-glossary.md)
