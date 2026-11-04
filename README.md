# vscode-hacker-meta

Meta repository for managing a suite of VS Code extensions by [`lamnguyenx`](https://github.com/lamnguyenx).

## Extensions

| Extension | Folder | Version | Description |
|---|---|---|---|
| [Eink 60Hz Theme](https://github.com/lamnguyenx/vscode-eink-60hz-theme) | `_submodules/vscode-eink-60hz` | 2026.9.3 | Dark+ with black background and enhanced contrast, optimized for e-ink displays |
| [Hacker Browser](https://github.com/lamnguyenx/vscode-hacker-browser) | `_submodules/vscode-hacker-browser` | 2026.9.3 | A browser view you can dock in the Panel or Primary Sidebar |
| [Hacker Markdown](https://github.com/lamnguyenx/vscode-hacker-markdown) | `_submodules/vscode-hacker-markdown` | 2026.9.6 | A Markdown preview you can dock in the Panel or Primary Sidebar, or open in the Editor |
| [Path Picker](https://github.com/lamnguyenx/vscode-path-picker) | `_submodules/vscode-hacker-path-picker` | 2026.9.3 | Pick a file or folder like the File Picker, then copy its relative path, real path, or reveal in the Explorer |
| [Hacker REST Control](https://github.com/lamnguyenx/vscode-hacker-rest-control) | `_submodules/vscode-hacker-rest-control` | 2026.9.29 | A REST endpoint inside the extension host for deterministic arrange/act in tests |
| [Stats Bar](https://github.com/lamnguyenx/vscode-hacker-stats-bar) | `_submodules/vscode-hacker-stats-bar` | 2026.9.30 | A status bar to show system stats (CPU, network, memory, uptime) |
| [Hacker Terminal Enhanced](https://github.com/lamnguyenx/vscode-hacker-terminal-enhanced) | `_submodules/vscode-hacker-terminal-enhanced` | 2026.10.5 | Copy the last command + output from the active terminal in an LLM-friendly format |

## Quick start

```bash
# Clone with submodules, then open the repo in VS Code
git clone --recurse-submodules <repo-url>
code .
```

Each extension lives as a git submodule in `_submodules/`. All share the same build/install pattern:

```bash
cd _submodules/vscode-hacker-<name>

# Build
make build        # produces build/<publisher>.<name>-<version>.vsix

# Install
make install          # installs to both code and code-server
```

Or, from the meta repo root, run the same target in **every** submodule at once:

```bash
make build               # `make build` in each _submodules/*
make install             # `make install` in each _submodules/*
make install-code-server # install the built VSIXs into the compose code-server
make list                # print the resolved submodule list
make info                # containers, ports, extension versions, URLs
```

A failing submodule does not stop the others; the run exits non-zero and lists
the failures at the end.

## Build & release

All extensions follow a unified convention:

- **Output**: `build/<publisher>.<name>-<version>.vsix`
- **Publisher**: `lamnguyenx`
- **Version**: CalVer `YYYY.M.PATCH`, one per extension (see the table above)
- **`.gitignore`**: shared minimal template via the submodules

Tagging and releasing is done per-repo using `gh`:

```bash
cd _submodules/vscode-hacker-<name>
VERSION=$(node -p "require('./package.json').version")
git tag "v$VERSION"
git push origin "v$VERSION"
gh release create "v$VERSION" build/*.vsix --generate-notes
```

## Dev harness (code-server)

The extensions are developed and tested against a shared code-server started
from `docker-compose.yml`:

- The `code-server` service runs with **`--disable-workspace-trust`**, so the
  session is trusted and user extensions activate without a trust prompt — no
  per-extension `capabilities.untrustedWorkspaces` needed. (The container only
  reaches the mounted git tree + config, so this is "trust the mounts".)
- `make install-code-server` installs each submodule's built VSIX into that
  container (picking the VSIX that matches each `package.json` version). The
  per-submodule `make install-code-server` runs the *host* `code-server` CLI,
  which writes to a different profile and never reaches the container. Reload
  the workbench window **once** afterwards.
- CDP tooling for the pp browser connects to `9024`; the REST control channel
  listens on `40620` (`HACKER_REST_CONTROL_PORT`).

### Local headed Chromium (optional)

`docker compose up -d chromium` starts a real, windowed Chromium on a Selkies
Wayland desktop — a self-contained local alternative to the pp browser.

| Endpoint | Address | Notes |
| --- | --- | --- |
| Canvas | `https://0.0.0.0:9325` | Selkies desktop, 1280×720 (16:9), no auth by default |
| CDP | `http://0.0.0.0:9324` | nginx → Chromium `127.0.0.1:9222` |
| REST Control | `http://127.0.0.1:40620` | loopback only, from code-server |

```bash
docker compose up -d chromium
# first run only: open the canvas and log in to https://localhost:9620 once;
# exp/chromium keeps the session for later runs.
CDP_PORT=9324 make -C _submodules/vscode-hacker-terminal-enhanced test-e2e
docker compose logs -f chromium
```

- The suites default to `CDP_PORT=9024` (pp); set `CDP_PORT=9324` for this
  browser, or they will target the pp browser instead.
- `CANVAS_PORT` changes the canvas port; `CANVAS_WIDTH` / `CANVAS_HEIGHT`
  change the desktop size (default `1280x720`). The CDP listener is the
  `listen` directive in `docker/chromium/cdp.conf`; edit it and restart.
- The bookmark bar is hidden by a managed policy
  (`docker/chromium/policies/`). Verify at `chrome://policy`.
- The canvas has **no auth by default**; uncomment `CUSTOM_USER` / `PASSWORD`
  in the compose service and recreate to enable basic auth. CDP is
  unauthenticated too, and both bind `0.0.0.0`; the canvas desktop has a
  terminal with passwordless `sudo`. Trusted networks only.
- Canvas TLS is self-signed, and the browser runs with
  `--ignore-certificate-errors` because code-server uses a mkcert certificate.

### `make info`

`make info` is a read-only snapshot of the harness: compose services, live
probes, the code-server / canvas / CDP / REST addresses, every extension's
package vs installed version, and the paths involved. It needs `bun`, `docker`,
and `curl`. Colour is TTY-aware; `NO_COLOR=1` disables it, `FORCE_COLOR=1`
forces it.

See [`docs/important/how-to-test-all.md`](docs/important/how-to-test-all.md)
(general playbook), [`docs/important/dev-code-on-nuc-test-on-pp.md`](docs/important/dev-code-on-nuc-test-on-pp.md)
(topology + recovery runbook), and the dated notes under
[`docs/plans/`](docs/plans/) — most recently
[`2026-11-04-headed-chromium-and-make-info.md`](docs/plans/2026/11/04/2026-11-04-headed-chromium-and-make-info.md).

## Generate summary table

```bash
python3 local/get_summary.py
```