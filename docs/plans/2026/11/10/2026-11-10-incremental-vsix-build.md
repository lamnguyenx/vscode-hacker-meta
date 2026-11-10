# Incremental VSIX builds: `make build`/`make install` skip unchanged extensions

**Date:** 2026-11-10
**Status:** DONE — all 7 submodule `Makefile`s updated in the working tree,
verified warm/cold; README and `docs/important/release/build-and-release.md`
updated alongside this log.
**Scope:** every `_submodules/*/Makefile` (the `vsix` target), plus meta-repo
docs. No `scripts/`, no root `Makefile` change.
**Repos:** all 7 extension submodules (Makefile only, no source).

## Context

`make build` and `make install` at the meta repo root fan out to every
submodule (`local/make-all.sh`). Each submodule's `vsix` target was listed in
`.PHONY`, so `vsce pack` (and, in four repos, `npm install && npm run compile`
first) ran **every time**, even when `build/<publisher>.<name>-<version>.vsix`
was already newer than every source file. A no-change `make build` cost a full
rebuild of all seven extensions.

Meanwhile `make install-ssh` (`scripts/install-ssh.ts`) already had the right
semantics: it computes `current | stale | missing` from mtimes
(`newestSourceMtime > vsix mtime`) and only builds what it must. So `make
install` was the *slow* path and `make install-ssh` the smart one — backwards
for the local fast-loop case.

## What shipped

Every submodule Makefile now declares the VSIX as a **real file target** with
explicit prerequisites, so plain `make` staleness logic does the work:

```make
# Inputs that decide whether the VSIX is stale ...
SOURCES := $(shell find src syntaxes -type f 2>/dev/null) \
	package.json package-lock.json tsconfig.json tsconfig.webview.json

build vsix: $(VSIX)

$(VSIX): $(SOURCES)
	mkdir -p build
	npx --yes @vscode/vsce pack -o $@
```

- `vsix` stops being phony but stays a working alias (`build vsix: $(VSIX)`) —
  muscle memory and scripts that call `make vsix` keep working.
- `SOURCES` per repo: the packed source trees + manifest + lockfile + tsconfigs
  (compile-and-pack repos) or the theme/icon trees (eink-60hz, which has no
  compile step):

  | Repo | `find` dirs | recipe |
  |---|---|---|
  | vscode-hacker-markdown | `src syntaxes` | pack only |
  | vscode-hacker-rest-control | `src assets` | pack only |
  | vscode-hacker-browser | `src media` | npm install + compile + pack |
  | vscode-hacker-path-picker | `src media` | npm install + compile + pack |
  | vscode-hacker-stats-bar | `src` | npm install + compile + pack |
  | vscode-hacker-terminal-enhanced | `src media` | npm install + compile + pack |
  | vscode-eink-60hz | `themes fileicons text-mate-rules themes-refs` | pack only |

- Generated trees (`out/`, `build/`, `node_modules/`) are **deliberately
  absent** from `SOURCES` — the recipe regenerates them, and mtime deps on
  outputs would self-trigger (see lessons).
- Version bumps invalidate themselves: the version is part of the VSIX
  filename, so a bumped `package.json` means a fresh filename, a "missing"
  target, and a rebuild.
- Verified: warm `make build` = `Nothing to be done` ×7 in **~4s** (was: full
  rebuild of 7, minutes); a cold run with 2 genuinely stale repos took 66s and
  rebuilt exactly those 2.
- Force a repack: `rm _submodules/<repo>/build/*.vsix && make build`, or
  `make -C _submodules/<repo> clean` where a `clean` target exists.

## Trials, errors, and lessons learnt

### The umbrella Makefile was innocent; the phony was in the submodules

The first read (root `Makefile` → `local/make-all.sh`) only shows a loop that
delegates `make <target>` into each submodule. Nothing forced a rebuild *there*.
The `.PHONY: ... vsix ...` line was only visible one level down.

**Lesson:** for layered build systems, walk the delegation chain to the leaf
that owns the recipe before blaming the orchestrator. Phony leaf targets sit
below the fan-out, invisible from the top.

### My own verification one-liner dropped the extra `find` dirs

The first sanity sweep extracted each Makefile's `find` arguments with
`grep -oP 'find \K[^ ]+'` — which stops at the first space. Output claimed
every repo watched only one dir (`src`), i.e. that `media`, `syntaxes`,
`assets`, `themes` had silently gone missing. A direct
`grep -h 'find ' _submodules/*/Makefile` showed all multi-dir lists were intact;
the check was wrong, not the files.

**Lesson:** when a verification command disagrees with what you wrote, suspect
the command. Re-verify with a dumber tool (plain grep) before "fixing" the
artifact.

### The one repo that did rebuild was right, not broken

The first `make -n build` sweep showed six repos at "Nothing to be done" and
`vscode-hacker-browser` scheduling a full `npm install + compile + pack`. That
asymmetry looked like a bug in the new prerequisite lists. It wasn't: browser's
VSIX was `2026.9.3` from September while `src/` had been touched since —
genuinely stale, correctly detected.

**Lesson:** in a dry-run, an outlier is evidence, not noise. Check the mtimes
behind it before forcing the output to look uniform; a "clean-looking" sweep
can also mean you built the prereq list wrong (too narrow) everywhere.

### Per-repo layout rules beat one `find .`

The obvious generic prerequisite is "every file under the repo". That fails
here for three reasons: `_refs/` is a **symlink farm** to external checkouts
(vscode itself!) in three repos — huge, slow, and wrong to watch; `exp/` is
scratch; `out/` and `node_modules/` are generated. install-ssh solves this with
`SKIP_DIRS = {build, node_modules, .git}` plus skipping all symlinks. The
Makefiles instead enumerate the packed trees per repo (mirroring each
`.vscodeignore`). One suspect, `themes-refs/` in eink-60hz, was verified to be
real tracked files (not symlinks) before being included.

**Lesson:** "all sources" is a per-project question. Read each repo's AGENTS.md
/ `.vscodeignore` and name the trees; a generic walker eventually follows a
symlink into a 2-GB reference checkout.

### Generated outputs must not be prerequisites

Putting `$(shell find out -type f)` into `SOURCES` looks thorough and is
self-defeating: `compile` regenerates `out/` *newer* than the old VSIX, so the
next run always repacks — back to square one, with extra steps. Same for
`node_modules/` (any `npm install` re-touches it). The rule: prerequisites are
*inputs the recipe consumes from the repo*, never *outputs it produces*.

**Lesson:** mtime-based caching keys on true sources only. If a generated file
(like markdown's `syntaxes/*.tmLanguage`, regenerated by `compile` into a
watched tree) is itself derived from tracked inputs, watching the derived file
is fine; watching the build's own outputs is an infinite-rebuild loop.

### Spaces in paths would silently split the prerequisite list

`$(shell find ...)` newlines collapse into space-separated words — fine, unless
a filename contains a space, at which point make sees two broken prereqs. A
pre-flight `find ... | grep -P '[ \t]'` over every watched tree came back clean
today, but this is a standing fragility of the pattern, not a guarantee.

**Lesson:** check for path-hostile filenames before turning `find` output into
make prerequisites, and re-run that check if the convention ever breaks; the
failure mode is silent under-invalidation, not a loud error.

### Parity with `make install-ssh` is the real win

Both paths now use the same rule (VSIX older than any packed source → stale),
so they can't disagree about what needs building. Before, `make install-ssh`
could call everything "current" while `make install` rebuilt it all — two
sources of truth for the same question.

**Lesson:** when two entry points answer the same staleness question, define
the rule once and let both consume it. Here the shared rule is duplicated
(find+mtime in TS vs SOURCES in make), but documented as the same contract in
both places; the docs now point at each other.

### Known blind spot, inherited and documented

Editing compiled artifacts directly (`out/`, or the webview bundle markdown
writes into `build/index.js`) does not re-stale the VSIX — identical to
install-ssh's pre-existing behavior. Markdown's `vsix` recipe never compiled
anyway (its `test-cdp` target does that separately), so this changes nothing
there; for the compile-and-pack repos, `src/` is watched and `out/` is derived,
which covers the real flow. Escape hatch: delete the VSIX or `make clean`.
Note eink-60hz has no `clean` target — for it, `rm build/*.vsix` is the force
lever.

**Lesson:** state the conservative blind spot in the docs next to the feature,
including the per-repo force mechanism, so "why didn't it rebuild?" has a
one-line answer.
