#!/usr/bin/env bash
#
# Install the built extension VSIXs into the code-server from docker-compose.yml
# (the shared dev harness, CDP port 9024 / HTTP 9620).
#
# Why this exists: the code-server service loads its extensions from the mounted
# data dir `./exp/code-server/.local/share/code-server` (the container sees it at
# `$HOME/.local/share/code-server`, host-expanded). That is a *different* profile
# from the host-native code-server, so the per-submodule `make install-code-server`
# (which runs the host `code-server` CLI) does not reach it. This script installs
# into the container explicitly and tells you what to do next.
#
# Usage:
#   local/install-code-server.sh                 # every _submodules/*/build/*.vsix
#   local/install-code-server.sh _submodules/vscode-hacker-markdown
#
# Build first (`make build`, or `make -C <submodule> build`). After installing,
# reload the window ONCE (or `hotload code-server`) so a fresh extension host
# loads the new build — do not reload repeatedly: the extension host lingers for
# VSCODE_RECONNECTION_GRACE_TIME (3h), so extra reloads leave orphaned hosts
# squatting the pinned REST port. See docs/important/how-to-test-all.md §9.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# docker-compose.yml mounts <host $HOME>/git into the container at the same
# absolute path, so a VSIX under it is readable in-container as-is. The
# code-server data dir is host-expanded too (the service runs with
# --user-data-dir ${HOME}/.local/share/code-server and the volume target is the
# same literal path).
host_home="${HOME}"
container_user_data_dir="${host_home}/.local/share/code-server"
visible_root="${host_home}/git"

# Resolve one VSIX per extension: the file matching the current package.json
# version (`<publisher>.<name>-<version>.vsix`), falling back to the newest in
# build/ when that exact file is absent. build/ accumulates old VSIXs, so a
# naive `build/*.vsix` glob would (re)install stale versions.
expected_vsix() {
	local dir="$1" file newest
	file="$(python3 -c "import json;d=json.load(open('$dir/package.json'));print('%s.%s-%s.vsix'%(d['publisher'],d['name'],d['version']))" 2>/dev/null)"
	if [ -n "$file" ] && [ -f "$dir/build/$file" ]; then
		printf '%s\n' "$dir/build/$file"
		return 0
	fi
	newest="$(ls -1t "$dir"/build/*.vsix 2>/dev/null | head -1)"
	[ -n "$newest" ] && printf '%s\n' "$newest"
}

shopt -s nullglob
dirs=()
if [ "$#" -gt 0 ]; then
	dirs=("$@")
else
	dirs=(_submodules/*/Makefile)
	dirs=("${dirs[@]%/Makefile}")
fi

vsixes=()
for dir in "${dirs[@]}"; do
	[ -f "$dir/package.json" ] || continue
	v="$(expected_vsix "$dir")"
	[ -n "$v" ] && vsixes+=("$v")
done

if [ "${#vsixes[@]}" -eq 0 ]; then
	echo "no VSIX found under build/ — run 'make build' first" >&2
	exit 1
fi

service="code-server"
if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$service"; then
	echo "docker compose service '$service' is not running — start it with: docker compose up -d $service" >&2
	exit 1
fi

failed=()
for vsix in "${vsixes[@]}"; do
	# Map the host path to a path the container can read.
	if [[ "$repo_root" == "$visible_root" || "$repo_root" == "$visible_root"/* ]]; then
		container_vsix="$repo_root/$vsix"
	else
		# Repo is not under the mounted git dir: stage the VSIX into the container.
		container_dir="/tmp/hmk-vsix"
		docker compose exec -T "$service" mkdir -p "$container_dir" </dev/null >/dev/null || { failed+=("$vsix"); continue; }
		docker compose cp "$vsix" "$service:$container_dir/" >/dev/null || { failed+=("$vsix"); continue; }
		container_vsix="$container_dir/$(basename "$vsix")"
	fi

	printf '\n==> install %s\n' "$vsix"
	if ! docker compose exec -T "$service" code-server \
			--install-extension "$container_vsix" --force \
			--user-data-dir "$container_user_data_dir" </dev/null; then
		failed+=("$vsix")
	fi
done

if [ "${#failed[@]}" -gt 0 ]; then
	printf '\nFAILED: %s\n' "${failed[*]}" >&2
	exit 1
fi

printf '\nInstalled %d VSIX into the docker code-server.\n' "${#vsixes[@]}"
printf 'Reload the window once (or run `hotload code-server`) so a fresh extension host loads it.\n'
