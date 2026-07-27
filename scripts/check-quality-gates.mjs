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
// ui (eslint) only lints the changed files (see buildLayerCommands) and is
// non-blocking (see `blocking: false` below): the UI has substantial
// pre-existing lint debt (mostly @typescript-eslint/no-explicit-any and a
// react-hooks/purity rule) accumulated file-by-file before this gate existed.
// ESLint reports per-file, not per-line-of-diff, so touching one line in an
// already-noisy file still surfaces that file's full pre-existing error count.
// Blocking on that would make unrelated one-line changes unpushable until the
// whole file's debt is paid down. tsc stays blocking (type errors are a
// correctness signal, not accumulated style debt) and mvn test stays blocking.
// Track paying down the eslint debt as its own board task, not as a side
// effect of unrelated pushes.
const LAYERS = [
  {
    name: 'collector (mvn test)',
    match: /^collector\/(src\/|pom\.xml)/,
    cwd: 'collector',
    tool: 'mvn',
    cmd: ['mvn', '-q', 'test'],
    blocking: true,
  },
  {
    name: 'api (tsc --noEmit)',
    match: /^api\/(src\/|package\.json|tsconfig)/,
    cwd: 'api',
    tool: 'npx',
    cmd: ['npx', 'tsc', '--noEmit'],
    blocking: true,
  },
  {
    name: 'ui (tsc -b)',
    match: /^ui\/(src\/|package\.json|tsconfig|vite\.config)/,
    cwd: 'ui',
    tool: 'npx',
    cmd: ['npx', 'tsc', '-b'],
    blocking: true,
  },
  {
    name: 'ui (eslint changed files)',
    match: /^ui\/src\/.*\.(ts|tsx)$/,
    cwd: 'ui',
    tool: 'npx',
    cmd: null, // built per-run from the matched files, see buildLayerCommands
    blocking: false,
  },
];

// ui (eslint changed files) needs the actual matched file list, not a fixed
// cmd array — build it here instead of hardcoding `eslint .` above.
// --all has no changed-file list, so it falls back to linting the whole tree
// (that's the "full check" contract of --all / `make verify`).
function buildLayerCommands(layer, files) {
  if (layer.name !== 'ui (eslint changed files)') return layer.cmd;
  if (!files) return ['npx', 'eslint', '.'];
  const uiFiles = files
    .filter((f) => layer.match.test(f))
    .map((f) => f.replace(/^ui\//, ''));
  return ['npx', 'eslint', ...uiFiles];
}

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
  const cmd = buildLayerCommands(layer, files);
  console.log(`[quality-gates] running ${layer.name}`);
  const result = spawnSync(cmd[0], cmd.slice(1), { cwd, shell: true, stdio: 'inherit' });
  if (result.status !== 0) {
    if (layer.blocking) {
      console.error(`[quality-gates] FAIL ${layer.name}`);
      failed = true;
    } else {
      console.warn(`[quality-gates] WARN ${layer.name} (non-blocking, pre-existing debt) — not blocking this push`);
    }
  }
}

if (failed) {
  console.error('[quality-gates] one or more gates failed; push rejected');
  process.exit(1);
}
console.log('[quality-gates] all gates passed');
