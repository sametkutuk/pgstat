import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../config/database';

export const GAP_TYPES = ['DATA_NOT_COLLECTED', 'DATA_INSUFFICIENT', 'MCP_FUNCTION_MISSING'] as const;
export type GapType = typeof GAP_TYPES[number];

export const TECHNICAL_REASONS = [
  'STALE_DATA', 'TOO_FEW_SAMPLES', 'RETENTION_TOO_SHORT', 'CAPABILITY_UNKNOWN',
  'UNSUPPORTED_VERSION', 'COLLECTION_FAILED', 'API_FAILED', 'TOOL_NOT_AVAILABLE',
] as const;
export type TechnicalReason = typeof TECHNICAL_REASONS[number];

export interface ImprovementReport {
  investigationId: string;
  gapType: GapType;
  technicalReason?: TechnicalReason;
  requestedCapability: string;
  title: string;
  simpleReason: string;
  requestedText: string;
  availableText: string;
  missingText: string;
  reasonText: string;
  toolCallId?: string;
  coverageSummary?: Record<string, unknown>;
}

function normalizedCapability(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function dedupKey(gapType: GapType, capability: string, investigationType: string,
                  pgMajor: number | null, reason?: TechnicalReason): string {
  // A missing API function is the same product gap on every instance. Split by
  // PG major only when the version itself is the verified incompatibility.
  const scope = reason === 'UNSUPPORTED_VERSION' ? pgMajor ?? 'unknown' : 'all_versions';
  const semanticKey = [gapType, normalizedCapability(capability), investigationType, scope].join('|');
  return createHash('sha256').update(semanticKey).digest('hex');
}

async function verifyToolCall(client: PoolClient, investigationId: string, toolCallId?: string): Promise<void> {
  if (toolCallId === undefined) return;
  const result = await client.query(
    `select 1 from agent.investigation_tool_call
     where tool_call_id = $1 and investigation_id = $2`,
    [toolCallId, investigationId],
  );
  if (result.rowCount === 0) throw new Error('TOOL_CALL_NOT_IN_INVESTIGATION');
}

/**
 * Store one evidence-backed product gap. The caller cannot choose the dedup key.
 * Replaying the same gap for the same investigation is idempotent.
 */
export async function reportTelemetryImprovement(report: ImprovementReport) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const investigation = await client.query(
      `select i.investigation_type, i.instance_pk, c.pg_major
       from agent.investigation i
       left join control.instance_capability c on c.instance_pk = i.instance_pk
       where i.investigation_id = $1`,
      [report.investigationId],
    );
    if (investigation.rowCount === 0) throw new Error('INVESTIGATION_NOT_FOUND');
    await verifyToolCall(client, report.investigationId, report.toolCallId);

    const context = investigation.rows[0];
    const key = dedupKey(report.gapType, report.requestedCapability,
      context.investigation_type, context.pg_major, report.technicalReason);
    const improvement = await client.query(
      `insert into agent.telemetry_improvement
         (dedup_key, gap_type, technical_reason, requested_capability, title, simple_reason)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (dedup_key) do update
         set updated_at = agent.telemetry_improvement.updated_at
       returning improvement_id`,
      [key, report.gapType, report.technicalReason ?? null, report.requestedCapability,
       report.title, report.simpleReason],
    );
    const improvementId = improvement.rows[0].improvement_id;
    const occurrence = await client.query(
      `insert into agent.telemetry_improvement_occurrence
         (improvement_id, investigation_id, instance_pk, pg_major, requested_text,
          available_text, missing_text, reason_text, tool_call_id, coverage_summary)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       on conflict (improvement_id, investigation_id) do nothing
       returning occurrence_id`,
      [improvementId, report.investigationId, context.instance_pk, context.pg_major,
       report.requestedText, report.availableText, report.missingText, report.reasonText,
       report.toolCallId ?? null, JSON.stringify(report.coverageSummary ?? {})],
    );
    if (occurrence.rowCount === 1) {
      await client.query(
        `update agent.telemetry_improvement
         set occurrence_count = occurrence_count + 1,
             last_detected_at = now(), updated_at = now(),
             status = case when status = 'resolved' then 'review_required' else status end,
             resolved_at = case when status = 'resolved' then null else resolved_at end
         where improvement_id = $1`, [improvementId],
      );
    }
    // Read on the transaction's connection before committing. Acquiring another
    // pool connection while holding this one can exhaust the pool under load.
    const stored = await client.query(
      `select * from agent.telemetry_improvement where improvement_id = $1`, [improvementId]);
    await client.query('commit');
    return { improvement: stored.rows[0], new_occurrence: occurrence.rowCount === 1 };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
