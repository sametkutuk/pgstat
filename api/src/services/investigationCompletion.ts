import type { Pool } from 'pg';

export interface StructuredResult {
  conclusion: string;
  confidence: 'low' | 'medium' | 'high';
  confidence_reason: string;
  observed_facts: { text: string; evidence_id: string }[];
  interpretations: string[];
  hypotheses: string[];
  limitations: string[];
}

/** Row-lock makes result/message/status one all-or-nothing transition. */
export async function completeInvestigation(database: Pool, id: string, workerId: string,
                                            result: StructuredResult, inputTokens: number | null,
                                            outputTokens: number | null) {
  const client = await database.connect();
  try {
    await client.query('begin');
    const row = await client.query(
      `select investigation_id from agent.investigation where investigation_id = $1
       and claimed_by = $2 and status = 'interpreting' for update`, [id, workerId]);
    if (!row.rows[0]) { await client.query('rollback'); return { outcome: 'superseded' as const }; }
    const ids = result.observed_facts.map(fact => fact.evidence_id);
    if (ids.length) {
      const verified = await client.query(
        `select evidence_id from agent.investigation_evidence
         where investigation_id = $1 and evidence_id = any($2::bigint[])`, [id, ids]);
      if (verified.rowCount !== new Set(ids).size) throw new Error('FACT_EVIDENCE_NOT_IN_INVESTIGATION');
    }
    await client.query(
      `insert into agent.investigation_result
        (investigation_id, conclusion, confidence, confidence_reason,
         observed_facts, interpretations, hypotheses, limitations)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)`,
      [id, result.conclusion, result.confidence, result.confidence_reason,
        JSON.stringify(result.observed_facts), JSON.stringify(result.interpretations),
        JSON.stringify(result.hypotheses), JSON.stringify(result.limitations)]);
    await client.query(
      `insert into agent.investigation_message (investigation_id, role, content)
       values ($1, 'assistant', $2)`, [id, result.conclusion]);
    const status = result.observed_facts.length ? 'completed' : 'insufficient_evidence';
    await client.query(
      `update agent.investigation set status = $2, completed_at = now(),
        input_tokens = $3, output_tokens = $4, claimed_by = null, heartbeat_at = null,
        updated_at = now() where investigation_id = $1`, [id, status, inputTokens, outputTokens]);
    await client.query('commit');
    return { outcome: 'completed' as const, status };
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
