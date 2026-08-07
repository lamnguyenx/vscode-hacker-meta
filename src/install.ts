// Installs a packed VSIX through every available install CLI:
//   code        → native VS Code     ($HOME/.vscode/extensions)
//   code-server → code-server        (${XDG_DATA_HOME:-$HOME/.local/share}/code-server/extensions)
//   remote-cli  → Remote-SSH server  ($HOME/.vscode-server/extensions)
//                (e.g. running this on the remote host installs for
//                Remote-SSH windows)
//
// A CLI that exists but fails to produce an install is a warning when another
// CLI already installed; the install fails only if nothing was installed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export class InstallError extends Error {}

export interface InstallResult {
	installedDirs: string[];
	warnings: string[];
}

function warn(warnings: string[], msg: string): void {
	warnings.push(msg);
	console.warn(`WARNING: ${msg}`);
}

function isExecutable(path: string): boolean {
	try {
		const st = statSync(path);
		return st.isFile() && (st.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

export function findOnPath(name: string, skip?: (candidate: string) => boolean): string | undefined {
	for (const entry of (process.env.PATH ?? '').split(':')) {
		const candidate = join(entry || '.', name);
		if (!isExecutable(candidate)) {
			continue;
		}
		if (skip && skip(candidate)) {
			continue;
		}
		return candidate;
	}
	return undefined;
}

// Newest remote-cli across both server layouts:
//   ~/.vscode-server/cli/servers/<commit>/server/bin/remote-cli/code  (current)
//   ~/.vscode-server/bin/<commit>/bin/remote-cli/code                 (older)
export function newestServerCli(): string | undefined {
	const home = homedir();
	const bases = [
		join(home, '.vscode-server', 'cli', 'servers'),
		join(home, '.vscode-server', 'bin'),
	];
	const candidates: string[] = [];
	for (const base of bases) {
		if (!existsSync(base)) {
			continue;
		}
		for (const entry of readdirSync(base)) {
			const full = join(base, entry, 'server', 'bin', 'remote-cli', 'code');
			if (existsSync(full)) {
				candidates.push(full);
			}
		}
	}
	candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return candidates[0];
}

// Reads <publisher>.<name>-<version> from the VSIX's extension.vsixmanifest so
// any extension's VSIX can be installed without extra arguments.
export function readManifestIdentity(vsix: string): { publisher: string; name: string; version: string } {
	const r = spawnSync('unzip', ['-p', vsix, 'extension.vsixmanifest'], { encoding: 'utf8' });
	if (r.status !== 0) {
		throw new InstallError(`unzip failed to read ${vsix}: ${(r.stderr ?? '').trim()}`);
	}
	const identity = (r.stdout ?? '').match(/<Identity[^>]*>/)?.[0];
	if (!identity) {
		throw new InstallError(`no <Identity> element in extension.vsixmanifest of ${vsix}`);
	}
	const attr = (name: string): string => identity.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
	const publisher = attr('Publisher');
	const name = attr('Id');
	const version = attr('Version');
	if (!publisher || !name || !version) {
		throw new InstallError(`could not read publisher/name/version from ${vsix}`);
	}
	return { publisher, name, version };
}

export interface InstallOptions {
	// Path to a .vsix file to install.
	vsix: string;
	// Optional executable invoked as `hook <installed-extension-dir>` after
	// each successful install (e.g. to verify the package's expected files).
	hook?: string;
}

export function installVsix(options: InstallOptions): InstallResult {
	const vsix = resolve(options.vsix);
	if (!existsSync(vsix)) {
		throw new InstallError(`${vsix} not found.`);
	}
	const hook = options.hook ? resolve(options.hook) : undefined;
	if (hook && !existsSync(hook)) {
		throw new InstallError(`hook ${hook} not found.`);
	}

	const { publisher, name, version } = readManifestIdentity(vsix);
	const extId = `${publisher}.${name}-${version}`;

	const home = homedir();
	const nativeDest = join(home, '.vscode', 'extensions');
	const codeServerDest = join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'code-server', 'extensions');
	const serverDest = join(home, '.vscode-server', 'extensions');

	// First `code` on PATH that is NOT the Remote-SSH server's CLI shim (which
	// lives under ~/.vscode-server/ and only works inside a VS Code terminal);
	// the shim is handled by the remote-cli install below.
	const nativeCli = findOnPath('code', (c) => c.startsWith(join(home, '.vscode-server')));
	const codeServerCli = findOnPath('code-server');
	const serverCli = newestServerCli();

	const result: InstallResult = { installedDirs: [], warnings: [] };

	const runHook = (target: string): boolean => {
		if (!hook) {
			return true;
		}
		// A hook that lost its exec bit (fresh git clones default to 644)
		// still runs via bash.
		const cmd = isExecutable(hook) ? [hook, target] : ['bash', hook, target];
		const h = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
		if (h.status !== 0) {
			warn(result.warnings, `post-install hook rejected ${target}`);
			return false;
		}
		return true;
	};

	const installVia = (cli: string, root: string): boolean => {
		if (!isExecutable(cli)) {
			return false;
		}
		const r = spawnSync(cli, ['--install-extension', vsix, '--force'], { encoding: 'utf8' });
		if (r.status !== 0) {
			const detail = (r.stderr ?? r.stdout ?? '').trim();
			warn(result.warnings, `installation via ${cli} failed${detail ? `: ${detail}` : '.'}`);
			return false;
		}
		const target = join(root, extId);
		if (!existsSync(target)) {
			warn(result.warnings, `${target} missing after installation.`);
			warn(result.warnings, 'The CLI may have forwarded the install to a connected VS Code instance (e.g. a dev host) instead of installing here.');
			return false;
		}
		if (!runHook(target)) {
			return false;
		}
		console.log(`Installed via ${cli} (${target}). Reload the window (Cmd+Shift+P > Developer: Reload Window) to activate.`);
		result.installedDirs.push(target);
		return true;
	};

	if (nativeCli) {
		installVia(nativeCli, nativeDest);
	}
	if (codeServerCli) {
		installVia(codeServerCli, codeServerDest);
	}
	if (serverCli) {
		installVia(serverCli, serverDest);
	}

	if (result.installedDirs.length === 0) {
		throw new InstallError('no install CLI succeeded: code, code-server and ~/.vscode-server/*/.../remote-cli/code were all missing or failed.');
	}
	return result;
}
