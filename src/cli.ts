#!/usr/bin/env node
// vscode-hacker-meta — meta tooling for hacking VS Code extensions.
//
// Usage:
//   vscode-hacker-meta install <extension-dir-or-vsix> [post-install-hook]
//
//   install <dir>      Packs the extension in <dir> with vsce (which runs its
//                      vscode:prepublish build) into <dir>/build/, then
//                      installs the VSIX through every install CLI on this
//                      machine (native VS Code, code-server, Remote-SSH
//                      server). If <dir>/tools/post_install.sh exists it is
//                      run after each install to verify the package.
//   install <file.vsix> Installs an already-packed VSIX directly.
//
// Exit code is 0 when at least one install succeeded.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { findOnPath, installVsix, InstallError } from './install';

const USAGE = `usage:
  vscode-hacker-meta install <extension-dir-or-vsix> [post-install-hook]
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

function packExtension(dir: string): string {
	if (!existsSync(join(dir, 'package.json'))) {
		throw new InstallError(`${dir} is not an extension project (no package.json)`);
	}
	const outDir = join(dir, 'build');
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
		publisher?: string;
		name?: string;
		version?: string;
	};
	if (!pkg.publisher || !pkg.name || !pkg.version) {
		throw new InstallError(`package.json in ${dir} is missing publisher/name/version`);
	}
	const vsix = join(outDir, `${pkg.name}-${pkg.version}.vsix`);
	if (!existsSync(vsix)) {
		throw new InstallError(`expected packed VSIX not found: ${vsix}`);
	}
	return vsix;
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
	if (cmd !== 'install') {
		die(`unknown command: ${cmd}\n\n${USAGE}`);
	}

	const target = resolve(args[1] ?? '');
	if (!target || !existsSync(target)) {
		die(`path not found: ${args[1] ?? ''}`);
	}

	const explicitHook = args[2] ? resolve(args[2]) : undefined;
	let vsix: string;
	let dir: string;
	if (extname(target).toLowerCase() === '.vsix') {
		vsix = target;
		dir = '';
	} else {
		dir = target;
		vsix = packExtension(dir);
	}
	const hook = explicitHook ?? (dir && existsSync(join(dir, 'tools', 'post_install.sh')) ? join(dir, 'tools', 'post_install.sh') : undefined);

	console.log(`Installing ${basename(vsix)}...`);
	installVsix({ vsix, hook });
}

try {
	main();
} catch (err) {
	if (err instanceof Error) {
		die(err.message);
	}
	throw err;
}
