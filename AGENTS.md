# AGENTS.md

## Project Structure

- `_submodules/` contains the extension repos as git submodules. This is the single source of truth; edit them here.
- `_refs/` contains read-only external references. Do not modify `_refs/vscode` and `_refs/code-server`.

## Dev environment & testing

- The docker code-server (compose service `code-server`, CDP `9024` / HTTP
  `9620`) is the shared test harness. Install the built submodules into it with
  `make install-code-server`, then reload the window **once**.
- `docs/important/how-to-test-all.md` is the full playbook — read it before
  debugging "the extension didn't load": trust / Restricted Mode, the REST
  control endpoint (`HACKER_REST_CONTROL_PORT`, default `40620`), install &
  restart hygiene, and anti-patterns.
- The compose `code-server` command runs with `--disable-workspace-trust`, so
  workspace trust never disables extensions in the harness (no per-extension
  `capabilities` needed).