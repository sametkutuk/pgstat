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
    const limit = parseLimit(req.query.limit, 100);

    let query = `
      select a.*, i.display_name, i.instance_id, i.host, i.port
      from ops.alert a
      left join control.instance_inventory i on i.instance_pk = a.instance_pk
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

// PATCH /api/alerts/:id/acknowledge — Alert'i onayla
router.patch('/:id/acknowledge', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      update ops.alert
      set status = 'acknowledged', acknowledged_at = now(), last_seen_at = now()
      where alert_id = $1 and status = 'open'
      returning *
    `, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Alert not found or already acknowledged' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alerts/:id/resolve — Alert'i çöz
router.patch('/:id/resolve', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      update ops.alert
      set status = 'resolved', resolved_at = now(), last_seen_at = now()
      where alert_id = $1 and status <> 'resolved'
      returning *
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
