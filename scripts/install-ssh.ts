#!/usr/bin/env bun
/**
 * `make install-ssh`: pick extensions and SSH hosts, build the VSIXs that are
 * missing or stale, and install them on every selected host.
 *
 * The host list comes from `~/.ssh/config` (`Host` aliases; wildcard-only
 * patterns and git remotes are skipped). Each host gets one tar stream over
 * SSH; the remote side extracts the VSIXs, finds the *running* code-server
 * (falling back to `PATH`, then a tarball under `~/Downloads`), and installs into
 * that instance's `--user-data-dir`. `--target code` installs with the `code`
 * CLI instead, and `--target auto` (the default) prefers code-server.
 *
 * Interactive by default. Pass `--extensions` / `--hosts` (or `--all`) to run
 * without prompts, e.g.:
 *
 *   make install-ssh
 *   make install-ssh ARGS="--all --dry-run"
 *   make install-ssh ARGS="-e hacker-markdown,hacker-stats-bar -H wsk,pp"
 *
 * SSH runs with `ClearAllForwardings=yes` so a host's `LocalForward` /
 * `RemoteForward` rules neither bind ports nor print collision warnings.
 * A failing host does not stop the others; the run exits non-zero and prints
 * a summary at the end.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { blue, bold, cyan, dim, green, magenta, red, yellow } from './style';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SUBMODULES = join(ROOT, '_submodules');
const SSH_CONFIG = process.env.SSH_CONFIG ?? join(homedir(), '.ssh', 'config');
const INSTALL_TIMEOUT_MS = 180_000;

type Target = 'auto' | 'code-server' | 'code';

interface Options {
  extensions?: string[];
  hosts?: string[];
  all: boolean;
  build: boolean;
  noBuild: boolean;
  dryRun: boolean;
  target: Target;
  jobs: number;
  help: boolean;
}

interface Extension {
  dir: string;
  /** `publisher.name`, the id VS Code and code-server use. */
  id: string;
  name: string;
  displayName: string;
  version: string;
  vsix: string;
  status: 'current' | 'missing' | 'stale';
}

interface SshHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: string;
}

interface HostResult {
  host: SshHost;
  ok: boolean;
  code: number;
  ms: number;
  error?: string;
}

// ---------------------------------------------------------------- args / help

const HELP = `Usage: make install-ssh [ARGS="..."]

Pick extensions and SSH hosts interactively, build stale VSIXs, install.

Options:
  -e, --extensions <list>  comma-separated ids, names, folder names, or "all"
  -H, --hosts <list>       comma-separated ~/.ssh/config aliases, or "all"
  -a, --all                every extension + every host, no prompts
  -b, --build              rebuild even when the VSIX looks current
      --no-build           never build; fail if a VSIX is missing
      --dry-run            print the plan and exit
  -t, --target <target>    auto (default) | code-server | code
  -j, --jobs <n>           install on n hosts in parallel (default 4)
  -h, --help               show this help

Examples:
  make install-ssh
  make install-ssh ARGS="--all --dry-run"
  make install-ssh ARGS="-e hacker-markdown -H wsk,mac"
  make install-ssh ARGS="--build -t code-server -j 2"`;

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    all: false,
    build: false,
    noBuild: false,
    dryRun: false,
    target: 'auto',
    jobs: 4,
    help: false,
  };

  const take = (index: number, inline: string | undefined, flag: string): [string, number] => {
    if (inline !== undefined) return [inline, index];
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('-')) {
      throw new Error(`${flag} needs a value`);
    }
    return [next, index + 1];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const inline = equals > 0 ? arg.slice(equals + 1) : undefined;

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-a':
      case '--all':
        options.all = true;
        break;
      case '-b':
      case '--build':
        options.build = true;
        break;
      case '--no-build':
        options.noBuild = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '-e':
      case '--extensions': {
        const [value, next] = take(index, inline, flag);
        options.extensions = [...(options.extensions ?? []), ...splitList(value)];
        index = next;
        break;
      }
      case '-H':
      case '--hosts': {
        const [value, next] = take(index, inline, flag);
        options.hosts = [...(options.hosts ?? []), ...splitList(value)];
        index = next;
        break;
      }
      case '-t':
      case '--target': {
        const [value, next] = take(index, inline, flag);
        if (value !== 'auto' && value !== 'code-server' && value !== 'code') {
          throw new Error(`--target must be auto, code-server, or code (got ${value})`);
        }
        options.target = value;
        index = next;
        break;
      }
      case '-j':
      case '--jobs': {
        const [value, next] = take(index, inline, flag);
        const jobs = Number.parseInt(value, 10);
        if (!Number.isFinite(jobs) || jobs < 1) throw new Error(`--jobs needs a positive integer (got ${value})`);
        options.jobs = jobs;
        index = next;
        break;
      }
      default:
        throw new Error(`unknown option: ${arg} (try --help)`);
    }
  }

  if (options.build && options.noBuild) throw new Error('--build and --no-build are mutually exclusive');
  return options;
}

// ------------------------------------------------------------------ discovery

const SKIP_DIRS = new Set(['build', 'node_modules', '.git']);

/** Newest mtime under an extension, ignoring build output and dependencies. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && !entry.name.endsWith('.vsix')) {
        try {
          newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
          // A file that disappears mid-walk is not worth failing over.
        }
      }
    }
  };
  walk(dir);
  return newest;
}

interface Manifest {
  publisher?: string;
  name?: string;
  version?: string;
  displayName?: string;
}

function discoverExtensions(): Extension[] {
  if (!existsSync(SUBMODULES)) throw new Error(`no ${relative(process.cwd(), SUBMODULES) || SUBMODULES} directory`);

  const extensions: Extension[] = [];
  const dirs = readdirSync(SUBMODULES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of dirs) {
    const dir = join(SUBMODULES, entry.name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;

    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    } catch {
      continue;
    }
    const { publisher, name, version } = manifest;
    if (publisher === undefined || name === undefined || version === undefined) continue;

    const vsix = join(dir, 'build', `${publisher}.${name}-${version}.vsix`);
    const status: Extension['status'] = !existsSync(vsix)
      ? 'missing'
      : newestSourceMtime(dir) > statSync(vsix).mtimeMs
        ? 'stale'
        : 'current';

    extensions.push({
      dir,
      id: `${publisher}.${name}`,
      name,
      displayName: manifest.displayName ?? name,
      version,
      vsix,
      status,
    });
  }

  return extensions;
}

const GIT_HOSTS = new Set(['github.com', 'ssh.github.com', 'gitlab.com', 'bitbucket.org']);

/** Drop a trailing `# comment` (respecting double quotes). */
function stripComment(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === '#' && !quoted && (index === 0 || /\s/.test(line[index - 1] ?? ''))) {
      return line.slice(0, index);
    }
  }
  return line;
}

/**
 * The concrete `Host` aliases in an OpenSSH config. Patterns with wildcards or
 * negations are skipped, as are the common git remotes. Aliases repeated in a
 * later block keep the first block's HostName/User/Port, and order is preserved.
 */
function parseSshConfig(path: string): SshHost[] {
  if (!existsSync(path)) throw new Error(`no SSH config at ${path}`);

  const hosts: SshHost[] = [];
  let patterns: string[] = [];
  let props: Omit<SshHost, 'alias'> = {};

  const flush = (): void => {
    for (const pattern of patterns) {
      if (pattern === '' || /[*?!]/.test(pattern) || GIT_HOSTS.has(pattern)) continue;
      if (hosts.some((host) => host.alias === pattern)) continue;
      hosts.push({ alias: pattern, ...props });
    }
    patterns = [];
    props = {};
  };

  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (line === '') continue;

    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();

    if (key === 'host') {
      flush();
      patterns = value.split(/\s+/);
    } else if (key === 'match') {
      flush();
    } else if (patterns.length > 0) {
      if (key === 'hostname') props.hostname = value;
      else if (key === 'user') props.user = value;
      else if (key === 'port') props.port = value;
    }
  }

  flush();
  return hosts;
}

function chooseExtensions(all: Extension[], wanted: string[]): Extension[] {
  if (wanted.length === 0) throw new Error('--extensions is empty');
  if (wanted.includes('all')) return all;

  const picked: Extension[] = [];
  for (const raw of wanted) {
    const needle = raw.toLowerCase();
    let matches = all.filter(
      (extension) =>
        extension.id.toLowerCase() === needle ||
        extension.name.toLowerCase() === needle ||
        basename(extension.dir).toLowerCase() === needle ||
        extension.displayName.toLowerCase() === needle,
    );
    if (matches.length === 0) {
      matches = all.filter(
        (extension) =>
          extension.id.toLowerCase().includes(needle) ||
          extension.name.toLowerCase().includes(needle) ||
          basename(extension.dir).toLowerCase().includes(needle),
      );
    }
    if (matches.length === 0) {
      throw new Error(`unknown extension: ${raw}\nknown: ${all.map((extension) => extension.id).join(', ')}`);
    }
    for (const extension of matches) {
      if (!picked.includes(extension)) picked.push(extension);
    }
  }
  return picked;
}

function chooseHosts(all: SshHost[], wanted: string[]): SshHost[] {
  if (wanted.length === 0) throw new Error('--hosts is empty');
  if (wanted.includes('all')) return all;

  const picked: SshHost[] = [];
  for (const raw of wanted) {
    const host = all.find((candidate) => candidate.alias === raw);
    if (host === undefined) {
      throw new Error(`unknown host: ${raw}\nknown: ${all.map((candidate) => candidate.alias).join(', ')}`);
    }
    if (!picked.includes(host)) picked.push(host);
  }
  return picked;
}

// ------------------------------------------------------------------- terminal

interface Choice {
  value: string;
  label: string;
  hint?: string;
  selected?: boolean;
}

function tokenizeKeys(chunk: string): string[] {
  return chunk.match(/\u001b\[[0-9;]*[A-Za-z]|\u001bO[A-Za-z]|[\s\S]/g) ?? [];
}

function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function fitPlain(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

/**
 * A checkbox list driven from raw stdin: space toggles, `a` toggles all,
 * `j`/`k` or the arrows move, enter confirms, `q`/Ctrl-C cancels.
 * Returns the selected values, or null when cancelled.
 */
async function multiSelect(question: string, choices: Choice[]): Promise<string[] | null> {
  const stdin = process.stdin;
  const out = process.stdout;
  const selected = new Set(choices.filter((choice) => choice.selected).map((choice) => choice.value));
  const columns = out.columns || 100;
  const width = Math.max(40, Math.min(columns - 2, 140));
  let cursor = 0;
  let drawn = 0;
  let notice = '';

  const renderChoice = (choice: Choice, index: number): string => {
    const active = index === cursor;
    const pointer = active ? cyan('❯') : ' ';
    const box = selected.has(choice.value) ? green('◉') : dim('◯');
    const room = width - 4;
    const labelText = fitPlain(choice.label, room);
    const hintText =
      choice.hint === undefined
        ? ''
        : fitPlain(`  ${choice.hint}`, Math.max(0, room - visibleLength(labelText)));
    const painted = active ? bold(labelText) : labelText;
    return `${pointer} ${box} ${painted}${dim(hintText)}`;
  };

  const render = (): void => {
    if (drawn > 0) out.write(`\u001b[${drawn}A`);
    out.write('\u001b[0J');
    const footer =
      notice !== ''
        ? red(notice)
        : dim(`${selected.size} selected · space toggle · a all · enter confirm · q quit`);
    const lines = [`${cyan('?')} ${bold(question)}`, ...choices.map(renderChoice), footer];
    out.write(`${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise((resolvePromise) => {
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      out.write('\u001b[?25h');
    };

    const finish = (value: string[] | null): void => {
      cleanup();
      if (drawn > 0) out.write(`\u001b[${drawn}A`);
      out.write('\u001b[0J');
      drawn = 0;
      if (value === null) {
        out.write(`${red('✖')} ${question} ${dim('cancelled')}\n`);
      } else {
        const summary = value
          .map((selectedValue) => choices.find((choice) => choice.value === selectedValue)?.label ?? selectedValue)
          .join(', ');
        const room = Math.max(20, width - question.length - 4);
        out.write(`${green('✔')} ${question} ${dim(fitPlain(summary, room))}\n`);
      }
      resolvePromise(value);
    };

    const onData = (data: Buffer | string): void => {
      for (const sequence of tokenizeKeys(data.toString())) {
        if (sequence === '\u0003' || sequence === 'q') {
          finish(null);
          return;
        }
        switch (sequence) {
          case ' ':
            if (selected.has(choices[cursor]?.value ?? '')) selected.delete(choices[cursor]?.value ?? '');
            else selected.add(choices[cursor]?.value ?? '');
            notice = '';
            break;
          case 'a': {
            const allSelected = selected.size === choices.length;
            selected.clear();
            if (!allSelected) for (const choice of choices) selected.add(choice.value);
            notice = '';
            break;
          }
          case 'j':
          case '\u001b[B':
          case '\u001bOB':
            cursor = Math.min(choices.length - 1, cursor + 1);
            break;
          case 'k':
          case '\u001b[A':
          case '\u001bOA':
            cursor = Math.max(0, cursor - 1);
            break;
          case 'g':
            cursor = 0;
            break;
          case 'G':
            cursor = choices.length - 1;
            break;
          case '\r':
          case '\n':
            if (selected.size === 0) {
              notice = 'select at least one item (space)';
            } else {
              finish(choices.filter((choice) => selected.has(choice.value)).map((choice) => choice.value));
              return;
            }
            break;
          default:
            break;
        }
      }
      render();
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    out.write('\u001b[?25l');
    render();
  });
}

// ------------------------------------------------------------------- building

function buildOne(extension: Extension): boolean {
  console.log(`\n${bold('==>')} build ${cyan(extension.name)} ${dim(extension.version)}`);
  const hasMakefile = existsSync(join(extension.dir, 'Makefile'));
  const result = hasMakefile
    ? spawnSync('make', ['build'], { cwd: extension.dir, stdio: 'inherit' })
    : spawnSync('npx', ['--yes', '@vscode/vsce', 'pack', '-o', extension.vsix], {
        cwd: extension.dir,
        stdio: 'inherit',
      });

  if (result.error !== undefined) {
    console.error(red(`build failed: ${result.error.message}`));
    return false;
  }
  if (result.status !== 0) {
    console.error(red(`build failed (exit ${result.status ?? 'unknown'})`));
    return false;
  }
  if (!existsSync(extension.vsix)) {
    console.error(red(`build finished but ${relative(ROOT, extension.vsix)} is missing`));
    return false;
  }
  return true;
}

// ----------------------------------------------------------------- installing

function remoteInstallScript(target: Target): string {
  // One POSIX-sh script per host. Its stdin is a gzipped tar of the VSIXs; it
  // prints one line per install and exits non-zero if any install fails.
  // String.raw keeps the awk regex backslashes intact.
  return String.raw`set -eu
TARGET="${target}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
tar -xzf - -C "$tmp" || { echo "could not extract VSIX stream" >&2; exit 4; }

# The running instance is "<root>/lib/node <root>/out/node/entry". Scope the
# scan to that line: this script's own text also appears in the ps output, and
# it mentions --user-data-dir.
entry=$(ps -eo args= 2>/dev/null | awk '$0 ~ /\/out\/node\/entry( |$)/ { print; exit }')
root=$(printf '%s\n' "$entry" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /\/out\/node\/entry$/) { sub(/\/out\/node\/entry$/, "", $i); print $i; exit } }')
userdata=$(printf '%s\n' "$entry" | awk '{ for (i = 1; i <= NF; i++) { if ($i == "--user-data-dir" && i < NF) { print $(i + 1); exit } if ($i ~ /^--user-data-dir=/) { sub(/^--user-data-dir=/, "", $i); print $i; exit } } }')

kind=""
bin=""
if [ "$TARGET" != "code" ]; then
  if [ -n "$root" ] && [ -x "$root/bin/code-server" ]; then
    bin="$root/bin/code-server"; kind=code-server
  elif command -v code-server >/dev/null 2>&1; then
    bin=$(command -v code-server); kind=code-server
  else
    candidate=$(ls -1dt "$HOME"/Downloads*/code-server*/bin/code-server 2>/dev/null | head -n 1 || true)
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      bin="$candidate"; kind=code-server
    fi
  fi
fi
if [ -z "$bin" ] && [ "$TARGET" != "code-server" ]; then
  if command -v code >/dev/null 2>&1; then
    bin=$(command -v code); kind=code
  fi
fi
if [ -z "$bin" ]; then
  echo "no code-server (or code) CLI found; pass --target or install one" >&2
  exit 3
fi

status=0
count=0
for file in $(find "$tmp" -type f -name '*.vsix' | sort); do
  echo "==> $(basename "$file")"
  if [ "$kind" = "code-server" ] && [ -n "$userdata" ]; then
    set -- --user-data-dir "$userdata"
  else
    set --
  fi
  if "$bin" --install-extension "$file" --force "$@"; then
    count=$((count + 1))
  else
    status=1
  fi
done
echo "done: $count extension(s) via $bin"
exit $status`;
}

function streamLines(stream: Readable, onLine: (line: string) => void): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffer !== '') onLine(buffer);
  });
}

function installOnHost(
  host: SshHost,
  extensions: Extension[],
  options: Options,
  tag: (alias: string) => string,
): Promise<HostResult> {
  const files = extensions.map((extension) => relative(ROOT, extension.vsix));
  const script = remoteInstallScript(options.target);

  return new Promise((resolvePromise) => {
    const started = Date.now();
    const ssh = spawn(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=15',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        host.alias,
        script,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const tar = spawn('tar', ['-czf', '-', ...files], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let error: string | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ssh.kill('SIGTERM');
    }, INSTALL_TIMEOUT_MS);

    tar.stdout.pipe(ssh.stdin);
    tar.on('error', (cause) => {
      error = cause.message;
    });
    tar.stderr.on('data', (chunk: Buffer) => {
      error = chunk.toString().trim();
    });
    ssh.on('error', (cause) => {
      error = cause.message;
    });
    streamLines(ssh.stdout, (line) => console.log(`${tag(host.alias)} ${line}`));
    streamLines(ssh.stderr, (line) => console.log(`${tag(host.alias)} ${dim(line)}`));

    ssh.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) error = `timed out after ${INSTALL_TIMEOUT_MS / 1000}s`;
      resolvePromise({
        host,
        ok: code === 0 && !timedOut,
        code: code ?? 1,
        ms: Date.now() - started,
        error,
      });
    });
  });
}

const HOST_COLORS = [cyan, magenta, yellow, green, blue];

function hostTagger(hosts: SshHost[]): (alias: string) => string {
  const width = Math.max(...hosts.map((host) => host.alias.length));
  const colors = new Map(hosts.map((host, index) => [host.alias, HOST_COLORS[index % HOST_COLORS.length] ?? cyan]));
  return (alias: string) => (colors.get(alias) ?? cyan)(`[${alias.padEnd(width)}]`);
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });

  await Promise.all(runners);
  return results;
}

// ----------------------------------------------------------------------- main

function describeStatus(extension: Extension, force: boolean): string {
  if (force) return 'build (--build)';
  if (extension.status === 'missing') return red('build (missing VSIX)');
  if (extension.status === 'stale') return yellow('build (source newer)');
  return dim('up to date');
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const allExtensions = discoverExtensions();
  if (allExtensions.length === 0) throw new Error('no extensions found under _submodules/*/package.json');
  const allHosts = parseSshConfig(SSH_CONFIG);
  if (allHosts.length === 0) throw new Error(`no usable Host entries in ${SSH_CONFIG}`);

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let extensions: Extension[];
  let hosts: SshHost[];

  if (options.all) {
    extensions = allExtensions;
    hosts = allHosts;
  } else {
    if (options.extensions !== undefined) {
      extensions = chooseExtensions(allExtensions, options.extensions);
    } else if (interactive) {
      const picked = await multiSelect(
        'Extensions to install',
        allExtensions.map((extension) => ({
          value: extension.id,
          label: extension.displayName,
          hint: `${extension.id}@${extension.version}${
            extension.status === 'current' ? '' : ' · needs build'
          }`,
          selected: true,
        })),
      );
      if (picked === null) return 130;
      extensions = allExtensions.filter((extension) => picked.includes(extension.id));
    } else {
      throw new Error('no TTY for prompts: pass --extensions (or --all)');
    }

    if (options.hosts !== undefined) {
      hosts = chooseHosts(allHosts, options.hosts);
    } else if (interactive) {
      const picked = await multiSelect(
        'SSH hosts to install on',
        allHosts.map((host) => ({
          value: host.alias,
          label: host.alias,
          hint: `${host.user === undefined ? '' : `${host.user}@`}${host.hostname ?? host.alias}${
            host.port === undefined ? '' : `:${host.port}`
          }`,
          selected: false,
        })),
      );
      if (picked === null) return 130;
      hosts = allHosts.filter((host) => picked.includes(host.alias));
    } else {
      throw new Error('no TTY for prompts: pass --hosts (or --all)');
    }
  }

  if (extensions.length === 0) throw new Error('no extensions selected');
  if (hosts.length === 0) throw new Error('no hosts selected');

  const stale = extensions.filter((extension) => options.build || extension.status !== 'current');

  if (options.dryRun) {
    console.log(`${bold('plan')} ${dim(`${extensions.length} extension(s) → ${hosts.length} host(s), target ${options.target}`)}`);
    for (const extension of extensions) {
      console.log(`  ${cyan(extension.name.padEnd(26))} ${dim(extension.version.padEnd(12))} ${describeStatus(extension, options.build)}`);
    }
    console.log(`  ${bold('hosts')} ${hosts.map((host) => host.alias).join(', ')}`);
    console.log(dim('\ndry run: nothing built or installed'));
    return 0;
  }

  if (stale.length > 0) {
    if (options.noBuild) {
      const missing = stale.filter((extension) => !existsSync(extension.vsix));
      if (missing.length > 0) {
        throw new Error(
          `--no-build but these VSIXs are missing: ${missing.map((extension) => extension.id).join(', ')}`,
        );
      }
      console.log(yellow(`\n--no-build: installing ${stale.length} stale VSIX(s) as-is`));
    } else {
      console.log(`\n${bold('build')} ${stale.length} of ${extensions.length} extension(s)`);
      const failed = new Set<Extension>();
      for (const extension of stale) {
        if (!buildOne(extension)) failed.add(extension);
      }
      if (failed.size > 0) {
        extensions = extensions.filter((extension) => !failed.has(extension));
        console.error(
          red(`\nbuild failed for: ${[...failed].map((extension) => extension.id).join(', ')}`),
        );
        if (extensions.length === 0) return 1;
        console.error(dim(`continuing with ${extensions.length} extension(s)`));
      }
    }
  }

  console.log(
    `\n${bold('install')} ${extensions.length} extension(s) on ${hosts.length} host(s) ${dim(
      `· target ${options.target} · ${options.jobs} job(s)`,
    )}`,
  );

  const tag = hostTagger(hosts);
  const results = await pool(hosts, options.jobs, (host) => installOnHost(host, extensions, options, tag));

  console.log(`\n${bold('summary')}`);
  for (const result of results) {
    const took = dim(`${(result.ms / 1000).toFixed(1)}s`);
    if (result.ok) {
      console.log(`  ${green('✔')} ${result.host.alias.padEnd(12)} ${took}  ${extensions.length} extension(s)`);
    } else {
      console.log(`  ${red('✖')} ${result.host.alias.padEnd(12)} ${took}  exit ${result.code}`);
      if (result.error !== undefined) console.log(dim(`    ${result.error}`));
    }
  }

  const failedHosts = results.filter((result) => !result.ok);
  if (failedHosts.length > 0) {
    console.error(red(`\n${failedHosts.length} host(s) failed`));
    return 1;
  }

  console.log(dim('\nReload each target window once so a fresh extension host loads the build.'));
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });

/** Never leave the terminal in raw mode / with a hidden cursor on a signal. */
function restoreTerminal(): void {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    // The terminal may already be gone.
  }
  process.stdout.write('\u001b[?25h');
}

process.once('SIGINT', () => {
  restoreTerminal();
  process.exit(130);
});
process.once('SIGTERM', () => {
  restoreTerminal();
  process.exit(143);
});
