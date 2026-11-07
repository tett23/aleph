# aleph

[![CI](https://github.com/tett23/aleph/actions/workflows/ci.yml/badge.svg)](https://github.com/tett23/aleph/actions/workflows/ci.yml)

aleph is an editor and preview environment for [Golem](https://github.com/tett23/golem), a typesetting system, under development.

[日本語の README](README.ja.md)

This English version is canonical.
README.ja.md is a machine translation of it.

## Overview

aleph is a desktop application built with [Tauri](https://tauri.app/).
It is for writing the manuscripts of Golem and seeing how they are typeset.

It will edit these formats:

- Markdown (`.md`)
- Golem documents (`.gm`) and Emet (`.emet`)
- CSV (`.csv`) and TSV (`.tsv`)
- TOML (`.toml`)
- SVG (`.svg`)
- PDF (`.pdf`)
- Mermaid

## Status

Nothing is implemented yet.
The design is being decided in ADRs (Architecture Decision Records) under [docs/adr/](docs/adr/).
The specification is in [docs/specifications.md](docs/specifications.md).

## Development

Install [adr-guard](https://github.com/tett23/adr-guard) v0.10.0 or later, and enable the git hooks in each clone.

```sh
cargo install --git https://github.com/tett23/adr-guard --tag v0.10.0
git config core.hooksPath .githooks
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made.

## License

[MIT](LICENSE)
