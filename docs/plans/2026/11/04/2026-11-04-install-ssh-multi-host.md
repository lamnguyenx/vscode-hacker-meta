# `make install-ssh`: pick extensions + hosts, build, install

**Date:** 2026-11-04
**Status:** DONE — code and docs in the working tree (`scripts/install-ssh.ts`,
`Makefile`, `README.md`, `docs/important/`, this log).
**Scope:** meta repo only — `scripts/`, `Makefile`, `README.md`, `docs/`.
**Repos:** no extension submodule source changed. Their VSIXs were built locally
during verification, and installed on the real hosts.

## Context

The suite runs on several machines: **wsk**, **pp**, and **mac** each have a
code-server, and every one of them is laid out differently:

| Host | Running code-server | Notes |
| --- | --- | --- |
| wsk | `~/Downloads2/code-server-4.139.1-linux-amd64` | not on `PATH` |
| pp | `~/Downloads/code-server-4.139.1-linux-amd64` | `/usr/bin/code-server` is an older 4.132.0 deb |
| mac | `/Volumes/CHEESE/Downloads/code-server` | `~/.local/bin/code-server` points at a different copy |

Pushing a local build meant a manual loop: build, `scp`, ssh in, find the right
binary, guess the user-data-dir, install, repeat per host. The goal was one
interactive command that:

1. selects one or more extensions,
2. selects one or more hosts from `~/.ssh/config`,
3. builds only the VSIXs that are missing or stale,
4. installs into the code-server that is actually running on each host.

## What shipped

### `scripts/install-ssh.ts`

A Bun script (zero dependencies, same as `scripts/info.ts` / `check-docs.ts`).
`Makefile` exposes it as `install-ssh`; `ARGS` is forwarded verbatim.

```bash
make install-ssh
make install-ssh ARGS="--all --dry-run"
make install-ssh ARGS="-e hacker-markdown -H wsk,mac"
make install-ssh ARGS="--build -t code-server -j 2"
```

**Selection.** Extensions come from `_submodules/*/package.json` (id, version,
display name). Hosts come from `~/.ssh/config` (`SSH_CONFIG` overrides the
path). Both are checkbox lists driven from raw stdin: `space` toggles, `a`
toggles all, `j`/`k` or arrows move, `enter` confirms, `q`/Ctrl-C cancels.
Extensions start selected; hosts start unselected. Without a TTY the script
refuses to prompt and asks for `--extensions` / `--hosts` (or `--all`).

**SSH parsing.** Concrete `Host` aliases only: wildcard/negation patterns and
the common git remotes are skipped. A shared block (`Host pp ppd`) emits every
alias; a later duplicate block keeps the first block's `HostName`/`User`/`Port`
and is ignored. Order follows the file. `Include` is not followed (this config
has none).

**Build if needed.** The expected artifact is
`build/<publisher>.<name>-<version>.vsix`. It is "stale" when the file is
missing or any packaged source file is newer. Stale extensions run their
submodule's `make build` (or `npx @vscode/vsce pack` when there is no Makefile).
`--build` forces a rebuild, `--no-build` forbids one and fails on a missing
VSIX. A failed build drops that extension and continues with the rest.

**Transport.** One gzipped tar of the selected VSIXs is piped over a single SSH
connection per host; the remote side extracts into `mktemp -d` and installs each
file with `--force`. This keeps the number of connections proportional to hosts,
not hosts × extensions.

**Remote detection.** In order:

1. the running instance, derived from the `ps` line ending in
   `<root>/out/node/entry` → `<root>/bin/code-server`;
2. `command -v code-server`;
3. the newest `~/Downloads*/code-server*/bin/code-server`;
4. `code` (unless `--target code-server`).

If that running line carries `--user-data-dir`, the same value is passed to
`--install-extension`, so the install lands in the profile the live host loads.
`--target auto` prefers code-server; `--target code` picks the `code` CLI;
`--target code-server` never falls back.

**SSH hygiene.** `BatchMode=yes` (keys only, no password prompt),
`ConnectTimeout=15`, `StrictHostKeyChecking=accept-new`, and
`ClearAllForwardings=yes`. The last one matters here: `~/.ssh/config` has many
`LocalForward`/`RemoteForward` rules for pp, and a plain `ssh pp` prints
"Address already in use" for half of them. The tool bypasses all of it.

**Output.** Each host's output is prefixed with a coloured `[alias]` tag while
hosts install in parallel (`--jobs`, default 4), followed by a per-host summary
and a reminder to reload each target window once.

### Docs

- `README.md` — target in the quick-start block, an "Install on other
  machines" section, and the newest design-log pointer.
- `docs/important/dev-env/dev-code-on-nuc-test-on-pp.md` — a remote-install
  section next to the code-server topology.
- `docs/important/testing/how-to-test-all.md` §9 — the remote path alongside
  `make install-code-server`.
- This log.

## Trials, errors, and lessons learnt

### A glob in the JSDoc header ended the comment

The header described the fallback as `` `~/Downloads*/code-server*` ``. The
`*/` inside that glob closed the `/** ... */` block early, so Bun parsed the
prose as TypeScript and produced a wall of errors (`Expected ";" but found
"user"`, `... "target"`, `... "code"`).

**Lesson:** source comments cannot contain `*/` for any reason, including globs
in documentation. Reword or escape it; a doc block is not a free-form file.

### The remote script found itself in `ps`

The first remote version scanned all of `ps -eo args=` for
`--user-data-dir`/`--user-data-dir=`. The SSH command line contains the script
itself, and the script mentions `--user-data-dir`, so awk read the *next token
of the script* as the path. The install then failed with
`error --user-data-dir requires a value`, printed `done: 0 extension(s)`, and
exited 1.

The fix is to first select the one line that ends in `/out/node/entry` (the
actual code-server entry process), then parse only that line for the root and
the user-data-dir.

**Lesson:** never grep all of `ps` for a token that appears in your own command
line. Scope the scan to a process-shaped marker, and parse that record alone.

### Backticks in the remote script closed the TypeScript template literal

While documenting the self-match fix inside the `String.raw` template, the
comment `` ... appears in `ps` ... `` closed the JS template at the backtick.
Bun reported `Expected ";" but found "ps"`.

**Lesson:** the remote shell script is a TS template literal. Shell comments
inside it cannot use backticks (or `${`, which would interpolate). Keep them
plain prose.

### SSH config forwards collide, loudly

A plain `ssh pp ...` printed:

```text
bind [127.0.0.1]:23507: Address already in use
...
Warning: remote port forwarding failed for listen port 9922
```

Those warnings are harmless for an install, but they are noise and can make a
healthy command look broken. `ClearAllForwardings=yes` clears both local and
remote forwards from the config for that invocation.

**Lesson:** automation should opt out of interactive SSH config side effects
explicitly, rather than inherit whatever the human's config happens to forward.

### `code-server` on `PATH` is not necessarily the running one

The three hosts proved this in three different ways:

- **wsk** has no `code-server` on `PATH`; the running 4.139.1 is a tarball in
  `~/Downloads2`.
- **pp** has `/usr/bin/code-server` (4.132.0, deb), but the running 4.139.1 is
  a tarball in `~/Downloads` — note `Downloads`, not `Downloads2`.
- **mac** resolves `~/.local/bin/code-server` to `~/Downloads2/code-server`
  (4.143.1), while the running instance is a *different* copy on
  `/Volumes/CHEESE/Downloads/code-server` (also 4.143.1).

Installing with the first `code-server` on `PATH` would have written into the
wrong tree on pp and mac, and failed outright on wsk. The detection now derives
the binary from the running process, then falls back to `PATH` and the
`Downloads` tarballs — and passes the running instance's `--user-data-dir` when
it has one.

**Lesson:** "is code-server installed?" is the wrong question; ask "which
code-server is running, and which profile does it load?"

### mtime-based staleness is conservative, and that is fine

After a docs pass, every VSIX was reported `build (source newer)` even though
only README/docs changed. That is technically correct: `vsce` packages those
files. Rebuilding is cheap and deterministic; the flags give the escape hatch
(`--no-build` to install the existing artifact, `--build` to force).

**Lesson:** staleness heuristics should be conservative and overridable, not
clever. A false rebuild costs seconds; a false "current" installs the wrong
code.

### TUI tests need a pty and paced input

Two test-only traps surfaced with `script -qec`:

- Input written as one chunk (`\r \r`) is delivered together. The first
  `enter` resolves the extension prompt and the handler returns, dropping the
  rest of the chunk — so the host prompt sat waiting forever and the test
  timed out. Real typing arrives in separate chunks; tests need a `sleep`
  between prompts.
- Ctrl-C delivered before raw mode is enabled is a real signal, not a byte.
  Without a handler the process died with the cursor hidden.

**Lesson:** drive TUIs through a pty, pace input, and make every raw-mode UI
restore the terminal on SIGINT/SIGTERM as well as on its own quit key. The
script now installs both signal handlers.

### Non-interactive flags pay for themselves

`--dry-run`, `-e`, `-H`, `--no-build`, and `-j` were added for the normal
reasons (CI, repeatability), but they also became the test harness: every
selection/build/install path could be exercised without keystrokes.

**Lesson:** design the flags before the TUI, not after it.

## Verification

Typecheck (borrowing a submodule's TypeScript and `@types/node`, since the meta
repo has no `package.json`):

```bash
_submodules/vscode-hacker-markdown/node_modules/.bin/tsc --noEmit --strict \
  --target ES2022 --module ESNext --moduleResolution Bundler --skipLibCheck \
  --types node \
  --typeRoots _submodules/vscode-hacker-markdown/node_modules/@types \
  scripts/install-ssh.ts
```

Plan/prompt checks:

```bash
make install-ssh ARGS="--all --dry-run"     # 7 extensions, 10 hosts, no side effects
bun scripts/install-ssh.ts --help
# interactive prompt exercised in a pty: toggle, select, cancel
```

Real installs (the only way to prove detection):

```text
hacker-markdown → wsk   via ~/Downloads2/code-server-4.139.1-linux-amd64/bin/code-server
hacker-markdown → pp    via ~/Downloads/code-server-4.139.1-linux-amd64/bin/code-server
hacker-markdown → mac   via /Volumes/CHEESE/Downloads/code-server/bin/code-server
hacker-stats-bar → wsk  (built by the script, then installed)
```

The script rebuilt `hacker-stats-bar` from source and installed it in the same
run, which covers the `make build` path end to end. `make check-docs` passes
after the doc edits.

## Known limitations and follow-ups

- **Key auth only.** `BatchMode=yes` makes an unknown/absent key fail fast
  instead of prompting for a password.
- **One instance per host.** Detection takes the first running
  `out/node/entry`; a host running two code-servers (or a code-server plus a
  VS Code server with the same entry shape) is ambiguous.
- **`--user-data-dir` is only visible if it is in the entry args.** A wrapper
  script that hides it would make the CLI write to the default profile.
- **`Include` is not followed** in `~/.ssh/config`, and wildcard `Host`
  patterns are skipped by design. The file here is self-contained.
- **POSIX remotes only.** The remote script is `sh` + `tar` + `find`; Windows
  remotes are out of scope.
- **Assumes simple VSIX filenames.** The install loop iterates with word
  splitting; publisher/name/version are controlled and contain no spaces.
- **`--all` really means all.** It includes unreachable hosts and
  `vast3060` (root); `--dry-run` first is the sane habit.
- **No automated test for the script.** Verification is the typecheck plus the
  manual runs above; there is no root test target to hang one on.
- The work is not committed yet; the code, docs, and this log are in the
  working tree.

## Files

| File | What |
| --- | --- |
| `scripts/install-ssh.ts` | the whole flow: discovery, prompts, build, SSH install |
| `Makefile` | `install-ssh` target and header/`.PHONY` entries |
| `README.md` | quick-start target, remote-install section, latest-plan pointer |
| `docs/important/dev-env/dev-code-on-nuc-test-on-pp.md` | remote install on the dev hosts |
| `docs/important/testing/how-to-test-all.md` | §9 remote reinstall path |
| `docs/plans/2026/11/04/2026-11-04-install-ssh-multi-host.md` | this log |

## Quick reference

```bash
make install-ssh                                   # interactive multi-select
make install-ssh ARGS="--all --dry-run"            # show plan, change nothing
make install-ssh ARGS="-e hacker-markdown -H wsk"  # one extension, one host
make install-ssh ARGS="--build -j 2"               # force rebuild, 2 hosts at a time

bun scripts/install-ssh.ts --help
bun scripts/install-ssh.ts -e hacker-markdown -H wsk --no-build --dry-run
```
