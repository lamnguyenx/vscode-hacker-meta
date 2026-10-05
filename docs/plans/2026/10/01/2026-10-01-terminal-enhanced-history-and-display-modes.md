# Terminal Enhanced: command history + configurable display

**Date:** 2026-10-01 (work started 2026-09-30)
**Status:** DONE
**Extension:** `_submodules/vscode-hacker-terminal-enhanced`
(`lamnguyenx.hacker-terminal-enhanced`, v`2026.9.9`)
**Repo:** commit `2c791b5` (history popup + SQLite store) plus an uncommitted
display-mode rework on top of it.

## Context

The extension originally copied only the *last* terminal command + output on a
keybinding. Over two sessions it grew into a browsable, persisted command
history with a two-pane webview, and then a setting for *where* that webview is
shown.

Reference stack: code-server in Docker on nuc (Node 24), browser on the pp
desktop, REST Control on `40620`, CDP on `9024`.

## What shipped

### 1. Command history (commit `2c791b5`)

- **Global, persisted** history in SQLite under the extension's `globalStorage`
  (built-in `node:sqlite`, no native deps). Survives window reloads/crashes.
- `terminalEnhanced.historySize` (default **10**) and
  `terminalEnhanced.maxOutputLength` (default **1 MB**) settings.
- Two-pane webview: command list on the left, full command + cwd/exit/start on
  the right; `↑/↓` browse, `Enter` copies the full LLM block, `Esc` closes.

### 2. Configurable display (this session)

| Setting | Values | Default |
| --- | --- | --- |
| `terminalEnhanced.historyDisplay` | `editor`, `panel`, `sidebar`, `secondarySidebar`, `window` | `editor` |
| `terminalEnhanced.closeOnCopy` | boolean | `false` |

- `editor` — a `WebviewPanel` in the editor area (no auto-dismiss unless
  `closeOnCopy`).
- `panel` / `sidebar` / `secondarySidebar` — a **single** docked webview
  `WebviewView` (`terminalEnhanced.historyView`), moved to the chosen container
  with the internal `vscode.moveViews` command and focused. A `setContext` key
  (`terminalEnhanced.display`) hides it in `editor`/`window` modes; containers
  use `hideIfEmpty` so the unused ones disappear.
- `window` — create the editor panel, then
  `workbench.action.moveEditorToNewWindow`.
- QuickPick was tried and **rejected**: VS Code's only true floating popup is
  single-column and loses the two-pane layout.

## Architecture

```
REST/commands ─▶ tracker.ts ─▶ store.ts (node:sqlite, globalStorage)
                                   │ onDidChange
keybinding ─▶ display.ts ─┬─▶ editorPanel.ts  (WebviewPanel, editor/window)
                          └─▶ panelView.ts     (WebviewView + vscode.moveViews)
                                   │ postMessage(items)
                                   ▼
                            webview/popup.ts  ──{copy,id}──▶ copy.ts
```

| File | Role |
| --- | --- |
| `src/history.ts` | Pure display helpers (first line, item mapping). |
| `src/store.ts` | `node:sqlite` store (path-in, no `vscode`). |
| `src/tracker.ts` | Shell-execution tracking → store. |
| `src/settings.ts` | `historyDisplay` / `closeOnCopy` readers. |
| `src/display.ts` | Routes `showHistory` to the configured presentation. |
| `src/editorPanel.ts` | Editor-area / separate-window webview panel. |
| `src/panelView.ts` | Docked view + `vscode.moveViews` placement + `setContext`. |
| `src/copy.ts` | Clipboard write + status-bar echo. |
| `src/historyWebview.ts` | Shared webview HTML + `{ready|copy|close}` protocol. |
| `src/webview/popup.ts` | Webview UI (bundled by `bun build` → `media/popup.js`). |

## Platform traps (each cost a debug cycle)

1. **`config.*` in a view `when` is not reactive.** A view gated by
   `config.terminalEnhanced.historyDisplay == '…'` stayed visible after the
   setting changed. Gate with a `setContext` key and update it on
   configuration change instead.
2. **View-container ids are prefixed.** A `viewsContainers` id `foo` registers
   as `workbench.view.extension.foo`; `vscode.moveViews` with the bare id
   silently no-ops (its destination lookup returns `undefined`).
3. **View-container ids cannot contain dots** (`^[A-Za-z0-9_-]+$`). The first
   cut used `terminalEnhanced.panel`, so all three containers were rejected and
   the view fell back to a default container.
4. **The secondary-sidebar location key is `secondarySidebar`**, not
   `auxiliarybar`.
5. **`workbench.action.moveEditorToNewWindow` is a no-op under code-server** (a
   browser tab cannot open an OS window); `window` mode degrades to `editor`.
6. **The remote browser cannot be OS-focused from the runner**, so
   `navigator.clipboard.readText()`/`writeText` fail with *"Document is not
   focused"*. The copy oracle is a hook on the renderer's
   `navigator.clipboard.writeText` (the extension host's
   `vscode.env.clipboard.writeText` routes through it).

## Testing

```bash
npm run test:units        # bun: history helpers + SQLite store (temp DB)
npm run typecheck:webview # strict tsc over src/webview
npm run typecheck:tests   # strict tsc over the Playwright suite
npm run test:e2e          # 12 passed (2.2m)
```

- REST Control arranges/acts; Playwright (CDP) asserts the webview DOM, the
  copied payload, the status-bar echo, and the **container placement**
  (`.part.panel` / `.part.sidebar` / `.part.auxiliarybar` composite titles).
- Commands must be single (`;` splits shell-integration executions) and not
  instant builtins: use `bash -c 'sleep 0.3 && echo …'`.
- `window` mode is manual (browser can't open an OS window).

CDP checks were done through the `chrome-devtools-9022` MCP, bridged to the
live browser on `9024`.

## Verification log

```
units            history_check / store_check  all checks passed
typechecks       tsc src + src/webview + tests  clean
build            lamnguyenx.hacker-terminal-enhanced-2026.9.9.vsix
install          code-server 4.138.0 (container) + window reload
e2e              12 passed (2.2m)
manual (CDP)     editor tab shown + docked view hidden in editor mode;
                 panel / sidebar / secondarySidebar docked in the right part;
                 window fell back to editor under code-server
```

## Lessons

- **The stable API has no floating webview.** "Popup" has to be mapped onto
  QuickPick (single column) or a docked view; a webview is editor area / panel /
  sidebar only.
- **Read VS Code's source** (`_refs/code-server/lib/vscode`) when a command
  silently no-ops: `vscode.moveViews`, container-id prefixing, and `canMoveView`
  were all resolved there.
- **Move one view, don't contribute many.** One `WebviewView` moved between
  containers (plus `hideIfEmpty`) keeps the UI clean and the state single.
- **Make dismissal opt-in.** `closeOnCopy` (default `false`) matches how people
  actually paste (often after the panel would have auto-closed).

## Links

- Extension testing playbook:
  `_submodules/vscode-hacker-terminal-enhanced/docs/important/how-to-test.md`
- Extension design log:
  `_submodules/vscode-hacker-terminal-enhanced/docs/plans/2026/09/30/2026-09-30-terminal-enhanced-history-popup.md`
- General playbook: [`docs/important/how-to-test-all.md`](../../../important/how-to-test-all.md)
- Topology: [`docs/important/dev-code-on-nuc-test-on-pp.md`](../../../important/dev-code-on-nuc-test-on-pp.md)
