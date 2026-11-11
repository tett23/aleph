# Aleph

[![CI](https://github.com/tett23/aleph/actions/workflows/ci.yml/badge.svg)](https://github.com/tett23/aleph/actions/workflows/ci.yml)

Aleph is an editor and preview environment for [Golem](https://github.com/tett23/golem), a typesetting system, under development.

[日本語の README](README.ja.md)

This English version is canonical.
README.ja.md is a machine translation of it.

## Overview

Aleph is a desktop application built with [Tauri](https://tauri.app/).
It is for writing the manuscripts of Golem, seeing how they are typeset, and managing the plot of a work.

It edits these formats:

- Markdown (`.md`)
- Golem documents (`.gm`) and Emet (`.emet`)
- CSV (`.csv`) and TSV (`.tsv`)
- TOML (`.toml`)
- JSON (`.json`), JSON with Comments (`.jsonc`), JSON5 (`.json5`) and JSON Lines (`.jsonl`)
- SVG (`.svg`)
- PDF (`.pdf`)
- Mermaid
- Images (PNG, JPEG, GIF, WebP), for viewing

Right-click a sheet, folder, or project in the file tree to rename it. Open sheets follow the new path.
The file tree shows chapters in their actual folders. The settings can show hidden files or hide files matched by `.gitignore`.

## Status

The first version is implemented: one editor for horizontal and vertical writing, golem lsp, previews of the text and the pages, saving and Git, goals and notes, the plot and its Gantt chart, the shared library, diagnostics and search, building the project, the conversion from Markdown, and plugins.
Each decision is an ADR (Architecture Decision Record) under [docs/adr/](docs/adr/), and the current behaviour is in [docs/specifications.md](docs/specifications.md).
It targets macOS on Apple Silicon first.

## Running

Install Node.js (the latest LTS), Rust, and [Golem](https://github.com/tett23/golem) and [shem](https://github.com/tett23/shem) (or let Aleph use the copies bundled by `scripts/bundle-tools.sh`).

```sh
npm ci
npx tauri dev
```

To build the app with golem and shem inside it:

```sh
sh scripts/bundle-tools.sh
npx tauri build
```

A debug build (`npx tauri dev` or `npx tauri build --debug`) shows a `dev` mark at the left of the toolbar.
All builds read the same settings.

## Development

The checks CI runs:

```sh
npx tsc --noEmit
npm test
(cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
```

Install [adr-guard](https://github.com/tett23/adr-guard) v0.10.0 or later, and enable the git hooks in each clone.

```sh
cargo install --git https://github.com/tett23/adr-guard --tag v0.10.0
git config core.hooksPath .githooks
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made.

## License

[MIT](LICENSE)
