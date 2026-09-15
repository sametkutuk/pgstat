import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';
import { requireAgentService, signEvidenceClaim } from '../config/agentServiceAuth';
import { advanceInvestigation, claimNextInvestigation, finishInvestigation,
  heartbeatInvestigation, reclaimStaleInvestigations } from '../services/investigationQueue';
import { readAgentSecretRef } from '../config/secrets';
import { recordToolEvidence, recordToolFailure, TOOL_CAPABILITIES } from '../services/agentEvidenceAudit';
import { completeInvestigation } from '../services/investigationCompletion';
import { persistRequestedCapabilityGaps } from '../services/verifiedCapabilityGap';

const router = Router();
router.use(requireAgentService);

const workerSchema = z.object({ worker_id: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/) }).strict();
const idSchema = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n);
const toolEvidenceSchema = workerSchema.extend({
  tool_name: z.enum(Object.keys(TOOL_CAPABILITIES) as [string, ...string[]]),
  duration_ms: z.number().int().min(0).max(30000),
  envelope: z.record(z.string(), z.unknown()),
}).strict();
const resultSchema = z.object({
  conclusion: z.string().trim().min(1).max(2000),
  confidence: z.enum(['low', 'medium', 'high']),
  confidence_reason: z.string().trim().min(1).max(500),
  observed_facts: z.array(z.object({
    text: z.string().trim().min(1).max(500),
    evidence_id: idSchema,
  }).strict()).max(20),
  interpretations: z.array(z.string().trim().min(1).max(500)).max(20),
  hypotheses: z.array(z.string().trim().min(1).max(500)).max(20),
  limitations: z.array(z.string().trim().min(1).max(500)).max(20),
}).strict();

function scopedToken(job: { investigation_id: string; instance_pk: string | null; dbid: number | null;
                            time_from: Date; time_to: Date }, workerId: string) {
  if (job.instance_pk === null) throw new Error('Queued investigation has no instance');
  return signEvidenceClaim({
    investigation_id: job.investigation_id, instance_pk: String(job.instance_pk),
    claimed_by: workerId, dbid: job.dbid,
    time_from: job.time_from.toISOString(), time_to: job.time_to.toISOString(),
  });
}

router.post('/claim', async (req, res, next) => {
  try {
    const parsed = workerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Geçersiz worker kimliği' });
    const job = await claimNextInvestigation(pool, parsed.data.worker_id);
    if (!job) return res.status(204).end();
    return res.json({ investigation: job, evidence_token: scopedToken(job, parsed.data.worker_id) });
  } catch (error) { next(error); }
});

router.post('/investigations/:id/heartbeat', async (req, res, next) => {
  try {
    if (!/^[1-9]\d{0,18}$/.test(req.params.id)) return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    const parsed = workerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Geçersiz worker kimliği' });
    const outcome = await heartbeatInvestigation(pool, req.params.id, parsed.data.worker_id);
    if (outcome.outcome === 'superseded') return res.status(409).json(outcome);
    const row = await pool.query(
      `select investigation_id, instance_pk, dbid, time_from, time_to from agent.investigation
       where investigation_id = $1 and claimed_by = $2`, [req.params.id, parsed.data.worker_id]);
    if (!row.rows[0]) return res.status(409).json({ outcome: 'superseded' });
    return res.json({ outcome, evidence_token: scopedToken(row.rows[0], parsed.data.worker_id) });
  } catch (error) { next(error); }
});

router.post('/reclaim-stale', async (_req, res, next) => {
  try { res.json(await reclaimStaleInvestigations(pool)); }
  catch (error) { next(error); }
});

router.post('/investigations/:id/advance', async (req, res, next) => {
  try {
    if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    const parsed = workerSchema.extend({
      expected: z.enum(['planning', 'collecting_evidence']),
      next: z.enum(['collecting_evidence', 'interpreting']),
    }).strict().safeParse(req.body);
    if (!parsed.success || (parsed.data.expected === 'planning' && parsed.data.next !== 'collecting_evidence')
        || (parsed.data.expected === 'collecting_evidence' && parsed.data.next !== 'interpreting')) {
      return res.status(400).json({ error: 'Geçersiz araştırma geçişi' });
    }
    const outcome = await advanceInvestigation(pool, req.params.id, parsed.data.worker_id,
      parsed.data.expected, parsed.data.next);
    return res.status(outcome.outcome === 'superseded' ? 409 : 200).json(outcome);
  } catch (error) { next(error); }
});

router.post('/investigations/:id/evidence', async (req, res, next) => {
  try {
    if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    const parsed = toolEvidenceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Geçersiz kanıt kaydı' });
    try {
      return res.status(201).json(await recordToolEvidence(pool, {
        investigationId: req.params.id, workerId: parsed.data.worker_id,
        toolName: parsed.data.tool_name, envelope: parsed.data.envelope,
        durationMs: parsed.data.duration_ms,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === 'INVESTIGATION_SUPERSEDED') return res.status(409).json({ error: error.message });
      if (error instanceof Error && /^(EVIDENCE_|SENSITIVE_|INSTANCE_)/.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  } catch (error) { next(error); }
});

router.post('/investigations/:id/tool-failure', async (req, res, next) => {
  try {
    if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    const parsed = workerSchema.extend({
      tool_name: z.enum(Object.keys(TOOL_CAPABILITIES) as [string, ...string[]]),
      code: z.string().regex(/^[A-Z0-9_]{3,80}$/),
      duration_ms: z.number().int().min(0).max(30000),
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Geçersiz araç hata kaydı' });
    try {
      return res.status(201).json(await recordToolFailure(pool, {
        investigationId: req.params.id, workerId: parsed.data.worker_id,
        toolName: parsed.data.tool_name, code: parsed.data.code,
        durationMs: parsed.data.duration_ms,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === 'INVESTIGATION_SUPERSEDED')
        return res.status(409).json({ error: error.message });
      throw error;
    }
  } catch (error) { next(error); }
});

router.post('/investigations/:id/complete', async (req, res, next) => {
  try {
    if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    const parsed = workerSchema.extend({
      result: resultSchema,
      input_tokens: z.number().int().min(0).max(1000000).nullable(),
      output_tokens: z.number().int().min(0).max(1000000).nullable(),
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Geçersiz AI sonuç şeması' });
    try {
      const outcome = await completeInvestigation(pool, req.params.id, parsed.data.worker_id,
        parsed.data.result, parsed.data.input_tokens, parsed.data.output_tokens);
      return res.status(outcome.outcome === 'superseded' ? 409 : 200).json(outcome);
    } catch (error) {
      if (error instanceof Error && error.message === 'FACT_EVIDENCE_NOT_IN_INVESTIGATION') {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  } catch (error) { next(error); }
});

router.post('/investigations/:id/fail', async (req, res, next) => {
  try {
    if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    const parsed = workerSchema.extend({
      code: z.string().regex(/^[A-Z0-9_]{3,80}$/),
      detail: z.string().trim().min(1).max(500),
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Geçersiz hata kaydı' });
    const outcome = await finishInvestigation(pool, req.params.id, parsed.data.worker_id,
      parsed.data.code === 'JOB_DEADLINE' ? 'timed_out' : 'failed',
      { code: parsed.data.code, detail: parsed.data.detail });
    return res.status(outcome.outcome === 'superseded' ? 409 : 200).json(outcome);
  } catch (error) { next(error); }
});

router.post('/investigations/:id/missing-capabilities', async (req, res, next) => {
  try {
    if (!idSchema.safeParse(req.params.id).success) return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    const parsed = workerSchema.extend({
      capabilities: z.array(z.enum(['query_performance_evidence', 'compare_periods'])).max(2),
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Geçersiz yetenek bildirimi' });
    try {
      return res.json(await persistRequestedCapabilityGaps(pool, req.params.id,
        parsed.data.worker_id, parsed.data.capabilities));
    } catch (error) {
      if (error instanceof Error && error.message === 'INVESTIGATION_SUPERSEDED') return res.status(409).json({ error: error.message });
      if (error instanceof Error && error.message === 'COVERAGE_EVIDENCE_REQUIRED') return res.status(400).json({ error: error.message });
      throw error;
    }
  } catch (error) { next(error); }
});

/** Only the claimed job's provider. Secret never reaches browser-facing routes. */
router.get('/investigations/:id/provider', async (req, res, next) => {
  try {
    if (!/^[1-9]\d{0,18}$/.test(req.params.id)) return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    const workerId = req.query.worker_id;
    if (typeof workerId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(workerId)) {
      return res.status(400).json({ error: 'Geçersiz worker kimliği' });
    }
    const connection = await pool.query(
      // Arastirma kendi modelini tasiyorsa o kullanilir: kullanici soru
      // basina model secebilir (hizli soruya kucuk model, derin analize
      // buyuk). Secmediyse baglantinin varsayilanina duser.
      `select p.provider, coalesce(i.model_name, p.model_name) as model_name,
              p.base_url, p.secret_ref
       from agent.investigation i join agent.provider_connection p on p.provider = i.model_provider
       where i.investigation_id = $1 and i.claimed_by = $2
         and i.status in ('planning', 'collecting_evidence', 'interpreting')
         and p.is_enabled and (p.provider = 'ollama' or p.data_policy_acknowledged_at is not null)`,
      [req.params.id, workerId]);
    if (!connection.rows[0]) return res.status(409).json({ error: 'Araştırma veya sağlayıcı artık etkin değil' });
    const row = connection.rows[0];
    return res.json({ provider: row.provider, model: row.model_name, base_url: row.base_url,
      api_key: row.secret_ref ? readAgentSecretRef(row.secret_ref) : null });
  } catch (error) { next(error); }
});

export default router;
