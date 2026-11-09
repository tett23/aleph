# ADR 0060: git が使えないことを知らせ、git を使う機能を止める

ステータス: 採択

## 文脈

Aleph は、Git のパネル、1 日 1 回の自動コミット、溝の変更の印、置換の確認の文言で git を使う（[ADR 0011](0011-saving-and-git.md)）。
git は、設定の `gitPath`、`/usr/bin`、Homebrew、PATH の順に探す（[src-tauri/src/process.rs](https://github.com/tett23/aleph/blob/64fc2bc/src-tauri/src/process.rs#L97)）。

macOS には、git を入れていなくても `/usr/bin/git` がある。
これは Xcode のコマンドラインツールを呼び出す入口で、ツールがなければ失敗して終わる。
`/usr/bin/git` はいつも見つかるので、`gitPath` に無いパスを書いたときを除き、Aleph が「git が見つかりません」と言うことはない（[src-tauri/src/lib.rs](https://github.com/tett23/aleph/blob/64fc2bc/src-tauri/src/lib.rs#L459)）。

そのため、git が使えない Mac では、git の失敗が「Git のリポジトリではない」と同じに扱われる。

- Git のパネルは「〇〇 は Git のリポジトリではありません」と「git init」のボタンを出す（[app/gitpanel.ts](https://github.com/tett23/aleph/blob/64fc2bc/app/gitpanel.ts#L85)）。原因と違う文言で、ボタンを押しても失敗する。
- 自動コミットは、どのワークスペースも黙って飛ばす（[app/gitpanel.ts](https://github.com/tett23/aleph/blob/64fc2bc/app/gitpanel.ts#L57)）。書き手は、コミットされていないことに気付けない。
- 溝の変更の印は、HEAD の中身を読めないので、HEAD にないファイルとして扱い、すべての行に追加の印を付ける（[app/main.ts](https://github.com/tett23/aleph/blob/64fc2bc/app/main.ts#L119)、[app/diff.ts](https://github.com/tett23/aleph/blob/64fc2bc/app/diff.ts#L10)）。
- 置換の確認は、「ディスクの上のファイルの置換は元に戻せません」と出す（[app/searchpanel.ts](https://github.com/tett23/aleph/blob/64fc2bc/app/searchpanel.ts#L100)）。こちらは正しい。

コマンドラインツールのない Mac で `/usr/bin/git` を走らせると、macOS が「コマンドラインデベロッパツールをインストールしますか」というダイアログを出すことがあると言われている。
Aleph は、シートを開くたび、パネルを開くたび、1 時間ごとに git を走らせるので、ダイアログが繰り返し出るおそれがある。
ただし、このダイアログがどの頻度で出るかは、コマンドラインツールのない機械で確かめていない。

## 実装すること

- 起動したときに一度、git が使えるかを確かめる。
  - Rust の側に、git の情報を返すコマンドを足す。golem と shem の `tool_info`（[src-tauri/src/lib.rs](https://github.com/tett23/aleph/blob/64fc2bc/src-tauri/src/lib.rs#L831)）と同じく、見つけたパスで `git --version` を走らせ、パスと版を返す。見つからないとき、終了コードが 0 でないとき、出力が `git version` で始まらないときは、使えないとして、理由（探した場所、または出力の先頭の行）を返す。
  - 結果は、起動のあいだ覚えておく。もう一度確かめるのは、設定で git のパスを変えたときと、Git のパネルの「確かめなおす」を押したときに限る。
- git が使えないときは、git を走らせない。
  - Git のパネルには、「git が使えません」と理由を出し、「Xcode のコマンドラインツール（`xcode-select --install`）か Homebrew で入れてから、確かめなおしてください」と添える。ボタンは「確かめなおす」と「設定を開く」とする。「git init」は出さない。
  - 自動コミットはしない。起動して最初の確かめで使えないと分かったときに、一度だけ「git が使えないので、自動のコミットをしません」と知らせる。設定で自動コミットを切っていれば、知らせない。
  - 溝の変更の印を出さない（すべての行を追加とはしない）。
  - 置換の確認は、リポジトリでないときと同じく「元に戻せません」とする。
  - ワークスペースが Git のリポジトリかどうかを確かめる処理（`rev-parse`）も走らせない。
- 設定の「git のバイナリ」の説明に、golem と shem と同じく、使っている git のパスと版を出す。使えないときは理由を赤で出す。
- 仕様書の Git の節に、git が使えないときの振る舞いを書く。

## 実装しないこと

- git を同梱すること。git のライセンス（GPL v2）と大きさ、Xcode のコマンドラインツールとの重なりがあり、Aleph の利用者の多くは、すでに git を入れていると見込む。
- コマンドラインツールのインストールを、Aleph から始めること。
- 使えるかの確かめを、起動のあいだにくり返すこと（ターミナルで git を入れたら、「確かめなおす」を押してもらう）。
- ワークスペースごとに、git の使える使えないを分けること。git の実行ファイルは Aleph 全体で一つである。

## テスト設計

`node --test` と `cargo test` で、テストを先に書いて失敗させてから実装する。

- Rust：`git --version` の結果から使えるかを決める関数が、次のとおりに判定すること。
  - 終了コード 0 で `git version 2.39.5 (Apple Git-154)` を出したとき、使える（版はその文字列）。
  - 終了コード 0 でないとき、使えない。理由は標準エラー出力の先頭の行（例：`xcrun: error: invalid active developer path ...`）。
  - 終了コード 0 でも、出力が `git version` で始まらないとき、使えない。
  - 実行ファイルが見つからないとき、使えない。理由は探した場所。
- TypeScript：
  - git が使えないとき、自動コミットの判定が、変更があってもコミットしないと返すこと。
  - git が使えないとき、変更の印が空になること（すべての行を追加にしないこと）。
  - Git のパネルの文言を作る関数が、使えないときに理由と入れ方の案内と「確かめなおす」を返し、「git init」を返さないこと。
- 画面の確かめ方：設定の git のパスに `/usr/bin/false` を選んで、次を確かめる。
  - Git のパネルに「git が使えません」と理由が出て、「git init」が出ないこと。
  - シートの溝に変更の印が出ないこと。
  - 起動しなおすと、自動コミットをしない旨の知らせが一度だけ出ること。
  - git のパスを空に戻して「確かめなおす」を押すと、パネルと変更の印が戻ること。
  - 設定の「git のバイナリ」に、使っている git のパスと版が出ること。

## トレードオフ

- 起動のたびに `git --version` を一度走らせる。git のない Mac では、それで macOS のダイアログが一度出るかもしれない。出たとしても、くり返し出るよりよい。
- 起動したあとに git を入れても、「確かめなおす」を押すか、起動しなおすまで使えない。確かめをくり返さないための割り切りである。
- `git --version` が通っても、ほかのサブコマンドが失敗することはある（壊れた設定など）。そのときは、これまでどおり各機能が失敗を扱う。
- 確かめるのは `--version` だけなので、git の版の新しさ（`--porcelain=v1 -z` などが使えるか）は見ない。

## 参考文献

- [ADR 0011](0011-saving-and-git.md)、[ADR 0042](0042-ipc-trust-boundary.md)、[ADR 0046](0046-safe-automatic-git.md)、[ADR 0050](0050-paths-the-writer-chooses.md)、[ADR 0051](0051-git-init-and-the-pages-window.md)
