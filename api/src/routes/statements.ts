import { Router } from 'express';
import { pool } from '../config/database';
import { parseHours, parseDays, parseLimit, parseId, parseOrderBy } from '../middleware/validation';

const router = Router();

// GET /api/statements/top — Tüm instance'lar genelinde top statement'lar
// Filtreler: hours, limit, order_by, instance_pk, datname, rolname
router.get('/top', async (req, res, next) => {
  try {
    const hours = parseHours(req.query.hours, 1);
    const limit = parseLimit(req.query.limit, 100);
    const instancePk = parseId(req.query.instance_pk);
    const datname = (req.query.datname as string) || null;
    const rolname = (req.query.rolname as string) || null;
    const queryid = (req.query.queryid as string) || null;

    const orderMap: Record<string, string> = {
      exec_time: 'total_exec_time_ms',
      avg_time: 'avg_exec_time_ms',
      calls: 'total_calls',
      rows: 'total_rows',
      blks_read: 'total_shared_blks_read',
      temp_blks: 'total_temp_blks_written',
    };
    const orderCol = parseOrderBy(req.query.order_by, orderMap, 'total_exec_time_ms');

    const params: any[] = [hours, limit];
    let whereExtra = '';

    if (instancePk) {
      params.push(instancePk);
      whereExtra += ` and d.instance_pk = $${params.length}`;
    }
    if (datname) {
      params.push(datname);
      whereExtra += ` and dbr.datname = $${params.length}`;
    }
    if (rolname) {
      params.push(rolname);
      whereExtra += ` and rr.rolname = $${params.length}`;
    }
    if (queryid) {
      params.push(queryid);
      whereExtra += ` and ss.queryid = $${params.length}`;
    }

    const result = await pool.query(`
      select
        d.instance_pk,
        inv.display_name as instance_name,
        ss.statement_series_id,
        ss.dbid, ss.queryid,
        dbr.datname,
        rr.rolname,
        left(qt.query_text, 500) as query_text_short,
        sum(d.calls_delta) as total_calls,
        sum(d.total_exec_time_ms_delta) as total_exec_time_ms,
        sum(d.rows_delta) as total_rows,
        sum(d.shared_blks_hit_delta) as total_shared_blks_hit,
        sum(d.shared_blks_read_delta) as total_shared_blks_read,
        sum(d.temp_blks_written_delta) as total_temp_blks_written,
        case when sum(d.calls_delta) > 0
          then sum(d.total_exec_time_ms_delta) / sum(d.calls_delta)
          else 0 end as avg_exec_time_ms
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      join control.instance_inventory inv on inv.instance_pk = d.instance_pk
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.sample_ts >= now() - make_interval(hours => $1)
      ${whereExtra}
      group by d.instance_pk, inv.display_name, ss.statement_series_id,
               ss.dbid, ss.queryid, dbr.datname, rr.rolname, qt.query_text
      order by ${orderCol} desc nulls last
      limit $2
    `, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/statements/:seriesId — Tek statement serisi detayı (zaman serisi)
router.get('/:seriesId', async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const hours = parseHours(req.query.hours, 24);

    // Seri bilgisi
    const seriesResult = await pool.query(`
      select ss.*, qt.query_text, dbr.datname, rr.rolname
      from dim.statement_series ss
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
      where ss.statement_series_id = $1
    `, [seriesId]);

    if (seriesResult.rows.length === 0) {
      res.status(404).json({ error: 'Statement series not found' });
      return;
    }

    // Zaman serisi delta verileri
    const deltaResult = await pool.query(`
      select
        sample_ts,
        calls_delta, total_exec_time_ms_delta, rows_delta,
        shared_blks_hit_delta, shared_blks_read_delta,
        temp_blks_read_delta, temp_blks_written_delta,
        blk_read_time_ms_delta, blk_write_time_ms_delta
      from fact.pgss_delta
      where statement_series_id = $1
        and sample_ts >= now() - make_interval(hours => $2)
      order by sample_ts
    `, [seriesId, hours]);

    res.json({
      series: seriesResult.rows[0],
      deltas: deltaResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/statements/:seriesId/hourly — Saatlik rollup zaman serisi
router.get('/:seriesId/hourly', async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const days = parseDays(req.query.days, 7);

    const result = await pool.query(`
      select
        bucket_start,
        calls_sum, exec_time_ms_sum, rows_sum,
        shared_blks_read_sum, shared_blks_hit_sum, temp_blks_written_sum
      from agg.pgss_hourly
      where statement_series_id = $1
        and bucket_start >= now() - make_interval(days => $2)
      order by bucket_start
    `, [seriesId, days]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/statements/:seriesId/daily — Günlük rollup zaman serisi
router.get('/:seriesId/daily', async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const days = parseDays(req.query.days, 30);

    const result = await pool.query(`
      select
        bucket_start,
        calls_sum, exec_time_ms_sum, rows_sum,
        shared_blks_read_sum, shared_blks_hit_sum, temp_blks_written_sum
      from agg.pgss_daily
      where statement_series_id = $1
        and bucket_start >= now() - make_interval(days => $2)
      order by bucket_start
    `, [seriesId, days]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

export default router;
