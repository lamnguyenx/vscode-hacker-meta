# Hacker Markdown: configurable preview fonts (mono inherits the terminal font)

**Date:** 2026-11-19
**Status:** DONE in `_submodules/vscode-hacker-markdown` (uncommitted, version
not yet bumped). Full write-up with trials/errors/lessons:
[`_submodules/vscode-hacker-markdown/docs/plans/2026/11/19/2026-11-19-configurable-preview-fonts.md`](../../../_submodules/vscode-hacker-markdown/docs/plans/2026/11/19/2026-11-19-configurable-preview-fonts.md)
**Repos touched:** `vscode-hacker-markdown` only (source, tests, docs). Meta
repo: this log and the README "Elsewhere" pointer.

## What changed (summary)

The Markdown preview's two font roles are now separately configurable:

- **Normal text**: `hackerMarkdown.preview.fontFamily` (new) → stock
  `markdown.preview.fontFamily` → default UI chain.
- **Code (inline + fences)**: `hackerMarkdown.preview.monoFontFamily` (new) →
  `terminal.integrated.fontFamily` → `editor.fontFamily` → the existing
  `--vscode-editor-font-family` CSS chain — i.e. code in the preview matches
  the terminal by default, with no new settings for users who set one mono
  font everywhere (editor = terminal = `Iosevka Light` just works).

Resolution lives in the submodule's `src/fonts.ts` (vscode-free, pinned by
`tests/units/fonts_check.ts`, wired into `npm run test:units`); the webview
gets it as `--markdown-font-family` / `--hmk-mono-font-family` on `<html>`,
and previews rebuild live when any input setting changes.

## Meta-level notes

- **`_refs/vscode` is absent from this checkout** — the meta `AGENTS.md` names
  it as a read-only reference, but only `_refs/code-server` exists here, and the
  submodule has no `_refs/` at all. Questions about VS Code internals had to go
  through web docs this session. If VS Code source is expected to be consultable
  (it has been in past sessions), restore the checkout or soften the `AGENTS.md`
  wording.
- **`make check-docs` stayed green** across the in-place doc edits
  (`docs/important/**` content changes don't break index/anchor checks as long
  as no files are added/renamed).
- **Release hygiene reminder**: the meta installer skips unchanged versions, so
  the submodule needs a `package.json#version` bump before the next
  `make install` / `make install-code-server` picked this up — see the
  [incremental VSIX builds](../10/2026-11-10-incremental-vsix-build.md) contract.
