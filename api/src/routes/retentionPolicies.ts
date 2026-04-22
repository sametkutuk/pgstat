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

// POST /api/retention-policies — Yeni retention politikası
router.post('/', async (req, res, next) => {
  try {
    const { policy_code, raw_retention_months, hourly_retention_months, daily_retention_months } = req.body;
    const result = await pool.query(`
      insert into control.retention_policy (policy_code, raw_retention_months, hourly_retention_months, daily_retention_months)
      values ($1, $2, $3, $4)
      returning *
    `, [policy_code, raw_retention_months, hourly_retention_months, daily_retention_months]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/retention-policies/:id — Retention politikası güncelle
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { raw_retention_months, hourly_retention_months, daily_retention_months } = req.body;
    const result = await pool.query(`
      update control.retention_policy
      set raw_retention_months = $2, hourly_retention_months = $3, daily_retention_months = $4
      where retention_policy_id = $1
      returning *
    `, [id, raw_retention_months, hourly_retention_months, daily_retention_months]);
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
    // Bağlı instance kontrolü
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
