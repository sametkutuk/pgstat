import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';
import { GAP_TYPES, TECHNICAL_REASONS, reportTelemetryImprovement } from '../services/telemetryImprovement';
import { saveNamedSecret } from '../config/secrets';
import { cancelInvestigation } from '../services/investigationLifecycle';
import { listImprovements } from '../services/improvementList';

const router = Router();

const createInvestigationSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  investigation_type: z.literal('autovacuum').default('autovacuum'),
  instance_pk: z.coerce.number().int().positive(),
  dbid: z.coerce.number().int().nonnegative().optional(),
  time_from: z.string().datetime({ offset: true }),
  time_to: z.string().datetime({ offset: true }),
}).strict();

const improvementStatusSchema = z.object({
  status: z.enum(['review_required', 'accepted', 'in_progress', 'resolved', 'rejected']),
}).strict();

const improvementReportSchema = z.object({
  gap_type: z.enum(GAP_TYPES),
  technical_reason: z.enum(TECHNICAL_REASONS).optional(),
  requested_capability: z.string().trim().min(1).max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  title: z.string().trim().min(1).max(160),
  simple_reason: z.string().trim().min(1).max(500),
  requested_text: z.string().trim().min(1).max(1000),
  available_text: z.string().trim().min(1).max(1000),
  missing_text: z.string().trim().min(1).max(1000),
  reason_text: z.string().trim().min(1).max(1000),
  tool_call_id: z.coerce.number().int().positive().optional(),
  coverage_summary: z.record(z.string(), z.unknown()).optional(),
}).strict();

const PROVIDERS = ['gemini', 'openrouter', 'ollama', 'openai', 'anthropic'] as const;
type Provider = typeof PROVIDERS[number];
const CLOUD_BASE_URLS: Record<Exclude<Provider, 'ollama'>, string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

const providerSchema = z.object({
  model_name: z.string().trim().min(1).max(120),
  api_key: z.string().trim().min(8).max(1000).optional(),
  base_url: z.string().url().max(500).optional(),
  is_enabled: z.boolean().default(true),
  data_policy_acknowledged: z.boolean().default(false),
}).strict();

function localProviderUrl(raw?: string): string {
  if (!raw) throw new Error('OLLAMA_BASE_URL_REQUIRED');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || !url.port) {
    throw new Error('OLLAMA_BASE_URL_INVALID');
  }
  const allowedHosts = new Set((process.env.PGSTAT_AI_LOCAL_HOSTS
    ?? 'ollama,host.docker.internal,localhost,127.0.0.1')
    .split(',').map(host => host.trim().toLowerCase()).filter(Boolean));
  if (!allowedHosts.has(url.hostname.toLowerCase())) throw new Error('OLLAMA_HOST_NOT_ALLOWED');
  return url.toString().replace(/\/$/, '');
}

const parsePositiveInt = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

router.post('/investigations', async (req, res, next) => {
  try {
    const parsed = createInvestigationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Geçersiz araştırma isteği', details: parsed.error.flatten() });
    }

    const input = parsed.data;
    const from = new Date(input.time_from);
    const to = new Date(input.time_to);
    if (from >= to || to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Araştırma zaman aralığı 0–31 gün arasında olmalı' });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      const instance = await client.query(
        `select instance_pk from control.instance_inventory
         where instance_pk = $1 and is_active`,
        [input.instance_pk],
      );
      if (instance.rowCount === 0) {
        await client.query('rollback');
        return res.status(404).json({ error: 'Aktif instance bulunamadı' });
      }

      const created = await client.query(
        `insert into agent.investigation
           (question, investigation_type, instance_pk, dbid, time_from, time_to)
         values ($1, $2, $3, $4, $5, $6)
         returning investigation_id, question, investigation_type, instance_pk,
                   dbid, time_from, time_to, status, created_at`,
        [input.question, input.investigation_type, input.instance_pk,
         input.dbid ?? null, input.time_from, input.time_to],
      );
      await client.query(
        `insert into agent.investigation_message (investigation_id, role, content)
         values ($1, 'user', $2)`,
        [created.rows[0].investigation_id, input.question],
      );
      await client.query('commit');
      return res.status(202).json(created.rows[0]);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

router.post('/investigations/:id/cancel', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    }
    const result = await cancelInvestigation(pool, id);
    if (result.outcome === 'not_found') return res.status(404).json({ error: 'Araştırma bulunamadı' });
    if (result.outcome === 'terminal') {
      return res.status(409).json({ error: 'Bitmiş araştırma iptal edilemez', status: result.investigation.status });
    }
    return res.json(result.investigation);
  } catch (error) {
    next(error);
  }
});

router.get('/investigations', async (req, res, next) => {
  try {
    const instancePk = req.query.instance_pk === undefined
      ? null
      : parsePositiveInt(req.query.instance_pk);
    if (req.query.instance_pk !== undefined && instancePk === null) {
      return res.status(400).json({ error: 'Geçersiz instance_pk' });
    }
    const limit = Math.min(parsePositiveInt(req.query.limit) ?? 50, 100);
    const result = await pool.query(
      `select i.investigation_id, i.question, i.investigation_type, i.instance_pk,
              ii.display_name as instance_name, i.dbid, i.time_from, i.time_to,
              i.status, i.model_provider, i.model_name, i.failure_code,
              i.started_at, i.completed_at, i.created_at
       from agent.investigation i
       left join control.instance_inventory ii on ii.instance_pk = i.instance_pk
       where ($1::bigint is null or i.instance_pk = $1)
       order by i.created_at desc
       limit $2`,
      [instancePk, limit],
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.get('/providers', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `select provider, model_name, base_url, is_enabled,
              secret_ref is not null as has_api_key,
              data_policy_acknowledged_at, last_tested_at,
              last_test_status, last_test_error_code, updated_at
       from agent.provider_connection order by connection_id`,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.put('/providers/:provider', async (req, res, next) => {
  try {
    const provider = req.params.provider as Provider;
    if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Desteklenmeyen AI sağlayıcısı' });
    const parsed = providerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Geçersiz sağlayıcı ayarı', details: parsed.error.flatten() });
    const input = parsed.data;
    if (provider !== 'ollama' && !input.api_key) {
      const exists = await pool.query(
        `select secret_ref is not null as has_key from agent.provider_connection where provider = $1`, [provider]);
      if (!exists.rows[0]?.has_key) return res.status(400).json({ error: 'API anahtarı zorunlu' });
    }
    if (provider !== 'ollama' && !input.data_policy_acknowledged) {
      return res.status(400).json({ error: 'Bulut sağlayıcısının veri politikası onaylanmalı' });
    }
    let baseUrl: string;
    try {
      baseUrl = provider === 'ollama' ? localProviderUrl(input.base_url) : CLOUD_BASE_URLS[provider];
    } catch (error) {
      const code = error instanceof Error ? error.message : 'OLLAMA_BASE_URL_INVALID';
      return res.status(400).json({ error: code });
    }
    const secretRef = input.api_key
      ? saveNamedSecret('ai-provider', provider, input.api_key)
      : null;
    const result = await pool.query(
      `insert into agent.provider_connection
         (provider, model_name, base_url, secret_ref, is_enabled, data_policy_acknowledged_at)
       values ($1, $2, $3, $4, $5, case when $6 then now() else null end)
       on conflict (provider) do update
       set model_name = excluded.model_name,
           base_url = excluded.base_url,
           secret_ref = coalesce(excluded.secret_ref, agent.provider_connection.secret_ref),
           is_enabled = excluded.is_enabled,
           data_policy_acknowledged_at = case when $6 then
             coalesce(agent.provider_connection.data_policy_acknowledged_at, now()) else null end,
           last_test_status = null, last_test_error_code = null, updated_at = now()
       returning provider, model_name, base_url, is_enabled,
                 secret_ref is not null as has_api_key,
                 data_policy_acknowledged_at, last_tested_at,
                 last_test_status, last_test_error_code, updated_at`,
      [provider, input.model_name, baseUrl, secretRef, input.is_enabled, input.data_policy_acknowledged],
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get('/investigations/:id', async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Geçersiz investigation id' });

    const [investigation, messages, calls, result, improvements] = await Promise.all([
      pool.query(
        `select i.*, ii.display_name as instance_name, c.pg_major
         from agent.investigation i
         left join control.instance_inventory ii on ii.instance_pk = i.instance_pk
         left join control.instance_capability c on c.instance_pk = i.instance_pk
         where i.investigation_id = $1`, [id]),
      pool.query(
        `select message_id, role, content, created_at
         from agent.investigation_message where investigation_id = $1
         order by created_at, message_id`, [id]),
      pool.query(
        `select tool_call_id, tool_name, tool_version, status, coverage_state,
                result_item_count, result_bytes, error_code, started_at,
                completed_at, duration_ms
         from agent.investigation_tool_call where investigation_id = $1
         order by started_at, tool_call_id`, [id]),
      pool.query(`select * from agent.investigation_result where investigation_id = $1`, [id]),
      pool.query(
        `select ti.improvement_id, ti.gap_type, ti.title, ti.simple_reason,
                ti.status, ti.occurrence_count
         from agent.telemetry_improvement_occurrence o
         join agent.telemetry_improvement ti on ti.improvement_id = o.improvement_id
         where o.investigation_id = $1 order by o.detected_at`, [id]),
    ]);
    if (investigation.rowCount === 0) return res.status(404).json({ error: 'Araştırma bulunamadı' });
    res.json({
      investigation: investigation.rows[0],
      messages: messages.rows,
      tool_calls: calls.rows,
      result: result.rows[0] ?? null,
      improvements: improvements.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/improvements', async (req, res, next) => {
  try {
    const allowed = ['review_required', 'accepted', 'in_progress', 'resolved', 'rejected'];
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Geçersiz durum' });
    const pagination = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    }).safeParse(req.query);
    if (!pagination.success) return res.status(400).json({ error: 'Geçersiz sayfalama' });
    res.json(await listImprovements(pool, status, pagination.data.limit, pagination.data.offset));
  } catch (error) {
    next(error);
  }
});

router.post('/investigations/:id/improvements', async (req, res, next) => {
  try {
    const investigationId = parsePositiveInt(req.params.id);
    if (investigationId === null) return res.status(400).json({ error: 'Geçersiz investigation id' });
    const parsed = improvementReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Geçersiz geliştirme bildirimi', details: parsed.error.flatten() });
    }
    try {
      const stored = await reportTelemetryImprovement({
        investigationId,
        gapType: parsed.data.gap_type,
        technicalReason: parsed.data.technical_reason,
        requestedCapability: parsed.data.requested_capability,
        title: parsed.data.title,
        simpleReason: parsed.data.simple_reason,
        requestedText: parsed.data.requested_text,
        availableText: parsed.data.available_text,
        missingText: parsed.data.missing_text,
        reasonText: parsed.data.reason_text,
        toolCallId: parsed.data.tool_call_id,
        coverageSummary: parsed.data.coverage_summary,
      });
      return res.status(stored.new_occurrence ? 201 : 200).json(stored);
    } catch (error) {
      if (error instanceof Error && error.message === 'INVESTIGATION_NOT_FOUND') {
        return res.status(404).json({ error: 'Araştırma bulunamadı' });
      }
      if (error instanceof Error && error.message === 'TOOL_CALL_NOT_IN_INVESTIGATION') {
        return res.status(400).json({ error: 'Tool çağrısı bu araştırmaya ait değil' });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

router.get('/improvements/:id', async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Geçersiz improvement id' });
    const [item, occurrences] = await Promise.all([
      pool.query(`select * from agent.telemetry_improvement where improvement_id = $1`, [id]),
      pool.query(
        `select o.*, ii.display_name as instance_name, inv.question
         from agent.telemetry_improvement_occurrence o
         left join control.instance_inventory ii on ii.instance_pk = o.instance_pk
         join agent.investigation inv on inv.investigation_id = o.investigation_id
         where o.improvement_id = $1 order by o.detected_at desc`, [id]),
    ]);
    if (item.rowCount === 0) return res.status(404).json({ error: 'Geliştirme kaydı bulunamadı' });
    res.json({ improvement: item.rows[0], occurrences: occurrences.rows });
  } catch (error) {
    next(error);
  }
});

router.patch('/improvements/:id/status', async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Geçersiz improvement id' });
    const parsed = improvementStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Geçersiz durum' });
    const result = await pool.query(
      `update agent.telemetry_improvement
       set status = $2,
           resolved_at = case when $2 = 'resolved' then now() else null end,
           updated_at = now()
       where improvement_id = $1
       returning *`, [id, parsed.data.status]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Geliştirme kaydı bulunamadı' });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

export default router;
