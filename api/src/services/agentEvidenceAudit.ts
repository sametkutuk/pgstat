import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export const TOOL_CAPABILITIES: Record<string, string> = {
  find_instance: 'find_instance',
  get_telemetry_coverage: 'telemetry_coverage',
  get_autovacuum_overview: 'autovacuum_overview',
  find_tables_needing_vacuum_attention: 'vacuum_candidates',
  get_table_vacuum_evidence: 'table_vacuum_evidence',
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function forbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenField);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) =>
      /password|api.?key|secret|query.?text|connection.?string|credential/i.test(key) || forbiddenField(item));
  }
  return false;
}

export interface ToolEvidenceInput {
  investigationId: string;
  workerId: string;
  toolName: keyof typeof TOOL_CAPABILITIES;
  envelope: Record<string, unknown>;
  durationMs: number;
}

export async function recordToolEvidence(database: Pool, input: ToolEvidenceInput) {
  if (input.toolName === 'find_instance') throw new Error('INSTANCE_DISCOVERY_NOT_SNAPSHOTTED');
  if (forbiddenField(input.envelope)) throw new Error('SENSITIVE_EVIDENCE_REJECTED');
  const serialized = JSON.stringify(canonical(input.envelope));
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes < 1 || bytes > 131072) throw new Error('EVIDENCE_TOO_LARGE');
  if (input.envelope.schema_version !== '1.0.0'
      || input.envelope.capability !== TOOL_CAPABILITIES[input.toolName]
      || !Array.isArray(input.envelope.coverage) || !Array.isArray(input.envelope.limitations)
      || !Array.isArray(input.envelope.gap_candidates)) throw new Error('EVIDENCE_SCHEMA_INVALID');

  const client = await database.connect();
  try {
    await client.query('begin');
    const context = await client.query(
      `select instance_pk, time_from, time_to from agent.investigation
       where investigation_id = $1 and claimed_by = $2 and status = 'collecting_evidence'
       for update`, [input.investigationId, input.workerId]);
    const row = context.rows[0];
    if (!row) throw new Error('INVESTIGATION_SUPERSEDED');
    const target = input.envelope.target as { instance_pk?: unknown } | null;
    const range = input.envelope.requested_range as { from?: unknown; to?: unknown } | null;
    if (!target || String(target.instance_pk) !== String(row.instance_pk)
        || !range || typeof range.from !== 'string' || typeof range.to !== 'string'
        || Date.parse(range.from) !== (row.time_from as Date).getTime()
        || Date.parse(range.to) !== (row.time_to as Date).getTime()) throw new Error('EVIDENCE_SCOPE_INVALID');
    const status = String(input.envelope.status);
    if (!['ok', 'partial', 'no_data', 'not_collected', 'unsupported_version',
      'unknown_capability', 'stale', 'insufficient_samples', 'failed'].includes(status)) {
      throw new Error('EVIDENCE_STATUS_INVALID');
    }
    const coverageState = status === 'ok' ? 'complete' : status;
    const call = await client.query(
      `insert into agent.investigation_tool_call
        (investigation_id, tool_name, status, coverage_state, result_bytes, completed_at, duration_ms)
       values ($1, $2, 'succeeded', $3, $4, now(), $5) returning tool_call_id`,
      [input.investigationId, input.toolName, coverageState, bytes, input.durationMs]);
    const evidence = await client.query(
      `insert into agent.investigation_evidence
        (investigation_id, tool_call_id, envelope, sha256_hex, response_bytes)
       values ($1, $2, $3::jsonb, $4, $5) returning evidence_id`,
      [input.investigationId, call.rows[0].tool_call_id, serialized,
        createHash('sha256').update(serialized).digest('hex'), bytes]);
    await client.query('commit');
    return { tool_call_id: call.rows[0].tool_call_id, evidence_id: evidence.rows[0].evidence_id,
      sha256_hex: createHash('sha256').update(serialized).digest('hex') };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

/** A failed tool call is an operational audit event, never gap evidence. */
export async function recordToolFailure(database: Pool, input: {
  investigationId: string; workerId: string; toolName: string;
  code: string; durationMs: number;
}) {
  const client = await database.connect();
  try {
    await client.query('begin');
    const owned = await client.query(`select 1 from agent.investigation
      where investigation_id=$1 and claimed_by=$2 and status='collecting_evidence'
      for update`, [input.investigationId, input.workerId]);
    if (!owned.rowCount) throw new Error('INVESTIGATION_SUPERSEDED');
    const inserted = await client.query(`insert into agent.investigation_tool_call
      (investigation_id, tool_name, status, coverage_state, error_code, completed_at, duration_ms)
      values ($1,$2,'failed','failed',$3,now(),$4) returning tool_call_id`,
    [input.investigationId, input.toolName, input.code, input.durationMs]);
    await client.query('commit');
    return { tool_call_id: String(inserted.rows[0].tool_call_id), status: 'failed' };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}
