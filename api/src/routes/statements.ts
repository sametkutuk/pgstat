import { Router } from 'express';
import { pool } from '../config/database';
import { parseHours, parseDays, parseLimit, parseId, parseOrderBy } from '../middleware/validation';

const router = Router();

function emptyClusterQueryTotals() {
  return { calls: 0, exec_ms: 0, rows_delta: 0, blks_hit: 0, blks_read: 0, temp_blks_written: 0, wal_bytes: 0 };
}

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

// GET /api/statements/search — dim.statement_series'ten SQL text araması
// Delta verisi olmayan sorgular dahil tüm bilinen sorguları döner
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q as string || '').trim();
    const instancePk = parseId(req.query.instance_pk);
    const limit = parseLimit(req.query.limit, 50);

    if (!q || q.length < 3) {
      res.json([]);
      return;
    }

    const params: any[] = [`%${q}%`, limit];
    let whereExtra = '';

    if (instancePk) {
      params.push(instancePk);
      whereExtra += ` and ss.instance_pk = $${params.length}`;
    }

    const result = await pool.query(`
      select
        ss.statement_series_id,
        ss.instance_pk,
        inv.display_name as instance_name,
        ss.queryid,
        ss.dbid,
        dbr.datname,
        rr.rolname,
        left(qt.query_text, 500) as query_text_short,
        ss.last_seen_at,
        coalesce(delta.total_calls, 0) as total_calls,
        coalesce(delta.total_exec_time_ms, 0) as total_exec_time_ms,
        coalesce(delta.avg_exec_time_ms, 0) as avg_exec_time_ms,
        coalesce(delta.total_rows, 0) as total_rows,
        coalesce(delta.total_shared_blks_read, 0) as total_shared_blks_read,
        coalesce(delta.total_temp_blks_written, 0) as total_temp_blks_written,
        case when delta.total_calls is null then true else false end as no_delta_data
      from dim.statement_series ss
      join control.instance_inventory inv on inv.instance_pk = ss.instance_pk
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      left join lateral (
        select
          sum(d.calls_delta) as total_calls,
          sum(d.total_exec_time_ms_delta) as total_exec_time_ms,
          sum(d.rows_delta) as total_rows,
          sum(d.shared_blks_read_delta) as total_shared_blks_read,
          sum(d.temp_blks_written_delta) as total_temp_blks_written,
          case when sum(d.calls_delta) > 0
            then sum(d.total_exec_time_ms_delta) / sum(d.calls_delta)
            else 0 end as avg_exec_time_ms
        from fact.pgss_delta d
        where d.statement_series_id = ss.statement_series_id
          and d.sample_ts >= now() - interval '7 days'
      ) delta on true
      where qt.query_text ilike $1
      ${whereExtra}
      order by ss.last_seen_at desc
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

// GET /api/statements/cluster/:queryid?from=ISO&to=ISO[&system_identifier=N]
// Aynı queryid'ye sahip TÜM instance'larda verilen zaman aralığındaki toplam.
router.get('/cluster/:queryid', async (req, res, next) => {
    try {
        const queryid = req.params.queryid;
        const fromIso = req.query.from as string | undefined;
        const toIso = req.query.to as string | undefined;
        const sysId = req.query.system_identifier as string | undefined;
        const from = fromIso || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const to = toIso || new Date().toISOString();
        if (!/^-?\d+$/.test(queryid)) {
            res.status(400).json({ error: 'Invalid queryid' });
            return;
        }
        if (sysId && !/^\d+$/.test(sysId)) {
            res.json({ queryid, from, to, instances: [], totals: emptyClusterQueryTotals(), query_text: null });
            return;
        }
        const params: any[] = [queryid, from, to];
        let sysFilter = '';
        if (sysId) { params.push(sysId); sysFilter = ` and c.system_identifier = $${params.length}::bigint`; }
        const r = await pool.query(`
            select
              i.instance_pk, i.display_name, i.host, i.port, c.system_identifier,
              c.is_primary, c.pg_major, ss.statement_series_id,
              coalesce(sum(d.calls_delta), 0) as calls,
              coalesce(sum(d.total_exec_time_ms_delta), 0) as exec_ms,
              coalesce(sum(d.rows_delta), 0) as rows_delta,
              coalesce(sum(d.shared_blks_hit_delta), 0) as blks_hit,
              coalesce(sum(d.shared_blks_read_delta), 0) as blks_read,
              coalesce(sum(d.temp_blks_written_delta), 0) as temp_blks_written,
              coalesce(sum(d.wal_bytes_delta), 0) as wal_bytes,
              left(coalesce(qt.query_text, ''), 500) as query_text,
              dbr.datname, rr.rolname
            from dim.statement_series ss
            join control.instance_inventory i on i.instance_pk = ss.instance_pk
            left join control.instance_capability c on c.instance_pk = i.instance_pk
            left join dim.query_text qt on qt.query_text_id = ss.query_text_id
            left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
            left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
            left join fact.pgss_delta d on d.statement_series_id = ss.statement_series_id
                 and d.sample_ts between $2::timestamptz and $3::timestamptz
            where ss.queryid = $1::bigint ${sysFilter}
            group by i.instance_pk, i.display_name, i.host, i.port, c.system_identifier,
                     c.is_primary, c.pg_major, ss.statement_series_id, qt.query_text,
                     dbr.datname, rr.rolname
            order by c.is_primary desc nulls last, i.display_name
        `, params);
        const totals = r.rows.reduce((a: any, x: any) => ({
            calls: a.calls + Number(x.calls),
            exec_ms: a.exec_ms + Number(x.exec_ms),
            rows_delta: a.rows_delta + Number(x.rows_delta),
            blks_hit: a.blks_hit + Number(x.blks_hit),
            blks_read: a.blks_read + Number(x.blks_read),
            temp_blks_written: a.temp_blks_written + Number(x.temp_blks_written),
            wal_bytes: a.wal_bytes + Number(x.wal_bytes),
        }), { calls: 0, exec_ms: 0, rows_delta: 0, blks_hit: 0, blks_read: 0, temp_blks_written: 0, wal_bytes: 0 });
        res.json({ queryid, from, to, instances: r.rows, totals, query_text: r.rows[0]?.query_text || null });
    } catch (err) { next(err); }
});

export default router;
