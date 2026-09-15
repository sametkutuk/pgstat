import type { Pool } from 'pg';
import { reportTelemetryImprovement } from './telemetryImprovement';

export type MissingCapability = 'query_performance_evidence' | 'compare_periods';

/** Model may request one of two known missing semantic functions; API derives the record from stored evidence. */
export async function persistRequestedCapabilityGaps(database: Pool, investigationId: string,
  workerId: string, requested: MissingCapability[]) {
  const context = await database.query(
    `select i.question, e.envelope, e.tool_call_id
     from agent.investigation i
     left join lateral (
       select envelope, tool_call_id from agent.investigation_evidence
       where investigation_id = i.investigation_id
         and envelope->>'capability' = 'telemetry_coverage'
       order by evidence_id desc limit 1
     ) e on true
     where i.investigation_id = $1 and i.claimed_by = $2
       and i.status in ('collecting_evidence', 'interpreting')`, [investigationId, workerId]);
  if (!context.rows[0]) throw new Error('INVESTIGATION_SUPERSEDED');
  const row = context.rows[0];
  if (!row.envelope || !row.tool_call_id) throw new Error('COVERAGE_EVIDENCE_REQUIRED');
  const coverage = row.envelope as { status?: string;
    data?: { pg_stat_statements?: { status?: string } };
    gap_candidates?: { capability?: string; kind?: string; detail_code?: string;
      observed?: string; impact?: string }[] };
  // A failed evidence request is an operational error, not proof of a missing
  // collector metric or MCP function. A privilege/collection failure is likewise
  // not a product backlog item.
  if (coverage.status === 'failed' || coverage.status === 'unknown_capability') {
    throw new Error('COVERAGE_NOT_VERIFIED');
  }
  const pgssRecordedStatus = coverage.data?.pg_stat_statements?.status;
  if (requested.includes('query_performance_evidence')
      && (!pgssRecordedStatus || ['permission_denied', 'collection_failed'].includes(pgssRecordedStatus))) {
    throw new Error('PGSS_COVERAGE_NOT_VERIFIED');
  }
  const output = [];
  for (const capability of new Set(requested)) {
    if (capability === 'query_performance_evidence') {
      const pgss = coverage.data?.pg_stat_statements?.status ?? 'unknown';
      const candidate = coverage.gap_candidates?.find(item => item.capability === capability);
      const missingData = pgss === 'not_installed';
      const unknown = pgss === 'version_unknown';
      const reason = missingData ? 'pgss kurulu değil olarak kaydedilmiş.'
        : unknown ? 'pgss sürümü bilinmiyor.'
          : 'Bu veriyi sunan semantik MCP/API fonksiyonu henüz yok.';
      output.push(await reportTelemetryImprovement({
        investigationId, gapType: missingData ? 'DATA_NOT_COLLECTED'
          : unknown ? 'DATA_INSUFFICIENT' : 'MCP_FUNCTION_MISSING',
        technicalReason: missingData ? undefined : unknown ? 'CAPABILITY_UNKNOWN' : 'TOOL_NOT_AVAILABLE',
        requestedCapability: capability,
        title: 'Sorgu performansı kanıtı istendi', simpleReason: reason,
        requestedText: 'Sorgu performansı kanıtı',
        availableText: `pgss durumu: ${pgss}`,
        missingText: missingData ? 'pgss verisi erişilebilir değil' : unknown
          ? 'Hangi pgss metriklerinin güvenilir olduğu bilinmiyor' : 'Sorgu performansı MCP fonksiyonu',
        reasonText: candidate?.observed ?? reason,
        toolCallId: String(row.tool_call_id),
        coverageSummary: { source: 'telemetry_coverage', pgss_status: pgss,
          observed: candidate?.observed ?? null, impact: candidate?.impact ?? null },
      }));
    } else {
      output.push(await reportTelemetryImprovement({
        investigationId, gapType: 'MCP_FUNCTION_MISSING', technicalReason: 'TOOL_NOT_AVAILABLE',
        requestedCapability: capability,
        title: 'Dönem karşılaştırması istendi',
        simpleReason: 'Dönemleri karşılaştıran semantik MCP/API fonksiyonu henüz yok.',
        requestedText: 'İki dönemin autovacuum kanıtını karşılaştırma',
        availableText: 'Tek dönem için autovacuum kanıtı var',
        missingText: 'Dönem karşılaştırması MCP fonksiyonu',
        reasonText: 'Fonksiyon mevcut MCP araç sözlüğünde bulunmuyor.',
        toolCallId: String(row.tool_call_id),
        coverageSummary: { source: 'telemetry_coverage', function_registered: false },
      }));
    }
  }
  return output;
}
