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
    const allowed = ['cluster_metric','io_metric','database_metric','statement_metric',
                     'table_metric','index_metric','activity_metric','replication_metric'];
    if (allowed.includes(metricType)) {
      params.push(metricType);
      where += ` and r.metric_type = $${params.length}`;
    }
  }

  const q = `
    select
      r.rule_id,
      r.rule_name,
      r.description,
      r.metric_type,
      r.metric_name,
      r.scope,
      r.instance_pk,
      i.display_name as instance_name,
      r.service_group,
      r.condition_operator,
      r.warning_threshold,
      r.critical_threshold,
      r.evaluation_window_minutes,
      r.aggregation,
      r.evaluation_type,
      r.change_threshold_pct,
      r.min_data_days,
      r.is_enabled,
      r.cooldown_minutes,
      r.auto_resolve,
      r.created_by,
      r.created_at,
      r.updated_at,
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
  } catch (err) {
    throw err;
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
router.post('/', async (req: Request, res: Response) => {
  const err = validateRuleBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const {
    rule_name, description, metric_type, metric_name, scope,
    instance_pk, service_group, condition_operator,
    warning_threshold, critical_threshold, evaluation_window_minutes,
    aggregation, evaluation_type, change_threshold_pct, min_data_days,
    is_enabled, cooldown_minutes, auto_resolve
  } = req.body;

  const result = await pool.query(
    `insert into control.alert_rule
       (rule_name, description, metric_type, metric_name, scope, instance_pk,
        service_group, condition_operator, warning_threshold, critical_threshold,
        evaluation_window_minutes, aggregation, evaluation_type,
        change_threshold_pct, min_data_days,
        is_enabled, cooldown_minutes, auto_resolve)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     returning *`,
    [
      rule_name, description ?? null, metric_type, metric_name,
      scope ?? 'all_instances', instance_pk ?? null, service_group ?? null,
      condition_operator ?? '>', warning_threshold ?? null, critical_threshold ?? null,
      evaluation_window_minutes ?? 5, aggregation ?? 'avg',
      evaluation_type ?? 'threshold', change_threshold_pct ?? null,
      min_data_days ?? 7,
      is_enabled !== false, cooldown_minutes ?? 15, auto_resolve !== false
    ]
  );
  res.status(201).json(result.rows[0]);
});

// Kural güncelle — PUT /api/alert-rules/:id
router.put('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Geçersiz rule_id' });

  const err = validateRuleBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const {
    rule_name, description, metric_type, metric_name, scope,
    instance_pk, service_group, condition_operator,
    warning_threshold, critical_threshold, evaluation_window_minutes,
    aggregation, evaluation_type, change_threshold_pct, min_data_days,
    is_enabled, cooldown_minutes, auto_resolve
  } = req.body;

  const result = await pool.query(
    `update control.alert_rule set
       rule_name=$1, description=$2, metric_type=$3, metric_name=$4, scope=$5,
       instance_pk=$6, service_group=$7, condition_operator=$8,
       warning_threshold=$9, critical_threshold=$10,
       evaluation_window_minutes=$11, aggregation=$12,
       evaluation_type=$13, change_threshold_pct=$14, min_data_days=$15,
       is_enabled=$16, cooldown_minutes=$17, auto_resolve=$18
     where rule_id=$19
     returning *`,
    [
      rule_name, description ?? null, metric_type, metric_name,
      scope ?? 'all_instances', instance_pk ?? null, service_group ?? null,
      condition_operator ?? '>', warning_threshold ?? null, critical_threshold ?? null,
      evaluation_window_minutes ?? 5, aggregation ?? 'avg',
      evaluation_type ?? 'threshold', change_threshold_pct ?? null, min_data_days ?? 7,
      is_enabled !== false, cooldown_minutes ?? 15, auto_resolve !== false, id
    ]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Kural bulunamadı' });
  res.json(result.rows[0]);
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
  const { template_rule_id, rule_name, warning_threshold, critical_threshold, scope, instance_pk, service_group } = req.body;

  const tId = parseId(template_rule_id);
  if (!tId) return res.status(400).json({ error: 'Geçersiz template_rule_id' });

  // Template'i bul
  const tResult = await pool.query(
    'select * from control.alert_rule where rule_id = $1', [tId]
  );
  if (tResult.rows.length === 0) return res.status(404).json({ error: 'Template bulunamadı' });
  const t = tResult.rows[0];

  const result = await pool.query(
    `insert into control.alert_rule
       (rule_name, description, metric_type, metric_name, scope, instance_pk,
        service_group, condition_operator, warning_threshold, critical_threshold,
        evaluation_window_minutes, aggregation, evaluation_type,
        change_threshold_pct, min_data_days, is_enabled, cooldown_minutes, auto_resolve)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,$16,$17)
     returning *`,
    [
      rule_name || t.rule_name,
      t.description,
      t.metric_type,
      t.metric_name,
      scope || t.scope,
      instance_pk ?? null,
      service_group ?? null,
      t.condition_operator,
      warning_threshold ?? t.warning_threshold,
      critical_threshold ?? t.critical_threshold,
      t.evaluation_window_minutes,
      t.aggregation,
      t.evaluation_type,
      t.change_threshold_pct,
      t.min_data_days,
      t.cooldown_minutes,
      t.auto_resolve
    ]
  );
  res.status(201).json(result.rows[0]);
});

// ---

const VALID_EVAL_TYPES = ['threshold','alltime_high','alltime_low','day_over_day','week_over_week'];
const VALID_METRIC_TYPES = [
  'cluster_metric','io_metric','database_metric','statement_metric',
  'table_metric','index_metric','activity_metric','replication_metric'
];
const VALID_SCOPES = ['all_instances','specific_instance','service_group'];
const VALID_OPS = ['>','<','>=','<=','='];
const VALID_AGGS = ['avg','sum','max','min','last','count'];

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
  if (['day_over_day','week_over_week'].includes(evalType) && b.change_threshold_pct == null)
    return 'day_over_day/week_over_week için change_threshold_pct zorunlu';
  if (['threshold'].includes(evalType) && b.warning_threshold == null && b.critical_threshold == null)
    return 'threshold tipi için warning_threshold veya critical_threshold zorunlu';
  if (b.evaluation_window_minutes !== undefined && (b.evaluation_window_minutes < 1))
    return 'evaluation_window_minutes en az 1 olmalı';
  if (b.cooldown_minutes !== undefined && b.cooldown_minutes < 0)
    return 'cooldown_minutes negatif olamaz';
  return null;
}

export default router;
