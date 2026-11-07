# ADR 0049: CI で依存の既知の脆弱性を検査する

ステータス: 採択

## 文脈

CI は `npm ci --no-audit` で依存を入れ（[.github/workflows/ci.yml](https://github.com/tett23/aleph/blob/b4ee3c4/.github/workflows/ci.yml#L81)）、Rust の依存も既知の脆弱性を検査していない。
2026-11-08 のセキュリティ監査（[docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md) の所見 10）は、これを指摘し、Mermaid は XSS の修正が続いている依存なので更新を追うよう勧めた。
メンテナーは、監査の修正をすべて ADR にするよう求めた（2026-11-08）。

## 実装すること

- CI に `audit` のジョブを足す。
  - `npm audit --omit=dev --audit-level=high`：アプリに入る npm の依存に、重さ high 以上の既知の脆弱性があれば失敗する。
  - `cargo audit`（RustSec の advisory database）：`src-tauri/Cargo.lock` の依存に既知の脆弱性があれば失敗する。`cargo-audit` は版を固定して入れる。
- このジョブは、プルリクエストのたびと、週に一度の定期の実行（`schedule`）で走らせる。定期の実行で失敗したら、Issue を立てずに CI の失敗として残す。
- 既知の脆弱性を、すぐに直せない理由があって一時的に許すときは、`audit.toml`（cargo）と、npm では理由を書いた許可のリストに、advisory の ID と理由と見直す日を書く。理由のない許可は置かない。

## 実装しないこと

- 依存を自動で更新する仕組み（Dependabot など）。
- dev の依存（Vite、TypeScript など、配るアプリに入らないもの）の検査を失敗の条件にすること。

## テスト設計

自動のテストは書けない（CI の設定のため）。確かめ方を次に書く。

- 足したジョブがプルリクエストで走り、今の依存で通ること、または通らない advisory があれば、その一覧を報告に残して対処を決めること。
- 試しに、既知の脆弱性のある古い版を一時的に入れた枝で、ジョブが失敗することを確かめる（確かめたあと枝は消す）。

## トレードオフ

- 上流の advisory が増えると、コードを変えていないプルリクエストでも CI が失敗する。既知の脆弱性に気づく機会を優先した。

## 参考文献

- [docs/audit/2026-11-08-security.md](../audit/2026-11-08-security.md)
- RustSec, cargo-audit：https://rustsec.org/
- npm audit：https://docs.npmjs.com/cli/commands/npm-audit
