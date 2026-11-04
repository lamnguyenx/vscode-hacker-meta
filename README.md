# vscode-hacker-meta

Meta repository for managing a suite of VS Code extensions by [`lamnguyenx`](https://github.com/lamnguyenx).

## Extensions

| Extension | Folder | Version | Description |
|---|---|---|---|
| [Eink 60Hz Theme](https://github.com/lamnguyenx/vscode-eink-60hz-theme) | `_submodules/vscode-eink-60hz` | 2026.9.3 | Dark+ with black background and enhanced contrast, optimized for e-ink displays |
| [Hacker Browser](https://github.com/lamnguyenx/vscode-hacker-browser) | `_submodules/vscode-hacker-browser` | 2026.9.3 | A browser view you can dock in the Panel or Primary Sidebar |
| [Hacker Markdown](https://github.com/lamnguyenx/vscode-hacker-markdown) | `_submodules/vscode-hacker-markdown` | 2026.11.5 | A Markdown preview you can dock in the Panel or Primary Sidebar, or open in the Editor |
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

Each extension lives as a git submodule in `_submodules/`. Build and install one directly:

```bash
cd _submodules/vscode-hacker-<name>
make build        # produces build/<publisher>.<name>-<version>.vsix
make install      # installs to both code and code-server
```

Or run the same target in **every** submodule from the meta repo root:

```bash
make build               # `make build` in each _submodules/*
make install             # `make install` in each _submodules/*
make install-code-server # install the built VSIXs into the compose code-server
make install-ssh         # pick extensions + SSH hosts, build, install remotely
make list                # print the resolved submodule list
make info                # containers, ports, extension versions, URLs
```

A failing submodule does not stop the others; the run exits non-zero and lists
the failures at the end.

### Install on other machines

`make install-ssh` reads the concrete `Host` aliases from `~/.ssh/config`,
asks which extensions and which hosts to target, builds any missing or stale
VSIXs, and installs them into each host's running code-server (it prefers the
binary of the running instance, and honours its `--user-data-dir`).

```bash
make install-ssh                                  # interactive multi-select
make install-ssh ARGS="--all --dry-run"           # preview without building
make install-ssh ARGS="-e hacker-markdown -H wsk,mac"
```

Use `--target code` to install with the `code` CLI instead, `--build` to force
a rebuild, and `--jobs N` to change how many hosts install in parallel. Reload
each target window once afterwards so a fresh extension host picks up the new
build.

## Docs

### [Dev environment](docs/important/dev-env/)

- [Dev on nuc, test on pp](docs/important/dev-env/dev-code-on-nuc-test-on-pp.md): the code-server + browser topology, ports, TLS, the local Chromium service, and the recovery runbook.

### [Release](docs/important/release/)

- [Build and release](docs/important/release/build-and-release.md): VSIX naming, CalVer, per-repo tagging, `gh release`, and the summary table.

### [Testing](docs/important/testing/)

- [How to test a VS Code extension](docs/important/testing/how-to-test-all.md): the general playbook — environment choice, REST arrange / CDP assert, state hygiene, pinned ports, cache-busting, and anti-patterns.

`make check-docs` verifies this index and every local link/anchor in it and in
the topic docs.

## Elsewhere

- Dated design logs live under [`docs/plans/`](docs/plans/); the most recent is [2026-11-04 `make install-ssh`](docs/plans/2026/11/04/2026-11-04-install-ssh-multi-host.md).
- Per-extension docs live in each submodule's `README.md` and `docs/important/` (see the table above).
