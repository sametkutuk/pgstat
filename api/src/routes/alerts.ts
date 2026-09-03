import { Router } from 'express';
import { pool } from '../config/database';
import { parseLimit } from '../middleware/validation';

const router = Router();

// GET /api/alerts — Alert listesi (filtrelenebilir)
router.get('/', async (req, res, next) => {
  try {
    const status = req.query.status as string; // open, acknowledged, resolved veya bos (tumu)
    const severity = req.query.severity as string;
    const instancePk = req.query.instance_pk as string;
    const source = req.query.source as string;
    const limit = parseLimit(req.query.limit, 100);

    let query = `
      select a.*, i.display_name, i.instance_id, i.host, i.port,
             r.rule_name, r.evaluation_type
      from ops.alert a
      left join control.instance_inventory i on i.instance_pk = a.instance_pk
      left join control.alert_rule r on r.rule_id = a.rule_id
      where 1=1
    `;
    const params: any[] = [];
    let paramIdx = 1;

    if (status) {
      query += ` and a.status = $${paramIdx++}`;
      params.push(status);
    }
    if (severity) {
      query += ` and a.severity = $${paramIdx++}`;
      params.push(severity);
    }
    if (instancePk) {
      query += ` and a.instance_pk = $${paramIdx++}`;
      params.push(instancePk);
    }
    if (source) {
      query += ` and a.alert_source = $${paramIdx++}`;
      params.push(source);
    }

    query += ` order by a.last_seen_at desc limit $${paramIdx}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/alerts/summary — Alert özet sayıları
router.get('/summary', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select
        severity,
        status,
        count(*) as count
      from ops.alert
      group by severity, status
      order by severity, status
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alerts/:id/acknowledge — Alert'i onayla (opsiyonel not ile)
router.patch('/:id/acknowledge', async (req, res, next) => {
  try {
    const { id } = req.params;
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
    const result = await pool.query(`
      update ops.alert
      set status = 'acknowledged',
          acknowledged_at = now(),
          last_seen_at = now(),
          acknowledge_note = $2
      where alert_id = $1 and status = 'open'
      returning *
    `, [id, note]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Alert bulunamadı veya zaten onaylanmış' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/alerts/evaluate-now — Tüm alert kurallarını hemen değerlendir
// Kullanıcı parametre değiştirip alert'in kapanmasını bekliyorsa 5-10s
// içinde re-evaluation tetiklenir (collector command queue üzerinden).
router.post('/evaluate-now', async (_req, res, next) => {
  try {
    const r = await pool.query(
      `insert into control.collector_command (command) values ('evaluate_alerts')
       returning command_id, status, requested_at`
    );
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/alerts/:id/resolve — Alert'i çöz
router.patch('/:id/resolve', async (req, res, next) => {
  try {
    const { id } = req.params;
    // Alert'i kapatirken ihlal epizodunu da kapat (PGSTAT-P0-048).
    //
    // Bu kanca ATLANIRSA epizot sonsuza kadar acik kalir ve cift yonlu
    // karsilastirma sorgusu 'epizot_var_alarm_yok' dondurur — yani kullanicinin
    // "Coz" dugmesi, dogrulama kapisini kendi basina kirar. "Kanca yalnizca
    // AlertRepository ve AlertService" tespiti alarm ACILISI icin dogruydu;
    // yasam dongusunun KAPANISINDA API de bir uretici.
    //
    // Tek ifade icinde CTE ile yapiliyor ki ikisi atomik olsun: alert kapanip
    // epizot acik kalan bir ara durum olusamaz.
    //
    // Epizodun state'i DEGISTIRILMEZ. Bu manuel bir kapatma; kosulun gectigini
    // kimse dogrulamadi, yalnizca kullanici alarmi kapatti. 'confirmed_healthy'
    // yazmak, veri yoklugunu saglik kaniti saymak olurdu.
    const result = await pool.query(`
      with kapanan as (
        update ops.alert
        set status = 'resolved', resolved_at = now(), last_seen_at = now()
        where alert_id = $1 and status <> 'resolved'
        returning *
      ), epizot as (
        update ops.alert_episode e
        set closed_at = now(),
            close_reason = 'manual',
            last_confirmed_at = now()
        from kapanan k
        where e.alert_key = k.alert_key
          and e.closed_at is null
        returning e.episode_id
      )
      select * from kapanan
    `, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Alert not found or already resolved' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
