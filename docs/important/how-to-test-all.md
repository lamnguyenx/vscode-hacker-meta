# How to test a VS Code extension (general playbook)

Transferable rules for testing **any** VS Code extension end-to-end in this
environment. Distilled from the per-extension playbooks in
[`_submodules/vscode-hacker-markdown`](../../_submodules/vscode-hacker-markdown/docs/important/how-to-test.md)
(webview panel, embedded-editor language features, contributed grammars,
background fetches), [`_submodules/vscode-hacker-browser`](../../_submodules/vscode-hacker-browser/docs/important/how-to-test.md)
(webview embedding a cross-origin iframe; Playwright-driven shell; server-log
and OS oracles), and [`_submodules/vscode-hacker-path-picker`](../../_submodules/vscode-hacker-path-picker/docs/important/how-to-test.md)
(QuickPick UI; isolated instance; clipboard oracle). Environment setup lives in
[`dev-code-on-nuc-test-on-pp.md`](dev-code-on-nuc-test-on-pp.md) — read that
first.

The examples use the reference stack (code-server in Docker on a remote box,
driven over CDP from a real browser, with a REST control extension in the
extension host). The **rules generalize**; the exact commands are the reference
implementation's.

## TL;DR

1. **Ask the user which environment** — code-server (preferred) or a local dev
   host — before running anything.
2. **Separate arrange/act from assert:** drive the extension host through a
   control API (REST `executeCommand`/eval); read observable state through CDP.
3. **Prefer deterministic API calls over keyboard automation.** Browser CDP
   swallows `Ctrl/Cmd+S`, `Ctrl+Shift+P`, `Ctrl+P`.
4. **Test in layers:** pure logic (no host) → host language features → UI/webview
   → manual. Push as much as possible down to the pure layer.
5. **Clean up after every suite.** The workbench is a shared, stateful resource;
   leftover dirty editors and tabs cause phantom failures.
6. **Pin every moving part** — ports, fixture paths, extension versions — and
   make the test runner and the extension host agree on them.
7. **A failing test is often load or stale state, not a regression.** Re-run on
   a quiet machine / fresh host before believing it.
8. **Never mutate the developer's environment without restoring it.** Snapshot
   and put back user settings; the workbench, profile and window layout are
   shared, persistent state.

---

## 1. Pick the environment before writing or running tests

A webview extension is not testable with plain browser tooling: its UI runs in
an **out-of-process iframe (OOPIF)** in the desktop app, or a **nest of
same-origin iframes** under code-server. Two supported environments:

| | Option A — code-server in Docker (**preferred**) | Option B — Extension Development Host |
| --- | --- | --- |
| What | Real code-server, real user extensions, driven from a real Chromium browser over CDP | Dedicated `code --extensionDevelopmentPath` instance with a debug port |
| Cockpit | `hotload code-server` + browser tab | `vscode_cdp` / `vscode_cdp_kill` |
| Best for | Realistic end-to-end, webview DOM, contributed plugins, interactive tooling | Keyboard-driven flows (save, palette), zero-install iteration |
| Caveats | Browser eats some shortcuts; mounted settings persist; service-worker caches JS | `--disable-extensions` default; puml/themes need `--with-extensions`; per-profile state |

**Rule (agents):** ask the user which environment they want; default to Option A
when they have no preference. In Option A the webview is **not** a separate CDP
target — you evaluate on the workbench page and dive through iframes.

### Environment mechanics (reference stack)

Concrete launch/prep mechanics, generalized — substitute your extension name,
profile dir, and fixtures.

**Option B — dev host.** `vscode_cdp` kills any prior host on the port, launches
`code --extensionDevelopmentPath=… --user-data-dir=<profile>
--remote-debugging-port=<port> --new-window <fixture>` detached, and polls the
port until the window is up. `vscode_cdp_kill` SIGTERMs it (main process only,
so no "Reopen?" dialog). Flags worth knowing:

- `--profile <dir>` — per-repo scratch profile (default is shared per port).
- `--file <path>` — open a file at startup so a view renders without extra setup.
- `--with-extensions` — load the real user extensions (the **default disables
  them**). Needed for any feature that depends on another extension (themes,
  diagram renderers, formatters).

Traps:

- a fresh `--user-data-dir` is required for a separate instance, otherwise the
  window joins a running VS Code and ignores the debug port;
- a scratch profile may need a setting that changes input behavior — e.g.
  `editor.editContext: false` (VS Code 1.13x defaults it on and the editor then
  ignores `Input.insertText`); recreate the profile with it if live-edit checks
  fail;
- the profile is reused across launches, so *applied* state (theme, open tabs)
  persists — a stale session can serve a stale window;
- Linux: the `code` on PATH must be the **native desktop binary** (the
  Remote-SSH CLI wrapper rejects the dev-host flags), `$DISPLAY` must be set (or
  `xvfb-run`), and a killed host can leave a `dconf watch` helper holding the
  CDP port in a zombie LISTEN state — free it (`ss -tlnp | grep :<port>`) before
  relaunching.
- keep the test instance fully isolated: `--user-data-dir` **and**
  `--extensions-dir`, so it never touches your daily profile or install; pre-seed
  `User/settings.json` to suppress first-run dialogs
  (`"security.workspace.trust.enabled": false`,
  `"window.restoreWindows": "none"`);
- **never `pkill` the host by debug port** — the pattern also matches renderer
  helper processes and triggers the "window terminated unexpectedly — Reopen?"
  dialog; use a graceful kill (`vscode_cdp_kill`, or the repo's
  `tools/kill-*.sh`);
- after editing `media/` assets, a CDP-synthesized reload may not refresh them —
  restart the host instead.

**Option A — code-server.** Install by symlinking the repo into the extensions
dir (a live mount, so `out/`/`build/` are read as-is), then `hotload code-server`
after each rebuild; the service worker may still serve stale JS, so also bump
`package.json#version` (see §9). The webview is not a separate CDP target —
evaluate on the workbench page and dive through the frames, finding your webview
by the `extensionId` in the iframe `src`:

```js
document.querySelector('iframe[src*="extensionId=<publisher.name>"]')
  .contentDocument                           // the webview bootstrap frame
  .querySelector('iframe').contentDocument   // your webview document
```

**Restricted Mode silently disables every user extension.** An untrusted
workspace does not activate user extensions: the control extension never binds
its port, and the workbench looks alive while `executeCommand` /
`getConfiguration().update` hang (pure evals still work — that asymmetry is the
tell). Check `vscode.workspace.isTrusted` and trust the workspace **first**;
recreating code-server can leave it untrusted.

**Fresh-profile workbench prep** (once per launch/recreate): (1) dismiss the
one-time onboarding overlay — it swallows all input; (2) toggle the panel
(`Cmd/Ctrl+J`) until the container switcher materializes (the panel bar is
rendered lazily); (3) click your view's tab with a real CDP mouse event;
(4) wait for the webview target/iframe. Opening a text file at startup makes the
view render immediately.

**VLM-assisted debugging.** When your model lacks vision, screenshot the target
and hand the image to a vision-capable model instead of guessing:

```sh
node -e "… real CDP client: find the target, CDP.screenshot(target.id, '/tmp/shot.png') …"
opencode run -m '<vision-capable-model>' \
  "Describe the rendered content. Are there any errors?" -f /tmp/shot.png
```

## 2. Test in layers (the pyramid)

Push every behavior to the lowest layer that can prove it:

| Layer | Needs | How | What belongs here |
| --- | --- | --- | --- |
| **Pure logic** | nothing (no host, no compile) | import `src/**/*.ts` directly with bun | parsers, rewrite/transform functions, catalog/count logic, span math — anything with **no `vscode` import** |
| **Extension host** | running host | control API: `vscode.commands.executeCommand(…)`, `document.save()`, settings writes | language features (definition/completion/hover/rename/lens/folding), commands, config |
| **UI / webview** | running host + browser CDP | evaluate in the iframe chain, real mouse/key events | DOM rendering, layout, frames, click/scroll, cursor highlight |
| **Manual** | a human | eyeball / interactive tooling | things with no stable oracle (see §13) |

The single biggest win is **structuring source so the interesting logic is pure**
(no `vscode` import) and can be unit-checked against the shipped code without a
host or a compile step. Reference examples: `src/plantuml/*` + `tests/units/*`
(markdown) and the extracted iftopd codec `src/sysinfo/protocol.ts` +
`tests/units/*` (stats bar).

## 3. Arrange/act via a control API, assert via CDP

The reference setup runs a **REST control extension** in the extension host:
HTTP `POST` with `{command, args}` runs `vscode.commands.executeCommand`, plus a
`custom.eval` escape hatch for arbitrary JS with `vscode` in scope.

```
REST   → arrange + act   (open files, type, save, settings, run commands)
CDP    → assert only     (read webview DOM: rendered nodes, attributes, classes)
```

Why this beats keyboard automation:

- Browser CDP **intercepts** `Ctrl/Cmd+S` (Save Page), `Ctrl+Shift+P`/`Ctrl+P`
  (print/save). Trusted key events for browser-reserved shortcuts never reach the
  keybinding service under code-server.
- The palette's fuzzy matcher ranks rows unpredictably, and palette timing is
  racy under load; `executeCommand` is exact and synchronous.
- It works identically under code-server and the dev host.

**Rules:**

- Add a small, shared control helper anyway — you still need CDP to assert.
- **Use the shared control client; never hand-parse the channel.** Reading a
  value with `fetch(...).text()` (raw JSON text) and restoring it with
  `JSON.stringify` double-encodes it — this corrupted a user's
  `workbench.colorTheme` for hours. The client must `JSON.parse` responses and
  the value must stay a value.
- **Box falsy results across the channel.** The reference REST server replies
  with `JSON.stringify(data || null)`, so a legitimate `false` / `0` / `''`
  arrives as `null`. Return a wrapper (`({ value })`) from `custom.eval` when
  the oracle can be falsy — an `enabled === false` assertion silently read as
  "unset" before this.
- **When the extension under test *is* the control channel, assert the channel's
  own contract too.** The falsy-boxing rule above, the `400` + JSON error body,
  the CORS/bind headers, the loopback-only bind, and the JSON-body vs
  `?command=…&args=…` query form are the cheapest, broadest regression net you
  can write — and every consumer suite silently depends on them. A regression
  there corrupts all of them.
- Use `custom.eval` for extension-host assertions the REST surface doesn't
  expose (`vscode.executeDefinitionProvider`, `executeCompletionItemProvider`,
  `vscode.window.tabGroups`, etc.). Prefer this over clicking UI to read state.
- Where keyboard is unavoidable, use **trusted** CDP input
  (`Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`), and prefer `F1` over
  `Ctrl+Shift+P` (Chromium has no `F1` default). Synthetic DOM events are only
  legitimate *inside* the webview for things like setting scroll position.
- After typing, a re-render typically happens **on save**, not on keystroke
  (many extensions debounce or gate on save). Assert the *old* content between
  typing and saving.
- Not every stack has a REST extension — the **control channel** can also be
  **Playwright over CDP** driving the workbench (real keyboard/mouse for the
  palette, panel tabs, settings) or a repo's own `tools/*.sh` + `exp/*.cjs`
  scripts. Keep the same split: drive via the control channel, assert via CDP.
- **Playwright can drive the workbench shell but not the webview OOPIF.** Use
  `chromium.connectOverCDP(port)` for the workbench page (view registration,
  panel tab, palette commands) and raw CDP (`/json/list` → `vscode-webview://`
  target) to reach the webview. **Under code-server the webview is not an
  OOPIF**: it is nested same-origin iframes inside the workbench page, so
  Playwright's `frameLocator` reaches it directly
  (`page.frameLocator('iframe[src*=extensionId=…]').frameLocator('iframe')`) —
  see the browser extension's committed suite. The raw-CDP requirement applies
  to the desktop dev host only.
- **Trusted keyboard-input traps under CDP:** (a) the webview must be the
  workbench's *active element* for VS Code to forward keys — click *inside the
  webview target*, not the workbench page; (b) shifted keys need the **uppercase
  letter** in `key` (`key: 'T'` with the shift modifier bit) or Chromium drops
  the shift and a different command runs; (c) symbol keys need explicit `code`s
  (`Minus`, `Equal`, `Digit0`, …) and modifier bitmasks (**Alt = 1, Meta = 4**).

## 4. Reaching the UI: topology, frames, stable anchors

- **Auto-detect the topology in one shared helper.** OOPIF (dev host): find a
  `vscode-webview://` target and probe it. Nested (code-server): from the
  workbench page, find the webview iframe by its **`extensionId=<publisher.name>`**
  in the `src`, then descend into its child iframe. Same helper API
  (`pEval`/`pClick`) for both.
- **The `contentDocument` gotcha (dev host):** the extension's HTML lives in a
  *child frame of the OOPIF*, so every expression must reach
  `document.querySelector('iframe').contentDocument`.
- **Find the view by a stable app anchor, never by target order.** The reference
  probes for `.toolbar .doc-name`; use whatever uniquely identifies *your*
  extension's UI. Target order changes with session restore.
- **Compute mouse coordinates from the frame chain.** Under code-server a click
  must be offset by `extFrame.getBoundingClientRect() + innerFrame.getBoundingClientRect()`,
  recalculated before each click (scrolling/layout shifts it).
- **Scroll before clicking:** `elementFromPoint` returns `null` below the
  viewport, so CDP clicks miss. `scrollIntoView({block:'center'})` first.
- **Lazy tabs:** webview tabs that are not the active tab in their editor group
  have **no iframe in the DOM** under code-server. Assert on **tab presence**,
  not webview DOM, to prove a panel was created.
- **Multiple previews exist.** "Return the first preview found" helpers can
  attach to a backgrounded editor panel instead of the docked view. Close extra
  editor panels first, or distinguish them by a view-only affordance.
- **Maximize the webview's estate before asserting.** Close editors, hide the
  secondary sidebar and the panel, and widen the pane that hosts the view
  (drag its sash). The webview fills its pane, so a bigger pane removes a class
  of layout-dependent flakiness — clicks landing outside the viewport,
  `elementFromPoint` misses. Window layout persists in the profile, so do it
  once per suite and say so.

## 5. Prefer observable behavior + the end-to-end echo

- Assert on what the user can observe (DOM nodes, attributes, text, classes,
  scroll positions), not on private internals.
- Where a feature is a round-trip (UI click → host message → host action →
  echoed back), assert the **echo** — it is stronger than introspecting either
  half. Reference example: click a rendered block → the host moves the editor
  selection → `onDidChangeTextEditorSelection` echoes the line back → the
  highlight moves. That single assertion proves the whole chain.
- For virtualized editors (monaco), a line only exists in the DOM once scrolled
  into view. Never query a line by DOM without scrolling; use `Ctrl+G`
  (go-to-line, 1-based) which works regardless of scroll, and remember fragment
  `data-line`-style attributes are typically 0-based.

## 6. Ground truth: reuse the platform's own engine

When the extension post-processes output from a built-in engine (e.g.
`markdown.api.render`), treat the **built-in fragment as trusted** and assert on
what *your* extension did with it (added attributes, wrapped frames, injected
spans) — not on the engine's HTML.

### Brand a shared chrome surface before asserting on it

The status bar, Problems, and the notification area are shared with the
workbench and other extensions, so "the bar changed" is **not** an oracle. Give
your items a unique marker — a format prefix (`SBCPU ${percent}%`), a
`Copied …:` message prefix — and match the marker. Assert on a set (or an
absence), never on the whole surface. Two corollaries:

- **A format is not applied when there is no data.** An extension that falls
  back to `-` when its provider is empty will not show your marker; identify
  that state by tooltip/`aria-label` instead.
- **Chrome order is a layout artifact.** A right-aligned status section renders
  its items in **reverse** insertion order (the left section preserves it);
  assert alignment-aware order, or compare as a set.

### Pin an external dependency with a fake on host loopback

When the extension consumes an external daemon/socket, replace it in the suite
with a deterministic fake that speaks the **same wire format** — import the
extension's own codec so the two cannot drift. Under `network_mode: host` the
extension host reaches the runner's `127.0.0.1`, so a plain TCP endpoint works
with no container plumbing; a `host:port` override setting makes it selectable.
Assert the deterministic values end-to-end (rendered text *and* tooltip), not
just "some data appeared".

The same trick covers **outbound HTTP callbacks** (event forwarding, an external
formatter): stand up a local HTTP server on the runner's loopback and point the
extension at it. Its **request log is the ground truth** that the call happened —
stronger than introspecting the extension — after which you assert the payload
and any echoed effect (e.g. the returned text actually landed in the document).

### Cross-origin content has no in-page oracle

When the extension embeds a **cross-origin** frame, the webview cannot read the
loaded page's DOM (`contentDocument` is inaccessible), and a failed load is
**silent** — no `error` event, `load` fires either way, and the frame resolves to
`about:blank`. So the `src` attribute is **not** proof. Use instead:

- a **server-side oracle** — a local test server's access log (`GET /x 200`) is
  ground truth that the page actually loaded;
- a **host-side probe** — have the extension probe the URL and surface an error
  overlay, then assert that overlay in the (same-origin) webview DOM.

## 7. State hygiene: suites must be idempotent and self-cleaning

- **Clean up in `finish()`.** Revert + close every dirty editor, close leftover
  text tabs (keep webview panels), delete temp fixtures. On code-server, close
  a dirty editor via `workbench.action.revertAndCloseActiveEditor` — force-close
  via the tab API still pops a save dialog.
- **A stuck "Do you want to save?" dialog blocks everything** (REST evals
  included). Dismiss it before continuing.
- **Non-idempotent suites exist; isolate them.** A smoke test that opens files,
  creates panels and switches editors cannot be re-run against a live session:
  restart the environment first.
- **Session restore serves stale state.** A reused profile can attach to a
  stale/hidden view. Wipe the profile or use a fresh `--user-data-dir`.
- **Batch limits are real.** The workbench destabilizes after a handful of
  integration tests (accumulated tabs/panels → timeouts, palette never renders,
  hang). Run one at a time; restart between small groups; the only reliable
  recovery is a container restart + fresh browser tab + re-prep.
- **Tests must not leave tracked fixtures dirty.** `git checkout` fixtures after
  a run if a failed input path leaked typed text.
- **Persisted side-state survives runs.** Extensions that write to global storage
  (history, zoom buckets, caches) carry state across test runs — normalize or
  reset it before asserting absolute values.
- **Tests must not mutate the developer's settings.** Snapshot the
  **Global-scope** value first
  (`getConfiguration(section).inspect(key).globalValue`), restore it, and
  **remove** a key that did not exist. `update(key, undefined)` can leave
  `"key": null` in some builds — treat `null`/`undefined` alike as "remove".
  Recover unintended changes from VS Code **local history**
  (`User/History/<id>/*.json`), which keeps timestamped copies of edited files.
- **`machine` / `machine-overridable` settings do not live in `User/settings.json`.**
  Under code-server, `ConfigurationTarget.Global` writes land in
  `<user-data-dir>/Machine/settings.json`, and `inspect().globalValue` reflects
  them. Snapshot/restore still works, but verify hygiene by **checksumming the
  machine file** (`md5sum` before/after) — diffing `User/settings.json` shows
  nothing.
- **Scratch probes are suites too.** An ad-hoc eval that changes settings and
  does not restore them becomes the "original" the next run's `beforeAll`
  snapshots — the suite then faithfully preserves the pollution. Restore probe
  changes before running the suite, and re-derive the original from local
  history when in doubt.
- **An extension that rebinds or disables itself on a settings change is hostile
  to a shared workbench.** If changing any of its settings restarts its server —
  and re-entering startup re-checks a port it already holds, or resolves a stale
  pid file back to the current host — then don't toggle those settings from the
  suite. Cover enable/disable and fallback paths by hand on a throwaway
  instance, and change **nothing** so there is nothing to restore.
- **A hard-interrupted suite bypasses cleanup.** If the runner is killed,
  `afterAll`/`finish()` never runs, so settings/layout leaks stick. Keep a short
  manual restore list for anything the suite changes.

## 8. Pin the moving parts (ports, paths, versions)

- **Pin control-plane ports via environment, not a workspace hash.** A port that
  is derived from the workspace path changes when the folder changes; a broken
  or occupied pinned port can fall back to a random ephemeral port. Put it in
  `docker-compose.yml` as an env passthrough
  (`HACKER_REST_CONTROL_PORT: ${HACKER_REST_CONTROL_PORT:-40620}`) and have both
  the extension and the test runner read the same var. Confirm `process.env`
  actually reaches the extension host with a live probe.
- **Don't hardcode fixture paths.** The runner and the extension host may not
  share a filesystem (container vs host). Resolve the extension root as the
  **host** sees it: an env override (e.g. `HMK_EXT_ROOT`) → the canonical mount
  if it exists → the repo derived from the test file's own location.
- **Container networking matters.** Extensions often fetch from the extension
  host process (inside the container), while the browser fetches separately.
  A server bound to the host loopback is unreachable from a bridged container —
  use `network_mode: host` or bind `0.0.0.0`. The failure is usually **silent**
  (a graceful fallback that disables a feature), so probe reachability from
  inside the container explicitly.
- **Version-pin the extension under test.** The install must not be shadowed by
  a stale copy.
- **A stale PID file is a landmine.** Any "kill the previous holder of my port"
  logic must verify the process is actually yours (e.g. `/proc/<pid>/cmdline`)
  before killing — container restarts recycle PIDs.

## 9. Rebuild, reinstall, restart, cache-bust

The full loop for a change:

```sh
npm run compile                 # build the extension in its own repo
# repackage + install (code-server in Docker):
docker exec <container> code-server --install-extension <abs/path/to.vsix> --force \
  --user-data-dir <user-data-dir> --extensions-dir <extensions-dir>
hotload code-server             # kill + up -d --no-deps --force-recreate
# then reload the browser tab so the workbench starts a fresh extension host
```

**Install into the profile the running host actually loads.** There can be more
than one code-server data dir (a Docker mount source *and* the host's real
`~/.local/share/code-server`, possibly each with a running server). The host CLI
writes to the literal `--user-data-dir` you pass, so passing the *container*
path silently edits a different profile. Pass the **host mount source**, then
confirm what the host loaded with `vscode.extensions.getExtension(id)` (id
**and** version) — a directory listing is not proof.

Cache-busting rules:

- **code-server caches extension JS in a Service Worker.** A plain reload may
  serve stale modules even with `ignoreCache`. The reliable fix is to **bump
  `package.json#version`** — code-server treats a new version as a new
  extension. Same-version reinstall can be skipped; bump it.
- **Open editors cache grammar tokens.** After changing `syntaxes/*` or
  `contributes.grammars`, close and reopen the tab (a window reload is not
  always enough).
- **`make install` skips an unchanged version.** Bump it, or overwrite the
  installed extension dir and reload the window.
- **A calendar version must still be valid semver.** `vsce` rejects
  `2026.09.30` ("Invalid extension version"; leading zeros are not valid
  semver) even though `npm` will happily store it in the lockfile. Use
  `2026.9.30`.
- Installing an extension while a host is running is picked up mid-session, but
  a just-launched host can miss an install that was in flight — relaunch once
  after installing.

## 10. Observability: read the right log

- **Extension-host `console.log` does not go to the browser console.** It goes
  to `…/logs/<ts>/exthost<N>/remoteexthost.log` (or an output channel’s log
  file). Messages in DevTools marked `[Extension Host]` are a cross-post, not
  the same thing. If a log never appears, write to a temp file to prove the code
  ran.
- **`renderer.log` carries manifest/grammar/activation errors** (e.g.
  "Unable to load and parse grammar … nonexistent file").
- **Window `main.log` records failed frame loads** (e.g.
  `CodeWindow: failed to load (reason: ERR_BLOCKED_BY_CSP)`). A webview CSP of
  `frame-src *` does **not** match `data:`/`blob:` navigations — add
  `data: blob:` if the extension frames them.
- **Grammar/theme debugging: verify scopes, not colors.** Use
  `Developer: Inspect Editor Tokens and Scopes` to read the full scope stack.
  `mtk*` classes only encode colors, which are theme-dependent (a monochrome
  theme looks like “no highlighting” even when tokenization is correct). For
  final colors, run the grammar through the real `vscode-textmate` with the
  theme applied offline.
- **When your model lacks vision,** delegate screenshots to a vision-capable
  model via the CLI rather than guessing.

## 11. Isolate environment-dependent failures with A/B controls

When something works “standalone” but fails in the real window, it is often an
**injection grammar** or behavior from *another* extension. Use three controls:

| Control | How | If it passes |
| --- | --- | --- |
| A — extensions off | dev host default (`--disable-extensions`) | your code is fine in isolation |
| B — all extensions | `--with-extensions` | some user extension collides |
| C — all minus suspect | `--with-extensions --disable-extension <id>` | **that** extension is the trigger |

Smoking-gun symptoms: an unexpected scope on top of yours; an unbalanced bracket
scope (`unexpected-closing-bracket`); bracket counters summed across regions; a
foreign language scope inside your embedded region. Fix by opting your region
into the other grammar's exclusion selector where possible (e.g. add a
`comment.block.*` scope to your fence `contentName`).

## 12. Flakiness is usually load — characterize it before “fixing” code

Some checks have short time windows and fail under pressure (other VS Code
instances, build/install jobs, RAM exhaustion) on a pristine checkout. The
failure set is often characteristic. Before treating a failure as a regression:

- Re-run on a fresh host on a quiet machine.
- A/B against `git stash`; if a log-clean A/B both pass on retry, it was load.
- Prefer polling with a timeout (`evalUntil`) over fixed sleeps — but keep
  tight polls tight where the state window is genuinely short.

## 13. Verify by hand (known limits)

Not everything has a stable external oracle. Deliberately leave these manual,
and say so in the docs:

- Stock VS Code chrome interactions (dragging a view to the sidebar).
- Bidirectional scroll sync where the editor side has no DOM oracle.
- Actions that touch the user's environment (opening external links in the
  system browser).
- Keyboard behavior inside cross-origin iframes (keystrokes never reach VS Code).
- Cases requiring an external server/dependency that isn't part of the repo.

## 14. Tooling gotchas worth remembering

- **Don't inline complex code in `bun -e '…'`** (nested backticks/`${}`/quotes
  get mangled by the shell). Write a temp `.ts` file, or use the MCP
  `evaluate_script` tool which has no shell-quoting layer.
- **On Linux/Remote-SSH, the `code` on PATH must be the native desktop binary.**
  The vscode-server CLI wrapper rejects `--extensionDevelopmentPath`,
  `--user-data-dir`, `--remote-debugging-port`. `$DISPLAY` must be set (or use
  `xvfb-run`).
- **Orphaned CDP-port holders:** a `dconf watch` helper can inherit the CDP
  socket and keep the port in a zombie LISTEN state after the host is killed;
  free it (`ss -tlnp | grep :PORT`) before relaunching.
- **`connectOverCDP` can hang after a browser restart.** Playwright connects the
  websocket but stalls attaching to targets while stray blank / start-page tabs
  are open. Close them via the CDP HTTP endpoint
  (`curl -s http://127.0.0.1:<cdp>/json/close/<targetId>`) and retry; logging in
  can be done with a raw CDP `Runtime.evaluate` form submit.
- **VS Code local history** (`User/History/<id>/*.json`) keeps timestamped
  copies of edited files — the forensic tool for "who changed my setting, and
  when".
- **Test webview JS without a host.** Run the real webview bundle in a plain
  page with a stubbed `acquireVsCodeApi`, serve the built CSS, and flip the page
  title to PASS/FAIL. Great for cross-renderer logic that doesn't need the
  extension host.
- **Fully detach long-lived helper servers** so a dead shell can't take them
  down: `( nohup <cmd> </dev/null >>log 2>&1 & )`. Verify with a `curl` status
  code before blaming the extension.
- **Screenshotting a webview:** the OOPIF target itself is not capturable
  (top-level only). Clip from the workbench page — find the webview iframe's
  `getBoundingClientRect()` there and capture with a `clip`.
- **Don't trust the accessibility snapshot** for virtualized/custom widgets
  (QuickPick, monaco lists) — query the DOM with `page.evaluate`.
- **Read the OS clipboard for copy assertions** (`pbpaste`/`xclip`);
  `navigator.clipboard.readText()` is denied in the renderer.
- **QuickPick re-filters your items** with its own fuzzy matcher against the raw
  query. If your extension computes path/glob matches, set `alwaysShow: true` and
  filter yourself — otherwise the widget hides every row even though the
  extension returned results.
- **A pinned formatter bounds the syntax you may use.** Prettier 2.x cannot
  parse inline `type` import/export modifiers (`import { type X }`); the lint
  step fails with a parse error. Use a separate `import type { X }` (or bump the
  whole toolchain).
- **Modern `@types/node` changes `Buffer` and socket types.** `Buffer` is
  generic (`Buffer<ArrayBuffer>`) and a socket `'data'` chunk is
  `string | Buffer`; annotate the accumulator and normalize the chunk, or the
  extension no longer compiles against newer types.
- **Pick a language/context where your code is the sole contributor.** A provider
  query (`vscode.executeFormatDocumentProvider`, completion, hover) returns the
  **merge** of every provider — a foreign formatter split a test's fixture output
  into two edits in a real run. Also probe `document.languageId` instead of
  inferring it from the file extension (a `.txt` fixture mapped to `log`).
- **Verify a documented feature against the source before building an oracle on
  it.** A README example can describe behavior the code does not implement — e.g.
  `__type__` special-type arguments were documented and shipped in a sample file,
  but `executeCommand` received plain objects and the command rejected them.
- **`viewsContainers` ids are prefixed and characters are restricted.** A
  contributed container id `foo` is registered as
  `workbench.view.extension.foo`; `vscode.moveViews` with the bare id silently
  no-ops. Ids must match `^[A-Za-z0-9_-]+$` (no dots), and the secondary-sidebar
  location key is `secondarySidebar` (not `auxiliarybar`).
- **A view `when` clause on `config.<section>.<key>` does not reliably
  re-evaluate when the setting changes** — a view gated that way stayed visible
  after the value changed. Gate with `setContext` and update it on
  `onDidChangeConfiguration`.
- **`workbench.action.moveEditorToNewWindow` is a no-op under code-server** (a
  browser tab cannot open an OS window); features that "open a window" degrade
  to the editor area there.
- **A remote browser cannot be OS-focused from the runner**, so
  `navigator.clipboard.readText()`/`writeText` reject with *"Document is not
  focused"* (CDP focus emulation does not fix it). To assert a copy, hook the
  renderer's `navigator.clipboard.writeText` — the extension host's
  `vscode.env.clipboard.writeText` is delivered through it — instead of reading
  the clipboard.

## Anti-patterns

- ❌ Clicking the palette / sending `Ctrl+S` to arrange state under code-server.
- ❌ Asserting on internal state instead of observable DOM / the echo.
- ❌ Mutating the developer's settings, profile or window layout without
  restoring them.
- ❌ Concluding "the extension is broken" from hung command/REST calls before
  checking workspace **trust** (Restricted Mode disables user extensions).
- ❌ Hardcoding absolute fixture paths or a workspace-hash-derived port.
- ❌ Leaving dirty editors/tabs behind; running suites back-to-back without
  cleanup or restarts.
- ❌ Trusting a passing run in a reused profile / stale extension host.
- ❌ Assuming “works in standalone textmate” means it works in the window.
- ❌ Concluding “regression” from a single run on a loaded machine.
- ❌ Passing the *container* `--user-data-dir` to a host `code-server` install —
  it edits a different profile than the one the container loads.
- ❌ Letting scratch probes mutate settings without restoring them.
- ❌ Treating a shared chrome surface (status bar, Problems, notifications) as a
  boolean oracle, or its DOM order as insertion order.
- ❌ Building an oracle on a feature the README documents but the source does not
  implement (or driving a workbench command that reports success on a no-op when
  a provider API answers the exact question).
- ❌ Toggling the settings of an extension that rebinds or disables itself on a
  settings change, then treating the stranded control channel as a regression.

## Reference implementation map

The rules above are implemented here (paths relative to the meta repo):

- Playbook for the reference extension:
  `_submodules/vscode-hacker-markdown/docs/important/how-to-test.md`
- Additional playbooks: `_submodules/vscode-hacker-browser/docs/important/how-to-test.md`
  (committed `@playwright/test` suite: REST arranges/acts; a two-level
  `frameLocator` reaches the code-server webview; `data:` fixtures assert the
  embedded page's own DOM; the HTTP fixture server is the probe oracle —
  mixed-content, `custom.eval`-falsy, and `mainThreadWebview-` prefixed
  `viewType` traps; **non-destructive** global-settings snapshot/restore and the
  `maximizeBrowserEstate` layout step) and
  `_submodules/vscode-hacker-path-picker/docs/important/how-to-test.md`
  (committed `@playwright/test` suite + `bun` pure-logic checks; dedicated
  fixture workspace that inherits the meta repo's trust; QuickPick traps;
  status-bar copy echo as the oracle — a host-side `clipboard.readText()` hangs
  under code-server)
- Status-bar extension: `_submodules/vscode-hacker-stats-bar/docs/important/how-to-test.md`
  (committed `@playwright/test` suite + `bun` pure-logic checks; unique
  **format markers** turn the shared status bar into a deterministic oracle; a
  fake `iftopd` TCP daemon pins the `portSpeed` rates and tooltip; `statsBar.*`
  are `machine-overridable`, so hygiene is verified by checksumming
  `Machine/settings.json`)
- Terminal history extension: `_submodules/vscode-hacker-terminal-enhanced/docs/important/how-to-test.md`
  (committed `@playwright/test` suite + `bun` pure-logic checks; one webview
  rendered in five places — editor / panel / primary sidebar / secondary
  sidebar / separate window — as a `setContext`-gated `WebviewView` moved with
  `vscode.moveViews`; container placement is asserted on the workbench chrome,
  not just the webview DOM; the copy oracle is a hook on the renderer's
  `navigator.clipboard.writeText`; `node:sqlite` history + a `bun build` webview
  bundle; commands must avoid `;` and instant builtins for deterministic
  captures)
- Environment / topology: `docs/important/dev-code-on-nuc-test-on-pp.md`
- Dual-topology CDP helper: `_submodules/vscode-hacker-markdown/tests/integration/cdp.ts`
- Control-plane helper + cleanup: `_submodules/vscode-hacker-markdown/tests/integration/rest.ts`
- Suite runner + path/port resolution: `_submodules/vscode-hacker-markdown/tests/integration/test_utils.ts`
- Pure-logic checks: `_submodules/vscode-hacker-markdown/tests/units/*`
- REST control extension + its own committed suite:
  `_submodules/vscode-hacker-rest-control/`
  (`docs/important/how-to-test.md`; `tests/playwright/` — the extension is both
  the control channel and the system under test, so the suite asserts the HTTP
  contract too: falsy results box to `null`, `400` + JSON errors, query-string
  vs JSON body, loopback-only bind; a local fixture server is the oracle for
  `custom.registerEventHandler` / `custom.registerExternalFormatter`; the
  status-bar `RC Port:` item and the `<port>.pid` file are the visible oracles)
- Compose env pin: `docker-compose.yml` (`HACKER_REST_CONTROL_PORT`)
