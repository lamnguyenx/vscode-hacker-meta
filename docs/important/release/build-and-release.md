# Build and release

How the extension VSIXs are built, versioned, tagged, and released.

All extensions follow a unified convention:

- **Output**: `build/<publisher>.<name>-<version>.vsix`
- **Publisher**: `lamnguyenx`
- **Version**: CalVer `YYYY.M.PATCH`, one per extension (see the [extension table](../../../README.md#extensions))
- **`.gitignore`**: shared minimal template via the submodules
- **Builds are incremental**: `make build` only repacks an extension whose
  sources changed (see below)

## Incremental VSIX builds

In every submodule the VSIX is a real file target whose prerequisites are the
packed sources (`SOURCES`: the source trees the `.vscodeignore` packs, plus
`package.json`, the lockfile, and tsconfigs where relevant):

```make
build vsix: $(VSIX)

$(VSIX): $(SOURCES)
	npx --yes @vscode/vsce pack -o $@
```

So `make build` / `make install` (and `make -C _submodules/<name> build`)
repack an extension **only** when a source is newer than its VSIX — the same
mtime rule `make install-ssh` uses, which means both paths always agree on
what is stale. A warm `make build` across all seven is a no-op (~4s).

Rules of the contract:

- Generated trees (`out/`, `build/`, `node_modules/`) are never prerequisites;
  each repo's recipe regenerates them. Watching build outputs would
  self-trigger a rebuild every run.
- A version bump re-stales itself (the version is in the VSIX filename → new
  target → rebuild). Old-versioned VSIXs linger in `build/`, harmlessly.
- Editing compiled artifacts directly (`out/`, the webview bundle) does not
  re-stale the VSIX. Force a repack with `make -C _submodules/<name> clean`
  where a `clean` target exists, or `rm _submodules/<name>/build/*.vsix`
  (e.g. `vscode-eink-60hz`, which has no `clean`).

Design log: [2026-11-10 incremental VSIX builds](../../plans/2026/11/10/2026-11-10-incremental-vsix-build.md).

## Tagging and releasing

```bash
cd _submodules/vscode-hacker-<name>
VERSION=$(node -p "require('./package.json').version")
git tag "v$VERSION"
git push origin "v$VERSION"
gh release create "v$VERSION" build/*.vsix --generate-notes
```

## Generate summary table

```bash
python3 local/get_summary.py
```
