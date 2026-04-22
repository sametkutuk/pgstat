import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

// GET /api/schedule-profiles — Zamanlama profilleri listesi
router.get('/', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select sp.*,
        (select count(*) from control.instance_inventory i
         where i.schedule_profile_id = sp.schedule_profile_id) as bound_instances
      from control.schedule_profile sp
      order by sp.profile_code
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/schedule-profiles — Yeni zamanlama profili
router.post('/', async (req, res, next) => {
  try {
    const {
      profile_code, cluster_interval_seconds, statements_interval_seconds,
      db_objects_interval_seconds, hourly_rollup_interval_seconds,
      daily_rollup_hour_utc, bootstrap_sql_text_batch,
      max_databases_per_run, statement_timeout_ms, lock_timeout_ms,
      connect_timeout_seconds, max_host_concurrency
    } = req.body;

    const result = await pool.query(`
      insert into control.schedule_profile (
        profile_code, cluster_interval_seconds, statements_interval_seconds,
        db_objects_interval_seconds, hourly_rollup_interval_seconds,
        daily_rollup_hour_utc, bootstrap_sql_text_batch,
        max_databases_per_run, statement_timeout_ms, lock_timeout_ms,
        connect_timeout_seconds, max_host_concurrency
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      returning *
    `, [
      profile_code, cluster_interval_seconds, statements_interval_seconds,
      db_objects_interval_seconds, hourly_rollup_interval_seconds,
      daily_rollup_hour_utc, bootstrap_sql_text_batch,
      max_databases_per_run, statement_timeout_ms, lock_timeout_ms,
      connect_timeout_seconds, max_host_concurrency
    ]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/schedule-profiles/:id — Zamanlama profili güncelle
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      cluster_interval_seconds, statements_interval_seconds,
      db_objects_interval_seconds, statement_timeout_ms,
      lock_timeout_ms, connect_timeout_seconds, max_host_concurrency
    } = req.body;

    const result = await pool.query(`
      update control.schedule_profile set
        cluster_interval_seconds = $2, statements_interval_seconds = $3,
        db_objects_interval_seconds = $4, statement_timeout_ms = $5,
        lock_timeout_ms = $6, connect_timeout_seconds = $7,
        max_host_concurrency = $8
      where schedule_profile_id = $1
      returning *
    `, [
      id, cluster_interval_seconds, statements_interval_seconds,
      db_objects_interval_seconds, statement_timeout_ms,
      lock_timeout_ms, connect_timeout_seconds, max_host_concurrency
    ]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Schedule profile not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/schedule-profiles/:id — Zamanlama profili sil (0 bağlı instance gerekli)
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const check = await pool.query(
      'select count(*) as cnt from control.instance_inventory where schedule_profile_id = $1',
      [id]
    );
    if (parseInt(check.rows[0].cnt) > 0) {
      res.status(409).json({ error: 'Bu profile bağlı instance var, silinemez.' });
      return;
    }
    await pool.query('delete from control.schedule_profile where schedule_profile_id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
