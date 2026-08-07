#!/usr/bin/env node
// vscode-hacker-meta — meta tooling for hacking VS Code extensions.
//
// Usage:
//   vscode-hacker-meta install <vsix-file> [--post-install-script <path>]
//   vscode-hacker-meta pack <extension-dir> [--out <dir>]
//
//   install <vsix-file> Installs the given VSIX through every install CLI on
//                       this machine (native VS Code, code-server, Remote-SSH
//                       server). The VSIX path must be specified explicitly;
//                       nothing is discovered.
//   --post-install-script <path>
//                       Optional executable invoked as
//                       `script <installed-extension-dir>` after each
//                       successful install to verify the package. Must be
//                       registered explicitly. A non-executable script is
//                       run via bash.
//   pack <dir>          Packs the extension in <dir> with vsce (which runs its
//                       vscode:prepublish build) and prints the produced VSIX
//                       path (default output: <dir>/build/).
//
// Exit code is 0 when at least one install succeeded.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { findOnPath, installVsix, InstallError } from './install';

const USAGE = `usage:
  vscode-hacker-meta install <vsix-file> [--post-install-script <path>]
  vscode-hacker-meta pack <extension-dir> [--out <dir>]
  vscode-hacker-meta --version
  vscode-hacker-meta --help`;

function die(msg: string): never {
	console.error(`ERROR: ${msg}`);
	process.exit(1);
}

function findVsce(): string {
	const global = findOnPath('vsce');
	if (global) {
		return global;
	}
	return 'npx @vscode/vsce';
}

// Packs the extension in <dir> via vsce; returns the produced VSIX path.
function packExtension(dir: string, outDir: string): string {
	if (!existsSync(join(dir, 'package.json'))) {
		throw new InstallError(`${dir} is not an extension project (no package.json)`);
	}
	mkdirSync(outDir, { recursive: true });
	const vsce = findVsce();
	const r = spawnSync(vsce, ['pack', '--out', outDir], {
		cwd: dir,
		stdio: 'inherit',
		encoding: 'utf8',
	});
	if (r.status !== 0) {
		throw new InstallError(`vsce pack failed in ${dir} (exit ${r.status})`);
	}
	const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
		name?: string;
		version?: string;
	};
	if (!pkg.name || !pkg.version) {
		throw new InstallError(`package.json in ${dir} is missing name/version`);
	}
	const vsix = join(outDir, `${pkg.name}-${pkg.version}.vsix`);
	if (!existsSync(vsix)) {
		throw new InstallError(`expected packed VSIX not found: ${vsix}`);
	}
	return vsix;
}

function cmdInstall(rest: string[]): void {
	let vsixArg: string | undefined;
	let hook: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === '--post-install-script') {
			hook = rest[++i];
			if (!hook) {
				die('--post-install-script requires a value');
			}
		} else if (a.startsWith('--post-install-script=')) {
			hook = a.slice('--post-install-script='.length);
		} else if (a.startsWith('-')) {
			die(`unknown option: ${a}\n\n${USAGE}`);
		} else if (vsixArg === undefined) {
			vsixArg = a;
		} else {
			die(`unexpected argument: ${a}\n\n${USAGE}`);
		}
	}
	if (vsixArg === undefined) {
		die(`missing <vsix-file>\n\n${USAGE}`);
	}
	const vsix = resolve(vsixArg);
	if (extname(vsix).toLowerCase() !== '.vsix') {
		die(`not a .vsix file: ${vsixArg}`);
	}
	if (!existsSync(vsix)) {
		die(`vsix not found: ${vsix}`);
	}
	const hookPath = hook ? resolve(hook) : undefined;

	console.log(`Installing ${basename(vsix)}...`);
	if (hookPath) {
		console.log(`Post-install script: ${hookPath}`);
	} else {
		console.log('No post-install script registered (pass --post-install-script <path> to verify installs).');
	}
	installVsix({ vsix, hook: hookPath });
}

function cmdPack(rest: string[]): void {
	let dirArg: string | undefined;
	let outArg: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === '--out') {
			outArg = rest[++i];
			if (!outArg) {
				die('--out requires a value');
			}
		} else if (a.startsWith('--out=')) {
			outArg = a.slice('--out='.length);
		} else if (a.startsWith('-')) {
			die(`unknown option: ${a}\n\n${USAGE}`);
		} else if (dirArg === undefined) {
			dirArg = a;
		} else {
			die(`unexpected argument: ${a}\n\n${USAGE}`);
		}
	}
	if (dirArg === undefined) {
		die(`missing <extension-dir>\n\n${USAGE}`);
	}
	const dir = resolve(dirArg);
	const outDir = resolve(outArg ?? join(dir, 'build'));
	const vsix = packExtension(dir, outDir);
	console.log(`Packed: ${vsix}`);
}

function main(): void {
	const args = process.argv.slice(2);
	const cmd = args[0];

	if (cmd === '--version' || cmd === '-v') {
		console.log(require('../package.json').version);
		return;
	}
	if (cmd === '--help' || cmd === '-h' || cmd === undefined) {
		console.log(USAGE);
		return;
	}
	if (cmd === 'install') {
		cmdInstall(args.slice(1));
		return;
	}
	if (cmd === 'pack') {
		cmdPack(args.slice(1));
		return;
	}
	die(`unknown command: ${cmd}\n\n${USAGE}`);
}

try {
	main();
} catch (err) {
	if (err instanceof Error) {
		die(err.message);
	}
	throw err;
}
