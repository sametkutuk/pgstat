import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const boardPath = path.join(root, 'docs', 'project-board.json');

const STATUSES = new Set([
  'planned',
  'in_progress',
  'codex_verified',
  'customer_validation',
  'done',
  'blocked',
]);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const AC_STATUSES = new Set(['pending', 'done', 'blocked', 'not_required']);

function fail(message) {
  console.error(`project-board: ${message}`);
  process.exitCode = 1;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function relExists(file) {
  return fs.existsSync(path.join(root, file));
}

function main() {
  if (!fs.existsSync(boardPath)) {
    fail('docs/project-board.json is missing');
    return;
  }

  let board;
  try {
    board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  } catch (err) {
    fail(`invalid JSON: ${err.message}`);
    return;
  }

  if (board.schema_version !== '1.0') fail('schema_version must be 1.0');
  if (!hasItems(board.tasks)) fail('tasks must be a non-empty array');

  const ids = new Set();
  const inProgress = [];

  for (const task of board.tasks ?? []) {
    const label = task.id || '<missing id>';
    if (!/^PGSTAT-P[0-3]-\d{3}$/.test(label)) fail(`${label}: id must match PGSTAT-Px-000`);
    if (ids.has(label)) fail(`${label}: duplicate id`);
    ids.add(label);

    if (!Number.isInteger(task.order) || task.order < 0) fail(`${label}: order must be a non-negative integer`);
    if (!PRIORITIES.has(task.priority)) fail(`${label}: invalid priority`);
    if (!STATUSES.has(task.status)) fail(`${label}: invalid status`);
    if (task.status === 'in_progress') inProgress.push(label);

    for (const field of ['workstream', 'title', 'problem', 'next_action']) {
      if (!hasText(task[field])) fail(`${label}: ${field} is required`);
    }
    for (const field of ['requirements', 'acceptance_criteria', 'implementation_plan', 'verification_plan', 'required_docs']) {
      if (!hasItems(task[field])) fail(`${label}: ${field} must be a non-empty array`);
    }

    for (const ac of task.acceptance_criteria ?? []) {
      if (!hasText(ac.id) || !hasText(ac.text)) fail(`${label}: each acceptance criterion needs id and text`);
      if (!AC_STATUSES.has(ac.status)) fail(`${label}: acceptance criterion ${ac.id} has invalid status`);
    }

    for (const doc of task.required_docs ?? []) {
      if (!hasText(doc)) fail(`${label}: required_docs contains an empty value`);
      if (!doc.includes('*') && !relExists(doc)) fail(`${label}: required doc does not exist: ${doc}`);
    }

    for (const dep of task.dependencies ?? []) {
      if (!/^PGSTAT-P[0-3]-\d{3}$/.test(dep)) fail(`${label}: invalid dependency id ${dep}`);
    }

    const customer = task.customer_acceptance ?? {};
    if (typeof customer.required !== 'boolean') fail(`${label}: customer_acceptance.required must be boolean`);
    if (!hasText(customer.status)) fail(`${label}: customer_acceptance.status is required`);

    if (task.status === 'done') {
      const unfinished = (task.acceptance_criteria ?? []).filter((ac) => ac.status !== 'done' && ac.status !== 'not_required');
      if (unfinished.length) fail(`${label}: done task has unfinished acceptance criteria`);
      if (!hasItems(task.verification_evidence)) fail(`${label}: done task needs verification_evidence`);
      if (customer.required && customer.status !== 'accepted') fail(`${label}: done task needs accepted customer gate`);
      if (!customer.required && customer.status !== 'not_required') fail(`${label}: done task without customer gate must use status not_required`);
      if (!hasText(task.completed_at)) fail(`${label}: done task needs completed_at`);
    }
  }

  const max = Number(board.project?.max_in_progress ?? 1);
  if (inProgress.length > max) fail(`too many in_progress tasks: ${inProgress.join(', ')}; max=${max}`);

  for (const task of board.tasks ?? []) {
    for (const dep of task.dependencies ?? []) {
      if (!ids.has(dep)) fail(`${task.id}: dependency does not exist: ${dep}`);
    }
  }

  const byId = new Map((board.tasks ?? []).map((task) => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  function visit(task, path = []) {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) {
      fail(`dependency cycle detected: ${[...path, task.id].join(' -> ')}`);
      return;
    }
    visiting.add(task.id);
    for (const depId of task.dependencies ?? []) {
      const dep = byId.get(depId);
      if (dep) visit(dep, [...path, task.id]);
    }
    visiting.delete(task.id);
    visited.add(task.id);
  }
  for (const task of board.tasks ?? []) visit(task);

  for (const task of board.tasks ?? []) {
    if (task.status !== 'in_progress') continue;
    const openDeps = (task.dependencies ?? []).filter((depId) => byId.get(depId)?.status !== 'done');
    if (openDeps.length) fail(`${task.id}: in_progress task has unfinished dependencies: ${openDeps.join(', ')}`);
  }

  if (process.exitCode) return;
  console.log(`project-board: ok (${board.tasks.length} tasks, ${inProgress.length} in progress)`);
}

main();
