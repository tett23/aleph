# ADR 0120: プラグインの権限をアプリ内で承認し、起動中だけ覚える

Status: proposed

## 文脈

プラグインが権限を使い始めるときは、何にアクセスするのかを利用者が確かめてから許可できるようにする。
同じ OS ユーザーで動く別プロセスが Aleph の設定ファイルを書き換えても、プラグインの権限を承認できないようにする。

## 調査した事項

既存のプラグインのインストール確認は Rust からネイティブのダイアログを開く。
Aleph は、編集案を適用する前の確認などにアプリ内のダイアログも使う。
アシスタントの外部コネクタの承認は Rust が管理するが、値はアプリの設定ファイルに保存する。
このファイルへの WebView からの書き込みを制限しても、同じユーザーで動く他のプロセスからの書き換えは OS のファイル権限だけでは区別できない。
[インストール時の確認](https://github.com/tett23/aleph/blob/6723ebc889bf95d27e25547dd9bcf23920264395/src-tauri/src/lib.rs#L693-L731)、[ADR 0088](0088-diff-tab-and-commit-before-applying.md)、[ADR 0089](0089-revoke-connector-approval.md)

macOS にはファイルベースとデータ保護の二つのキーチェーン実装がある。
データ保護キーチェーンでは、macOS がコード署名の entitlement からアプリのアクセスグループを決める。
項目にアクセスできるアプリは、その項目のグループに属するものに限られる。
[Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)、[Apple `kSecAttrAccessGroup`](https://developer.apple.com/documentation/security/ksecattraccessgroup)

`kSecUseDataProtectionKeychain` でデータ保護キーチェーンを選べる。`kSecAttrSynchronizable` を `false` にすると、その項目は iCloud で同期しない。
[Apple `kSecUseDataProtectionKeychain`](https://developer.apple.com/documentation/security/ksecusedataprotectionkeychain)、[Apple `kSecAttrSynchronizable`](https://developer.apple.com/documentation/security/ksecattrsynchronizable)

配布するアプリが `keychain-access-groups` entitlement を使う場合、配布用 provisioning profile による承認が必要になる。
Aleph の配布ビルドで専用グループによるアクセス制限が効くことは未検証である。
[Apple「Creating distribution-signed code for macOS」](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/#Embed-distribution-provisioning-profiles)

### App Sandbox コンテナの試験

macOS の App Sandbox コンテナでは、コード署名に基づいてアプリをコンテナに関連づける。macOS 14 以降では、別のアプリがアクセスしようとしたときに利用者の許可を求める場合がある。
[Apple「Accessing files from the macOS App Sandbox」](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)

macOS 27.0（26A428、arm64、SIP 有効）で、`com.apple.security.app-sandbox` だけを付けて `codesign -s -` で ad hoc 署名した試験アプリを `open` で起動した。Team ID はなく、provisioning profile も使わなかった。初回の起動でコンテナの `Data/Library/Application Support` に試験用の承認を書けた。同じバンドル ID で別のバイナリに更新しても、以前の承認を読めた。コンテナの外に置いた試験用の原稿をパスで開く操作は `EPERM` になった。

同じユーザーで、別のバンドル ID、ad hoc 署名、App Sandbox なしの試験アプリを `open` で起動すると、承認ファイルへの 20 バイトの書き込みに成功した。更新版の試験アプリで読み直すと、値は書き換わっていた。この構成のコンテナ単独では、別プロセスによる承認の書き換えを防げなかった。

## 実装すること

### 初回の承認ダイアログ

ここでいう承認は、利用者が一つのプラグイン、一つの権限、対象の範囲の組を認めた記録である。
[ADR 0115](0115-isolate-tabs-and-authorize-ipc.md) の許可は、Rust が有効な通信路に発行する値である。
承認があっても、Rust は要求と通信路と対象を照合してから、その要求に使う許可を発行する。

プラグインが未承認の組を初めて要求すると、Rust は要求を承認待ちにし、Aleph のメイン画面に通知する。
メイン画面は、既存のアプリ内ダイアログの見た目に合わせて、権限の承認を求めていることを明示したダイアログを開く。
ダイアログには、インストール時のプラグイン名、権限でできること、アクセスする対象、承認を覚える期間と、「許可する」「許可しない」を表示する。
開いたときはフォーカスをダイアログに移し、確認が終わるまで自動では消さない。
ほかのウィンドウや画面を操作しても、承認待ちの状態は変わらない。
同じ組の要求は一つの確認にまとめ、別の確認は順番に出す。
Rust は、メイン画面の承認ダイアログから、表示中の要求に対応する応答だけを受け付ける。
プラグインに公開する通信路では承認の応答を受け付けない。
利用者が「許可する」を押した後に、対象と通信路がまだ有効かを確かめ、承認を記録して許可を発行する。
承認待ちの間、Rust はその権限を必要とする IPC 操作を実行せず、対象のデータも渡さない。
「許可しない」を押した場合とダイアログを閉じた場合は要求を拒む。
同じ組への拒否をその起動中は覚え、設定で拒否を取り消すまで再表示しない。

権限の宣言や画面項目の登録では承認ダイアログを出さない。
既存の API 版 1 のコマンド、ステータス表示、保存通知も、シートの情報を渡す前に同じ承認を確かめる。
その操作に必要なシートの読み取りの承認が無ければ、シートの参照や本文を渡す前に確認する。

### 承認の保持と取消

承認と拒否は、現在の Aleph の Rust プロセスのメモリにだけ保持する。ダイアログに「Aleph を終了するまで」と表示する。
Rust プロセスを起動するたびに承認と拒否を空の状態から始める。以前のプロセスが発行した許可は使えない。
IPC の許可を発行するときは、Rust のメモリにある承認を参照する。設定ファイルやプラグインの保存領域から承認を読み込む経路は設けない。

承認は、インストールしたプラグインの ID、実際に読み込むソースの SHA-256、権限 ID、Rust が正規化した対象の範囲の組に結びつける。
ソースが変わった版、別の権限、承認範囲の外を初めて要求するときは、もう一度確認する。
設定には承認の一覧と取消を置く。
取り消した時点で、対応する通信路の許可も失効させる。

### 保護の範囲

承認をメモリだけに置くと、別プロセスが設定ファイルに承認を書き足しても、IPC の許可に変わる経路がなくなる。プラグインのソースを書き換えた場合は、読み込んだ内容のハッシュが変わり、以前の承認を再利用できなくなる。

この設計は、Rust プロセスと承認ダイアログを表示するメイン画面が信頼できることを前提とする。Aleph の実行ファイルや実行中の状態を改変できるプロセス、利用者に代わって承認操作を実行できるプロセスは、保護の範囲から外れる。

## 実装しないこと

承認や拒否の永続化、端末間同期、セーフモード専用の承認処理。

## 不変条件

- I1: 利用者が初回の要求を承認するまで、Rust はその権限を必要とする IPC 操作を実行せず、許可も対象のデータも渡さない。
- I2: 承認待ちの要求を表示している間は目的と対象がダイアログで分かり、ダイアログ以外の操作やプラグインからの応答は承認にならない。
- I3: 現在のプロセスの承認を再利用するのは、プラグイン ID、ソースの SHA-256、権限 ID、対象の範囲が承認済みの組に合う場合に限る。
- I4: Rust プロセスの起動時は承認と拒否が空で、ファイルからも復元されない。以前のプロセスが発行した許可は受理しない。
- I5: 承認を取り消すと、対応する実行時の許可は失効する。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| 初回に同じ権限と対象を複数回要求し、別のウィンドウを操作する | ダイアログは一つで、承認待ちのまま IPC 操作を拒む | I1, I2 |
| ダイアログを閉じるか、その表示中に通信路が失効する | その要求への許可を発行しない | I1 |
| プラグインが「許可する」に相当するメッセージを送る | 承認待ちの状態を変えず、許可を発行しない | I1, I2 |
| 同名のプラグインのソースを置き換え、前と同じ対象を要求する | 改めて承認を求める | I3 |
| 承認後、同じプロセスで同じ組を再要求する | 再確認せず、現在有効な通信路に許可を発行する | I3 |
| 承認または拒否したあとで Aleph を終了して起動し直し、同じ組を要求する | 改めて承認を求める。以前のプロセスの許可で操作を呼んでも拒む | I4 |
| 設定ファイルに承認の形をした値を足して起動する | 承認を求め、応答まで操作を拒む | I1, I4 |
| 有効な許可を発行した後で設定から承認を取り消す | 発行済みの値で操作を呼んでも拒む | I5 |

## 受けいれ条件

- A1: 初回要求を出すと、メイン画面で承認を求められていることと対象が分かり、マウスとキーボードで許可か拒否を選べる。
- A2: ダイアログに「Aleph を終了するまで」と表示され、同じ組は Aleph の終了と起動を挟むと再確認になる。

## テスト設計

許可発行とデータ返却を差し替え、ダイアログの結果、同時要求、通信路失効、ソース差し替え、取消を組み合わせる。
承認と拒否を持つ Rust の状態を作り直し、以前の判断と許可が引き継がれないことを確かめる。試験用の設定ファイルに承認の形をした値を置いても、IPC 操作が承認待ちになることを確かめる。
Tauri のデバッグ版で、ダイアログの表示とフォーカスを確認し、別のウィンドウを操作しても承認待ちの IPC が実行されないことを確かめる（A1）。
同じ組を承認したあと、Aleph を終了して起動し直す。再要求でダイアログが表示されることと、承認の期限表示を確かめる（A2）。

## トレードオフ

起動中だけの承認は、Apple Developer Program への加入や専用の保存先を必要としない。利用者は Aleph を起動し直すたびに、使う権限と対象を改めて確認する。

## 参考文献

- [ADR 0115](0115-isolate-tabs-and-authorize-ipc.md)
- macOS の二つのキーチェーン実装と、コード署名の entitlement からアクセスグループが決まる仕組み。 [Apple TN3137「On Mac keychain APIs and implementations」](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)
- 項目が属するグループの指定と、そのグループのメンバーだけがアクセスできる条件。 [Apple `kSecAttrAccessGroup`](https://developer.apple.com/documentation/security/ksecattraccessgroup)
- データ保護キーチェーンを選ぶクエリキーと、iCloud 同期を無効にする属性。 [Apple `kSecUseDataProtectionKeychain`](https://developer.apple.com/documentation/security/ksecusedataprotectionkeychain)、[Apple `kSecAttrSynchronizable`](https://developer.apple.com/documentation/security/ksecattrsynchronizable)
- `keychain-access-groups` entitlement を配布用 provisioning profile が承認する要件。 [Apple「Creating distribution-signed code for macOS」の「Embed distribution provisioning profiles」](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/#Embed-distribution-provisioning-profiles)
- App Sandbox コンテナとコード署名の関連づけ、および別アプリによるアクセス時の確認。 [Apple「Accessing files from the macOS App Sandbox」](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)
