import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { listImprovements } from '../src/services/improvementList';

test('improvement summaries retain one coherent latest occurrence and page deterministically', async () => {
  const url = process.env.PGSTAT_IMPROVEMENT_TEST_URL;
  assert.ok(url, 'A fresh disposable PGSTAT_IMPROVEMENT_TEST_URL is required');
  const database = new Pool({ connectionString: url });
  try {
    await database.query('create schema control');
    await database.query('create table control.instance_inventory (instance_pk bigint primary key)');
    await database.query(await readFile('../db/migrations/V120__ai_investigation_and_telemetry_improvement.sql', 'utf8'));
    await database.query('insert into control.instance_inventory values (1), (2)');
    await database.query(`insert into agent.investigation (question, instance_pk, time_from, time_to)
      select 'question', n, now() - interval '1 hour', now() from generate_series(1, 2) n`);
    await database.query(`insert into agent.telemetry_improvement
      (dedup_key, gap_type, requested_capability, title, simple_reason, last_detected_at)
      select n::text, 'DATA_NOT_COLLECTED', 'vacuum.test', 'Test', 'Fallback', '2026-01-01'
      from generate_series(1, 3) n`);
    await database.query(`update agent.telemetry_improvement set status = 'accepted' where improvement_id = 3`);
    await database.query(`insert into agent.telemetry_improvement_occurrence
      (improvement_id, investigation_id, instance_pk, requested_text, available_text, missing_text, reason_text, detected_at)
      values (2, 1, 1, 'old request', 'old available', 'old missing', 'old reason', '2026-01-01'),
             (2, 2, 2, 'new request', 'new available', 'new missing', 'new reason', '2026-01-01')`);
    const rows = await listImprovements(database, null, 50, 0);
    assert.deepEqual(rows.map(row => row.improvement_id), ['2', '1', '3']);
    assert.equal(rows[0].affected_investigations, 2);
    assert.equal(rows[0].affected_instances, 2);
    assert.equal(rows[0].latest_investigation_id, '2');
    for (const field of ['requested_text', 'available_text', 'missing_text', 'reason_text']) {
      assert.ok(rows[0][field].startsWith('new '), field);
      assert.equal(rows[1][field], null, 'missing occurrence is not invented');
    }
    assert.equal(rows[1].affected_investigations, 0);
    assert.deepEqual((await listImprovements(database, null, 1, 1)).map(row => row.improvement_id), ['1']);
    assert.deepEqual((await listImprovements(database, 'accepted', 50, 0)).map(row => row.improvement_id), ['3']);
    assert.deepEqual(await listImprovements(database, null, 50, 3), []);
  } finally {
    await database.end();
  }
});
