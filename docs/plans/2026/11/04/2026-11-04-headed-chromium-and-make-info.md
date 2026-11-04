# Headed Chromium for code-server, and `make info`

**Date:** 2026-11-04
**Status:** DONE — code in `c2500bb`; this log and the doc refresh follow it.
**Scope:** meta repo only — `docker-compose.yml`, `docker/chromium/`,
`scripts/`, `Makefile`, `README.md`, `docs/`
**Repos:** no extension submodule source changed.

## Context

The test harness had one CDP browser: Vivaldi on **pp**, forwarded to nuc's
`localhost:9024`. That works, but it is remote, shared, and awkward for a quick
local check of the code-server workbench.

The goal became two things:

1. A self-contained **headed** Chromium on the dev box, with CDP and a visible
   canvas, so the workbench can be watched and driven locally.
2. A single command, `make info`, that prints the state of the harness: what is
   running, which ports are live, which extension versions are installed, and
   where to open things.

The browser service is the `linuxserver/chromium` image (Selkies desktop). It
is a real, windowed Chromium on a Wayland desktop — not a headless browser and
not an Xvfb trick. Clients attach over CDP; humans watch the canvas.

## What shipped

### 1. The `chromium` compose service

Pinned image: `lscr.io/linuxserver/chromium:version-1aca5d17` (Chrome
156.0.8078.47, Selkies 2.1.0 at the time of writing).

| Thing | Value |
| --- | --- |
| Network | `network_mode: host` |
| Canvas | `0.0.0.0:9325`, HTTPS, **no auth by default** |
| CDP | `0.0.0.0:9324` → nginx → Chromium `127.0.0.1:9222` |
| Desktop | `1280x720` (16:9); `CANVAS_WIDTH` / `CANVAS_HEIGHT` override |
| Profile | `./exp/chromium:/config` (survives recreation) |
| Bookmark bar | hidden by managed policy `BookmarkBarEnabled: false` |
| Start | `docker compose up -d chromium` |

The canvas is the image's own nginx (Selkies). CDP is a second nginx server
block, `docker/chromium/cdp.conf`, mounted at
`/etc/nginx/conf.d/cdp.conf`. It exists for one reason: Chromium refuses to
bind CDP to anything but its own loopback and ignores
`--remote-debugging-address`; the nginx block is what puts it on `0.0.0.0`.

```text
tests / MCP ── CDP :9324 ──► nginx ──► 127.0.0.1:9222 ──► Chromium (headed)
browser     ── HTTPS :9325 ─► nginx ──► Selkies desktop  ──► labwc + Chromium
```

The browser profile keeps the code-server session. The first run needs a manual
login at `https://localhost:9620` in the canvas; after that the cookies survive
in `exp/chromium` and the E2E suites can reuse the session.

### 2. `make info`

`Makefile` → `bun scripts/info.ts`; `scripts/style.ts` holds the ANSI palette.

It prints:

- git branch/HEAD and the dirty-file count;
- compose project and service state (`code-server`, `chromium`, webview dev);
- live probes: code-server `/healthz`, REST Control `custom.eval`, CDP
  `/json/version` and `/json/list`, canvas HTTP status;
- every submodule's `package.json` version vs what is installed in the
  code-server (including the legacy `vscode-` name form);
- paths the harness writes to;
- the URLs last, because a short terminal shows the tail;
- common next commands.

The CDP port is read from `docker/chromium/cdp.conf` (the actual listener), the
canvas port from the running container's `CUSTOM_HTTPS_PORT`, and the REST port
from the code-server container's `HACKER_REST_CONTROL_PORT`. It is read-only:
no containers are started, no extension is installed, no files are changed.

### 3. Documentation

- `README.md` — a local-browser subsection, `make info`, accurate extension
  versions.
- `docs/important/dev-env/dev-code-on-nuc-test-on-pp.md` — the local alternative to the
  pp browser, ports, first-run login, security and troubleshooting.
- `docs/important/testing/how-to-test-all.md` — the local option in the environment
  chooser and the `make info` habit.
- This plan.

## Trials, errors, and lessons learnt

### Published ports cannot work for Chromium CDP

The obvious first shape would have been `ports: ["9024:9222"]`. It cannot
work: Chromium binds `--remote-debugging-port` on loopback only, and
`--remote-debugging-address` is ignored. Docker publishes to the container's
`eth0`, so the host connection is refused even though Chromium is healthy
inside.

**Lesson:** to expose CDP, either run on the host network (CDP lands on the
host's loopback) or put a TCP/HTTP proxy in front of `127.0.0.1:9222`. The final
design does both: host networking for the browser, plus nginx for `0.0.0.0`
access.

### Bridge networking breaks the code-server URL

The suites open `https://localhost:9620`. code-server uses host networking, so
that is the host's port. A bridge-networked browser resolves `localhost` to
itself and lands on nothing.

**Lesson:** the browser and code-server must share the host network namespace
(or the test URLs must switch to a host-gateway name, which would ripple through
every suite). Host networking is the smaller change and matches the existing
code-server service.

### Port 9024 was already taken

The pp Vivaldi forward owns `127.0.0.1:9024` on this host. The first browser
container was started on `9124` to avoid killing it, and the suites were run
with `CDP_PORT=9124`. The owner then chose `9324`/`9325` for the local browser,
which also removed the collision.

**Lesson:** check `ss -ltnp` before pinning a port, and keep the port
configurable in `make info` rather than assuming the test default.

### `make info` first reported the wrong CDP port

Before the nginx split, the external CDP port was in `CHROME_CLI`
(`--remote-debugging-port=...`). After the split, `CHROME_CLI` correctly carries
the **internal** `9222`, while the external listener is the `listen` directive
in `cdp.conf`. Reading the old place would have printed `9222`.

**Lesson:** report the listener, not the upstream. `scripts/info.ts` now parses
`docker/chromium/cdp.conf`; changing the port there is the single source of
truth.

### The canvas password was a surprise

The image turns on nginx basic auth whenever `PASSWORD` is non-empty. The first
compose version set `CUSTOM_USER`/`PASSWORD` to `chromium`/`chromium`; the
canvas then answered `401` (healthy, but a login prompt). The owner wanted no
password, so both env lines were removed and the container recreated; the
canvas now answers `200`.

**Lesson:** `401` from the canvas is "up, auth required", not "down". Auth is
opt-in in this service; `init-nginx` builds the htpasswd file at container
start, so changing it needs a recreate, not a restart of the browser only.

### "16:9" is the desktop, not the page viewport

`SELKIES_MANUAL_WIDTH/HEIGHT` sets the Selkies desktop. At `1280x720` the
screenshot/stream is 16:9, but Chrome's own toolbar takes roughly 124 px, so
`window.innerHeight` is about `596` — the **content** viewport is not 16:9.
That is normal for a headed browser on a 16:9 screen.

**Lesson:** document which ratio is meant. If an exact 16:9 page viewport is
needed, Chrome must run in app/kiosk mode (no tab strip/address bar), or the
desktop must be sized larger than 16:9 to compensate. Neither was done; the
canvas stays a true 16:9 desktop.

### The bookmark bar has no CLI flag

There is no `--hide-bookmark-bar`. The supported switch is a managed policy:
`BookmarkBarEnabled: false` in a JSON file under
`/etc/chromium/policies/managed/`.

The directory did not exist in the image; mounting the host directory at that
target created it cleanly. `chrome://policy` confirmed the policy as
`Platform / Machine / Mandatory / OK`.

**Lesson:** browser chrome is policy territory, not page DOM. Also,
`chrome://policy` renders in shadow roots — `document.body.innerText` is empty;
walk the shadow roots (or read the row text) to verify.

### Nginx config placement

The image's `init-nginx` rewrites `/etc/nginx/sites-available/default` for the
canvas. `nginx.conf` also includes `/etc/nginx/conf.d/*.conf`, so the CDP block
can live in its own file and survives container restarts. Mounting it read-only
is enough; no custom image is needed.

**Lesson:** find the include path before building a derivative image. The CDP
block is five lines of proxy config, not a fork.

### `make info` had several small correctness traps

- **Color detection:** `stdout.isTTY` is false when piped; `NO_COLOR` must
  disable, `FORCE_COLOR` must override. The style helper handles all three.
- **REST probe:** a bare `GET /` is not enough; the server is request-driven.
  The probe posts a harmless `custom.eval` of `1` and expects `1`.
- **Extension matching:** `eink-60hz`'s installed directory still uses the old
  `publisher.vscode-<name>-<version>` form. Matching only `publisher.<name>-`
  would report a false "missing"; the script tries both.
- **Untracked files:** `git status --porcelain` collapses a new directory to one
  line; `--untracked-files=all` gives the real file count.
- **Self-signed TLS:** code-server and the canvas need `curl -k` (or the
  browser needs `--ignore-certificate-errors`).

### First run after a recreate is noisy

A full `terminal-enhanced` run immediately after recreating the container
reported two failures and "9 did not run"; the failing tests passed when rerun
individually. After the host settled, the same suite ran **17/17**.

The failure signature was `TypeError: fetch failed` / `SocketError: other side
closed` from the REST channel, not a layout assertion — consistent with the
extension host/REST server reconnecting after the window reload.

**Lesson:** after recreating code-server or the browser, reload/wait once and
rerun before believing a failure. The suite is stateful and shares one
workbench; the first run is the least trustworthy.

## Verification

```bash
ss -ltnp | grep -E ':(9324|9325|9222)'
# 0.0.0.0:9324   nginx (CDP front door)
# 0.0.0.0:9325   nginx (canvas)
# 127.0.0.1:9222 Chromium (internal CDP)

curl -s http://0.0.0.0:9324/json/version | jq -r .Browser
# Chrome/156.0.8078.47

curl -sk -o /dev/null -w '%{http_code}\n' https://0.0.0.0:9325/
# 200 (no auth)

# LAN reachability, not just loopback:
curl -s http://192.168.1.17:9324/json/version | jq -r .webSocketDebuggerUrl
# ws://192.168.1.17:9324/devtools/browser/...
```

`chrome://policy`:

```text
BookmarkBarEnabled   false
Platform             Machine
Level                Mandatory
Status               OK
```

Suites:

```bash
CDP_PORT=9324 make -C _submodules/vscode-hacker-terminal-enhanced test-e2e
# 17 passed
```

## Security

**CDP has no authentication, and the canvas has no authentication by default.**
Both bind `0.0.0.0`.

- CDP gives full control of the browser and of any code-server session in the
  browser profile.
- The canvas desktop includes a terminal with passwordless `sudo` inside the
  container, and the same profile.

Keep `9324`/`9325` on a trusted network, or tunnel them. To restore canvas basic
auth, uncomment `CUSTOM_USER` and `PASSWORD` in the compose service and recreate:
`docker compose up -d --force-recreate chromium`. REST Control stays loopback
only (`127.0.0.1:40620`) on purpose.

## Known limitations and follow-ups

- The suites still default to `CDP_PORT=9024` (the pp browser). The local
  browser needs `CDP_PORT=9324`; `make info` prints the right command. Changing
  the defaults would be a cross-submodule decision and was not done.
- The canvas is 16:9; the Chrome **content** viewport is not, because of the tab
  strip and address bar. App/kiosk mode would be needed for an exact content
  ratio.
- The CDP port is fixed in `docker/chromium/cdp.conf`; edit it and restart the
  container. `make info` reads it from there.
- There is no compose healthcheck for `chromium`; `make info` probes CDP and the
  canvas directly.
- `make info` needs `bun`, `docker`, and `curl`. It degrades to "down" rather
  than failing when a service is absent.
- The code-server still has `eink-60hz` `2026.6.20-1` installed while the
  submodule is `2026.9.3`; `make install-code-server` would refresh it.
- The service, `make info`, and the first doc pass are in `c2500bb`; this plan
  and the final doc edits are the follow-up.

## Files

| File | What |
| --- | --- |
| `docker-compose.yml` | `chromium` service: ports, 16:9, policy, nginx mount |
| `docker/chromium/cdp.conf` | `0.0.0.0:9324` → `127.0.0.1:9222` |
| `docker/chromium/policies/bookmark-bar.json` | `BookmarkBarEnabled: false` |
| `scripts/info.ts` | `make info` reporter |
| `scripts/style.ts` | ANSI palette and TTY detection |
| `Makefile` | `info` target |
| `README.md` | local-browser and `make info` docs |
| `docs/important/dev-env/dev-code-on-nuc-test-on-pp.md` | topology, ports, troubleshooting |
| `docs/important/testing/how-to-test-all.md` | environment chooser and local browser |

## Quick reference

```bash
docker compose up -d chromium            # local headed browser
docker compose logs -f chromium          # nginx + Selkies + watchdog
make info                                # state, ports, versions, URLs

curl -s http://0.0.0.0:9324/json/version # CDP
# https://0.0.0.0:9325                  # canvas (no auth by default)

CDP_PORT=9324 make -C _submodules/vscode-hacker-terminal-enhanced test-e2e
docker compose up -d --force-recreate chromium   # after env/policy changes
```
