import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';

test('verified missing semantic function deduplicates across instances and PG majors', async () => {
  const url = process.env.PGSTAT_VERIFIED_GAP_TEST_URL;
  assert.ok(url, 'PGSTAT_VERIFIED_GAP_TEST_URL must name a fresh disposable database');
  const parsed = new URL(url);
  process.env.PGSTAT_DB_HOST = parsed.hostname;
  process.env.PGSTAT_DB_PORT = parsed.port;
  process.env.PGSTAT_DB_NAME = parsed.pathname.slice(1);
  process.env.PGSTAT_DB_USER = decodeURIComponent(parsed.username);
  process.env.PGSTAT_DB_PASSWORD = decodeURIComponent(parsed.password);
  const fixture = new Pool({ connectionString: url });
  let applicationPool: Pool | undefined;
  try {
    await fixture.query('create schema control');
    await fixture.query('create table control.instance_inventory (instance_pk bigint primary key)');
    await fixture.query('create table control.instance_capability (instance_pk bigint primary key, pg_major int)');
    for (const file of ['V120__ai_investigation_and_telemetry_improvement.sql',
      'V123__investigation_worker_claim.sql', 'V124__agent_evidence_snapshot_and_result_reason.sql']) {
      await fixture.query(await readFile(`../db/migrations/${file}`, 'utf8'));
    }
    await fixture.query('insert into control.instance_inventory values (1), (2)');
    await fixture.query('insert into control.instance_capability values (1, 14), (2, 18)');
    await fixture.query(`insert into agent.investigation
      (question, instance_pk, time_from, time_to, status, claimed_by)
      select 'Query impact?', n, '2026-09-14', '2026-09-15', 'interpreting', 'worker-test'
      from generate_series(1, 2) n`);
    await fixture.query(`insert into agent.investigation_tool_call
      (investigation_id, tool_name, status) values
      (1, 'get_telemetry_coverage', 'succeeded'), (2, 'get_telemetry_coverage', 'succeeded')`);
    await fixture.query(`insert into agent.investigation_evidence
      (investigation_id, tool_call_id, envelope, sha256_hex, response_bytes)
      select n, n, jsonb_build_object('capability','telemetry_coverage',
        'data',jsonb_build_object('pg_stat_statements',jsonb_build_object('status','available')),
        'gap_candidates','[]'::jsonb), repeat('a',64), 100
      from generate_series(1,2) n`);
    const [{ persistRequestedCapabilityGaps }, { pool }] = await Promise.all([
      import('../src/services/verifiedCapabilityGap'), import('../src/config/database')]);
    applicationPool = pool;
    const first = await persistRequestedCapabilityGaps(pool, '1', 'worker-test', ['query_performance_evidence']);
    assert.equal(first.length, 1);
    assert.equal(first[0].new_occurrence, true);
    const replay = await persistRequestedCapabilityGaps(pool, '1', 'worker-test', ['query_performance_evidence']);
    assert.equal(replay[0].new_occurrence, false);
    const second = await persistRequestedCapabilityGaps(pool, '2', 'worker-test', ['query_performance_evidence']);
    assert.equal(second[0].new_occurrence, true);
    assert.equal(first[0].improvement.improvement_id, second[0].improvement.improvement_id);
    const item = (await fixture.query('select gap_type, occurrence_count from agent.telemetry_improvement')).rows;
    assert.equal(item.length, 1);
    assert.equal(item[0].gap_type, 'MCP_FUNCTION_MISSING');
    assert.equal(item[0].occurrence_count, 2);
    const occurrences = (await fixture.query('select investigation_id, instance_pk from agent.telemetry_improvement_occurrence')).rows;
    assert.deepEqual(occurrences.map(row => row.instance_pk).sort(), ['1', '2']);
    await fixture.query(`insert into agent.investigation
      (question, instance_pk, time_from, time_to, status, claimed_by)
      values ('Why no metrics?', 1, '2026-09-14', '2026-09-15', 'interpreting', 'worker-test')`);
    await fixture.query(`insert into agent.investigation_tool_call
      (investigation_id, tool_name, status) values (3, 'get_telemetry_coverage', 'succeeded')`);
    await fixture.query(`insert into agent.investigation_evidence
      (investigation_id, tool_call_id, envelope, sha256_hex, response_bytes)
      values (3, 3, '{"capability":"telemetry_coverage","status":"failed",
        "data":{"pg_stat_statements":{"status":"collection_failed"}}}'::jsonb,
        repeat('b',64), 100)`);
    await assert.rejects(persistRequestedCapabilityGaps(pool, '3', 'worker-test',
      ['query_performance_evidence']), /COVERAGE_NOT_VERIFIED/);
    await fixture.query(`insert into agent.investigation
      (question, instance_pk, time_from, time_to, status, claimed_by)
      values ('Permission?', 1, '2026-09-14', '2026-09-15', 'interpreting', 'worker-test')`);
    await fixture.query(`insert into agent.investigation_tool_call
      (investigation_id, tool_name, status) values (4, 'get_telemetry_coverage', 'succeeded')`);
    await fixture.query(`insert into agent.investigation_evidence
      (investigation_id, tool_call_id, envelope, sha256_hex, response_bytes)
      values (4, 4, '{"capability":"telemetry_coverage","status":"partial",
        "data":{"pg_stat_statements":{"status":"permission_denied"}}}'::jsonb,
        repeat('c',64), 100)`);
    await assert.rejects(persistRequestedCapabilityGaps(pool, '4', 'worker-test',
      ['query_performance_evidence']), /PGSS_COVERAGE_NOT_VERIFIED/);
    await assert.rejects(fixture.query("update agent.investigation_evidence set response_bytes=101 where investigation_id=4"),
      /append-only/);
    assert.equal((await fixture.query('select count(*)::int as n from agent.telemetry_improvement'))
      .rows[0].n, 1, 'temporary errors and permissions must not become product cards');
    await fixture.query("update agent.investigation set status = 'cancelled' where investigation_id = 2");
    await assert.rejects(persistRequestedCapabilityGaps(pool, '2', 'worker-test', ['compare_periods']),
      /INVESTIGATION_SUPERSEDED/);
    const third = (await fixture.query('select count(*)::int as n from agent.telemetry_improvement')).rows[0].n;
    assert.equal(third, 1);
  } finally {
    if (applicationPool) await applicationPool.end();
    await fixture.end();
  }
});
