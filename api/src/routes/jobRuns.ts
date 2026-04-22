import { Router } from 'express';
import { pool } from '../config/database';
import { parseLimit } from '../middleware/validation';

const router = Router();

// GET /api/job-runs — Job çalıştırma geçmişi (filtrelenebilir)
// per_type=N: her job tipi için son N kaydı döner (tümü görünümü için)
// job_type + limit: belirli tip için son N kayıt
router.get('/', async (req, res, next) => {
  try {
    const perType = parseLimit(req.query.per_type, 0);
    const limit = parseLimit(req.query.limit, 50);
    const jobType = req.query.job_type as string;
    const status = req.query.status as string;

    if (perType > 0 && !jobType) {
      // Her job tipi için son N kaydı döndür
      const result = await pool.query(`
        select * from (
          select *, row_number() over (partition by job_type order by started_at desc) as rn
          from ops.job_run
          ${status ? 'where status = $2' : ''}
        ) sub
        where rn <= $1
        order by started_at desc
      `, status ? [perType, status] : [perType]);
      res.json(result.rows);
      return;
    }

    let query = `select * from ops.job_run where 1=1`;
    const params: any[] = [];
    let paramIdx = 1;

    if (jobType) {
      query += ` and job_type = $${paramIdx++}`;
      params.push(jobType);
    }
    if (status) {
      query += ` and status = $${paramIdx++}`;
      params.push(status);
    }

    query += ` order by started_at desc limit $${paramIdx}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/job-runs/stats — Job türü bazında başarı/hata istatistikleri (son 24 saat)
router.get('/stats', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select
        job_type,
        count(*) as total_runs,
        count(*) filter (where status = 'success') as success_count,
        count(*) filter (where status = 'failed') as failed_count,
        count(*) filter (where status = 'partial') as partial_count,
        avg(extract(epoch from (finished_at - started_at))) as avg_duration_seconds,
        sum(rows_written) as total_rows_written
      from ops.job_run
      where started_at >= now() - interval '24 hours'
      group by job_type
      order by job_type
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/job-runs/:id — Tek job run detayı
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`select * from ops.job_run where job_run_id = $1`, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job run not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/job-runs/:id/instances — Job'un instance detayları
router.get('/:id/instances', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      select jri.*, i.display_name, i.instance_id, i.host, i.port
      from ops.job_run_instance jri
      left join control.instance_inventory i on i.instance_pk = jri.instance_pk
      where jri.job_run_id = $1
      order by jri.started_at
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

export default router;
