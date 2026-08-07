# vscode-hacker-meta

Meta tooling for hacking VS Code extensions: pack a project and install the
VSIX into **every** install CLI available on the machine — native VS Code,
code-server, and the Remote-SSH server (when run on the remote host).

## Usage

```sh
npx vscode-hacker-meta install <extension-dir-or-vsix> [post-install-hook]
```

- `install <dir>` — packs the extension with `vsce` (which runs its
  `vscode:prepublish` build) into `<dir>/build/`, then installs it everywhere.
- `install <file.vsix>` — installs an already-packed VSIX directly.
- `post-install-hook` — optional executable invoked as
  `hook <installed-extension-dir>` after each successful install to verify the
  package. If `<dir>/tools/post_install.sh` exists it is used automatically.

Example:

```sh
npx vscode-hacker-meta install ./   # pack + install this extension repo
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
4. Each install is verified (extension dir exists) and the post-install hook
   runs; a CLI that fails is a warning when another install succeeded. The
   command fails only if nothing was installed.
5. If a CLI forwards the install to a connected VS Code instance instead of
   installing locally (a common remote-cli behavior outside a real VS Code
   terminal), the dir check catches it and reports a warning.

## Development

```sh
npm install
npm run build   # tsc -> dist/
npx . install <path-to-extension-repo>   # local test of the CLI
```

Requires `vsce` (global, or installed anywhere) to pack; falls back to
`npx @vscode/vsce`.
