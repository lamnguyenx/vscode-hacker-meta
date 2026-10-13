# code-server trust, install path, and test-harness hardening

**Date:** 2026-10-12
**Status:** DONE
**Scope:** meta repo (`docker-compose.yml`, docs, `local/`) + `vscode-hacker-markdown`
+ `vscode-hacker-rest-control`
**Repo:** meta `cddcee4`; `vscode-hacker-markdown` `7e27bcc`;
`vscode-hacker-rest-control` `50b4d00` (all local, unpushed).

## Context

It started as a one-line task: *open `tests/samples/long-table-fail-02.md` and open
the Markdown preview panel.* It turned into a multi-hour environment forensics
session, then a deliberate cleanup of the harness that the forensics exposed.

Reference stack: code-server in Docker on nuc, the workbench opened from the pp
browser over an ssh `RemoteForward`, REST Control on `40620`, CDP on `9024`.

## What shipped

### 1. Workspace trust handled by the harness, not per extension

The instinctive fix for "Restricted Mode disables the extensions" is to declare
`"capabilities": { "untrustedWorkspaces": { "supported": true } }` in every
`package.json`. That was implemented first — then reverted at the owner's
request and replaced with a single compose flag:

```yaml
# docker-compose.yml — code-server service
command:
  - --bind-addr
  - 0.0.0.0:9620
  - --config
  - ${HOME}/.config/code-server/config.yaml
  - --user-data-dir
  - ${HOME}/.local/share/code-server
  - --disable-workspace-trust
```

`--disable-workspace-trust` is **session-scoped**: the workbench treats the
session as trusted, so extensions activate regardless of the workspace, and
third-party extensions that don't support untrusted workspaces load too. The
container can only reach the mounted git tree + config, so "trusted session" ==
"trust the mounts". No per-extension changes, nothing to seed client-side.

### 2. A deterministic install target

`make install-code-server` → `local/install-code-server.sh` installs every
submodule's **built** VSIX into the compose code-server:

- resolves the VSIX matching each `package.json` version (`build/` accumulates
  stale VSIXs — a naive `build/*.vsix` glob reinstalls old versions),
- runs `docker compose exec code-server code-server --install-extension … --force`,
  mapping the host path (the repo is mounted read-only at the same absolute
  path) and falling back to `docker compose cp` if it isn't under `$HOME/git`,
- prints the "reload once" reminder.

This replaces the old "symlink the repo into the extensions dir" dev path, which
silently breaks whenever the checkout moves.

### 3. Test-harness fixes (each was a real failure, not cosmetic)

| Fix | File |
| --- | --- |
| Attach to the real workbench tab instead of opening a stray `localhost:9620` tab | `rest-control/tests/playwright/workbench.ts` |
| Wait for the async mermaid render and match **every** renderer | `markdown/tests/integration/mermaid_stale_check.ts` |
| Accept any workbench page URL (a tailnet host is not `localhost`/`vscode-file`) | `markdown/tests/integration/plantuml_note_highlight_check.ts` |
| Activate the text editor before the CDP-keyboard cursor checks | `markdown/tests/integration/test_preview.ts` |
| Document that the `*_ix`/`*_check` probes are standalone, not one suite | `markdown/AGENTS.md`, `docs/important/how-to-test-all.md` |

### 4. Mermaid stale-holder bug exposed by the harness fix

With renderer detection fixed, `mermaid_stale_check` reached its assertion and
**failed for real**: `stale.ts` only excluded `.mermaid-wrapper` (the dev-host
renderer). Under code-server the chart renders as
`pre > div.mermaid-chart > (hmk-frame) > svg`, so the stale snapshot held the
`<pre>` and a `.hmk-stale-holder` ("Re-rendering…" badge + blank space) fired on
every refresh.

```ts
// src/webview/stale.ts
const MERMAID_SEL = '.mermaid-wrapper, .mermaid-chart, #markdown-mermaid';
if (child.closest(MERMAID_SEL) || child.querySelector(MERMAID_SEL)) {
    continue;
}
```

The `querySelector` half is the important bit: the block is the ancestor `pre`,
so a `closest()`-only check (the first cut) missed it and the check flaked
(0 samples once, 240 the next time).

### 5. Docs

- `docs/important/how-to-test-all.md` — how the harness handles trust (flag vs
  per-folder state; where trust is stored), the VSIX-vs-symlink install paths,
  the reload-once / orphaned-host note, and the "probes are not one suite"
  anti-pattern.
- `docs/important/dev-code-on-nuc-test-on-pp.md` — container image, the trust
  flag, and the recovery runbook.
- `README.md` — pointer to the harness target and the playbook.
- This document.

## Trials, errors, and dead ends

Ordered roughly as they happened. Several were self-inflicted by the previous
step.

1. **"The extension isn't installed" — it was installed, via a broken symlink.**
   The container's extensions dir held
   `hacker-markdown -> /home/lamnt45/git/vscode-hacker-markdown` — a path that
   stopped existing when the repo moved under `_submodules/`. The extension just
   never loaded (no error). Fixed by installing a built VSIX instead.

2. **Wrong code-server.** There are two: the container one (`9620`, data dir
   under `exp/`) and a host-native one (`9120`, `~/.local/share/code-server`).
   Half the initial diagnosis was against the wrong profile. The per-submodule
   `make install-code-server` also targets the *host* CLI, which never reaches
   the container — hence the new meta target.

3. **Reloads spawned orphaned extension hosts.** code-server keeps a disconnected
   extension host for `VSCODE_RECONNECTION_GRACE_TIME` (3h here). Each window
   reload added a host while the old one lingered, and one of them kept squatting
   `40620`, so REST commands landed in a *stale* session while the visible window
   was served by a different host (commands "succeed", nothing changes on screen).
   Recovered by restarting the container; the durable lesson is **reload once**.

4. **Trust was the actual blocker.** Every `lamnguyenx.*` extension lacks
   `capabilities.untrustedWorkspaces`, so Restricted Mode silently disabled all
   of them — the status bar said *Restricted Mode* the whole time, and the tell
   is that pure `custom.eval` works while `executeCommand`/`getConfiguration().update`
   hang and no port is bound. First fix: the capability flag. Second (shipped)
   fix: `--disable-workspace-trust` in compose.

5. **Trust is not where you'd look.** No `security.workspace.trust.*` setting
   lists folders (only `enabled`/`emptyWindow`/`untrustedFiles`/`startupPrompt`/`banner`).
   For code-server the workbench is the browser, so trust lives **client-side**
   in the browser's IndexedDB (`vscode-web-state-db-global-shared` →
   `content.trust.model.key`), keyed by the remote **authority**
   (`nuc…:9620` ≠ `localhost:9620`), and never in the server-side `state.vscdb`.
   A hand edit there "fixed" it for one origin, which is exactly why the flag is
   the better answer.

6. **`build/` accumulates stale VSIXs.** `_submodules/*/build/*.vsix` had several
   versions per extension; a glob install would pick the wrong one. The installer
   now reads each `package.json` version.

7. **Cycle of "it works / it doesn't".** Repeated container restarts and reloads
   made the environment the variable under test. A diagnostic that create/close
   tabs, opens the extension view, etc., leaves the workbench in a different
   shape each time — which is why pin/cursor "failures" turned out to be state.

8. **rest-control e2e opened a *new* tab and asserted against it.**
   `connectWorkbench` defaulted `CODE_SERVER_ORIGIN=https://localhost:9620`; the
   real tab was the tailnet host, so it opened a second tab and read an empty
   status bar. Fix: prefer the tab matching the origin, else any tab with
   `.monaco-workbench`.

9. **The mermaid renderer assumption is baked in.** `stale.ts` excludes
   `.mermaid-wrapper`; code-server renders `.mermaid-chart` / `#markdown-mermaid`.
   The same assumption (still unfixed) sits in `frames.ts` (the chart currently
   gets pan/zoom-framed under code-server), `cursor.ts`, `source.ts`, and
   `media.css` (invert / full-bleed).

10. **The first `stale.ts` fix was flaky, not wrong-by-luck.** It passed once
    (ancestor was the `.mermaid-chart`) and failed later (`pre` was the block).
    Determinism only came from testing descendants too.

11. **`showQuickPick` is flaky under load.** It passed 20/20 twice and failed
    twice with a 30s click timeout when the host was busy. Not chased; retry
    passes.

## Lessons

- **Read the existing playbook first.** `docs/important/how-to-test-all.md`
  already covered trust, the REST channel, install/restart hygiene, and even
  `security.workspace.trust.enabled`. Most of the session was re-deriving it.
- **Environment trust belongs in the environment.** One compose flag beats a
  capability declaration repeated in every `package.json`.
- **Reload once.** The 3h reconnection grace makes repeated reloads a footgun;
  prefer a single reload or a container recreate, and verify the REST port maps
  to the *live* host before driving it.
- **The host CLI and the container profile are different worlds.** Pass the
  container's `--user-data-dir`; never trust a directory listing as proof an
  extension loaded (check `vscode.extensions.getExtension(id).isActive`).
- **Anchor tests on the thing under test, not on a proxy.** A page URL, a
  renderer class name, the first `.monaco-editor`, or the presence of a command
  are all proxies that drift.
- **When a fix passes once and fails later, you haven't found the mechanism yet.**
  Instrument the DOM/state instead of re-running.

## Verification log

```
compose flag      docker inspect shows --disable-workspace-trust
trust             vscode.workspace.isTrusted === true   (capability absent from the build)
activation        lamnguyenx.hacker-markdown.isActive && …rest-control.isActive
install target    make install-code-server → both VSIXs installed into the container
markdown (CDP)    test_preview 15/15 ; mermaid_stale_check PASS ×2 ;
                  plantuml_note_highlight_check PASS
rest-control e2e  20/20 (default CODE_SERVER_ORIGIN; one flaky retry of showQuickPick)
regression set    custom_styles 6/6, media_controls 7/7, link_nav 3/3,
                  editor_preview 2/2, pin 5/5, plantuml_intellisense 3/3,
                  plantuml_render 7/7, preview_misc 6/6, render_on_save 3/3
```

## Files & commits

| Where | What |
| --- | --- |
| `docker-compose.yml` | `--disable-workspace-trust` on the code-server service |
| `local/install-code-server.sh` (new) | version-matched container install |
| `Makefile`, `README.md`, `AGENTS.md` | `install-code-server` target + docs |
| `docs/important/how-to-test-all.md`, `…/dev-code-on-nuc-test-on-pp.md` | playbook + runbook updates |
| `_submodules/vscode-hacker-markdown` | `7e27bcc` — stale.ts (renderer-agnostic) + 3 harness fixes + AGENTS |
| `_submodules/vscode-hacker-rest-control` | `50b4d00` — `connectWorkbench` host-agnostic |

## Links

- General playbook: [`docs/important/how-to-test-all.md`](../../../../important/how-to-test-all.md)
- Topology / runbook: [`docs/important/dev-code-on-nuc-test-on-pp.md`](../../../../important/dev-code-on-nuc-test-on-pp.md)
- Extension playbook: `_submodules/vscode-hacker-markdown/docs/important/how-to-test.md`
- Meta repo: [`README.md`](../../../../../README.md)
