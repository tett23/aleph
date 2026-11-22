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
Drag a sheet, file, folder, or project to another folder in the same workspace to move it. A drop on a file uses its parent folder, and a drop on the empty part of the tree uses the workspace root.
A translucent copy of the item's name and icon follows the pointer while dragging. It stays inside the window, marks unavailable destinations, and disappears when the drag ends or passes to another application. Images use the same display when dragged into a Golem chapter.
When the move crosses a project boundary, Aleph confirms the change and shows any chapter registrations that will move. Every move requires a Golem LSP with workspace move plan version 1. The bundled Golem 0.1.0-rc4 does not support this feature. Use a compatible Golem executable in settings. Open sheets, notes, goals, and references follow the move.
When Golem LSP supports file operations, Aleph updates local references before renaming; if reference updates are unavailable, you can cancel or rename without updating them.
Right-click a project or folder to add a folder or an empty sheet of a chosen type. Right-click a Markdown sheet to convert that sheet to gm.

Choose “Golem プロジェクトに初期化” (initialize as a Golem project) from the workspace menu or command palette to make the current workspace folder itself a project. Aleph keeps existing files and stops if generated paths collide or the workspace already contains a project.


With New Sheet, a name without an extension prompts you to choose Markdown (.md) or Golem (.gm).
Inside a project, New Sheet registers Golem documents as chapters.

To reorder projects in the same folder, right-click a project and choose “一つ上へ” (move up) or “一つ下へ” (move down). Aleph remembers the order for each workspace.
The file tree shows chapters in their actual folders. The settings can show hidden files or hide files matched by `.gitignore`.
Right-click a Golem document to add it to or remove it from the project chapters. Selected Golem documents can be exported as one file in tree order.

Right-click menus stay within the window, including when you open them near an edge. If the items do not all fit, scroll within the menu to reach the rest.

With page refresh on save enabled, ⌘S refreshes the PDF preview immediately when the saved content changes. Autosave waits for five seconds of idle time and skips rendering if the pages already match.

The text and page previews keep your scroll position when the same content target refreshes, both in the tab and in a separate window. The position is measured in pixels from the reading start.

The writing checks for `.gm`, `.md`, and `.txt` skip absolute HTTP and HTTPS URLs with a host, including URLs enclosed in angle brackets.

After a manual build, click the build status to read its command and output. The success notification can reveal the project’s output folder in Finder.
The file tree shows each project’s `build/` folder with every file in it, so outputs such as PDFs can be handed to other applications: drag rows out of the window, choose “コピー” (copy) from the right-click menu and paste in Finder, or choose “zip で書き出す…” (export as zip) on a folder or a project. The zip writes its file names in UTF-8, normalized to NFC and flagged as UTF-8, and leaves out `.DS_Store` and `.git`.

Closing a notification that stays on screen marks it as seen and updates the unread count on the “通知” (Notifications) tab in the bottom panel.
This also works in separate page preview and plot windows.
Closed notifications stay in the main window’s history.

The assistant in the bottom panel takes a request in plain words, such as "widen the line pitch a little", and proposes edits to the focused sheet (or the selection) with an explanation and a diff. Nothing changes until you press “適用” (apply). If the workspace has uncommitted changes, Aleph first offers to commit them, then applies, saves, and opens the diff tab. The ribbon's “差分” (diff) button shows the workspace's changes against the last commit at any time.
By default the assistant runs Qwen3.5-4B on your Mac with the bundled `llama-server`, and sends nothing outside. The other three models of the list can be downloaded from the settings. Claude Code and Codex can also be chosen when they are installed; they send the request, the target text and the manual excerpts to Anthropic or OpenAI with your own account, so Aleph asks once before using each. If they fail, Aleph asks the local model instead and says so.

Select text in the editor to highlight up to 10,000 other exact, case-sensitive matches in the same sheet. Matches can occur inside words, and selections can include spaces and line breaks. The match outlines update without moving or rewrapping the text.

Choose the app's appearance under “一般” (General) → “外観” (Appearance) in the settings: “OS に合わせる” (match the OS, the default), “ライト” (light), or “ダーク” (dark). Light and dark stay fixed when the OS appearance changes. The saved choice applies to the main window and to the separate text preview, page preview, and plot windows, including windows opened later and after a restart. It changes only the app's colors, not the manuscript, the typesetting colors, or exported PDFs.

In the text editor, press Escape or Control-E to dismiss suggestions. With suggestions closed, Control-E moves to the end of the logical line. Each shortcut’s context can be changed in the key binding settings.

When the Japanese input method uses Escape to cancel conversion, that press cancels only the conversion.
For example, you can continue typing the name of a new sheet in the same dialog.
A separate press of Escape after conversion ends performs the usual action.

The diff tab and Git panel mark changed characters inline, including in Japanese text. Removed text has a strikethrough, and added text is underlined.

Aleph bundles Git support through libgit2. Its Git panel initializes repositories, shows changes and history, and commits, pushes, and pulls without requiring a Git executable. The Git section of the app settings edits your global author name and email. Use a project's gear button or the Git panel to edit the identity of a particular repository.

For push and pull, configure a tracking branch on an SSH or HTTPS remote. SSH uses your agent and verifies the server against your known hosts. HTTPS verifies the server certificate and asks for a username and password or token when the server requires them.

## Status

The first version is implemented: one editor for horizontal and vertical writing, golem lsp, previews of the text and the pages, saving and Git, goals and notes, the plot and its Gantt chart, the shared library, diagnostics and search, building the project, the conversion from Markdown, and plugins.
Each decision is an ADR (Architecture Decision Record) under [docs/adr/](docs/adr/), and the current behaviour is in [docs/specifications.md](docs/specifications.md). The names of the elements of the screen, such as the sidebar, the right sidebar and the bottom panel, are in [docs/glossary.md](docs/glossary.md).
It targets macOS on Apple Silicon first.

## Running

Install Node.js (the latest LTS), Rust, and [Golem](https://github.com/tett23/golem) and [shem](https://github.com/tett23/shem) (or let Aleph use the copies bundled by `scripts/bundle-tools.sh`).

```sh
npm ci
npx tauri dev
```

To build the app with golem, shem, llama-server and the default model of the assistant (Qwen3.5-4B, about 2.7 GB to download), and the chapters of the Golem manual inside it:

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

CI skips these checks when a change touches only documentation (README, CONTRIBUTING, the ADRs, the specification and the other files under `docs/` that `scripts/docs-only.sh` lists). The ADR and translation checks run on every change.

Install [adr-guard](https://github.com/tett23/adr-guard) v0.13.1 or later, and enable the git hooks in each clone.

```sh
cargo install --git https://github.com/tett23/adr-guard --tag v0.13.1
git config core.hooksPath .githooks
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made.

## License

[MIT](LICENSE)
