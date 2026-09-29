#!/usr/bin/env bash
#
# Run a make target in every extension submodule under _submodules/.
#
#   local/make-all.sh build
#   local/make-all.sh install
#   local/make-all.sh build _submodules/vscode-hacker-markdown   # explicit subset
#
# Used by the root Makefile's `build` / `install` targets. A failing submodule
# does not stop the others; the script prints the failures and exits non-zero.
# With no directory arguments it discovers every _submodules/*/ that has a
# Makefile.
set -uo pipefail

target="${1:-}"
if [ -z "$target" ]; then
	echo "usage: $(basename "$0") <make-target> [submodule-dir ...]" >&2
	exit 2
fi
shift

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ "$#" -gt 0 ]; then
	dirs=("$@")
else
	shopt -s nullglob
	dirs=(_submodules/*/Makefile)
	dirs=("${dirs[@]%/Makefile}")
fi

if [ "${#dirs[@]}" -eq 0 ]; then
	echo "no submodules with a Makefile found under _submodules/" >&2
	exit 0
fi

failed=()
for mk in "${dirs[@]}"; do
	printf '\n==> %s: make %s\n' "$mk" "$target"
	if ! make -C "$mk" "$target" </dev/null; then
		failed+=("$mk")
	fi
done

if [ "${#failed[@]}" -gt 0 ]; then
	printf '\nFAILED: %s\n' "${failed[*]}"
	exit 1
fi

printf '\nAll %d submodule(s) completed: make %s\n' "${#dirs[@]}" "$target"
