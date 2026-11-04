#!/usr/bin/env bun
/**
 * `make info`: the dev harness at a glance — git state, the compose stack and
 * its live probes, every extension submodule's package version against what is
 * installed in the code-server, and the paths the harness writes to.
 *
 * Read-only: it asks Docker and curl a few questions and reads package.json
 * files. It starts, installs, and changes nothing. Colour is on for a TTY;
 * `NO_COLOR=1` or a redirect prints the same text plain, and `FORCE_COLOR=1`
 * forces it.
 *
 * The URLs are printed **last** on purpose: a short terminal shows only the
 * tail, and those are the lines worth keeping in view.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bold,
  cyan,
  dim,
  green,
  italic,
  label,
  red,
  underline,
  yellow,
} from './style';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SUBMODULES = join(ROOT, '_submodules');
const DATA = join(ROOT, 'exp/code-server/.local/share/code-server');
const EXTENSIONS = join(DATA, 'extensions');
const PROJECT = process.env.COMPOSE_PROJECT_NAME ?? basename(ROOT);
const COLUMN = 16;

interface Result {
  ok: boolean;
  out: string;
}

/** Run a command quietly; a missing program or a non-zero exit is not fatal. */
function run(cmd: string[], timeout = 5_000): Result {
  const [program, ...args] = cmd;
  if (program === undefined) return { ok: false, out: '' };
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

interface Container {
  name: string;
  /** Compose's `Up 2 hours (healthy)` / `Exited (0) …` text. */
  status: string;
  running: boolean;
}

/** The compose container for a service label, preferring a running one. */
function findContainer(service: string): Container | undefined {
  const result = run([
    'docker',
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--format',
    '{{.Names}}\t{{.Status}}',
  ]);
  const containers = result.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [name, ...rest] = line.split('\t');
      const status = rest.join('\t');
      return {
        name: name ?? '',
        status,
        running: status.startsWith('Up'),
      };
    })
    .filter((container) => container.name !== '');
  return (
    containers.find((container) => container.running) ?? containers[0]
  );
}

/** A container's environment; an absent container yields an empty map. */
function containerEnv(name: string | undefined): Record<string, string> {
  if (name === undefined) return {};
  const result = run([
    'docker',
    'inspect',
    '--format',
    '{{range .Config.Env}}{{println .}}{{end}}',
    name,
  ]);
  const env: Record<string, string> = {};
  for (const line of result.out.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

/** A container's status: `up` for a running+healthy one, `down` otherwise. */
function containerState(container: Container | undefined): string {
  if (container === undefined) return red('not created');
  if (!container.running) return `${red('down')} ${dim(container.status)}`;
  if (/unhealthy|restarting|starting/i.test(container.status)) {
    return `${yellow('up')} ${dim(container.status.replace(/^Up\s+/, ''))}`;
  }
  return `${green('up')} ${dim(container.status.replace(/^Up\s+/, ''))}`;
}

/** A relative path, marked green when present and red when absent. */
function path(file: string): string {
  const relative =
    file === ROOT ? '.' : file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : file;
  return existsSync(file) ? bold(relative) : `${dim(relative)} ${red('missing')}`;
}

/** `curl` an HTTP status; `000` when it cannot connect. */
function httpCode(url: string): string {
  const result = run(
    ['curl', '-sk', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', url],
    5_000,
  );
  return result.ok ? result.out || '000' : '000';
}

/** `curl` and parse JSON; undefined when the endpoint is down or not JSON. */
function httpJson<T>(url: string): T | undefined {
  const result = run(['curl', '-s', '-m', '3', url], 5_000);
  if (!result.ok || result.out === '') return undefined;
  try {
    return JSON.parse(result.out) as T;
  } catch {
    return undefined;
  }
}

/** A status code with a readable colour: 2xx/401 green, 000 red. */
function codeState(code: string): string {
  if (code === '000') return red('unreachable');
  if (code.startsWith('2') || code === '401') return green(code);
  return yellow(code);
}

/** The canvas desktop size and its reduced ratio, from the Selkies env. */
function canvasSize(env: Record<string, string>): string {
  if ((env.SELKIES_MANUAL_RESOLUTION ?? 'true') !== 'true') {
    return 'follows viewer';
  }
  const width = Number(env.SELKIES_MANUAL_WIDTH ?? '1280');
  const height = Number(env.SELKIES_MANUAL_HEIGHT ?? '720');
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return '';
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${String(width)}×${String(height)} (${String(width / divisor)}:${String(height / divisor)})`;
}

/** The CDP port from the nginx front door, which is the actual listener. */
function cdpPortFromConfig(): string {
  try {
    const config = readFileSync(join(ROOT, 'docker/chromium/cdp.conf'), 'utf8');
    return /^\s*listen\s+(\d+)\s*;/m.exec(config)?.[1] ?? '9324';
  } catch {
    return '9324';
  }
}

/** The code-server `auth:` mode, without reading the password line. */
function authMode(): string {
  const file = join(ROOT, 'dot-config/code-server/config.yaml');
  try {
    const line = readFileSync(file, 'utf8')
      .split('\n')
      .find((entry) => entry.trimStart().startsWith('auth:'));
    return line?.slice(line.indexOf(':') + 1).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The REST control endpoint answers only a real request, not a bare GET. */
function restIsUp(port: string): boolean {
  const result = run(
    [
      'curl',
      '-s',
      '-m',
      '3',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '-d',
      '{"command":"custom.eval","args":["1"]}',
      `http://127.0.0.1:${port}/`,
    ],
    5_000,
  );
  return result.ok && result.out.trim() === '1';
}

/** The origin of a test URL, with the folder/query stripped. */
function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

interface PackageJson {
  name?: string;
  publisher?: string;
  version?: string;
  displayName?: string;
}

interface ExtensionRow {
  name: string;
  packageVersion: string;
  installed: string;
  state: 'current' | 'stale' | 'missing';
}

/** The installed versions of one extension, by its publisher.name prefix. */
function installedVersions(
  pkg: PackageJson,
  directories: readonly string[],
): string[] {
  if (pkg.name === undefined || pkg.publisher === undefined) return [];
  const prefixes = [
    `${pkg.publisher}.${pkg.name}-`,
    `${pkg.publisher}.vscode-${pkg.name}-`,
  ];
  const versions = new Set<string>();
  for (const directory of directories) {
    for (const prefix of prefixes) {
      if (!directory.startsWith(prefix)) continue;
      // Strip the platform suffix some extensions carry, e.g. `-universal`.
      versions.add(
        directory
          .slice(prefix.length)
          .replace(/-(universal|linux-x64|linux-arm64|alpine|web)$/, ''),
      );
    }
  }
  return [...versions].sort();
}

/** Every submodule's package version, against the installed directories. */
function extensionRows(): ExtensionRow[] {
  let installedDirectories: string[] = [];
  try {
    installedDirectories = readdirSync(EXTENSIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    installedDirectories = [];
  }

  const rows: ExtensionRow[] = [];
  let folders: string[] = [];
  try {
    folders = readdirSync(SUBMODULES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return rows;
  }

  for (const folder of folders) {
    const packageFile = join(SUBMODULES, folder, 'package.json');
    if (!existsSync(packageFile)) continue;
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as PackageJson;
    } catch {
      continue;
    }
    if (pkg.name === undefined || pkg.version === undefined) continue;
    const versions = installedVersions(pkg, installedDirectories);
    const state: ExtensionRow['state'] = versions.includes(pkg.version)
      ? 'current'
      : versions.length > 0
        ? 'stale'
        : 'missing';
    rows.push({
      name: pkg.name,
      packageVersion: pkg.version,
      installed: versions.length === 0 ? '—' : versions.join(', '),
      state,
    });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

/** One row: the label, then the first value; later values align under it. */
function row(
  name: string,
  first: string,
  rest: readonly string[] = [],
): string {
  const gutter = `  ${' '.repeat(COLUMN)}`;
  return [
    `  ${label(name, COLUMN)}${first}`,
    ...rest.map((value) => `${gutter}${value}`),
  ].join('\n');
}

/** A section heading, optionally with a dim italic summary after it. */
function section(title: string, note = ''): string {
  const head = cyan(underline(bold(title)));
  return note === '' ? head : `${head}  ${dim(italic(note))}`;
}

/** Pad a plain cell before it is coloured, so ANSI codes do not count. */
function pad(text: string, width: number): string {
  return text.padEnd(width);
}

const branch = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], 3_000).out || '?';
const head = run(['git', 'rev-parse', '--short', 'HEAD'], 3_000).out || '?';
const changes = run(
  ['git', 'status', '--porcelain', '--untracked-files=all'],
  3_000,
).out
  .split('\n')
  .filter(Boolean).length;

const codeServer = findContainer('code-server');
const codeServerEnv = containerEnv(codeServer?.name);
const chromium = findContainer('chromium');
const chromiumEnv = containerEnv(chromium?.name);
const webview = findContainer(
  'lamnguyenx.hacker-terminal-enhanced-webview-dev',
);

const codeServerOrigin = originOf(
  process.env.CODE_SERVER_ORIGIN ??
    process.env.CODE_SERVER_URL ??
    'https://localhost:9620',
);
const cdpPort = cdpPortFromConfig();
const canvasPort =
  chromiumEnv.CUSTOM_HTTPS_PORT ?? process.env.CANVAS_PORT ?? '9325';
const canvasAuth = (chromiumEnv.PASSWORD ?? '') !== '';
const canvasSizeLabel = canvasSize(chromiumEnv);
const restPort =
  codeServerEnv.HACKER_REST_CONTROL_PORT ??
  process.env.HACKER_REST_CONTROL_PORT ??
  '40620';

const codeServerCode = httpCode(`${codeServerOrigin}/healthz`);
const canvasUrl = `https://0.0.0.0:${canvasPort}`;
const canvasCode = httpCode(`https://127.0.0.1:${canvasPort}/`);
const restUp = restIsUp(restPort);
const cdpVersion = httpJson<{ Browser?: string }>(
  `http://127.0.0.1:${cdpPort}/json/version`,
);
const cdpTargets = httpJson<{ type?: string }[]>(
  `http://127.0.0.1:${cdpPort}/json/list`,
);
const pageCount = Array.isArray(cdpTargets)
  ? cdpTargets.filter((target) => target.type === 'page').length
  : 0;

const docker = run(['docker', 'version', '--format', '{{.Server.Version}}'], 3_000);

const header = [
  `${cyan(underline(bold('vscode-hacker-meta')))}  ${dim('·')}  ${bold(branch)} ${dim('@')} ${bold(head)}  ${dim('·')}  ${
    changes === 0 ? green('clean') : yellow(`${String(changes)} changed`)
  }`,
  row('checkout', bold(ROOT)),
  row(
    'project',
    `${bold(PROJECT)}  ${dim('compose project')}`,
    docker.ok
      ? []
      : [red('docker is not reachable') + dim('  · stack probes will be down')],
  ),
].join('\n');

const stack = [
  row(
    'code-server',
    `${containerState(codeServer)}  ${bold(underline(codeServerOrigin))}  ${codeState(codeServerCode)}`,
  ),
  row(
    'REST control',
    `${restUp ? green('up') : red('down')}  ${underline(`http://127.0.0.1:${restPort}`)}`,
  ),
  row(
    'chromium',
    `${containerState(chromium)}  ${bold(underline(canvasUrl))}  ${codeState(canvasCode)}${canvasCode === '401' ? dim(' auth') : ''}`,
  ),
  row(
    'CDP',
    cdpVersion?.Browser === undefined
      ? `${red('down')}  ${dim(`0.0.0.0:${cdpPort} → 127.0.0.1:9222`)}`
      : `${green('up')}  ${bold(cdpVersion.Browser)}  ${dim(`${String(pageCount)} page target${pageCount === 1 ? '' : 's'}  ·  0.0.0.0:${cdpPort} → 127.0.0.1:9222`)}`,
  ),
  ...(webview === undefined
    ? []
    : [
        row(
          'webview dev',
          `${containerState(webview)}  ${dim('http://localhost:5199')}`,
        ),
      ]),
];

const extensions = extensionRows();
const nameWidth = Math.max(
  9,
  ...extensions.map((extension) => extension.name.length),
);
const packageWidth = Math.max(
  7,
  ...extensions.map((extension) => extension.packageVersion.length),
);
const installedWidth = Math.max(
  9,
  ...extensions.map((extension) => extension.installed.length),
);
const extensionTable = [
  `  ${dim(italic(pad('extension', nameWidth)))}  ${dim(italic(pad('package', packageWidth)))}  ${dim(italic(pad('installed', installedWidth)))}  ${dim(italic('state'))}`,
  ...extensions.map((extension) => {
    const state =
      extension.state === 'current'
        ? green(extension.state)
        : extension.state === 'stale'
          ? yellow(extension.state)
          : red(extension.state);
    return `  ${pad(extension.name, nameWidth)}  ${pad(extension.packageVersion, packageWidth)}  ${pad(extension.installed, installedWidth)}  ${state}`;
  }),
];

const paths = [
  row('data', path(DATA)),
  row('extensions', path(EXTENSIONS)),
  row(
    'config',
    `${path(join(ROOT, 'dot-config/code-server/config.yaml'))}  ${dim(`(auth: ${authMode()})`)}`,
  ),
  row('tls cert', path(join(ROOT, 'dot-config/code-server/localhost.pem'))),
  row('browser profile', path(join(ROOT, 'exp/chromium'))),
  row('compose', path(join(ROOT, 'docker-compose.yml'))),
];

const open = [
  row(
    'code-server',
    `${bold(underline(green(codeServerOrigin)))}  ${dim('workbench · binds 0.0.0.0:9620')}`,
  ),
  row(
    'canvas',
    `${bold(underline(green(canvasUrl)))}  ${dim(`all interfaces · ${canvasAuth ? 'basic auth' : 'no auth'}${canvasSizeLabel === '' ? '' : ` · ${canvasSizeLabel}`}`)}`,
  ),
  row(
    'CDP',
    `${bold(underline(cyan(`http://0.0.0.0:${cdpPort}`)))}  ${dim(`all interfaces · suites need CDP_PORT=${cdpPort}`)}`,
  ),
  row(
    'REST',
    `${bold(underline(cyan(`http://127.0.0.1:${restPort}`)))}  ${dim('loopback only · custom.eval / executeCommand')}`,
  ),
];

const next = [
  row('build', `${bold('make build')}  ${dim('VSIXs in every submodule')}`),
  row(
    'install',
    `${bold('make install-code-server')}  ${dim('into the compose code-server; reload the window once')}`,
  ),
  row(
    'test',
    `${bold(`CDP_PORT=${cdpPort} make -C _submodules/vscode-hacker-terminal-enhanced test-e2e`)}`,
  ),
];

console.log(
  [
    header,
    [section('STACK', 'compose services + live probes'), ...stack].join('\n'),
    [
      section('EXTENSIONS', 'package version vs installed in code-server'),
      ...extensionTable,
      ...(existsSync(EXTENSIONS)
        ? []
        : [dim(italic('  no extensions directory yet — run make install-code-server'))]),
    ].join('\n'),
    [section('PATHS', 'files the harness writes to'), ...paths].join('\n'),
    [section('OPEN', 'URLs last — the tail is what matters'), ...open].join('\n'),
    [section('NEXT', 'common commands'), ...next].join('\n'),
  ].join('\n\n'),
);
