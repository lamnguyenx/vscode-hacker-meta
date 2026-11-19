# AGENTS.md

## Project Structure

- `_submodules/` contains the extension repos as git submodules. This is the single source of truth; edit them here.
- `_refs/` contains read-only external references. Do not modify `_refs/vscode` and `_refs/code-server`.

## Documentation placement

- Write docs in the repo that owns the change. A compose/harness change belongs
  in this repo; do not copy it into `_submodules/*` just because those
  extensions run on that harness.
- "Every module we touched" means modules with actual file changes this
  session. Check `git status` in this repo and each submodule before writing;
  leave clean submodules clean.
- If a change genuinely spans repos, put the full design log in the repo that
  owns the code and only cross-link from the others.

## Dev environment & testing

- The docker code-server (compose service `code-server`, CDP `9024` / HTTP
  `9620`) is the shared test harness. Install the built submodules into it with
  `make install-code-server`, then reload the window **once**.
- `docs/important/testing/how-to-test-all.md` is the full playbook — read it before
  debugging "the extension didn't load": trust / Restricted Mode, the REST
  control endpoint (`HACKER_REST_CONTROL_PORT`, default `40620`), install &
  restart hygiene, and anti-patterns.
- `make check-docs` verifies that every `docs/important/**/*.md` is indexed from
  its repo's `README.md`, and that README/doc links and anchors resolve. Add the
  README bullet in the same change as a new doc.
- The compose `code-server` command runs with `--disable-workspace-trust`, so
  workspace trust never disables extensions in the harness (no per-extension
  `capabilities` needed).