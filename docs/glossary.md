# Aleph 用語集

この用語集は、Aleph の画面の要素の正式な名前を一か所に定める。
名前は [ADR 0082](adr/0082-ui-names-and-glossary.md) が決めた。
仕様書と、これから書く ADR と README は、ここの正式な名前を使う。
ただし、コミット済みの ADR は直さないので、古い ADR には古い名前が残る。

## 名前の決め方

名前は、区画 (画面を分けた場所) と、区画に出す中身を、別の語で呼ぶように選んである。
区画は「サイドバー」「右サイドバー」「下部パネル」などで、中身は「〜のパネル」「〜のタブ」などである。
区画の名前が「下部パネル」のように「パネル」を含むときは、その区画の中身を「パネル」と呼ばず、「下部パネルのタブ」と呼ぶ。
また、一つの名前は一つの要素だけを指す。
例外として、「ファイルツリー」は、同じ段落でくり返すときに限り「ツリー」と略してよい。

## 名前の一覧

表の列の意味は次のとおりである。

- 「画面の文言」は、ボタンの表示、ツールチップ、コマンドの名前に使う文字列である。画面に名前が出ない要素は「(無し)」とする。
- 「英語の名前」は、README の英語版と、コードの名前の元にする名前である。
- 「コードの名前」は、CSS のクラス、`data-*` の属性、`ctx` の鍵、型、関数の名前である。
- 「今のコードの名前」は、[ADR 0082](adr/0082-ui-names-and-glossary.md) の実装で「コードの名前」に変えた、前の名前である。`config.json` に保存された前の名前は、`app/legacy-names.ts` だけが新しい名前に読みかえる。
- 「使わない名前」は、その要素を指して、画面の文言と仕様書で使わない名前である。

| 正式な名前 | 英語の名前 | 指すもの | 画面の文言 | コードの名前 | 今のコードの名前 | 使わない名前 |
| --- | --- | --- | --- | --- | --- | --- |
| リボン | Ribbon | 左端の縦のアイコンの列 ([ADR 0005](adr/0005-layout-and-appearance.md)) | (無し) | `.ribbon` | (無し) | (無し) |
| サイドバー | Sidebar | 左の区画。左右をまとめて言うときは「サイドバーと右サイドバー」と書く | 「サイドバー」 | `.sidebar`、`ctx.sidebar`、型 `SidebarPanelId` | `.side`、`ctx.left`、型 `LeftPanel` | 「左のサイドバー」 |
| ワークスペースバー | Workspace bar | サイドバーの上の、ワークスペースの名前とブランチの帯 | (無し) | `.workspace-bar` | `.wsbar` | (無し) |
| パネル | Panel | サイドバーと右サイドバーに出す中身の一つ。「ファイルのパネル」「検索のパネル」のように呼ぶ | (無し) | 型 `Panel` | (無し) | (無し) |
| ファイルのパネル | Files panel | ファイルツリーとその上のボタンを出すパネル | 「ファイル」 | `ctx.sidebar.files` | `ctx.left.files` | (無し) |
| ファイルツリー | File tree | ファイルのパネルの、ファイルとフォルダの木 | 「ファイルツリー」 | `.file-tree` | `.tree` | 「ファイルのツリー」 |
| 右サイドバー | Right sidebar | 右の区画 | 「右サイドバー」 | `.right-sidebar`、`ctx.rightSidebar`、型 `RightSidebarPanelId` | `.right`、`ctx.right`、型 `RightPanel` | 「右のパネル」 |
| ツールバー | Toolbar | 中央の列の上端の帯 | (無し) | `.toolbar` | (無し) | (無し) |
| ほかの操作 | More actions | ツールバーの「…」のメニュー | 「ほかの操作」 | `data-toolbar="more-actions"` | `data-tb="more"` | 「ツールバーのメニュー」 |
| エディタの領域 | Editor area | 中央の列の左の区画。ペインを並べる | (無し) | `.editor-area`、`ctx.view.editorArea` | `.main-pane`、`ctx.view.main` | (無し) |
| ペイン | Pane | エディタの領域を左右に分けた一つ。タブの並びを持つ ([ADR 0024](adr/0024-tabs-and-split.md)) | (無し) | `.pane` | `.epane` | (無し) |
| タブ | Tab | ペインの中の、開いたもの (シート、まとめて開いた章、プロット) の一つ | (無し) | `.tab` | (無し) | (無し) |
| プレビューのタブ | Preview tab | ペインのタブの一つ。映すタブのシートの、本文、ページ、図を出す | 「プレビュー」 | `Tab.preview`、`ctx.view.previewTab`、型 `PreviewMode` | `.preview-area`、`ctx.view.previewArea` | 「プレビューの領域」 |
| 映すタブ | Followed tab | プレビューのタブが映す、シートを持つタブ | (無し) | `followed`、`shown` | (無し) | (無し) |
| 下部パネル | Bottom panel | エディタの領域の下、ステータスバーの上の区画。下部パネルのタブで中身を切り替える | 「下部パネル」 | `.bottom-panel`、`ctx.view.bottomPanel` | `.problems-panel`、`ctx.view.problems` | 「問題のパネル」、「問題パネル」 |
| 下部パネルのタブ | Bottom panel tab | 下部パネルの中身を切り替える見出しの一つと、その中身 | (無し) | `.bottom-panel-tab` | `.ptab` | (無し) |
| 問題のタブ | Problems tab | 下部パネルのタブの一つ。診断の一覧 | 「問題」 | `data-tab="problems"` | (無し) | 「問題の一覧」 |
| 通知のタブ | Notifications tab | 下部パネルのタブの一つ。通知の履歴 | 「通知」 | `data-tab="notifications"` | `data-tab="notes"` | (無し) |
| ビルドログのタブ | Build log tab | 下部パネルのタブの一つ。手動のビルドの記録で、ビルドした後だけ出る | 「ビルドログ」 | `data-tab="build-log"` | `data-tab="build"` | (無し) |
| ステータスバー | Status bar | 中央の列の下端の帯 | (無し) | `.status-bar` | `.status` | (無し) |
| 通知 | Notification | Aleph が書き手に知らせる一件の知らせ ([ADR 0064](adr/0064-unified-notifications.md)) | (無し) | `notify` | (無し) | (無し) |
| トースト | Toast | 通知を画面の右下に出したもの | (無し) | `.toasts` | (無し) | (無し) |
| コマンドパレット | Command palette | ⌘P と ⇧⌘P で開く入力欄 ([ADR 0023](adr/0023-command-palette.md)) | 「コマンドパレット」 | `.command-palette`、`openCommandPalette` | `.palette`、`openPalette` | (無し) |
| クイックオープン | Quick open | コマンドパレットで、シートを名前で探して開く使い方 | (無し) | (無し) | (無し) | (無し) |
| メニュー | Menu | 右クリックやボタンで開く、項目の縦の並び | (無し) | `.menu` | (無し) | (無し) |
| ダイアログ | Dialog | 画面を暗くして前に出す、画面の中の小さなウィンドウ (名前の入力、確認、選択、食い違いの解消) | (無し) | `.dialog` | `.modal` | (無し) |
| ネイティブのダイアログ | Native dialog | Rust の側が出す macOS のダイアログ (保存、フォルダの選択、承認) | (無し) | (無し) | (無し) | (無し) |
| 設定のダイアログ | Settings dialog | 設定を変えるダイアログ。その中の一つを「〜の節」と呼ぶ | 「設定」 | `openSettingsDialog` | `openSettings` | (無し) |

## 名前を足すとき

新しい画面の要素を足す ADR は、その実装で、この表にも名前を足す。
表は `app/glossary.test.ts` が読み、画面の文言が画面に現れること、使わない名前が画面と仕様書に現れないこと、名前が重ならないことを確かめる。
