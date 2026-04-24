import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

// GET /api/retention-policies — Retention politikaları listesi
router.get('/', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select rp.*,
        (select count(*) from control.instance_inventory i
         where i.retention_policy_id = rp.retention_policy_id) as bound_instances
      from control.retention_policy rp
      order by rp.policy_code
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/retention-policies — Yeni retention politikası (day-bazlı)
router.post('/', async (req, res, next) => {
  try {
    const {
      policy_code,
      raw_retention_days, hourly_retention_days, daily_retention_days,
      snapshot_retention_hours,
      // Eski _months alanları da kabul edilir (day'e çevrilir)
      raw_retention_months, hourly_retention_months, daily_retention_months,
    } = req.body;

    const rawDays    = raw_retention_days    ?? (raw_retention_months    ? raw_retention_months    * 30 : 14);
    const hourlyDays = hourly_retention_days ?? (hourly_retention_months ? hourly_retention_months * 30 : 60);
    const dailyDays  = daily_retention_days  ?? (daily_retention_months  ? daily_retention_months  * 30 : 730);
    const snapHours  = snapshot_retention_hours ?? 48;

    const result = await pool.query(`
      insert into control.retention_policy (
        policy_code,
        raw_retention_months, hourly_retention_months, daily_retention_months,
        raw_retention_days,   hourly_retention_days,   daily_retention_days,
        snapshot_retention_hours
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      returning *
    `, [
      policy_code,
      Math.max(1, Math.ceil(rawDays / 30)),
      Math.max(1, Math.ceil(hourlyDays / 30)),
      Math.max(1, Math.ceil(dailyDays / 30)),
      rawDays, hourlyDays, dailyDays,
      snapHours,
    ]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/retention-policies/:id — Retention politikası güncelle (day-bazlı)
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      raw_retention_days, hourly_retention_days, daily_retention_days,
      snapshot_retention_hours,
      raw_retention_months, hourly_retention_months, daily_retention_months,
    } = req.body;

    // day veya months'tan biri gelsin
    const rawDays    = raw_retention_days    ?? (raw_retention_months    ? raw_retention_months    * 30 : null);
    const hourlyDays = hourly_retention_days ?? (hourly_retention_months ? hourly_retention_months * 30 : null);
    const dailyDays  = daily_retention_days  ?? (daily_retention_months  ? daily_retention_months  * 30 : null);

    if (rawDays == null || hourlyDays == null || dailyDays == null) {
      res.status(400).json({ error: 'raw/hourly/daily retention süresi zorunlu' });
      return;
    }

    const result = await pool.query(`
      update control.retention_policy
      set raw_retention_days       = $2,
          hourly_retention_days    = $3,
          daily_retention_days     = $4,
          snapshot_retention_hours = coalesce($5, snapshot_retention_hours),
          raw_retention_months     = greatest(1, ceil($2::numeric / 30)::int),
          hourly_retention_months  = greatest(1, ceil($3::numeric / 30)::int),
          daily_retention_months   = greatest(1, ceil($4::numeric / 30)::int)
      where retention_policy_id = $1
      returning *
    `, [id, rawDays, hourlyDays, dailyDays, snapshot_retention_hours ?? null]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Retention policy not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/retention-policies/:id — Retention politikası sil (0 bağlı instance gerekli)
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      'select count(*) as cnt from control.instance_inventory where retention_policy_id = $1',
      [id]
    );
    if (parseInt(check.rows[0].cnt) > 0) {
      res.status(409).json({ error: 'Bu politikaya bağlı instance var, silinemez.' });
      return;
    }
    await pool.query('delete from control.retention_policy where retention_policy_id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
