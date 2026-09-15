import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { cancelInvestigation } from '../src/services/investigationLifecycle';

// Explicit disposable database only. Missing configuration fails, never silently skips.
test('cancellation lifecycle on disposable PostgreSQL', async () => {
  const url = process.env.PGSTAT_LIFECYCLE_TEST_URL;
  assert.ok(url, 'PGSTAT_LIFECYCLE_TEST_URL must identify a fresh disposable database');
  const pool = new Pool({ connectionString: url, max: 4 });
  try {
    // Fail on existing schemas: this harness must never reset an existing database.
    await pool.query('create schema control');
    await pool.query('create table control.instance_inventory (instance_pk bigint primary key)');
    await pool.query(await readFile('../db/migrations/V120__ai_investigation_and_telemetry_improvement.sql', 'utf8'));
    const create = async (status: string) => (await pool.query(
      `insert into agent.investigation (question, time_from, time_to, status)
       values ('test', now() - interval '1 hour', now(), $1) returning investigation_id`, [status])).rows[0].investigation_id;

    for (const state of ['queued', 'planning', 'collecting_evidence', 'interpreting']) {
      const id = await create(state);
      const results = await Promise.all(Array.from({ length: 8 }, () => cancelInvestigation(pool, id)));
      assert.ok(results.every(result => result.outcome === 'cancelled'));
      assert.equal(new Set(results.map(result => result.investigation.completed_at.toISOString())).size, 1);
      const messages = await pool.query('select count(*)::int as n from agent.investigation_message where investigation_id = $1', [id]);
      assert.equal(messages.rows[0].n, 1, 'concurrent retries create exactly one cancellation message');
    }
    for (const state of ['completed', 'insufficient_evidence', 'failed', 'timed_out']) {
      const id = await create(state);
      assert.equal((await cancelInvestigation(pool, id)).outcome, 'terminal');
      const row = (await pool.query('select status, completed_at from agent.investigation where investigation_id = $1', [id])).rows[0];
      assert.equal(row.status, state);
      assert.equal(row.completed_at, null, 'cancellation must not change terminal timestamps');
    }
    assert.equal((await cancelInvestigation(pool, '9223372036854775807')).outcome, 'not_found');

    // An audit-message insert failure must roll back the status transition too.
    const id = await create('queued');
    await pool.query("alter table agent.investigation_message add constraint test_reject_system check (role <> 'system') not valid");
    await assert.rejects(cancelInvestigation(pool, id));
    assert.equal((await pool.query('select status from agent.investigation where investigation_id = $1', [id])).rows[0].status, 'queued');
  } finally {
    await pool.end();
  }
});
