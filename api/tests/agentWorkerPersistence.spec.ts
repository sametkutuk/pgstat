import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { recordToolEvidence, recordToolFailure } from '../src/services/agentEvidenceAudit';
import { completeInvestigation } from '../src/services/investigationCompletion';
import { cancelInvestigation } from '../src/services/investigationLifecycle';

test('worker evidence and answer remain scoped, referenced and cancellation-safe on PostgreSQL', async () => {
  const url = process.env.PGSTAT_WORKER_PERSISTENCE_TEST_URL;
  assert.ok(url, 'PGSTAT_WORKER_PERSISTENCE_TEST_URL must identify a fresh disposable database');
  const db = new Pool({ connectionString: url, max: 6 });
  try {
    await db.query('create schema control');
    await db.query('create table control.instance_inventory (instance_pk bigint primary key)');
    for (const version of [120, 123, 124]) {
      const file = version === 120 ? 'V120__ai_investigation_and_telemetry_improvement.sql'
        : version === 123 ? 'V123__investigation_worker_claim.sql'
          : 'V124__agent_evidence_snapshot_and_result_reason.sql';
      await db.query(await readFile(`../db/migrations/${file}`, 'utf8'));
    }
    await db.query('insert into control.instance_inventory values (1), (2)');
    const create = async (state: string) => (await db.query(
      `insert into agent.investigation
       (question, instance_pk, time_from, time_to, status, claimed_by)
       values ('Test', 1, '2026-09-14', '2026-09-15', $1, 'worker-test')
       returning investigation_id`, [state])).rows[0].investigation_id as string;
    const envelope = {
      schema_version: '1.0.0', capability: 'autovacuum_overview', status: 'ok',
      target: { instance_pk: 1 },
      requested_range: { from: '2026-09-14T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' },
      data: { activity: { autovacuum_count: '2' } }, coverage: [], limitations: [], gap_candidates: [],
    };
    const id = await create('collecting_evidence');
    const failedCall = await recordToolFailure(db, { investigationId: id, workerId: 'worker-test',
      toolName: 'get_telemetry_coverage', code: 'MCP_TOOL_FAILED', durationMs: 12 });
    assert.equal((await db.query('select status, error_code from agent.investigation_tool_call where tool_call_id=$1',
      [failedCall.tool_call_id])).rows[0].error_code, 'MCP_TOOL_FAILED');
    assert.equal((await db.query('select count(*)::int as n from agent.investigation_evidence')).rows[0].n, 0,
      'tool failure is audit only, never fabricated evidence');
    await assert.rejects(recordToolEvidence(db, { investigationId: id, workerId: 'worker-test',
      toolName: 'get_autovacuum_overview', envelope: { ...envelope, target: { instance_pk: 2 } }, durationMs: 1 }),
      /EVIDENCE_SCOPE_INVALID/);
    await assert.rejects(recordToolEvidence(db, { investigationId: id, workerId: 'worker-test',
      toolName: 'get_autovacuum_overview', envelope: { ...envelope, password: 'should never store' }, durationMs: 1 }),
      /SENSITIVE_EVIDENCE_REJECTED/);
    const stored = await recordToolEvidence(db, { investigationId: id, workerId: 'worker-test',
      toolName: 'get_autovacuum_overview', envelope, durationMs: 7 });
    const snapshot = (await db.query('select envelope, sha256_hex, response_bytes from agent.investigation_evidence where evidence_id = $1',
      [stored.evidence_id])).rows[0];
    assert.equal(snapshot.envelope.data.activity.autovacuum_count, '2');
    assert.equal(snapshot.sha256_hex, stored.sha256_hex);
    assert.ok(snapshot.response_bytes > 0);
    const call = (await db.query('select coverage_state from agent.investigation_tool_call where tool_call_id = $1',
      [stored.tool_call_id])).rows[0];
    assert.equal(call.coverage_state, 'complete');
    await db.query("update agent.investigation set status = 'interpreting' where investigation_id = $1", [id]);
    const answer = { conclusion: 'Pencere içinde iki autovacuum sayacı gözlendi; sorun kesin değil.',
      confidence: 'low' as const, confidence_reason: 'Örnekleme ve tablo kapsamı sınırlı.',
      observed_facts: [{ text: 'İki sayaç artışı', evidence_id: stored.evidence_id }],
      interpretations: ['Sayaçlar aktiviteyi gösterir.'], hypotheses: ['Eşik sorunu olabilir.'],
      limitations: ['Nedensellik kanıtlanmadı.'] };
    await assert.rejects(completeInvestigation(db, id, 'worker-test',
      { ...answer, observed_facts: [{ text: 'Uydurma referans', evidence_id: '9223372036854775807' }] }, 5, 3),
      /FACT_EVIDENCE_NOT_IN_INVESTIGATION/);
    assert.equal((await db.query('select count(*)::int as n from agent.investigation_result')).rows[0].n, 0);
    const completed = await completeInvestigation(db, id, 'worker-test', answer, 5, 3);
    assert.deepEqual(completed, { outcome: 'completed', status: 'completed' });
    assert.equal((await cancelInvestigation(db, id)).outcome, 'terminal');
    const final = (await db.query('select status, input_tokens, output_tokens from agent.investigation where investigation_id = $1', [id])).rows[0];
    assert.equal(final.status, 'completed');
    assert.equal(final.input_tokens, 5);
    assert.equal(final.output_tokens, 3);

    const cancelledId = await create('collecting_evidence');
    assert.equal((await cancelInvestigation(db, cancelledId)).outcome, 'cancelled');
    await assert.rejects(recordToolEvidence(db, { investigationId: cancelledId, workerId: 'worker-test',
      toolName: 'get_autovacuum_overview', envelope, durationMs: 2 }), /INVESTIGATION_SUPERSEDED/);
    await assert.rejects(recordToolFailure(db, { investigationId: cancelledId, workerId: 'worker-test',
      toolName: 'get_autovacuum_overview', code: 'MCP_TOOL_FAILED', durationMs: 2 }), /INVESTIGATION_SUPERSEDED/);
    assert.deepEqual(await completeInvestigation(db, cancelledId, 'worker-test', answer, null, null), { outcome: 'superseded' });
    assert.equal((await db.query('select status from agent.investigation where investigation_id = $1', [cancelledId])).rows[0].status, 'cancelled');
    const insufficientId = await create('interpreting');
    assert.deepEqual(await completeInvestigation(db, insufficientId, 'worker-test',
      { ...answer, observed_facts: [] }, null, null), { outcome: 'completed', status: 'insufficient_evidence' });
  } finally { await db.end(); }
});
