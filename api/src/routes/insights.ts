import { Router } from 'express';
import { pool } from '../config/database';
import { parseTimeRange, parseLimit } from '../middleware/validation';

const router = Router();

type CompareKey = '1h' | '1d' | '1w' | '1m';

const COMPARE_OFFSETS: Record<CompareKey, { seconds: number; intervalSql: string }> = {
    '1h': { seconds: 3_600, intervalSql: `interval '1 hour'` },
    '1d': { seconds: 86_400, intervalSql: `interval '1 day'` },
    '1w': { seconds: 604_800, intervalSql: `interval '7 days'` },
    '1m': { seconds: 2_592_000, intervalSql: `interval '30 days'` },
};

function parseCompareParam(value: unknown): CompareKey | null {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (raw === '1h' || raw === '1d' || raw === '1w' || raw === '1m') return raw;
    throw new Error('Invalid compare');
}

function shiftedIso(iso: string, offsetSeconds: number): string {
    return new Date(new Date(iso).getTime() - offsetSeconds * 1000).toISOString();
}

function pgssBucketExpr(windowHours: number): string {
    if (windowHours <= 6) {
        return `date_trunc('hour', d.sample_ts) + make_interval(mins => (extract(minute from d.sample_ts)::int / 5) * 5)`;
    }
    if (windowHours <= 7 * 24) {
        return `date_trunc('hour', d.sample_ts)`;
    }
    if (windowHours <= 30 * 24) {
        return `date_trunc('day', d.sample_ts) + make_interval(hours => (extract(hour from d.sample_ts)::int / 6) * 6)`;
    }
    return `date_trunc('day', d.sample_ts)`;
}

// pgssBucketExpr'e karsilik gelen bucket adimi. generate_series icin
// kullanilir — boylece pencerede veri olmayan bucket'lar 0 ile doldurulur.
function pgssBucketStepSql(windowHours: number): string {
    if (windowHours <= 6) return `interval '5 minutes'`;
    if (windowHours <= 7 * 24) return `interval '1 hour'`;
    if (windowHours <= 30 * 24) return `interval '6 hours'`;
    return `interval '1 day'`;
}

// Pencere baslangicini bucket sinirina hizala (generate_series'in ilk
// noktasi grid ile uyumlu olsun).
function pgssBucketAlignSql(windowHours: number, paramIndex: number): string {
    if (windowHours <= 6) {
        return `(date_trunc('hour', $${paramIndex}::timestamptz)
                 + make_interval(mins => (extract(minute from $${paramIndex}::timestamptz)::int / 5) * 5))`;
    }
    if (windowHours <= 7 * 24) {
        return `date_trunc('hour', $${paramIndex}::timestamptz)`;
    }
    if (windowHours <= 30 * 24) {
        return `(date_trunc('day', $${paramIndex}::timestamptz)
                 + make_interval(hours => (extract(hour from $${paramIndex}::timestamptz)::int / 6) * 6))`;
    }
    return `date_trunc('day', $${paramIndex}::timestamptz)`;
}

async function fetchDbTimeTrend(id: string, fromIso: string, toIso: string, datname: string, searchRaw: string, bucketExpr: string, windowHours: number, alignIntervalSql?: string) {
    const params: any[] = [id, fromIso, toIso];
    let dbWhere = '';
    if (searchRaw) {
        if (/^-?\d+$/.test(searchRaw)) {
            params.push(searchRaw);
            dbWhere += ` and ss.queryid::text = $${params.length}`;
        } else {
            params.push(searchRaw);
            dbWhere += ` and qt.query_text ilike $${params.length}`;
        }
    }
    if (datname) {
        params.push(datname);
        dbWhere += ` and dbr.datname = $${params.length}`;
    }
    const stepSql = pgssBucketStepSql(windowHours);
    // $2 ve $3 from/to. Grid'i bucket sinirina hizala.
    const gridStart = pgssBucketAlignSql(windowHours, 2);
    const alignedSelect = alignIntervalSql ? `, g.bucket_start + ${alignIntervalSql} as bucket_aligned` : '';
    return pool.query(`
        with buckets as (
          select
            ${bucketExpr} as bucket_start,
            coalesce(sum(d.total_exec_time_ms_delta), 0)::double precision as total_ms,
            coalesce(sum(d.calls_delta), 0)::bigint as total_calls
          from fact.pgss_delta d
          join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
          left join dim.query_text qt on qt.query_text_id = ss.query_text_id
          left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
          where d.instance_pk = $1
            and d.sample_ts between $2::timestamptz and $3::timestamptz
            ${dbWhere}
          group by bucket_start
        ),
        grid as (
          select gs as bucket_start
          from generate_series(${gridStart}, $3::timestamptz, ${stepSql}) gs
        )
        select
          g.bucket_start${alignedSelect},
          coalesce(b.total_ms, 0)::double precision as total_ms,
          coalesce(b.total_calls, 0)::bigint as total_calls
        from grid g
        left join buckets b on b.bucket_start = g.bucket_start
        order by g.bucket_start
    `, params);
}

async function fetchQueryTrend(id: string, seriesId: string, fromIso: string, toIso: string, bucketExpr: string, windowHours: number, alignIntervalSql?: string) {
    const stepSql = pgssBucketStepSql(windowHours);
    // $3 ve $4 from/to (1: id, 2: seriesId).
    const gridStart = pgssBucketAlignSql(windowHours, 3);
    const alignedSelect = alignIntervalSql ? `, g.bucket_start + ${alignIntervalSql} as bucket_aligned` : '';
    return pool.query(`
        with buckets as (
          select
            ${bucketExpr} as bucket_start,
            coalesce(sum(d.calls_delta), 0)::bigint as calls,
            coalesce(sum(d.total_exec_time_ms_delta), 0)::double precision as total_ms,
            min(d.min_exec_time_ms)::double precision as min_ms,
            avg(d.mean_exec_time_ms)::double precision as avg_ms,
            max(d.max_exec_time_ms)::double precision as max_ms
          from fact.pgss_delta d
          where d.instance_pk = $1
            and d.statement_series_id = $2::bigint
            and d.sample_ts between $3::timestamptz and $4::timestamptz
          group by bucket_start
        ),
        grid as (
          select gs as bucket_start
          from generate_series(${gridStart}, $4::timestamptz, ${stepSql}) gs
        )
        select
          g.bucket_start${alignedSelect},
          coalesce(b.calls, 0)::bigint as calls,
          coalesce(b.total_ms, 0)::double precision as total_ms,
          b.min_ms,
          b.avg_ms,
          b.max_ms
        from grid g
        left join buckets b on b.bucket_start = g.bucket_start
        order by g.bucket_start
    `, [id, seriesId, fromIso, toIso]);
}

// GET /api/insights/:id/db-time-trend?from=...&to=...[&datname=...]
router.get('/:id/db-time-trend', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        let compare: CompareKey | null = null;
        try {
            compare = parseCompareParam(req.query.compare);
        } catch {
            res.status(400).json({ error: 'Invalid compare. Allowed values: 1h, 1d, 1w, 1m' });
            return;
        }
        const datname = (req.query.datname as string || '').trim();
        const searchRaw = (req.query.search as string || '').trim();

        // Bucket granulu pencereye gore secilir; fact.pgss_delta'dan okuyoruz.
        // <=6s: 5dk, <=7g: 1s, <=30g: 6s, >30g: 1g.
        const windowHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
        const bucketExpr = pgssBucketExpr(windowHours);

        // Baseline = ayni pencere + datname filtresi var ama search YOK. Yani
        // kullanici '%select%hotel%' yazdiginda foreground o sorgular,
        // background DB'nin (veya tum instance'in) toplam yuku — karsilastirma
        // baglami. Search uygulanmamissa baseline current ile ozdes oldugundan
        // ekstra sorgu calistirma.
        const includeBaseline = String(req.query.include_baseline || '').trim() === '1';
        const baselineNeeded = includeBaseline && searchRaw !== '';

        const [current, baselineRes] = await Promise.all([
            fetchDbTimeTrend(id, fromIso, toIso, datname, searchRaw, bucketExpr, windowHours),
            baselineNeeded
                ? fetchDbTimeTrend(id, fromIso, toIso, datname, '', bucketExpr, windowHours)
                : Promise.resolve(null),
        ]);

        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchDbTimeTrend(
                id,
                shiftedIso(fromIso, offset.seconds),
                shiftedIso(toIso, offset.seconds),
                datname,
                searchRaw,
                bucketExpr,
                windowHours,
                offset.intervalSql,
            )).rows;
        }
        const baseline = baselineRes ? baselineRes.rows : null;
        res.json({ current: current.rows, previous, compare, baseline });
    } catch (err) {
        next(err);
    }
});

// GET /api/insights/:id/query-trend?series_id=N&from=...&to=...
router.get('/:id/query-trend', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        let compare: CompareKey | null = null;
        try {
            compare = parseCompareParam(req.query.compare);
        } catch {
            res.status(400).json({ error: 'Invalid compare. Allowed values: 1h, 1d, 1w, 1m' });
            return;
        }
        const seriesIdRaw = String(req.query.series_id || '');
        if (!/^\d+$/.test(seriesIdRaw)) {
            res.status(400).json({ error: 'Invalid series_id' });
            return;
        }

        const windowHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
        const bucketExpr = pgssBucketExpr(windowHours);

        const current = await fetchQueryTrend(id, seriesIdRaw, fromIso, toIso, bucketExpr, windowHours);
        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchQueryTrend(
                id,
                seriesIdRaw,
                shiftedIso(fromIso, offset.seconds),
                shiftedIso(toIso, offset.seconds),
                bucketExpr,
                windowHours,
                offset.intervalSql,
            )).rows;
        }
        res.json({ current: current.rows, previous, compare });
    } catch (err) {
        next(err);
    }
});

// GET /api/insights/:id/top-queries?sort=time|calls|slow&from=...&to=...&limit=20
// 3 farklı predefined sıralama:
//   time  → toplam exec_time (DB zamanını en çok kim yiyor)
//   calls → toplam çağrı sayısı (en sık çalışan)
//   slow  → ortalama exec time (en yavaş, min 10 çağrı şartı — tek-spike eleme)
router.get('/:id/top-queries', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        const limit = parseLimit(req.query.limit, 20);
        const sort = String(req.query.sort || 'time').toLowerCase();

        // Sıralama whitelist
        let orderBy: string;
        if (sort === 'calls') {
            orderBy = 'sum(d.calls_delta) desc nulls last';
        } else if (sort === 'slow') {
            orderBy = 'avg(d.mean_exec_time_ms) desc nulls last';
        } else {
            // default: time
            orderBy = 'sum(d.total_exec_time_ms_delta) desc nulls last';
        }

        // Arama: query text icin ILIKE pattern veya queryid tam eslesme
        // Kullanici '%select%hotel%' yazarsa SQL text'i, sadece sayi yazarsa
        // queryid olarak yorumlanir.
        const searchRaw = (req.query.search as string || '').trim();
        const datname = (req.query.datname as string || '').trim();
        const params: any[] = [id, fromIso, toIso];
        let searchWhere = '';
        if (searchRaw) {
            // Sadece rakam ve - ise queryid olarak dene (bigint signed)
            if (/^-?\d+$/.test(searchRaw)) {
                params.push(searchRaw);
                searchWhere += ` and ss.queryid::text = $${params.length}`;
            } else {
                params.push(searchRaw);
                searchWhere += ` and qt.query_text ilike $${params.length}`;
            }
        }
        if (datname) {
            params.push(datname);
            searchWhere += ` and dbr.datname = $${params.length}`;
        }
        params.push(limit);

        const result = await pool.query(`
      with toplam as (
        select sum(d.total_exec_time_ms_delta) as total_ms
        from fact.pgss_delta d
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
      )
      select
        dbr.datname,
        ss.queryid::text as queryid,
        ss.query_text_id,
        left(qt.query_text, 200) as query_short,
        qt.query_text as query_full,
        sum(d.calls_delta)::bigint as toplam_cagri,
        sum(d.total_exec_time_ms_delta)::bigint as toplam_exec_ms,
        round((sum(d.total_exec_time_ms_delta) / 1000.0 / 60.0)::numeric, 2) as toplam_dk,
        round((100.0 * sum(d.total_exec_time_ms_delta) / nullif((select total_ms from toplam), 0))::numeric, 1) as pct_of_total,
        round(min(d.min_exec_time_ms)::numeric, 2) as min_ms,
        round(avg(d.mean_exec_time_ms)::numeric, 2) as ort_ms,
        round(max(d.max_exec_time_ms)::numeric, 2) as max_ms,
        sum(d.rows_delta)::bigint as toplam_satir,
        -- Cache hit % = hit / (hit + read). 0 ise null.
        case when sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)) > 0
          then round((100.0 * sum(coalesce(d.shared_blks_hit_delta, 0))
                      / nullif(sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)), 0))::numeric, 1)
          else null end as cache_hit_pct,
        round(avg(d.mean_plan_time_ms)::numeric, 2) as ort_plan_ms,
        round((sum(coalesce(d.wal_bytes_delta, 0)) / 1024.0 / 1024.0)::numeric, 2) as wal_mb,
        case when sum(d.calls_delta) > 0
          then round((sum(coalesce(d.rows_delta, 0))::numeric / sum(d.calls_delta)::numeric), 1)
          else 0 end as satir_per_cagri,
        ss.statement_series_id
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
      group by dbr.datname, ss.queryid, ss.query_text_id, qt.query_text, ss.statement_series_id
      having sum(d.total_exec_time_ms_delta) > 0
      order by ${orderBy}
      limit $${params.length}
    `, params);

        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// =========================================================================
// TEMP SPILL sekmesi
// =========================================================================

// Top temp-spill sorgular — temp_blks_written desc, HAVING > 0.
// Sadece geçici dosya yazan sorgulari listeler. 1 blok = 8KB.
async function fetchTempSpillData(id: string, fromIso: string, toIso: string, datname: string, searchRaw: string, bucketExpr: string, windowHours: number, alignIntervalSql?: string) {
    const params: any[] = [id, fromIso, toIso];
    let dbWhere = '';
    if (searchRaw) {
        if (/^-?\d+$/.test(searchRaw)) {
            params.push(searchRaw);
            dbWhere += ` and ss.queryid::text = $${params.length}`;
        } else {
            params.push(searchRaw);
            dbWhere += ` and qt.query_text ilike $${params.length}`;
        }
    }
    if (datname) {
        params.push(datname);
        dbWhere += ` and dbr.datname = $${params.length}`;
    }
    const stepSql = pgssBucketStepSql(windowHours);
    const gridStart = pgssBucketAlignSql(windowHours, 2);
    const alignedSelect = alignIntervalSql ? `, g.bucket_start + ${alignIntervalSql} as bucket_aligned` : '';
    return pool.query(`
        with buckets as (
          select
            ${bucketExpr} as bucket_start,
            coalesce(sum(d.temp_blks_written_delta), 0)::bigint as temp_blks_written,
            coalesce(sum(d.temp_blks_read_delta), 0)::bigint as temp_blks_read,
            coalesce(sum(d.calls_delta), 0)::bigint as calls
          from fact.pgss_delta d
          join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
          left join dim.query_text qt on qt.query_text_id = ss.query_text_id
          left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
          where d.instance_pk = $1
            and d.sample_ts between $2::timestamptz and $3::timestamptz
            ${dbWhere}
          group by bucket_start
        ),
        grid as (
          select gs as bucket_start
          from generate_series(${gridStart}, $3::timestamptz, ${stepSql}) gs
        )
        select
          g.bucket_start${alignedSelect},
          coalesce(b.temp_blks_written, 0)::bigint as temp_blks_written,
          coalesce(b.temp_blks_read, 0)::bigint as temp_blks_read,
          coalesce(b.calls, 0)::bigint as calls
        from grid g
        left join buckets b on b.bucket_start = g.bucket_start
        order by g.bucket_start
    `, params);
}

// GET /api/insights/:id/temp-spill?sort=temp_written|temp_read&from=&to=&limit=20
router.get('/:id/temp-spill', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        const limit = parseLimit(req.query.limit, 20);
        const sort = String(req.query.sort || 'temp_written').toLowerCase();

        let orderBy: string;
        if (sort === 'temp_read') {
            orderBy = 'sum(coalesce(d.temp_blks_read_delta, 0)) desc nulls last';
        } else {
            orderBy = 'sum(coalesce(d.temp_blks_written_delta, 0)) desc nulls last';
        }

        const searchRaw = (req.query.search as string || '').trim();
        const datname = (req.query.datname as string || '').trim();
        const params: any[] = [id, fromIso, toIso];
        let searchWhere = '';
        if (searchRaw) {
            if (/^-?\d+$/.test(searchRaw)) {
                params.push(searchRaw);
                searchWhere += ` and ss.queryid::text = $${params.length}`;
            } else {
                params.push(searchRaw);
                searchWhere += ` and qt.query_text ilike $${params.length}`;
            }
        }
        if (datname) {
            params.push(datname);
            searchWhere += ` and dbr.datname = $${params.length}`;
        }
        params.push(limit);

        const result = await pool.query(`
      select
        dbr.datname,
        ss.queryid::text as queryid,
        ss.query_text_id,
        left(qt.query_text, 200) as query_short,
        qt.query_text as query_full,
        sum(d.calls_delta)::bigint as toplam_cagri,
        sum(coalesce(d.temp_blks_written_delta, 0))::bigint as toplam_temp_written_blks,
        sum(coalesce(d.temp_blks_read_delta, 0))::bigint as toplam_temp_read_blks,
        -- 1 blok = 8 KB → MB icin / 128
        round((sum(coalesce(d.temp_blks_written_delta, 0)) / 128.0)::numeric, 2) as temp_written_mb,
        round((sum(coalesce(d.temp_blks_read_delta, 0)) / 128.0)::numeric, 2) as temp_read_mb,
        -- Cagri basina ortalama temp MB
        case when sum(d.calls_delta) > 0
          then round(((sum(coalesce(d.temp_blks_written_delta, 0)) / 128.0)
                      / sum(d.calls_delta)::numeric)::numeric, 4)
          else null end as temp_written_mb_per_call,
        sum(d.total_exec_time_ms_delta)::bigint as toplam_exec_ms,
        round((sum(d.total_exec_time_ms_delta) / 1000.0 / 60.0)::numeric, 2) as toplam_dk,
        round(avg(d.mean_exec_time_ms)::numeric, 2) as ort_ms,
        sum(d.rows_delta)::bigint as toplam_satir,
        ss.statement_series_id
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
      group by dbr.datname, ss.queryid, ss.query_text_id, qt.query_text, ss.statement_series_id
      having sum(coalesce(d.temp_blks_written_delta, 0)) > 0
      order by ${orderBy}
      limit $${params.length}
    `, params);

        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// GET /api/insights/:id/temp-trend?from=&to=&datname=&search=&compare=&include_baseline=1
router.get('/:id/temp-trend', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        let compare: CompareKey | null = null;
        try {
            compare = parseCompareParam(req.query.compare);
        } catch {
            res.status(400).json({ error: 'Invalid compare. Allowed values: 1h, 1d, 1w, 1m' });
            return;
        }
        const datname = (req.query.datname as string || '').trim();
        const searchRaw = (req.query.search as string || '').trim();

        const windowHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
        const bucketExpr = pgssBucketExpr(windowHours);

        const includeBaseline = String(req.query.include_baseline || '').trim() === '1';
        const baselineNeeded = includeBaseline && searchRaw !== '';

        const [current, baselineRes] = await Promise.all([
            fetchTempSpillData(id, fromIso, toIso, datname, searchRaw, bucketExpr, windowHours),
            baselineNeeded
                ? fetchTempSpillData(id, fromIso, toIso, datname, '', bucketExpr, windowHours)
                : Promise.resolve(null),
        ]);

        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchTempSpillData(
                id,
                shiftedIso(fromIso, offset.seconds),
                shiftedIso(toIso, offset.seconds),
                datname,
                searchRaw,
                bucketExpr,
                windowHours,
                offset.intervalSql,
            )).rows;
        }
        const baseline = baselineRes ? baselineRes.rows : null;
        res.json({ current: current.rows, previous, compare, baseline });
    } catch (err) {
        next(err);
    }
});

// GET /api/insights/:id/databases — instance'a ait DB listesi (filtre dropdown'u icin)
router.get('/:id/databases', async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            select distinct dbr.datname
            from dim.database_ref dbr
            where dbr.instance_pk = $1
              and dbr.datname is not null
            order by dbr.datname
        `, [id]);
        res.json(result.rows.map((r: any) => r.datname));
    } catch (err) {
        next(err);
    }
});

export default router;
