# Build and release

How the extension VSIXs are built, versioned, tagged, and released.

All extensions follow a unified convention:

- **Output**: `build/<publisher>.<name>-<version>.vsix`
- **Publisher**: `lamnguyenx`
- **Version**: CalVer `YYYY.M.PATCH`, one per extension (see the [extension table](../../../README.md#extensions))
- **`.gitignore`**: shared minimal template via the submodules

Tagging and releasing is done per-repo using `gh`:

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
