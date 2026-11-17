# ADR 0082: 画面の要素の名前を決め、用語集にまとめる

Status: accepted

## 文脈

Aleph の画面の要素は、同じものが場所によって違う名前で呼ばれている。
画面の文言、コマンドの名前、仕様書、ADR のあいだで、名前がそろっていない。
そのため、書き手は「どこを押せばよいか」を文章から探しにくく、ADR を書く側も毎回「以下、〜と呼ぶ」と断っている。
[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) が画面の下の区画に新しいタブを足すので、その前に名前を決めたい。

この ADR は、画面の要素の正式な名前と英語の名前を決め、`docs/glossary.md` (以下、用語集) にまとめる。
画面の文言、仕様書、コードの名前は、この名前に合わせる。
コードの名前だけが古いまま残ると、読む人が二つの名前を対応づけ続けることになり、負債になるからである。

## 調査した事項

この節には、ソースと文書で確かめたことだけを書く。
調べたコミットは [02b966a](https://github.com/tett23/aleph/tree/02b966a835c5c49a0ae18137310a9cf2cc4978f6) である。
`app/` の画面の文言、`docs/specifications.md`、`docs/adr/` の語を、`rg` で数えて比べた。

名前の食い違いは、次のとおりである。

| 要素 | 使われている名前 | 根拠 |
| --- | --- | --- |
| 画面の下の区画 | 「問題のパネル」、「下部パネル」、「問題パネル」、「問題の一覧」 | コマンドの名前 [problemsmount.ts:176](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/problemsmount.ts#L176)、仕様書の「下部パネル」(1 か所) と「問題のパネル」(9 か所)、[ADR 0069](0069-build-log-and-reveal.md) の「問題パネル」、[ADR 0055](0055-problems-panel.md) の「問題の一覧」 |
| 右の区画 | 「右のパネル」 | ツールバーの文言 [shell.ts:161](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/ui/shell.ts#L161)、[ADR 0005](0005-layout-and-appearance.md) |
| 左の区画 | 「サイドバー」、「左のサイドバー」 | [shell.ts:155](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/ui/shell.ts#L155)、仕様書 |
| ファイルの木 | 「ファイル」、「ファイルツリー」、「ツリー」、「ファイルのツリー」 | リボンの文言 [shell.ts:17](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/ui/shell.ts#L17)、設定の節の名前 [tree.ts:450](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/ui/tree.ts#L450)、仕様書 (「ツリー」だけ)、[ADR 0077](0077-hand-sidebar-files-outside.md) から [ADR 0079](0079-read-titles-again-on-save.md) |
| 画面の右下に出る知らせ | 「通知」、「トースト」 | 関数 [`toast`](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/ui/dom.ts#L8) と [`notify`](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/ui/notices.ts#L35)、仕様書は「通知」が主 |
| ⌘P の入力欄 | 「コマンドパレット」、「パレット」、「クイックオープン」 | [ADR 0023](0023-command-palette.md)、[ADR 0022](0022-quick-open.md)、[ADR 0026](0026-recent-files.md) |
| ツールバーの「…」 | 「ほかの操作」、「ツールバーのメニュー」 | 画面の文言 [shell.ts:160](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/ui/shell.ts#L160)、仕様書 |
| エディタとプレビューの二つの区画 | 呼び名が無い (仕様書の「ペイン」は、エディタの枠の一つを指す) | 仕様書の「画面の構成」と「タブと分割」の節 |
| サイドバーの上の帯 | 呼び名が無い (「ワークスペースの名前」とだけ書く) | 仕様書 |

画面の下の区画は、「問題」と「通知」のタブと、ビルドの記録があるときだけ出る「ビルドログ」のタブを持つ ([problemsmount.ts:89-98](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/problemsmount.ts#L89-L98))。
そのため、「問題のパネル」という名前は中身と合わない。
仕様書の下の区画の節は、「ビルドログ」のタブを書いていない。
画面の下の区画は、エディタの領域とプレビューの領域の両方の下、ステータスバーの上にある ([shell.ts:61-67](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/ui/shell.ts#L61-L67))。
ステータスバーは、中央の列の中にあり、リボンとサイドバーの下には広がらない。

`app/` で「右のパネル」と「問題のパネル」が画面の文言に出るのは、次の 8 か所である (`rg -n '右のパネル|問題のパネル' app/`)。

- [problemsmount.ts:171](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/problemsmount.ts#L171)、[problemsmount.ts:176](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/problemsmount.ts#L176)
- [projectbuildmount.ts:58](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/projectbuildmount.ts#L58)
- [diag/mount.ts:118](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/diag/mount.ts#L118)
- [palette.ts:207](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/palette.ts#L207)、[palette.ts:208](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/palette.ts#L208)
- [shell.ts:161](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/ui/shell.ts#L161)
- [keywordpanel.ts:49](https://github.com/tett23/aleph/blob/02b966a835c5c49a0ae18137310a9cf2cc4978f6/app/keywordpanel.ts#L49)

「パネル」は、左右の区画に出す中身 (型 `Panel`) と、下の区画の両方に使われている。
コマンド `view.problems` の名前「問題のパネル」は [ADR 0055](0055-problems-panel.md) が、右の区画の名前「右のパネル」は [ADR 0005](0005-layout-and-appearance.md) が決めた。

## 実装すること

### 名前の決め方

名前は、次の三つの決まりで選ぶ。

- 区画 (画面を分けた場所) と、区画に出す中身を、別の語で呼ぶ。区画は「サイドバー」「右サイドバー」「下部パネル」などで、中身は「〜のパネル」「〜のタブ」などである。区画の名前が「下部パネル」のように「パネル」を含むときは、その区画の中身を「パネル」と呼ばない。
- 画面に今出ている文言を、なるべく正式な名前にする。書き手がすでに目にしている語だからである。
- 一つの名前は、一つの要素だけを指す。「〜のタブ」のように、ほかの名前を含む名前は、別の名前として数える。

### 決める名前

正式な名前、英語の名前、コードの名前は次のとおりとする。

- 「画面の文言」は、かぎ括弧で囲んだ、ボタンの表示、ツールチップ、コマンドの名前に使う文字列か、「(無し)」である。
- 「英語の名前」は、README の英語版と、コードの名前の元にする名前である。
- 「コードの名前」は、この ADR の実装の後の、CSS のクラス、`data-*` の属性、`ctx` の鍵、型、関数の名前である。英語の名前から作る (CSS と属性の値はケバブケース、型はパスカルケース、鍵と関数はキャメルケース)。
- 「今のコードの名前」は、この ADR の実装で変える、今の名前である。
- 「使わない名前」は、その要素を指して、画面の文言と仕様書で使わない名前である。

| 正式な名前 | 英語の名前 | 指すもの | 画面の文言 | コードの名前 | 今のコードの名前 | 使わない名前 |
| --- | --- | --- | --- | --- | --- | --- |
| リボン | Ribbon | 左端の縦のアイコンの列 ([ADR 0005](0005-layout-and-appearance.md)) | (無し) | `.ribbon` | (無し) | (無し) |
| サイドバー | Sidebar | 左の区画。左右をまとめて言うときは「サイドバーと右サイドバー」と書く | 「サイドバー」 | `.sidebar`、`ctx.sidebar`、型 `SidebarPanelId` | `.side`、`ctx.left`、型 `LeftPanel` | 「左のサイドバー」 |
| ワークスペースバー | Workspace bar | サイドバーの上の、ワークスペースの名前とブランチの帯 | (無し) | `.workspace-bar` | `.wsbar` | (無し) |
| パネル | Panel | サイドバーと右サイドバーに出す中身の一つ。「ファイルのパネル」「検索のパネル」のように呼ぶ | (無し) | 型 `Panel` | (無し) | (無し) |
| ファイルのパネル | Files panel | ファイルツリーとその上のボタンを出すパネル | 「ファイル」 | `ctx.sidebar.files` | `ctx.left.files` | (無し) |
| ファイルツリー | File tree | ファイルのパネルの、ファイルとフォルダの木 | 「ファイルツリー」 | `.file-tree` | `.tree` | 「ファイルのツリー」 |
| 右サイドバー | Right sidebar | 右の区画 | 「右サイドバー」 | `.right-sidebar`、`ctx.rightSidebar`、型 `RightSidebarPanelId` | `.right`、`ctx.right`、型 `RightPanel` | 「右のパネル」 |
| ツールバー | Toolbar | 中央の列の上端の帯 | (無し) | `.toolbar` | (無し) | (無し) |
| ほかの操作 | More actions | ツールバーの「…」のメニュー | 「ほかの操作」 | `data-toolbar="more-actions"` | `data-tb="more"` | 「ツールバーのメニュー」 |
| エディタの領域 | Editor area | 中央の列の左の区画。ペインを並べる | (無し) | `.editor-area`、`ctx.view.editorArea` | `.main-pane`、`ctx.view.main` | (無し) |
| ペイン | Pane | エディタの領域を左右に分けた一つ。タブの並びを持つ ([ADR 0024](0024-tabs-and-split.md)) | (無し) | `.pane` | `.epane` | (無し) |
| タブ | Tab | ペインの中の、開いたもの (シート、まとめて開いた章、プロット) の一つ | (無し) | `.tab` | (無し) | (無し) |
| プレビューの領域 | Preview area | 中央の列の右の区画。本文、ページ、プレビューを出す | (無し) | `.preview-area`、`ctx.view.previewArea`、型 `PreviewMode` | `.side-pane`、`ctx.view.side`、型 `SidePane` | (無し) |
| 下部パネル | Bottom panel | エディタの領域とプレビューの領域の下、ステータスバーの上の区画。下部パネルのタブで中身を切り替える | 「下部パネル」 | `.bottom-panel`、`ctx.view.bottomPanel` | `.problems-panel`、`ctx.view.problems` | 「問題のパネル」、「問題パネル」 |
| 下部パネルのタブ | Bottom panel tab | 下部パネルの中身を切り替える見出しの一つと、その中身 | (無し) | `.bottom-panel-tab` | `.ptab` | (無し) |
| 問題のタブ | Problems tab | 下部パネルのタブの一つ。診断の一覧 | 「問題」 | `data-tab="problems"` | (無し) | 「問題の一覧」 |
| 通知のタブ | Notifications tab | 下部パネルのタブの一つ。通知の履歴 | 「通知」 | `data-tab="notifications"` | `data-tab="notes"` | (無し) |
| ビルドログのタブ | Build log tab | 下部パネルのタブの一つ。手動のビルドの記録で、ビルドした後だけ出る | 「ビルドログ」 | `data-tab="build-log"` | `data-tab="build"` | (無し) |
| ステータスバー | Status bar | 中央の列の下端の帯 | (無し) | `.status-bar` | `.status` | (無し) |
| 通知 | Notification | Aleph が書き手に知らせる一件の知らせ ([ADR 0064](0064-unified-notifications.md)) | (無し) | `notify` | (無し) | (無し) |
| トースト | Toast | 通知を画面の右下に出したもの | (無し) | `.toasts` | (無し) | (無し) |
| コマンドパレット | Command palette | ⌘P と ⇧⌘P で開く入力欄 ([ADR 0023](0023-command-palette.md)) | 「コマンドパレット」 | `.command-palette`、`openCommandPalette` | `.palette`、`openPalette` | (無し) |
| クイックオープン | Quick open | コマンドパレットで、シートを名前で探して開く使い方 | (無し) | (無し) | (無し) | (無し) |
| メニュー | Menu | 右クリックやボタンで開く、項目の縦の並び | (無し) | `.menu` | (無し) | (無し) |
| ダイアログ | Dialog | 画面を暗くして前に出す、画面の中の小さなウィンドウ (名前の入力、確認、選択、食い違いの解消) | (無し) | `.dialog` | `.modal` | (無し) |
| ネイティブのダイアログ | Native dialog | Rust の側が出す macOS のダイアログ (保存、フォルダの選択、承認) | (無し) | (無し) | (無し) | (無し) |
| 設定のダイアログ | Settings dialog | 設定を変えるダイアログ。その中の一つを「〜の節」と呼ぶ | 「設定」 | `openSettingsDialog` | `openSettings` | (無し) |

### 画面の文言を直す

正式な名前と画面の文言が食い違うところを、次のように直す。

| 今の文言 | 直した文言 | 場所 |
| --- | --- | --- |
| 「右のパネル」 | 「右サイドバー」 | ツールバーのボタンのツールチップ |
| 「右のパネルを出し入れ」 | 「右サイドバーを出し入れ」 | コマンド `view.toggleRight` の名前 |
| 「右のパネル：〜」 | 「右サイドバー：〜」 | コマンド `view.right.*` の名前 |
| 「右のパネルの「添付」で、シートにキーワードを付けます。」 | 「右サイドバーの「添付」で、シートにキーワードを付けます。」 | キーワードのパネルの、空のときの文 |
| 「問題のパネル」 | 「下部パネル」 | コマンド `view.problems` の名前 |
| 「問題のパネル（⇧⌘M）」 | 「下部パネル（⇧⌘M）」 | ステータスバーの「エラー n　警告 m」のツールチップ |
| 「〜 の結果を問題のパネルに出す」 | 「〜 の結果を下部パネルに出す」 | ステータスバーの lint と preflight のツールチップ |
| 「問題のパネルを開く」 | 「下部パネルを開く」 | ビルドの失敗の通知のボタン |
| 設定の節の名前の「ファイルツリー」 | (変えない) | 設定のダイアログ |

### コードの名前を直す

上の表の「今のコードの名前」を、「コードの名前」に変える。
状態、保存する画面の状態、コマンドの ID も、同じ考えで次のように変える。

| 種類 | 今の名前 | 新しい名前 |
| --- | --- | --- |
| 状態と保存する画面の状態 (`config.json` の `ui`) | `left`、`showLeft` | `sidebarPanel`、`showSidebar` |
| 同上 | `right`、`showRight` | `rightSidebarPanel`、`showRightSidebar` |
| 同上 | `side` | `previewMode` |
| 保存する画面の状態 | `showProblems`、`problemsHeight`、`problemsTab` | `showBottomPanel`、`bottomPanelHeight`、`bottomPanelTab` |
| 保存する画面の状態の値 (`bottomPanelTab`) | `notes`、`build` | `notifications`、`build-log` |
| コマンドの ID | `view.toggleLeft`、`view.toggleRight` | `view.toggleSidebar`、`view.toggleRightSidebar` |
| 同上 | `view.right.<パネル>` | `view.rightSidebar.<パネル>` |
| 同上 | `view.problems` | `view.bottomPanel` |

書き手の保存した状態とキーの割り当てを失わないよう、`config.json` を読むときに古い名前を新しい名前に読みかえる。

- `ui` に古い鍵だけがあれば、その値を新しい鍵の値として読む。両方あれば、新しい鍵の値を使う。
- `keyBindings` の古いコマンドの ID は、新しい ID に読みかえる。両方あれば、新しい ID の割り当てを使う。
- 書くときは、新しい名前だけを書く。古い名前は、次に書くときに消える。
- 読みかえの表は、一つのモジュールにまとめ、ほかの場所に古い名前を書かない。

この ADR は、[ADR 0055](0055-problems-panel.md) のコマンドの名前と、[ADR 0005](0005-layout-and-appearance.md) の右の区画の名前を変える。
採択した後、両者のステータスを `superseded` にし、変えた部分を記録する。

### 用語集

`docs/glossary.md` を置き、上の「決める名前」の表を載せる。

- 仕様書と、これから書く ADR と README は、用語集の正式な名前を使う。
- 「ファイルツリー」は、同じ段落でくり返すときに限り「ツリー」と略してよい。
- 新しい画面の要素を足す ADR は、その実装で用語集にも名前を足す。アシスタントのタブは、[ADR 0081](0081-assistant-with-local-llm-and-connectors.md) の実装で足す。
- コミット済みの ADR は直さない。

仕様書は、この ADR の実装で、使わない名前を正式な名前に直す。
仕様書の下部パネルの節には、「ビルドログ」のタブも書く。

## 実装しないこと

- 画面の要素の配置や見た目を変えること。
- 画面の文言を英語にすること。英語の名前は、README の英語版とコードの名前に使う。
- コミット済みの ADR の語を直すこと。

## 不変条件

ここで、**画面の文字列**は、`app/` の `.ts` の中の、`title="…"`、`label: "…"`、`placeholder="…"` の値と、HTML のテンプレートの中のタグの外の文字とする。
コメント、クラス名、属性の名前は含まない。

- I1: 用語集の表の「画面の文言」の列の、かぎ括弧の中の文字列は、どれも画面の文字列のどこかに、その形で現れる。
- I2: 用語集の表の「使わない名前」の列の、かぎ括弧の中の文字列は、画面の文字列にも、仕様書にも、部分の文字列として現れない。
- I3: 用語集の正式な名前は互いに等しくなく、英語の名前も互いに等しくない。
- I4: 用語集の表の「今のコードの名前」の列と、上の「コードの名前を直す」の表の「今の名前」の列の名前は、読みかえの表のモジュールのほかでは、`app/` と `src-tauri/` のソース (テストを除く) に現れない。
- I5: 古い名前だけを持つ `config.json` を読んで書くと、同じ値が新しい名前で残り、古い名前は残らない。古い名前と新しい名前の両方があるときは、新しい名前の値が残る。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| 下部パネルの行の画面の文言「下部パネル」 | `app/problemsmount.ts` の画面の文字列に現れる | I1 |
| 画面の文言が「(無し)」の行 | 検査しない | I1 |
| `app/` の `label:` に「問題のパネル」が残っている | テストが落ちる | I2 |
| `app/` のコメントに「問題のパネル」がある | 検査しない | I2 |
| 仕様書に「右のパネル」が残っている | テストが落ちる | I2 |
| 使わない名前が「(無し)」の行 | 検査しない | I2 |
| 用語集に「パネル」の行が二つある | テストが落ちる | I3 |
| 「タブ」と「下部パネルのタブ」の行がある | 等しくないので通る | I3 |
| 英語の名前「Panel」が二つの行にある | テストが落ちる | I3 |
| `app/` に `ctx.left` が残っている | テストが落ちる | I4 |
| 読みかえの表のモジュールに `showLeft` がある | 通る | I4 |
| `ui` が `{ "showLeft": false }` だけ | 読んで書いた後は `{ "showSidebar": false }` | I5 |
| `ui` が `{ "showLeft": false, "showSidebar": true }` | `showSidebar` は `true` | I5 |
| `ui` が空 | 既定の値を使い、古い名前を書かない | I5 |
| `keyBindings` が `{ "view.problems": […] }` | `view.bottomPanel` に同じ割り当てがある | I5 |
| `ui.problemsTab` が `"notes"` | `bottomPanelTab` が `"notifications"` | I5 |

## 受けいれ条件

- A1: `docs/glossary.md` があり、上の表の名前がすべて載っている。
- A2: 仕様書に、用語集の使わない名前が現れない。
- A3: 画面で、ツールバーの右端のボタンのツールチップが「右サイドバー」と出る。
- A4: コマンドパレットで「下部パネル」と打つと、`view.bottomPanel` が見つかる。
- A5: rc7 で下部パネルを開き、右サイドバーを閉じてから、この ADR の実装の版で開くと、同じ状態で開く。

## テスト設計

- 用語集の表を読むテストを TypeScript で書く。表を Markdown から読み、I1、I2、I3 を確かめる。名前は `ADR 0082 I1: …` とする。
- 画面の文字列を取り出す関数を、コメント、クラス名、属性の名前を含む入力でテストする。
- A1 は、用語集の行の数と、この ADR の表の行の数を比べるテストで確かめる。
- A2 は、I2 のテストが仕様書も読むことで確かめる。
- I4 は、二つの表の名前を `app/` と `src-tauri/` から探すテストで確かめる。CSS のクラスは `class="` の値と `app/style.css` のセレクタで、`ctx` の鍵と関数は識別子として探す。
- I5 は、読みかえの関数を、境界の表の `config.json` でテストする。
- A3、A4、A5 は、デバッグ版で手で確かめる。

## トレードオフ

右の区画を「右サイドバー」にすると、今の「右のパネル」の文言を見慣れた書き手には、名前が変わる。
しかし、「パネル」を区画と中身の両方に使い続けると、「右のパネルのリンクのパネル」のような言い方になる。
区画と中身を分けるために、文言を変える。

画面の下の区画を「下部パネル」と呼ぶと、区画の名前に「パネル」が残る。
代わりに「下の区画」などの新しい語を作ると、仕様書と依頼者がすでに使う「下部パネル」と食い違い、書き手にも新しい語を覚えさせることになる。
下部パネルの中身は「パネル」と呼ばず「下部パネルのタブ」と呼ぶ決まりで、中身の「パネル」と重ならないようにする。

コードの名前まで変えると、変える箇所が多く、保存した状態とキーの割り当ての読みかえも要る。
しかし、コードの名前だけが古いまま残ると、`.problems-panel` と「下部パネル」のような対応を、読む人が覚え続けることになる。
読みかえを一つのモジュールにまとめて、一度で変える。

提案中の [ADR 0068](0068-emet-repl-panel.md) (下部パネルで Emet の式を試す) も、下部パネルにタブを足す。
採択した順に、それぞれの実装で用語集にタブの名前を足す。

## 参考文献

- [ADR 0005](0005-layout-and-appearance.md)
- [ADR 0022](0022-quick-open.md)
- [ADR 0023](0023-command-palette.md)
- [ADR 0024](0024-tabs-and-split.md)
- [ADR 0026](0026-recent-files.md)
- [ADR 0055](0055-problems-panel.md)
- [ADR 0064](0064-unified-notifications.md)
- [ADR 0069](0069-build-log-and-reveal.md)
- [ADR 0081](0081-assistant-with-local-llm-and-connectors.md)
