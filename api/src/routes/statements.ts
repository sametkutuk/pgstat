import { Router } from 'express';
import { pool } from '../config/database';
import { parseHours, parseDays, parseLimit, parseId, parseOrderBy } from '../middleware/validation';

const router = Router();

function emptyClusterQueryTotals() {
  return { calls: 0, exec_ms: 0, rows_delta: 0, blks_hit: 0, blks_read: 0, temp_blks_written: 0, wal_bytes: 0 };
}

// ============================================================================
// pg_stat_statements metric whitelist — versiyon-agnostik default + opsiyonel
// Anahtar: API'nin response alani (camelCase yok, snake_case)
// Deger: SQL aggregate expression (group icin)
// since: ilk var oldugu PG surumu (UI'da rozet gostermek icin)
// ============================================================================
export type PgssCol = { sql: string; since: number; label: string };
export const PGSS_COLUMNS: Record<string, PgssCol> = {
  // Tum surumlerde olan (default) — 11+ olarak isaretlenmesi PG13'te rename'li
  // ama collector tek isime normalize ediyor (mean_time -> mean_exec_time vs.)
  total_calls:                { sql: 'sum(d.calls_delta)', since: 11, label: 'Calls' },
  total_exec_time_ms:         { sql: 'sum(d.total_exec_time_ms_delta)', since: 11, label: 'Toplam Süre (ms)' },
  total_rows:                 { sql: 'sum(d.rows_delta)', since: 11, label: 'Satır' },
  total_shared_blks_hit:      { sql: 'sum(d.shared_blks_hit_delta)', since: 11, label: 'Shared Blk Hit' },
  total_shared_blks_read:     { sql: 'sum(d.shared_blks_read_delta)', since: 11, label: 'Shared Blk Read' },
  total_shared_blks_dirtied:  { sql: 'sum(d.shared_blks_dirtied_delta)', since: 11, label: 'Shared Blk Dirtied' },
  total_shared_blks_written:  { sql: 'sum(d.shared_blks_written_delta)', since: 11, label: 'Shared Blk Written' },
  total_local_blks_hit:       { sql: 'sum(d.local_blks_hit_delta)', since: 11, label: 'Local Blk Hit' },
  total_local_blks_read:      { sql: 'sum(d.local_blks_read_delta)', since: 11, label: 'Local Blk Read' },
  total_local_blks_dirtied:   { sql: 'sum(d.local_blks_dirtied_delta)', since: 11, label: 'Local Blk Dirtied' },
  total_local_blks_written:   { sql: 'sum(d.local_blks_written_delta)', since: 11, label: 'Local Blk Written' },
  total_temp_blks_read:       { sql: 'sum(d.temp_blks_read_delta)', since: 11, label: 'Temp Blk Read' },
  total_temp_blks_written:    { sql: 'sum(d.temp_blks_written_delta)', since: 11, label: 'Temp Blk Written' },
  total_blk_read_time:        { sql: 'sum(d.blk_read_time_ms_delta)', since: 11, label: 'Blk Read Time (ms)' },
  total_blk_write_time:       { sql: 'sum(d.blk_write_time_ms_delta)', since: 11, label: 'Blk Write Time (ms)' },
  // mean/min/max/stddev SNAPSHOT (PG ham deger, delta degil)
  mean_exec_time_ms:          { sql: 'avg(d.mean_exec_time_ms)', since: 11, label: 'Ort. Exec (ms)' },
  min_exec_time_ms:           { sql: 'min(d.min_exec_time_ms)', since: 11, label: 'Min Exec (ms)' },
  max_exec_time_ms:           { sql: 'max(d.max_exec_time_ms)', since: 11, label: 'Max Exec (ms)' },
  stddev_exec_time_ms:        { sql: 'avg(d.stddev_exec_time_ms)', since: 11, label: 'Stddev Exec (ms)' },
  // PG13+ — wal
  total_wal_records:          { sql: 'sum(d.wal_records_delta)', since: 13, label: 'WAL Records' },
  total_wal_fpi:              { sql: 'sum(d.wal_fpi_delta)', since: 13, label: 'WAL FPI' },
  total_wal_bytes:            { sql: 'sum(d.wal_bytes_delta::numeric)', since: 13, label: 'WAL Bytes' },
  // PG13+ — plan metrics
  total_plans:                { sql: 'sum(d.plans_delta)', since: 13, label: 'Plans' },
  total_plan_time_ms:         { sql: 'sum(d.total_plan_time_ms_delta)', since: 13, label: 'Toplam Plan (ms)' },
  mean_plan_time_ms:          { sql: 'avg(d.mean_plan_time_ms)', since: 13, label: 'Ort. Plan (ms)' },
  min_plan_time_ms:           { sql: 'min(d.min_plan_time_ms)', since: 13, label: 'Min Plan (ms)' },
  max_plan_time_ms:           { sql: 'max(d.max_plan_time_ms)', since: 13, label: 'Max Plan (ms)' },
  stddev_plan_time_ms:        { sql: 'avg(d.stddev_plan_time_ms)', since: 13, label: 'Stddev Plan (ms)' },
  // PG15+ — temp blk time, jit count
  total_temp_blk_read_time:   { sql: 'sum(d.temp_blk_read_time_ms_delta)', since: 15, label: 'Temp Blk Read Time (ms)' },
  total_temp_blk_write_time:  { sql: 'sum(d.temp_blk_write_time_ms_delta)', since: 15, label: 'Temp Blk Write Time (ms)' },
  total_jit_functions:        { sql: 'sum(d.jit_functions_delta)', since: 15, label: 'JIT Functions' },
  total_jit_generation_time:  { sql: 'sum(d.jit_generation_time_ms_delta)', since: 15, label: 'JIT Gen (ms)' },
  total_jit_inlining_time:    { sql: 'sum(d.jit_inlining_time_ms_delta)', since: 15, label: 'JIT Inl (ms)' },
  total_jit_optimization_time:{ sql: 'sum(d.jit_optimization_time_ms_delta)', since: 15, label: 'JIT Opt (ms)' },
  total_jit_emission_time:    { sql: 'sum(d.jit_emission_time_ms_delta)', since: 15, label: 'JIT Emit (ms)' },
  total_jit_inlining_count:   { sql: 'sum(d.jit_inlining_count)', since: 15, label: 'JIT Inl Count' },
  total_jit_optimization_count:{ sql: 'sum(d.jit_optimization_count)', since: 15, label: 'JIT Opt Count' },
  total_jit_emission_count:   { sql: 'sum(d.jit_emission_count)', since: 15, label: 'JIT Emit Count' },
  // PG16+ — jit deform
  total_jit_deform_count:     { sql: 'sum(d.jit_deform_count_delta)', since: 16, label: 'JIT Deform Count' },
  total_jit_deform_time:      { sql: 'sum(d.jit_deform_time_ms_delta)', since: 16, label: 'JIT Deform (ms)' },
  // PG17+ — blk time split
  total_shared_blk_read_time: { sql: 'sum(d.shared_blk_read_time_ms_delta)', since: 17, label: 'Shared Blk Read Time (ms)' },
  total_shared_blk_write_time:{ sql: 'sum(d.shared_blk_write_time_ms_delta)', since: 17, label: 'Shared Blk Write Time (ms)' },
  total_local_blk_read_time:  { sql: 'sum(d.local_blk_read_time_ms_delta)', since: 17, label: 'Local Blk Read Time (ms)' },
  total_local_blk_write_time: { sql: 'sum(d.local_blk_write_time_ms_delta)', since: 17, label: 'Local Blk Write Time (ms)' },
  // PG18+ — wal_buffers_full, parallel workers
  total_wal_buffers_full:     { sql: 'sum(d.wal_buffers_full_delta)', since: 18, label: 'WAL Buffers Full' },
  total_parallel_to_launch:   { sql: 'sum(d.parallel_workers_to_launch_delta)', since: 18, label: 'Parallel To Launch' },
  total_parallel_launched:    { sql: 'sum(d.parallel_workers_launched_delta)', since: 18, label: 'Parallel Launched' },
};

// Versiyon-agnostik default kolonlar (PG11+ hepsinde dolar)
export const DEFAULT_COLUMNS: string[] = [
  'total_calls',
  'total_exec_time_ms',
  'mean_exec_time_ms',
  'min_exec_time_ms',
  'max_exec_time_ms',
  'stddev_exec_time_ms',
  'total_rows',
  'total_shared_blks_hit',
  'total_shared_blks_read',
  'total_temp_blks_written',
  'total_blk_read_time',
];

export function parseRequestedColumns(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_COLUMNS;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  // Whitelist filtresi — bilinmeyen kolon adlarini sessizce at
  const safe = list.filter(c => Object.prototype.hasOwnProperty.call(PGSS_COLUMNS, c));
  return safe.length > 0 ? safe : DEFAULT_COLUMNS;
}

// Whitelist meta endpoint — UI sutun yonet modali bunu kullanir
router.get('/columns', (_req, res) => {
  res.json({
    defaults: DEFAULT_COLUMNS,
    available: Object.entries(PGSS_COLUMNS).map(([key, v]) => ({
      key, label: v.label, since: v.since,
    })),
  });
});

// Tek SQL fetch — DB rahatlatma (UI React Query cache'ler)
router.get('/text/:queryTextId', async (req, res, next) => {
  try {
    const id = parseId(req.params.queryTextId);
    if (!id) {
      res.status(400).json({ error: 'invalid queryTextId' });
      return;
    }
    const r = await pool.query(
      'select query_text from dim.query_text where query_text_id = $1',
      [id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ query_text: r.rows[0].query_text });
  } catch (err) {
    next(err);
  }
});

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

    // Kullanici secimi: ?columns=col1,col2,... ; bos -> default 11 kolon
    const requestedCols = parseRequestedColumns(req.query.columns as string | undefined);

    // Order by — sadece secilen kolonlardan biri olabilir (whitelist guvenligi)
    const orderColRaw = (req.query.order_by as string) || 'total_exec_time_ms';
    const orderCol = requestedCols.includes(orderColRaw) ? orderColRaw
                     : (requestedCols.includes('total_exec_time_ms') ? 'total_exec_time_ms'
                        : requestedCols[0]);

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

    // Dinamik SELECT — kullanicinin istedigi kolonlari ekle
    const selectCols = requestedCols
      .map(c => `${PGSS_COLUMNS[c].sql} as ${c}`)
      .join(',\n        ');

    const result = await pool.query(`
      select
        d.instance_pk,
        inv.display_name as instance_name,
        ss.statement_series_id,
        ss.queryid,
        ss.query_text_id,
        dbr.datname,
        rr.rolname,
        left(qt.query_text, 80) as query_text_short,
        ${selectCols}
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      join control.instance_inventory inv on inv.instance_pk = d.instance_pk
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.sample_ts >= now() - make_interval(hours => $1)
      ${whereExtra}
      group by d.instance_pk, inv.display_name, ss.statement_series_id,
               ss.queryid, ss.query_text_id, dbr.datname, rr.rolname, qt.query_text
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
