import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../config/database';
import { GAP_TYPES, TECHNICAL_REASONS, reportTelemetryImprovement } from '../services/telemetryImprovement';
import { saveNamedSecret } from '../config/secrets';
import { cancelInvestigation } from '../services/investigationLifecycle';
import { decideIntake, resolveTarget, resolveWindow } from '../services/investigationIntake';
import { listImprovements } from '../services/improvementList';
import { testProviderConnection } from '../services/providerConnectionTest';
import { listProviderModels } from '../services/providerModelCatalog';
import rateLimit from 'express-rate-limit';

const router = Router();
const PROVIDERS = ['gemini', 'openrouter', 'ollama', 'openai', 'anthropic'] as const;
const instancePkSchema = z.union([
  z.string().regex(/^[1-9]\d{0,18}$/),
  z.number().int().positive().safe().transform(String),
]).refine(value => BigInt(value) <= 9223372036854775807n);

// Sohbet arayuzu: yalnizca soru zorunludur. Hedef ve zaman araligi
// verilmezse ya guvenle cozulur ya da kullaniciya sorulur — bkz.
// services/investigationIntake.ts.
const createInvestigationSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  investigation_type: z.literal('autovacuum').default('autovacuum'),
  model_provider: z.enum(PROVIDERS).optional(),
  // Soru basina model. Desen provider.ts'teki dogrulamayla ayni; gecersiz
  // ya da erisilemez bir ad artik hata mesajinda gorunur.
  model_name: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).optional(),
  instance_pk: instancePkSchema.optional(),
  dbid: z.coerce.number().int().nonnegative().optional(),
  time_from: z.string().datetime({ offset: true }).optional(),
  time_to: z.string().datetime({ offset: true }).optional(),
}).strict();

// Eksik kalan hedefi/araligi tamamlamak icin. En az biri verilmelidir.
const clarifyInvestigationSchema = z.object({
  instance_pk: instancePkSchema.optional(),
  dbid: z.coerce.number().int().nonnegative().optional(),
  time_from: z.string().datetime({ offset: true }).optional(),
  time_to: z.string().datetime({ offset: true }).optional(),
  message: z.string().trim().min(1).max(4000).optional(),
}).strict().refine(
  (value) => value.instance_pk !== undefined || value.time_from !== undefined || value.time_to !== undefined,
  { message: 'En az bir alan verilmelidir' },
);

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
  tool_call_id: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
  coverage_summary: z.record(z.string(), z.unknown()).optional(),
}).strict();

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
const parseBigintId = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return null;
  return BigInt(value) <= 9223372036854775807n ? value : null;
};

router.post('/investigations', async (req, res, next) => {
  try {
    const parsed = createInvestigationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Geçersiz araştırma isteği', details: parsed.error.flatten() });
    }

    const input = parsed.data;
    const window = resolveWindow(input.time_from ?? null, input.time_to ?? null);
    const from = new Date(window.from);
    const to = new Date(window.to);
    if (from >= to || to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Araştırma zaman aralığı 0–31 gün arasında olmalı' });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      const target = await resolveTarget(client, input.instance_pk ?? null);
      // Acikca verilen ama var olmayan/pasif instance bir girdi hatasidir,
      // sorulacak bir belirsizlik degil.
      if (target.kind === 'not_found') {
        await client.query('rollback');
        return res.status(404).json({ error: 'Aktif instance bulunamadı' });
      }

      const outcome = decideIntake(target, window);
      const connection = await client.query(
        `select provider, model_name from agent.provider_connection
         where is_enabled and (provider = 'ollama' or data_policy_acknowledged_at is not null)
           and ($1::text is null or provider = $1)
         order by connection_id limit 1`, [input.model_provider ?? null]);
      if (!connection.rows[0]) {
        await client.query('rollback');
        return res.status(409).json({ error: 'AI sağlayıcısı bağlı değil; önce AI Bağlantısı ekranından bağlayın' });
      }
      const created = await client.query(
        `insert into agent.investigation
           (question, investigation_type, instance_pk, dbid, time_from, time_to, status,
            model_provider, model_name)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning investigation_id, question, investigation_type, instance_pk,
                   dbid, time_from, time_to, status, created_at`,
        [input.question, input.investigation_type, outcome.instancePk,
         input.dbid ?? null, outcome.window.from, outcome.window.to, outcome.status,
         connection.rows[0].provider, input.model_name ?? connection.rows[0].model_name],
      );
      const investigationId = created.rows[0].investigation_id;
      await client.query(
        `insert into agent.investigation_message (investigation_id, role, content)
         values ($1, 'user', $2)`,
        [investigationId, input.question],
      );
      // Otomatik secim ve varsayilan pencere sessizce uygulanmaz; konusmaya yazilir.
      for (const message of outcome.assistantMessages) {
        await client.query(
          `insert into agent.investigation_message (investigation_id, role, content)
           values ($1, 'assistant', $2)`,
          [investigationId, message],
        );
      }
      await client.query('commit');
      return res.status(202).json({
        ...created.rows[0],
        window_defaulted: outcome.window.defaulted,
        clarification: outcome.status === 'needs_clarification'
          ? { needs: ['instance_pk'], candidates: outcome.candidates }
          : null,
      });
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

/**
 * Eksik kalan hedefi/araligi tamamlar ve arastirmayi kuyruga alir.
 *
 * Yalnizca 'needs_clarification' durumundaki arastirma tamamlanabilir; zaten
 * kuyruga girmis ya da bitmis bir isin hedefi degistirilemez, cunku toplanmis
 * kanit baska bir hedefe ait olurdu.
 */
router.post('/investigations/:id/clarify', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      return res.status(400).json({ error: 'Geçersiz araştırma kimliği' });
    }
    const parsed = clarifyInvestigationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Geçersiz tamamlama isteği', details: parsed.error.flatten() });
    }
    const input = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('begin');
      const existing = await client.query(
        `select investigation_id, status, instance_pk, time_from, time_to
           from agent.investigation where investigation_id = $1 for update`,
        [id],
      );
      const row = existing.rows[0];
      if (!row) {
        await client.query('rollback');
        return res.status(404).json({ error: 'Araştırma bulunamadı' });
      }
      if (row.status !== 'needs_clarification') {
        await client.query('rollback');
        return res.status(409).json({
          error: 'Bu araştırma zaten başlatılmış; hedefi değiştirilemez',
          status: row.status,
        });
      }

      let instancePk: string | null = row.instance_pk === null ? null : String(row.instance_pk);
      if (input.instance_pk !== undefined) {
        const target = await resolveTarget(client, input.instance_pk);
        if (target.kind === 'not_found') {
          await client.query('rollback');
          return res.status(404).json({ error: 'Aktif instance bulunamadı' });
        }
        instancePk = input.instance_pk;
      }

      const window = resolveWindow(
        input.time_from ?? (row.time_from as Date).toISOString(),
        input.time_to ?? (row.time_to as Date).toISOString(),
      );
      const from = new Date(window.from);
      const to = new Date(window.to);
      if (from >= to || to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1000) {
        await client.query('rollback');
        return res.status(400).json({ error: 'Araştırma zaman aralığı 0–31 gün arasında olmalı' });
      }

      // Hedef hala bilinmiyorsa durum degismez: soru acik kalir.
      const nextStatus = instancePk === null ? 'needs_clarification' : 'queued';
      const updated = await client.query(
        `update agent.investigation
            set instance_pk = $2, dbid = coalesce($3, dbid),
                time_from = $4, time_to = $5, status = $6, updated_at = now()
          where investigation_id = $1
          returning investigation_id, question, investigation_type, instance_pk,
                    dbid, time_from, time_to, status, created_at`,
        [id, instancePk, input.dbid ?? null, window.from, window.to, nextStatus],
      );
      if (input.message) {
        await client.query(
          `insert into agent.investigation_message (investigation_id, role, content)
           values ($1, 'user', $2)`,
          [id, input.message],
        );
      }
      await client.query('commit');
      return res.json(updated.rows[0]);
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

router.get('/investigations', async (req, res, next) => {
  try {
    const instancePk = req.query.instance_pk === undefined
      ? null
      : parseBigintId(req.query.instance_pk);
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

const providerTestLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5,
  message: { error: 'Bağlantı testi sınırına ulaşıldı; daha sonra deneyin' } });
// Liste cagrisi saglayicinin kotasindan harcar; testten daha sik ama yine sinirli.
const providerModelsLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20,
  message: { error: 'Model listesi sınırına ulaşıldı; daha sonra deneyin' } });
router.post('/providers/:provider/test', providerTestLimiter, async (req, res, next) => {
  try {
    if (!PROVIDERS.includes(req.params.provider as Provider)) return res.status(400).json({ error: 'Desteklenmeyen AI sağlayıcısı' });
    try { return res.json(await testProviderConnection(pool, req.params.provider)); }
    catch (error) {
      if (error instanceof Error && error.message === 'PROVIDER_NOT_ENABLED') return res.status(404).json({ error: 'Aktif sağlayıcı bulunamadı' });
      if (error instanceof Error && /^(PROVIDER_NOT_READY|PROVIDER_URL_INVALID)$/.test(error.message)) return res.status(409).json({ error: error.message });
      throw error;
    }
  } catch (error) { next(error); }
});

/**
 * Kayitli anahtarin gercekten kullanabilecegi modeller.
 *
 * Model adini elle yazdirmak yanlis/erisilemez ad yuzunden 404'e yol
 * aciyordu. Liste saglayicidan gelir; anahtar disariya donmez.
 */
router.get('/providers/:provider/models', providerModelsLimiter, async (req, res, next) => {
  try {
    if (!PROVIDERS.includes(req.params.provider as Provider)) {
      return res.status(400).json({ error: 'Desteklenmeyen AI sağlayıcısı' });
    }
    try {
      return res.json({ models: await listProviderModels(pool, req.params.provider) });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN';
      if (code === 'PROVIDER_NOT_CONFIGURED') {
        return res.status(404).json({ error: 'Bu sağlayıcı için kayıt yok; önce API anahtarını kaydedin', code });
      }
      if (code === 'PROVIDER_NOT_READY' || code === 'PROVIDER_URL_INVALID') {
        return res.status(409).json({ error: 'Sağlayıcı kaydı eksik ya da geçersiz', code });
      }
      if (code === 'PROVIDER_AUTH_FAILED') {
        return res.status(502).json({ error: 'API anahtarı reddedildi', code });
      }
      if (code === 'PROVIDER_RATE_LIMITED') {
        return res.status(502).json({ error: 'Sağlayıcı kota sınırı; birazdan tekrar deneyin', code });
      }
      if (code === 'PROVIDER_UNREACHABLE' || code.startsWith('PROVIDER_HTTP_')) {
        return res.status(502).json({ error: 'Sağlayıcıya ulaşılamadı', code });
      }
      throw error;
    }
  } catch (error) { next(error); }
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
    const id = parseBigintId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Geçersiz investigation id' });

    const [investigation, messages, calls, evidence, result, improvements] = await Promise.all([
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
      pool.query(
        `select evidence_id, tool_call_id,
                envelope->>'capability' as capability,
                envelope->>'status' as status,
                envelope->'coverage' as coverage,
                envelope->'limitations' as limitations,
                envelope->'data' as data,
                sha256_hex, response_bytes, recorded_at
         from agent.investigation_evidence where investigation_id = $1
         order by evidence_id limit 10`, [id]),
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
      evidence: evidence.rows,
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
    const investigationId = parseBigintId(req.params.id);
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
    const id = parseBigintId(req.params.id);
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
    const id = parseBigintId(req.params.id);
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
