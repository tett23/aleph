# Aleph

[![CI](https://github.com/tett23/aleph/actions/workflows/ci.yml/badge.svg)](https://github.com/tett23/aleph/actions/workflows/ci.yml)

Aleph is an editor and preview environment for [Golem](https://github.com/tett23/golem), a typesetting system, under development.

[日本語の README](README.ja.md)

This English version is canonical.
README.ja.md is a machine translation of it.

## Overview

Aleph is a desktop application built with [Tauri](https://tauri.app/).
It is for writing the manuscripts of Golem, seeing how they are typeset, and managing the plot of a work.

It will edit these formats:

- Markdown (`.md`)
- Golem documents (`.gm`) and Emet (`.emet`)
- CSV (`.csv`) and TSV (`.tsv`)
- TOML (`.toml`)
- SVG (`.svg`)
- PDF (`.pdf`)
- Mermaid
- Images (PNG, JPEG, GIF, WebP), for viewing

## Status

The implementation has not started.
A throwaway prototype is in [prototype/](prototype/); its README tells how to run it.
The design learned from the prototype is accepted in ADRs (Architecture Decision Records) under [docs/adr/](docs/adr/), none of them implemented yet.
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
