# vscode-hacker-meta

Meta tooling for hacking VS Code extensions: pack a project and install the
VSIX into **every** install CLI available on the machine — native VS Code,
code-server, and the Remote-SSH server (when run on the remote host).

## Usage

```sh
npx vscode-hacker-meta pack <extension-dir> [--out <dir>]
npx vscode-hacker-meta install <vsix-file> [--post-install-script <path>]
```

- `pack <dir>` — packs the extension with `vsce` (which runs its
  `vscode:prepublish` build) and prints the produced VSIX path (default
  output: `<dir>/build/`).
- `install <vsix-file>` — installs the given VSIX through every install CLI
  on the machine. The path must be specified explicitly; nothing is
  discovered.
- `--post-install-script <path>` — optional executable invoked as
  `script <installed-extension-dir>` after each successful install to verify
  the package. **Must be registered explicitly; nothing is auto-discovered.**
  A non-executable script (e.g. 644 after a fresh clone) is run via bash.

Example:

```sh
npx vscode-hacker-meta pack ./
npx vscode-hacker-meta install build/vscode-hacker-markdown-0.0.1.vsix \
  --post-install-script tools/post_install.sh
```

## How install works

1. The target folder name (`<publisher>.<name>-<version>`) is read from the
   VSIX's `extension.vsixmanifest`, so any extension's VSIX works.
2. The VSIX is installed through every CLI that exists on the machine:
   - `code` (native) → `~/.vscode/extensions` — a PATH `code` that is the
     Remote-SSH shim (lives under `~/.vscode-server/`) is skipped; it is
     handled as the server install below.
   - `code-server` → `${XDG_DATA_HOME:-~/.local/share}/code-server/extensions`
   - remote-cli → `~/.vscode-server/extensions` (newest of both server
     layouts: `cli/servers/*/server/bin/remote-cli/code` and `bin/*/bin/remote-cli/code`)
3. The install arg order matters: `--install-extension <vsix> --force` (a
   `--force` before the value makes VS Code's CLI ignore the option).
4. Each install is verified (extension dir exists) and the registered
   post-install script runs; a CLI that fails is a warning when another
   install succeeded. The command fails only if nothing was installed.
5. If a CLI forwards the install to a connected VS Code instance instead of
   installing locally (a common remote-cli behavior outside a real VS Code
   terminal), the dir check catches it and reports a warning.

## Development

```sh
npm install
npm run build   # tsc -> dist/
npx . pack <path-to-extension-repo>
npx . install <path-to-extension-repo>/build/<name>-<version>.vsix
```

Requires `vsce` (global, or installed anywhere) to pack; falls back to
`npx @vscode/vsce`.
