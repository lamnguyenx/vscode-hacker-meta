#!/usr/bin/env bun
/**
 * Documentation contract for the meta repo and every submodule:
 *
 *   - every docs/important/**\/*.md is linked from that repo's README;
 *   - every docs/important doc starts with an H1;
 *   - every relative Markdown link in README + docs/important resolves;
 *   - every `path#anchor` points at a heading that exists.
 *
 * Run with `make check-docs`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const LINK_RE = /(!?\[[^\]]*\]\()([^)\s]+)([^)]*)\)/g;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

type Problem = { file: string; line: number; message: string };

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function stripFences(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/gu, '')
    .replace(/\s/g, '-');
}

const anchorCache = new Map<string, Set<string>>();

function anchors(path: string): Set<string> {
  const cached = anchorCache.get(path);
  if (cached) return cached;
  const counts = new Map<string, number>();
  const result = new Set<string>();
  for (const line of stripFences(read(path)).split('\n')) {
    const match = HEADING_RE.exec(line);
    if (!match) continue;
    const base = slug(match[2]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorCache.set(path, result);
  return result;
}

function checkRepo(repo: string): Problem[] {
  const problems: Problem[] = [];
  const readme = join(repo, 'README.md');
  const readmeText = read(readme);
  const docs = walk(join(repo, 'docs', 'important')).sort();

  for (const doc of docs) {
    const rel = relative(repo, doc).replaceAll('\\', '/');
    if (!readmeText.includes(`](${rel})`) && !readmeText.includes(`](${rel}#`)) {
      problems.push({ file: 'README.md', line: 0, message: `not indexed: ${rel}` });
    }
    const text = read(doc);
    if (!/^# /m.test(text)) {
      problems.push({ file: rel, line: 1, message: 'missing H1 title' });
    }
  }

  const files = [readme, ...docs];
  for (const file of files) {
    const text = read(file);
    for (const match of text.matchAll(LINK_RE)) {
      let target = match[2];
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      if (!target || /^(#|https?:\/\/|mailto:|tel:|data:)/.test(target)) continue;
      const hashAt = target.indexOf('#');
      const queryAt = target.indexOf('?');
      const cut = hashAt === -1 ? (queryAt === -1 ? target.length : queryAt) : hashAt;
      const rawPath = target.slice(0, cut);
      const fragmentPart = hashAt === -1 ? '' : target.slice(hashAt + 1);
      if (!rawPath) continue;
      let decoded = rawPath;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {}
      if (decoded.startsWith('/')) continue;
      const dest = resolve(dirname(file), decoded);
      if (!existsSync(dest)) {
        problems.push({
          file: relative(repo, file).replaceAll('\\', '/'),
          line: lineOf(text, match.index ?? 0),
          message: `missing link target: ${target}`,
        });
        continue;
      }
      if (fragmentPart && statSync(dest).isFile() && dest.endsWith('.md')) {
        if (!anchors(dest).has(fragmentPart)) {
          problems.push({
            file: relative(repo, file).replaceAll('\\', '/'),
            line: lineOf(text, match.index ?? 0),
            message: `missing anchor: ${target}`,
          });
        }
      }
    }
  }
  return problems;
}

const repos = [root];
const submodules = join(root, '_submodules');
if (existsSync(submodules) && statSync(submodules).isDirectory()) {
  for (const entry of readdirSync(submodules, { withFileTypes: true })) {
    if (entry.isDirectory()) repos.push(join(submodules, entry.name));
  }
}

let total = 0;
for (const repo of repos) {
  if (!existsSync(join(repo, 'README.md'))) continue;
  const problems = checkRepo(repo);
  const label = relative(root, repo) || '.';
  if (problems.length === 0) {
    console.log(`✓ ${label}`);
  } else {
    for (const problem of problems) {
      const where = problem.line ? `${problem.file}:${problem.line}` : problem.file;
      console.error(`✗ ${label}/${where}: ${problem.message}`);
    }
  }
  total += problems.length;
}

if (total > 0) {
  console.error(`\n${total} documentation problem(s)`);
  process.exit(1);
}
console.log('\nAll documentation checks passed.');
