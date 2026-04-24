import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { parseId, parseLimit } from '../middleware/validation';

const router = Router();

// Kural listesi — GET /api/alert-rules
router.get('/', async (req: Request, res: Response) => {
  const limit = parseLimit(req.query.limit, 200);
  const enabled = req.query.enabled;
  const metricType = req.query.metric_type;

  let where = 'where 1=1';
  const params: any[] = [];

  if (enabled !== undefined) {
    params.push(enabled === 'true');
    where += ` and r.is_enabled = $${params.length}`;
  }
  if (metricType && typeof metricType === 'string') {
    const allowed = ['cluster_metric', 'io_metric', 'database_metric', 'statement_metric',
      'table_metric', 'index_metric', 'activity_metric', 'replication_metric'];
    if (allowed.includes(metricType)) {
      params.push(metricType);
      where += ` and r.metric_type = $${params.length}`;
    }
  }

  // r.* ile tüm kolonları döndür — yeni kolonlar (sensitivity, instance_group_id)
  // migration uygulanmadıysa yoksa bile crash etmez.
  const q = `
    select
      r.*,
      i.display_name as instance_name,
      (
        select count(*)
        from ops.alert a
        where a.alert_key like 'rule:' || r.rule_id || ':%'
          and a.status = 'open'
      ) as open_alert_count,
      e.last_evaluated_at,
      e.last_alert_at,
      e.last_value,
      e.current_severity
    from control.alert_rule r
    left join control.instance_inventory i on i.instance_pk = r.instance_pk
    left join lateral (
      select last_evaluated_at, last_alert_at, last_value, current_severity
      from control.alert_rule_last_eval
      where rule_id = r.rule_id
      order by last_evaluated_at desc
      limit 1
    ) e on true
    ${where}
    order by r.is_enabled desc, r.rule_id
    limit $${params.length + 1}
  `;
  params.push(limit);

  try {
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (e: any) {
    console.error('alert-rules GET failed:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'query failed' });
  }
});

// Hazır template'ler — GET /api/alert-rules/templates
router.get('/templates', async (_req: Request, res: Response) => {
  // Template'ler seed data'daki is_enabled=false kurallardan gelir
  const result = await pool.query(`
    select
      rule_id,
      rule_name,
      description,
      metric_type,
      metric_name,
      scope,
      condition_operator,
      warning_threshold,
      critical_threshold,
      evaluation_window_minutes,
      aggregation,
      evaluation_type,
      change_threshold_pct,
      min_data_days,
      alert_category,
      spike_fallback_pct,
      flatline_minutes,
      cooldown_minutes,
      auto_resolve
    from control.alert_rule
    where created_by = 'system'
    order by metric_type, rule_id
  `);
  res.json(result.rows);
});

// Tek kural detayı — GET /api/alert-rules/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Geçersiz rule_id' });

  const result = await pool.query(
    `select r.*, i.display_name as instance_name
     from control.alert_rule r
     left join control.instance_inventory i on i.instance_pk = r.instance_pk
     where r.rule_id = $1`,
    [id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Kural bulunamadı' });
  res.json(result.rows[0]);
});

// Kural oluştur — POST /api/alert-rules
router.post('/', async (req: Request, res: Response, next) => {
  try {
    const err = validateRuleBody(req.body);
    if (err) return res.status(400).json({ error: err });

    const {
      rule_name, description, metric_type, metric_name, scope,
      instance_pk, service_group, condition_operator,
      warning_threshold, critical_threshold, evaluation_window_minutes,
      aggregation, evaluation_type, change_threshold_pct, min_data_days,
      alert_category, spike_fallback_pct, flatline_minutes, sensitivity, instance_group_id,
      is_enabled, cooldown_minutes, auto_resolve
    } = req.body;

    // Dinamik kolon listesi — DB'deki gerçek kolonlara göre INSERT kur.
    // Bu sayede V018/V019 henüz uygulanmamışsa bile çalışır.
    const existing = await getExistingColumns();

    const cols: { name: string; val: any; default?: any }[] = [
      { name: 'rule_name', val: rule_name },
      { name: 'description', val: description ?? null },
      { name: 'metric_type', val: metric_type },
      { name: 'metric_name', val: metric_name },
      { name: 'scope', val: scope ?? 'all_instances' },
      { name: 'instance_pk', val: instance_pk ?? null },
      { name: 'service_group', val: service_group ?? null },
      { name: 'condition_operator', val: condition_operator ?? '>' },
      { name: 'warning_threshold', val: warning_threshold ?? null },
      { name: 'critical_threshold', val: critical_threshold ?? null },
      { name: 'evaluation_window_minutes', val: evaluation_window_minutes ?? 5 },
      { name: 'aggregation', val: aggregation ?? 'avg' },
      { name: 'is_enabled', val: is_enabled !== false },
      { name: 'cooldown_minutes', val: cooldown_minutes ?? 15 },
      { name: 'auto_resolve', val: auto_resolve !== false },
      // V013+
      { name: 'evaluation_type', val: evaluation_type ?? 'threshold' },
      { name: 'change_threshold_pct', val: change_threshold_pct ?? null },
      { name: 'min_data_days', val: min_data_days ?? 7 },
      // V016+
      { name: 'alert_category', val: alert_category ?? 'threshold' },
      { name: 'spike_fallback_pct', val: spike_fallback_pct ?? null },
      { name: 'flatline_minutes', val: flatline_minutes ?? 30 },
      // V018+
      { name: 'sensitivity', val: sensitivity ?? 'medium' },
      { name: 'instance_group_id', val: instance_group_id ?? null },
    ];

    const active = cols.filter(c => existing.has(c.name));
    const colList = active.map(c => c.name).join(', ');
    const placeholders = active.map((_, i) => `$${i + 1}`).join(', ');
    const values = active.map(c => c.val);

    const result = await pool.query(
      `insert into control.alert_rule (${colList}) values (${placeholders}) returning *`,
      values
    );
    res.status(201).json(result.rows[0]);
  } catch (e: any) {
    console.error('alert-rules POST failed:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'insert failed' });
  }
});

// Kolon listesi cache (60s TTL)
let columnsCache: { at: number; cols: Set<string> } | null = null;
async function getExistingColumns(): Promise<Set<string>> {
  if (columnsCache && Date.now() - columnsCache.at < 60_000) return columnsCache.cols;
  const r = await pool.query(
    `select column_name from information_schema.columns
     where table_schema='control' and table_name='alert_rule'`
  );
  const set = new Set<string>(r.rows.map(x => x.column_name));
  columnsCache = { at: Date.now(), cols: set };
  return set;
}

// Kural güncelle — PUT /api/alert-rules/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Geçersiz rule_id' });

    const err = validateRuleBody(req.body);
    if (err) return res.status(400).json({ error: err });

    const {
      rule_name, description, metric_type, metric_name, scope,
      instance_pk, service_group, condition_operator,
      warning_threshold, critical_threshold, evaluation_window_minutes,
      aggregation, evaluation_type, change_threshold_pct, min_data_days,
      alert_category, spike_fallback_pct, flatline_minutes, sensitivity, instance_group_id,
      is_enabled, cooldown_minutes, auto_resolve
    } = req.body;

    // Dinamik UPDATE — DB'deki mevcut kolonlara göre set kur
    const existing = await getExistingColumns();
    const cols: { name: string; val: any }[] = [
      { name: 'rule_name', val: rule_name },
      { name: 'description', val: description ?? null },
      { name: 'metric_type', val: metric_type },
      { name: 'metric_name', val: metric_name },
      { name: 'scope', val: scope ?? 'all_instances' },
      { name: 'instance_pk', val: instance_pk ?? null },
      { name: 'service_group', val: service_group ?? null },
      { name: 'condition_operator', val: condition_operator ?? '>' },
      { name: 'warning_threshold', val: warning_threshold ?? null },
      { name: 'critical_threshold', val: critical_threshold ?? null },
      { name: 'evaluation_window_minutes', val: evaluation_window_minutes ?? 5 },
      { name: 'aggregation', val: aggregation ?? 'avg' },
      { name: 'is_enabled', val: is_enabled !== false },
      { name: 'cooldown_minutes', val: cooldown_minutes ?? 15 },
      { name: 'auto_resolve', val: auto_resolve !== false },
      { name: 'evaluation_type', val: evaluation_type ?? 'threshold' },
      { name: 'change_threshold_pct', val: change_threshold_pct ?? null },
      { name: 'min_data_days', val: min_data_days ?? 7 },
      { name: 'alert_category', val: alert_category ?? 'threshold' },
      { name: 'spike_fallback_pct', val: spike_fallback_pct ?? null },
      { name: 'flatline_minutes', val: flatline_minutes ?? 30 },
      { name: 'sensitivity', val: sensitivity ?? 'medium' },
      { name: 'instance_group_id', val: instance_group_id ?? null },
    ];
    const active = cols.filter(c => existing.has(c.name));
    const setSql = active.map((c, i) => `${c.name}=$${i + 1}`).join(', ');
    const values = active.map(c => c.val);
    values.push(id);

    const result = await pool.query(
      `update control.alert_rule set ${setSql} where rule_id=$${values.length} returning *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kural bulunamadı' });
    res.json(result.rows[0]);
  } catch (e: any) {
    console.error('alert-rules PUT failed:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'update failed' });
  }
});

// Aktif/pasif toggle — PATCH /api/alert-rules/:id/toggle
router.patch('/:id/toggle', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Geçersiz rule_id' });

  const result = await pool.query(
    `update control.alert_rule
     set is_enabled = not is_enabled
     where rule_id = $1
     returning rule_id, rule_name, is_enabled`,
    [id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Kural bulunamadı' });
  res.json(result.rows[0]);
});

// Kural sil — DELETE /api/alert-rules/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Geçersiz rule_id' });

  const result = await pool.query(
    `delete from control.alert_rule where rule_id = $1 returning rule_id`,
    [id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Kural bulunamadı' });
  res.json({ deleted: true });
});

// Template'den kural oluştur — POST /api/alert-rules/from-template
router.post('/from-template', async (req: Request, res: Response) => {
  try {
    const { template_rule_id, rule_name, warning_threshold, critical_threshold, scope, instance_pk, service_group } = req.body;

    const tId = parseId(template_rule_id);
    if (!tId) return res.status(400).json({ error: 'Geçersiz template_rule_id' });

    // Template'i bul
    const tResult = await pool.query(
      'select * from control.alert_rule where rule_id = $1', [tId]
    );
    if (tResult.rows.length === 0) return res.status(404).json({ error: 'Template bulunamadı' });
    const t = tResult.rows[0];

    // Template'in tüm ilgili alanlarını kopyala — yeni kolonlar (alert_category,
    // sensitivity, flatline_minutes, spike_fallback_pct) mevcut DB'de varsa kullan
    const existing = await getExistingColumns();
    const cols: { name: string; val: any }[] = [
      { name: 'rule_name', val: rule_name || t.rule_name },
      { name: 'description', val: t.description },
      { name: 'metric_type', val: t.metric_type },
      { name: 'metric_name', val: t.metric_name },
      { name: 'scope', val: scope || t.scope },
      { name: 'instance_pk', val: instance_pk ?? null },
      { name: 'service_group', val: service_group ?? null },
      { name: 'condition_operator', val: t.condition_operator },
      { name: 'warning_threshold', val: warning_threshold ?? t.warning_threshold },
      { name: 'critical_threshold', val: critical_threshold ?? t.critical_threshold },
      { name: 'evaluation_window_minutes', val: t.evaluation_window_minutes },
      { name: 'aggregation', val: t.aggregation },
      { name: 'is_enabled', val: true },
      { name: 'cooldown_minutes', val: t.cooldown_minutes },
      { name: 'auto_resolve', val: t.auto_resolve },
      { name: 'evaluation_type', val: t.evaluation_type },
      { name: 'change_threshold_pct', val: t.change_threshold_pct },
      { name: 'min_data_days', val: t.min_data_days },
      { name: 'alert_category', val: t.alert_category },
      { name: 'spike_fallback_pct', val: t.spike_fallback_pct },
      { name: 'flatline_minutes', val: t.flatline_minutes },
      { name: 'sensitivity', val: t.sensitivity },
    ];
    const active = cols.filter(c => existing.has(c.name));
    const colList = active.map(c => c.name).join(', ');
    const placeholders = active.map((_, i) => `$${i + 1}`).join(', ');
    const values = active.map(c => c.val);

    const result = await pool.query(
      `insert into control.alert_rule (${colList}) values (${placeholders}) returning *`,
      values
    );
    res.status(201).json(result.rows[0]);
  } catch (e: any) {
    console.error('alert-rules from-template failed:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'from-template failed' });
  }
});

// ---

const VALID_EVAL_TYPES = ['threshold', 'alltime_high', 'alltime_low', 'day_over_day', 'week_over_week', 'spike', 'flatline', 'hourly_pattern', 'adaptive'];
const VALID_METRIC_TYPES = [
  'cluster_metric', 'io_metric', 'database_metric', 'statement_metric',
  'table_metric', 'index_metric', 'activity_metric', 'replication_metric',
  'wal_metric', 'archiver_metric', 'slot_metric', 'conflict_metric',
  'slru_metric', 'subscription_metric', 'prefetch_metric', 'function_metric'
];
const VALID_SCOPES = ['all_instances', 'specific_instance', 'service_group', 'instance_group'];
const VALID_OPS = ['>', '<', '>=', '<=', '='];
const VALID_AGGS = ['avg', 'sum', 'max', 'min', 'last', 'count'];

function validateRuleBody(b: any): string | null {
  if (!b.rule_name || typeof b.rule_name !== 'string' || b.rule_name.trim().length === 0)
    return 'rule_name zorunlu';
  if (!b.metric_type || !VALID_METRIC_TYPES.includes(b.metric_type))
    return 'Geçersiz metric_type';
  if (!b.metric_name || typeof b.metric_name !== 'string' || b.metric_name.trim().length === 0)
    return 'metric_name zorunlu';
  if (b.scope && !VALID_SCOPES.includes(b.scope))
    return 'Geçersiz scope';
  if (b.condition_operator && !VALID_OPS.includes(b.condition_operator))
    return 'Geçersiz condition_operator';
  if (b.aggregation && !VALID_AGGS.includes(b.aggregation))
    return 'Geçersiz aggregation';
  if (b.evaluation_type && !VALID_EVAL_TYPES.includes(b.evaluation_type))
    return 'Geçersiz evaluation_type';
  const evalType = b.evaluation_type || 'threshold';
  if (['day_over_day', 'week_over_week', 'hourly_pattern'].includes(evalType) && b.change_threshold_pct == null)
    return 'Bu evaluation_type için change_threshold_pct zorunlu';
  if (evalType === 'threshold' && b.warning_threshold == null && b.critical_threshold == null)
    return 'threshold tipi için warning_threshold veya critical_threshold zorunlu';
  if (b.alert_category && !['smart', 'threshold'].includes(b.alert_category))
    return 'Geçersiz alert_category';
  if (b.evaluation_window_minutes !== undefined && (b.evaluation_window_minutes < 1))
    return 'evaluation_window_minutes en az 1 olmalı';
  if (b.cooldown_minutes !== undefined && b.cooldown_minutes < 0)
    return 'cooldown_minutes negatif olamaz';
  return null;
}

export default router;
