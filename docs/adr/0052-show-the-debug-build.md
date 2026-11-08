# ADR 0052: デバッグのビルドであることを画面に出す

ステータス: 採択

## 文脈

Aleph は、`tauri dev` で動かすとき、`tauri build --debug` で作ったとき、`tauri build` で作ったときで、どれも同じ識別子（`dev.tett23.aleph`）を持つ。
そのため、どのビルドも同じ `config.json` を読み、同じワークスペースを開く。
画面も同じなので、開いているウィンドウがデバッグのビルドなのか、配るものと同じリリースのビルドなのかを、見た目で区別できない。
確かめているつもりのビルドと違うものを触ってしまうと、確かめた結果を取り違える。

`tauri::is_dev()` は `tauri dev` のときだけ真になり、`tauri build --debug` では偽になる。
画面の側の `import.meta.env.DEV` も、`tauri build --debug` では画面を本番の設定で作るので偽になる。
どちらも、デバッグのビルドすべてを拾えない。

## 実装すること

- Rust の側に、デバッグのビルドかどうか（`cfg!(debug_assertions)`）を返すコマンド `debug_build` を足す。引数は取らない。
- メインのウィンドウのツールバーで、タイトルの左に「dev」の印を出す。リリースのビルドでは出さない。
  - 印は小さな枠付きの文字とし、アクセントの色で塗る。タイトルの文字より目立たせない。
  - 印の上で、ウィンドウを動かせる（`data-tauri-drag-region`）。
- 設定の画面の見出しの版にも、デバッグのビルドでは「(dev)」を添える（例：`1.0.0-rc1 (dev)`）。

## 実装しないこと

- プレビュー、プロット、IME の記録などの別ウィンドウへの表示。どれもメインのウィンドウから開くので、メインのウィンドウで区別できれば足りる。
- デバッグのビルドで識別子や設定の置き場所を分けること。今の設定を使って確かめる使い方ができなくなる。
- Dock のアイコンやウィンドウの色を変えること。

## テスト設計

`node --test` と `cargo test` で、テストを先に書いて失敗させてから実装する。

- ツールバーの HTML を作る関数が、デバッグのビルドのときだけ「dev」の印を含むこと。
- 設定の見出しの版の文字列を作る関数が、デバッグのビルドのときだけ「(dev)」を添えること。
- `debug_build` が `cfg!(debug_assertions)` と同じ値を返すこと（`cargo test` はデバッグで走るので真になる）。
- 画面の確かめ方：`tauri build --debug` のアプリでツールバーに「dev」が出ること、`tauri build` のアプリでは出ないことを確かめる。

## トレードオフ

- 判定をコマンドで受け取るので、画面の起動のときに IPC を一回増やす。値はビルドで決まるので、一度だけ受け取って覚えておく。
- `cfg!(debug_assertions)` は Cargo のプロファイルに従う。リリースのプロファイルで `debug-assertions` を有効にすると「dev」が出るが、Aleph はそうしていない。

## 参考文献

- [Tauri 2 `is_dev`](https://docs.rs/tauri/2/tauri/fn.is_dev.html)
- [The Cargo Book: Profiles（debug-assertions）](https://doc.rust-lang.org/cargo/reference/profiles.html#debug-assertions)
