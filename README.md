# vscode-hacker-meta

Meta repository for managing a suite of VS Code extensions by [`lamnguyenx`](https://github.com/lamnguyenx).

## Extensions

| Extension | Folder | Version | Description |
|---|---|---|---|
| [Eink 60Hz Theme](https://github.com/lamnguyenx/vscode-eink-60hz-theme) | `_refs/vscode-eink-60hz` | 2026.9.3 | Dark+ with black background and enhanced contrast, optimized for e-ink displays |
| [Hacker Browser](https://github.com/lamnguyenx/vscode-hacker-browser) | `_refs/vscode-hacker-browser` | 2026.9.3 | A browser view you can dock in the Panel or Primary Sidebar |
| [Hacker Markdown](https://github.com/lamnguyenx/vscode-hacker-markdown) | `_refs/vscode-hacker-markdown` | 2026.9.3 | A Markdown preview you can dock in the Panel or Primary Sidebar, or open in the Editor |
| [Path Picker](https://github.com/lamnguyenx/vscode-path-picker) | `_refs/vscode-hacker-path-picker` | 2026.9.3 | Pick a file or folder like the File Picker, then copy its relative path, real path, or reveal in the Explorer |
| [Stats Bar](https://github.com/lamnguyenx/vscode-hacker-stats-bar) | `_refs/vscode-hacker-stats-bar` | 2026.9.3 | A status bar to show system stats (CPU, network, memory, uptime) |

## Quick start

```bash
# Open the workspace in VS Code
code vscode-hacker-meta.code-workspace
```

Each extension is referenced as a symlink in `_refs/`. All share the same build/install pattern:

```bash
cd _refs/vscode-hacker-<name>

# Build
make build        # produces build/<publisher>.<name>-<version>.vsix

# Install
make install          # installs to both code and code-server
```

## Build & release

All extensions follow a unified convention:

- **Output**: `build/<publisher>.<name>-<version>.vsix`
- **Publisher**: `lamnguyenx`
- **Version**: `2026.9.3`
- **`.gitignore`**: Shared minimal template via `_refs/`

Tagging and releasing is done per-repo using `gh`:

```bash
git tag v2026.9.3
git push origin v2026.9.3
gh release create v2026.9.3 build/*.vsix --generate-notes
```

## Generate summary table

```bash
python3 local/get_summary.py
```