#!/usr/bin/env node
// Local CI replacement (decision: GitHub Actions will not be used, ADR-0002).
// Detects which layers changed and runs only their quality gates:
//   collector/  -> mvn test
//   api/        -> npx tsc --noEmit
//   ui/         -> npx tsc -b && npx eslint .
//
// Usage:
//   node scripts/check-quality-gates.mjs                 # working tree + staged vs HEAD
//   node scripts/check-quality-gates.mjs --base=<ref>    # committed range <ref>..HEAD (pre-push)
//   node scripts/check-quality-gates.mjs --all           # run every gate regardless of diff
//
// Escape hatch for emergencies only (documented in docs/test-strategy.md):
//   PGSTAT_SKIP_GATES=1 git push

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const args = process.argv.slice(2);
const runAll = args.includes('--all');
const baseArg = args.find((a) => a.startsWith('--base='));

if (process.env.PGSTAT_SKIP_GATES === '1') {
  console.warn('[quality-gates] SKIPPED via PGSTAT_SKIP_GATES=1 — use only for emergencies');
  process.exit(0);
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

// Collect changed paths for the requested mode.
function changedFiles() {
  if (baseArg) {
    const base = baseArg.slice('--base='.length);
    return git(`diff --name-only ${base}...HEAD`).split('\n').filter(Boolean);
  }
  // Local mode: staged + unstaged against HEAD.
  return git('diff --name-only HEAD').split('\n').filter(Boolean);
}

// Layer definitions: which paths trigger which command.
const LAYERS = [
  {
    name: 'collector (mvn test)',
    match: /^collector\/(src\/|pom\.xml)/,
    cwd: 'collector',
    tool: 'mvn',
    cmd: ['mvn', '-q', 'test'],
  },
  {
    name: 'api (tsc --noEmit)',
    match: /^api\/(src\/|package\.json|tsconfig)/,
    cwd: 'api',
    tool: 'npx',
    cmd: ['npx', 'tsc', '--noEmit'],
  },
  {
    name: 'ui (tsc -b)',
    match: /^ui\/(src\/|package\.json|tsconfig|vite\.config)/,
    cwd: 'ui',
    tool: 'npx',
    cmd: ['npx', 'tsc', '-b'],
  },
  {
    name: 'ui (eslint)',
    match: /^ui\/(src\/|package\.json|eslint)/,
    cwd: 'ui',
    tool: 'npx',
    cmd: ['npx', 'eslint', '.'],
  },
];

function toolAvailable(tool) {
  const probe = spawnSync(tool, ['--version'], { shell: true, stdio: 'ignore' });
  return probe.status === 0;
}

const files = runAll ? null : changedFiles();
const toRun = runAll ? LAYERS : LAYERS.filter((l) => files.some((f) => l.match.test(f)));

if (!toRun.length) {
  console.log('[quality-gates] no collector/api/ui changes detected; nothing to run');
  process.exit(0);
}

let failed = false;
for (const layer of toRun) {
  const cwd = path.join(repoRoot, layer.cwd);
  if (!existsSync(cwd)) continue;
  if (!toolAvailable(layer.tool)) {
    console.error(`[quality-gates] FAIL ${layer.name}: '${layer.tool}' not found on PATH.`);
    console.error('[quality-gates] Install the toolchain, or for an emergency push: PGSTAT_SKIP_GATES=1');
    failed = true;
    continue;
  }
  console.log(`[quality-gates] running ${layer.name}`);
  const result = spawnSync(layer.cmd[0], layer.cmd.slice(1), { cwd, shell: true, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[quality-gates] FAIL ${layer.name}`);
    failed = true;
  }
}

if (failed) {
  console.error('[quality-gates] one or more gates failed; push rejected');
  process.exit(1);
}
console.log('[quality-gates] all gates passed');
