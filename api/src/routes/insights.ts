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

function bucketExprForTs(windowHours: number, tsExpr: string): string {
    if (windowHours <= 6) {
        return `date_trunc('hour', ${tsExpr}) + make_interval(mins => (extract(minute from ${tsExpr})::int / 5) * 5)`;
    }
    if (windowHours <= 7 * 24) {
        return `date_trunc('hour', ${tsExpr})`;
    }
    if (windowHours <= 30 * 24) {
        return `date_trunc('day', ${tsExpr}) + make_interval(hours => (extract(hour from ${tsExpr})::int / 6) * 6)`;
    }
    return `date_trunc('day', ${tsExpr})`;
}

function pgssBucketExpr(windowHours: number): string {
    return bucketExprForTs(windowHours, 'd.sample_ts');
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

async function fetchQueryTempTrend(id: string, seriesId: string, fromIso: string, toIso: string, bucketExpr: string, windowHours: number, alignIntervalSql?: string) {
    const stepSql = pgssBucketStepSql(windowHours);
    // $3 ve $4 from/to (1: id, 2: seriesId).
    const gridStart = pgssBucketAlignSql(windowHours, 3);
    const alignedSelect = alignIntervalSql ? `, g.bucket_start + ${alignIntervalSql} as bucket_aligned` : '';
    return pool.query(`
        with buckets as (
          select
            ${bucketExpr} as bucket_start,
            coalesce(sum(d.calls_delta), 0)::bigint as calls,
            coalesce(sum(coalesce(d.temp_blks_written_delta, 0)), 0)::bigint as temp_written_blks,
            coalesce(sum(coalesce(d.temp_blks_read_delta, 0)), 0)::bigint as temp_read_blks
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
          coalesce(b.temp_written_blks, 0)::bigint as temp_written_blks,
          coalesce(b.temp_read_blks, 0)::bigint as temp_read_blks
        from grid g
        left join buckets b on b.bucket_start = g.bucket_start
        order by g.bucket_start
    `, [id, seriesId, fromIso, toIso]);
}

async function fetchQueryWalTrend(id: string, seriesId: string, fromIso: string, toIso: string, bucketExpr: string, windowHours: number, alignIntervalSql?: string) {
    const stepSql = pgssBucketStepSql(windowHours);
    // $3 ve $4 from/to (1: id, 2: seriesId).
    const gridStart = pgssBucketAlignSql(windowHours, 3);
    const alignedSelect = alignIntervalSql ? `, g.bucket_start + ${alignIntervalSql} as bucket_aligned` : '';
    return pool.query(`
        with buckets as (
          select
            ${bucketExpr} as bucket_start,
            coalesce(sum(coalesce(d.wal_bytes_delta, 0)), 0)::double precision as wal_bytes,
            coalesce(sum(coalesce(d.wal_records_delta, 0)), 0)::bigint as wal_records,
            coalesce(sum(coalesce(d.wal_fpi_delta, 0)), 0)::bigint as wal_fpi,
            coalesce(sum(d.calls_delta), 0)::bigint as calls
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
          coalesce(b.wal_bytes, 0)::double precision as wal_bytes,
          coalesce(b.wal_records, 0)::bigint as wal_records,
          coalesce(b.wal_fpi, 0)::bigint as wal_fpi,
          coalesce(b.calls, 0)::bigint as calls
        from grid g
        left join buckets b on b.bucket_start = g.bucket_start
        order by g.bucket_start
    `, [id, seriesId, fromIso, toIso]);
}

async function fetchQueryCacheHitTrend(id: string, seriesId: string, fromIso: string, toIso: string, bucketExpr: string, windowHours: number, alignIntervalSql?: string) {
    const stepSql = pgssBucketStepSql(windowHours);
    // $3 ve $4 from/to (1: id, 2: seriesId).
    const gridStart = pgssBucketAlignSql(windowHours, 3);
    const alignedSelect = alignIntervalSql ? `, g.bucket_start + ${alignIntervalSql} as bucket_aligned` : '';
    return pool.query(`
        with buckets as (
          select
            ${bucketExpr} as bucket_start,
            coalesce(sum(coalesce(d.shared_blks_hit_delta, 0)), 0)::bigint as hit_blks,
            coalesce(sum(coalesce(d.shared_blks_read_delta, 0)), 0)::bigint as read_blks,
            coalesce(sum(coalesce(d.shared_blk_read_time_ms_delta, 0)), 0)::double precision as read_time_ms,
            coalesce(sum(d.calls_delta), 0)::bigint as calls
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
          coalesce(b.hit_blks, 0)::bigint as hit_blks,
          coalesce(b.read_blks, 0)::bigint as read_blks,
          coalesce(b.read_time_ms, 0)::double precision as read_time_ms,
          coalesce(b.calls, 0)::bigint as calls
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

// GET /api/insights/:id/query-temp-trend?series_id=N&from=...&to=...
router.get('/:id/query-temp-trend', async (req, res, next) => {
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

        const current = await fetchQueryTempTrend(id, seriesIdRaw, fromIso, toIso, bucketExpr, windowHours);
        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchQueryTempTrend(
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

// GET /api/insights/:id/query-wal-trend?series_id=N&from=...&to=...
router.get('/:id/query-wal-trend', async (req, res, next) => {
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

        const current = await fetchQueryWalTrend(id, seriesIdRaw, fromIso, toIso, bucketExpr, windowHours);
        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchQueryWalTrend(
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

// GET /api/insights/:id/query-cache-hit-trend?series_id=N&from=...&to=...
router.get('/:id/query-cache-hit-trend', async (req, res, next) => {
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

        const current = await fetchQueryCacheHitTrend(id, seriesIdRaw, fromIso, toIso, bucketExpr, windowHours);
        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchQueryCacheHitTrend(
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
        case when sum(coalesce(d.temp_blks_written_delta, 0)) > 0
          then true else false end as has_temp_spill,
        case when sum(coalesce(d.wal_bytes_delta, 0)) > 1048576
          then true else false end as has_wal_writes,
        case when sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)) > 0
           and (100.0 * sum(coalesce(d.shared_blks_hit_delta, 0))
                / nullif(sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)), 0)) < 90
          then true else false end as has_cache_miss,
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
// CACHE HIT sekmesi
// =========================================================================

async function fetchCacheHitTrendData(id: string, fromIso: string, toIso: string, datname: string, searchRaw: string, bucketExpr: string, windowHours: number, alignIntervalSql?: string) {
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
            coalesce(sum(coalesce(d.shared_blks_hit_delta, 0)), 0)::bigint as hit_blks,
            coalesce(sum(coalesce(d.shared_blks_read_delta, 0)), 0)::bigint as read_blks,
            coalesce(sum(coalesce(d.shared_blk_read_time_ms_delta, 0)), 0)::double precision as read_time_ms,
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
          coalesce(b.hit_blks, 0)::bigint as hit_blks,
          coalesce(b.read_blks, 0)::bigint as read_blks,
          coalesce(b.read_time_ms, 0)::double precision as read_time_ms,
          coalesce(b.calls, 0)::bigint as calls
        from grid g
        left join buckets b on b.bucket_start = g.bucket_start
        order by g.bucket_start
    `, params);
}

// GET /api/insights/:id/cache-hit?sort=cache_miss|disk_read|read_time|low_hit_pct&from=&to=&limit=20
router.get('/:id/cache-hit', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        const limit = parseLimit(req.query.limit, 20);
        const sort = String(req.query.sort || 'cache_miss').toLowerCase();

        let orderBy: string;
        let extraHaving = '';
        if (sort === 'read_time') {
            orderBy = 'sum(coalesce(d.shared_blk_read_time_ms_delta, 0)) desc nulls last';
        } else if (sort === 'low_hit_pct') {
            orderBy = '(100.0 * sum(coalesce(d.shared_blks_hit_delta, 0)) / nullif(sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)), 0)) asc nulls last';
            extraHaving = ' and sum(d.calls_delta) > 100';
        } else {
            orderBy = 'sum(coalesce(d.shared_blks_read_delta, 0)) desc nulls last';
            if (sort !== 'disk_read') {
                extraHaving = ' and sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)) > 100';
            }
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
        const totalsParams = [...params];
        params.push(limit);

        const windowHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
        const bucketExpr = pgssBucketExpr(windowHours);

        const rowsPromise = pool.query(`
      with toplam_disk_read as (
        select sum(coalesce(d.shared_blks_read_delta, 0)) as total_read_blks
        from fact.pgss_delta d
        join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
        left join dim.query_text qt on qt.query_text_id = ss.query_text_id
        left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
          ${searchWhere}
      )
      select
        dbr.datname,
        ss.queryid::text as queryid,
        ss.query_text_id,
        ss.statement_series_id,
        left(qt.query_text, 200) as query_short,
        qt.query_text as query_full,
        sum(d.calls_delta)::bigint as toplam_cagri,
        sum(coalesce(d.shared_blks_hit_delta, 0))::bigint as toplam_hit_blks,
        sum(coalesce(d.shared_blks_read_delta, 0))::bigint as toplam_read_blks,
        round((sum(coalesce(d.shared_blks_read_delta, 0)) * 8.0 / 1024.0)::numeric, 2) as disk_read_mb,
        case when sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)) > 0
          then round((100.0 * sum(coalesce(d.shared_blks_hit_delta, 0)) / nullif(sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)), 0))::numeric, 1)
          else null end as cache_hit_pct,
        round((sum(coalesce(d.shared_blk_read_time_ms_delta, 0)) / 1000.0)::numeric, 2) as disk_read_time_sec,
        case when sum(d.calls_delta) > 0
          then round(((sum(coalesce(d.shared_blks_read_delta, 0)) * 8.0 / 1024.0) / sum(d.calls_delta)::numeric)::numeric, 4)
          else null end as disk_read_mb_per_call,
        case when sum(d.calls_delta) > 0
          then round((sum(coalesce(d.shared_blks_read_delta, 0))::numeric / sum(d.calls_delta)::numeric), 1)
          else null end as read_blks_per_call,
        case when (select total_read_blks from toplam_disk_read) > 0
          then round((100.0 * sum(coalesce(d.shared_blks_read_delta, 0))::numeric / nullif((select total_read_blks from toplam_disk_read), 0))::numeric, 1)
          else null end as pct_of_total_disk_read,
        case when sum(d.total_exec_time_ms_delta) > 0
          then round((100.0 * sum(coalesce(d.shared_blk_read_time_ms_delta, 0)) / sum(d.total_exec_time_ms_delta))::numeric, 1)
          else null end as io_bound_pct,
        sum(d.total_exec_time_ms_delta)::bigint as toplam_exec_ms,
        round((sum(d.total_exec_time_ms_delta) / 1000.0 / 60.0)::numeric, 2) as toplam_dk,
        round(avg(d.mean_exec_time_ms)::numeric, 2) as ort_ms,
        sum(d.rows_delta)::bigint as toplam_satir
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
      group by dbr.datname, ss.queryid, ss.query_text_id, qt.query_text, ss.statement_series_id
      having sum(coalesce(d.shared_blks_read_delta, 0)) > 0${extraHaving}
      order by ${orderBy}
      limit $${params.length}
    `, params);

        const [rowsResult, instanceHitResult, worstDbResult, peakResult, settingsResult, heavyReaderResult] = await Promise.all([
            rowsPromise,
            pool.query(`
      select
        case when sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)) > 0
          then (100.0 * sum(coalesce(d.shared_blks_hit_delta, 0)) / nullif(sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)), 0))::double precision
          else null end as instance_hit_pct
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
    `, totalsParams),
            pool.query(`
      select
        dbr.datname,
        case when sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)) > 0
          then (100.0 * sum(coalesce(d.shared_blks_hit_delta, 0)) / nullif(sum(coalesce(d.shared_blks_hit_delta, 0) + coalesce(d.shared_blks_read_delta, 0)), 0))::double precision
          else null end as hit_pct,
        (sum(coalesce(d.shared_blks_read_delta, 0)) * 8.0 / 1024.0)::double precision as disk_read_mb
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
      group by dbr.datname
      having sum(coalesce(d.shared_blks_read_delta, 0)) > 0
      order by hit_pct asc nulls last, disk_read_mb desc
      limit 1
    `, totalsParams),
            pool.query(`
      select
        ${bucketExpr} as bucket_start,
        (sum(coalesce(d.shared_blks_read_delta, 0)) * 8.0 / 1024.0)::double precision as mb
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
      group by bucket_start
      having sum(coalesce(d.shared_blks_read_delta, 0)) > 0
      order by mb desc
      limit 1
    `, totalsParams),
            pool.query(`
      select distinct on (setting_name)
        setting_name,
        setting_value,
        unit,
        case
          when unit = 'kB' then setting_value::bigint
          when unit = 'MB' then setting_value::bigint * 1024
          when unit = 'GB' then setting_value::bigint * 1024 * 1024
          else setting_value::bigint
        end as kb
      from fact.pg_settings_snapshot
      where instance_pk = $1
        and setting_name in ('shared_buffers', 'effective_cache_size')
      order by setting_name, snapshot_ts desc
    `, [id]),
            pool.query(`
      select count(*)::int as count
      from (
        select ss.statement_series_id
        from fact.pgss_delta d
        join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
        left join dim.query_text qt on qt.query_text_id = ss.query_text_id
        left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
          ${searchWhere}
        group by ss.statement_series_id
        having (sum(coalesce(d.shared_blks_read_delta, 0)) * 8.0 / 1024.0) >= 100
      ) heavy
    `, totalsParams),
        ]);

        const settingByName = new Map(settingsResult.rows.map((r: any) => [String(r.setting_name), r]));
        const settingKb = (name: string): number | null => {
            const row = settingByName.get(name) as any;
            return row?.kb == null ? null : Number(row.kb);
        };
        const worstDb = worstDbResult.rows[0] ?? null;
        const peak = peakResult.rows[0] ?? null;
        res.json({
            rows: rowsResult.rows,
            totals: {
                instance_hit_pct: instanceHitResult.rows[0]?.instance_hit_pct == null ? null : Number(instanceHitResult.rows[0].instance_hit_pct),
                worst_datname: worstDb ? { datname: worstDb.datname, hit_pct: Number(worstDb.hit_pct), disk_read_mb: Number(worstDb.disk_read_mb) } : null,
                peak: peak ? { bucket_start: peak.bucket_start, mb: Number(peak.mb) } : null,
                shared_buffers_kb: settingKb('shared_buffers'),
                effective_cache_size_kb: settingKb('effective_cache_size'),
                heavy_reader_count: Number(heavyReaderResult.rows[0]?.count ?? 0),
            },
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/insights/:id/cache-hit-trend?from=&to=&datname=&search=&compare=&include_baseline=1
router.get('/:id/cache-hit-trend', async (req, res, next) => {
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
            fetchCacheHitTrendData(id, fromIso, toIso, datname, searchRaw, bucketExpr, windowHours),
            baselineNeeded
                ? fetchCacheHitTrendData(id, fromIso, toIso, datname, '', bucketExpr, windowHours)
                : Promise.resolve(null),
        ]);

        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchCacheHitTrendData(
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

// =========================================================================
// VACUUM LAG sekmesi
// =========================================================================

async function fetchVacuumLagTrendData(id: string, fromIso: string, toIso: string, datname: string, searchRaw: string, windowHours: number, alignIntervalSql?: string) {
    const params: any[] = [id, fromIso, toIso];
    let searchWhere = '';
    if (searchRaw) {
        params.push(`%${searchRaw}%`);
        searchWhere += ` and d.relname ilike $${params.length}`;
    }
    if (datname) {
        params.push(datname);
        searchWhere += ` and dbr.datname = $${params.length}`;
    }

    const stepSql = pgssBucketStepSql(windowHours);
    const gridStart = pgssBucketAlignSql(windowHours, 2);
    const alignedSelect = alignIntervalSql ? `, g.bucket_start + ${alignIntervalSql} as bucket_aligned` : '';
    const filteredBucketExpr = bucketExprForTs(windowHours, 'f.sample_ts');
    const snapshotBucketExpr = bucketExprForTs(windowHours, 's.sample_ts');

    return pool.query(`
        with filtered_data as (
          select
            d.sample_ts,
            coalesce(d.n_dead_tup_estimate, 0)::bigint as n_dead_tup_estimate,
            (coalesce(d.vacuum_count_delta, 0) + coalesce(d.autovacuum_count_delta, 0))::bigint as vacuum_count_delta
          from fact.pg_table_stat_delta d
          left join dim.database_ref dbr on dbr.instance_pk = d.instance_pk and dbr.dbid = d.dbid
          where d.instance_pk = $1
            and d.sample_ts between $2::timestamptz and $3::timestamptz
            ${searchWhere}
        ),
        snapshot_sums as (
          select
            sample_ts,
            sum(n_dead_tup_estimate)::bigint as total_dead_tup
          from filtered_data
          group by sample_ts
        ),
        dead_buckets as (
          select
            ${snapshotBucketExpr} as bucket_start,
            avg(s.total_dead_tup)::double precision as total_dead_tup
          from snapshot_sums s
          group by bucket_start
        ),
        vacuum_buckets as (
          select
            ${filteredBucketExpr} as bucket_start,
            coalesce(sum(f.vacuum_count_delta), 0)::bigint as vacuum_count
          from filtered_data f
          group by bucket_start
        ),
        grid as (
          select gs as bucket_start
          from generate_series(${gridStart}, $3::timestamptz, ${stepSql}) gs
        )
        select
          g.bucket_start${alignedSelect},
          coalesce(db.total_dead_tup, 0)::bigint as total_dead_tup,
          coalesce(vb.vacuum_count, 0)::bigint as vacuum_count
        from grid g
        left join dead_buckets db on db.bucket_start = g.bucket_start
        left join vacuum_buckets vb on vb.bucket_start = g.bucket_start
        order by g.bucket_start
    `, params);
}

async function fetchTableVacuumTrend(id: string, dbid: string, relid: string, fromIso: string, toIso: string, bucketExpr: string, windowHours: number, alignIntervalSql?: string) {
    const stepSql = pgssBucketStepSql(windowHours);
    // $4 ve $5 from/to (1: id, 2: dbid, 3: relid).
    const gridStart = pgssBucketAlignSql(windowHours, 4);
    const alignedSelect = alignIntervalSql ? `, g.bucket_start + ${alignIntervalSql} as bucket_aligned` : '';
    return pool.query(`
        with snapshot_data as (
          select
            ${bucketExpr} as bucket_start,
            avg(coalesce(d.n_dead_tup_estimate, 0))::bigint as dead_tup,
            avg(coalesce(d.n_live_tup_estimate, 0))::bigint as live_tup,
            sum(coalesce(d.n_tup_upd_delta, 0))::bigint as n_tup_upd,
            sum(coalesce(d.n_tup_del_delta, 0))::bigint as n_tup_del,
            sum(coalesce(d.n_tup_ins_delta, 0))::bigint as n_tup_ins,
            sum(coalesce(d.vacuum_count_delta, 0) + coalesce(d.autovacuum_count_delta, 0))::bigint as vacuum_count,
            sum(coalesce(d.analyze_count_delta, 0) + coalesce(d.autoanalyze_count_delta, 0))::bigint as analyze_count
          from fact.pg_table_stat_delta d
          where d.instance_pk = $1
            and d.dbid = $2::oid
            and d.relid = $3::oid
            and d.sample_ts between $4::timestamptz and $5::timestamptz
          group by bucket_start
        ),
        grid as (
          select gs as bucket_start
          from generate_series(${gridStart}, $5::timestamptz, ${stepSql}) gs
        )
        select
          g.bucket_start${alignedSelect},
          coalesce(s.dead_tup, 0)::bigint as dead_tup,
          coalesce(s.live_tup, 0)::bigint as live_tup,
          coalesce(s.n_tup_upd, 0)::bigint as n_tup_upd,
          coalesce(s.n_tup_del, 0)::bigint as n_tup_del,
          coalesce(s.n_tup_ins, 0)::bigint as n_tup_ins,
          coalesce(s.vacuum_count, 0)::bigint as vacuum_count,
          coalesce(s.analyze_count, 0)::bigint as analyze_count
        from grid g
        left join snapshot_data s on s.bucket_start = g.bucket_start
        order by g.bucket_start
    `, [id, dbid, relid, fromIso, toIso]);
}

// GET /api/insights/:id/vacuum-lag?sort=dead_tup|dead_pct|stale_vacuum|update_rate|mod_since_analyze&from=&to=&limit=20&datname=&search=
router.get('/:id/vacuum-lag', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        const limit = parseLimit(req.query.limit, 20);
        const sort = String(req.query.sort || 'dead_tup').toLowerCase();

        let orderBy = 'n_dead_tup desc nulls last, dead_pct desc nulls last';
        if (sort === 'dead_pct') {
            orderBy = 'case when (n_live_tup + n_dead_tup) > 1000 then dead_pct else null end desc nulls last, n_dead_tup desc nulls last';
        } else if (sort === 'stale_vacuum') {
            orderBy = 'case when n_dead_tup > 100 then days_since_vacuum else null end desc nulls last, n_dead_tup desc nulls last';
        } else if (sort === 'update_rate') {
            orderBy = 'update_per_sec desc nulls last, n_tup_upd desc nulls last';
        } else if (sort === 'mod_since_analyze') {
            orderBy = 'n_mod_since_analyze desc nulls last, dead_pct desc nulls last';
        }

        const searchRaw = (req.query.search as string || '').trim();
        const datname = (req.query.datname as string || '').trim();
        const params: any[] = [id, fromIso, toIso];
        let searchWhere = '';
        if (searchRaw) {
            params.push(`%${searchRaw}%`);
            searchWhere += ` and d.relname ilike $${params.length}`;
        }
        if (datname) {
            params.push(datname);
            searchWhere += ` and dbr.datname = $${params.length}`;
        }

        const baseParams = [...params];
        params.push(limit);

        const baseCtes = `
      with filtered_data as (
        select
          d.instance_pk,
          d.dbid::int as dbid,
          d.relid::int as relid,
          d.schemaname,
          d.relname,
          d.sample_ts,
          dbr.datname,
          d.n_live_tup_estimate,
          d.n_dead_tup_estimate,
          d.n_mod_since_analyze,
          d.last_vacuum,
          d.last_autovacuum,
          d.last_analyze,
          d.last_autoanalyze,
          coalesce(d.vacuum_count_delta, 0)::bigint as vacuum_count_delta,
          coalesce(d.autovacuum_count_delta, 0)::bigint as autovacuum_count_delta,
          coalesce(d.analyze_count_delta, 0)::bigint as analyze_count_delta,
          coalesce(d.autoanalyze_count_delta, 0)::bigint as autoanalyze_count_delta,
          coalesce(d.n_tup_ins_delta, 0)::bigint as n_tup_ins_delta,
          coalesce(d.n_tup_upd_delta, 0)::bigint as n_tup_upd_delta,
          coalesce(d.n_tup_del_delta, 0)::bigint as n_tup_del_delta,
          coalesce(d.n_tup_hot_upd_delta, 0)::bigint as n_tup_hot_upd_delta
        from fact.pg_table_stat_delta d
        left join dim.database_ref dbr on dbr.instance_pk = d.instance_pk and dbr.dbid = d.dbid
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
          ${searchWhere}
      ),
      latest_snapshot as (
        select distinct on (instance_pk, dbid, relid)
          dbid,
          relid,
          schemaname,
          relname,
          datname,
          n_live_tup_estimate,
          n_dead_tup_estimate,
          n_mod_since_analyze,
          last_vacuum,
          last_autovacuum,
          last_analyze,
          last_autoanalyze
        from filtered_data
        order by instance_pk, dbid, relid, sample_ts desc
      ),
      delta_data as (
        select
          dbid,
          relid,
          sum(vacuum_count_delta + autovacuum_count_delta)::bigint as vacuum_count,
          sum(analyze_count_delta + autoanalyze_count_delta)::bigint as analyze_count,
          sum(n_tup_ins_delta)::bigint as n_tup_ins,
          sum(n_tup_upd_delta)::bigint as n_tup_upd,
          sum(n_tup_del_delta)::bigint as n_tup_del,
          sum(n_tup_hot_upd_delta)::bigint as n_tup_hot_upd
        from filtered_data
        group by dbid, relid
      ),
      ranked as (
        select
          ls.dbid,
          ls.relid,
          ls.schemaname,
          ls.relname,
          ls.datname,
          coalesce(ls.n_live_tup_estimate, 0)::bigint as n_live_tup,
          coalesce(ls.n_dead_tup_estimate, 0)::bigint as n_dead_tup,
          coalesce(ls.n_mod_since_analyze, 0)::bigint as n_mod_since_analyze,
          case when coalesce(ls.n_live_tup_estimate, 0) + coalesce(ls.n_dead_tup_estimate, 0) > 0
            then round((100.0 * coalesce(ls.n_dead_tup_estimate, 0)::numeric
                        / nullif(coalesce(ls.n_live_tup_estimate, 0) + coalesce(ls.n_dead_tup_estimate, 0), 0))::numeric, 1)
            else null end as dead_pct,
          greatest(ls.last_vacuum, ls.last_autovacuum) as last_vacuum,
          greatest(ls.last_analyze, ls.last_autoanalyze) as last_analyze,
          case when greatest(ls.last_vacuum, ls.last_autovacuum) is not null
            then round((extract(epoch from (now() - greatest(ls.last_vacuum, ls.last_autovacuum))) / 86400.0)::numeric, 1)
            else null end as days_since_vacuum,
          case when greatest(ls.last_analyze, ls.last_autoanalyze) is not null
            then round((extract(epoch from (now() - greatest(ls.last_analyze, ls.last_autoanalyze))) / 86400.0)::numeric, 1)
            else null end as days_since_analyze,
          coalesce(dd.vacuum_count, 0)::bigint as vacuum_count,
          coalesce(dd.analyze_count, 0)::bigint as analyze_count,
          coalesce(dd.n_tup_ins, 0)::bigint as n_tup_ins,
          coalesce(dd.n_tup_upd, 0)::bigint as n_tup_upd,
          coalesce(dd.n_tup_del, 0)::bigint as n_tup_del,
          coalesce(dd.n_tup_hot_upd, 0)::bigint as n_tup_hot_upd,
          case when coalesce(dd.n_tup_upd, 0) > 0
            then round((100.0 * coalesce(dd.n_tup_hot_upd, 0)::numeric / nullif(dd.n_tup_upd, 0))::numeric, 1)
            else null end as hot_upd_pct,
          case when extract(epoch from ($3::timestamptz - $2::timestamptz)) > 0
            then round((coalesce(dd.n_tup_upd, 0)::numeric / extract(epoch from ($3::timestamptz - $2::timestamptz)))::numeric, 2)
            else null end as update_per_sec
        from latest_snapshot ls
        left join delta_data dd on dd.dbid = ls.dbid and dd.relid = ls.relid
      )
    `;

        const rowsPromise = pool.query(`
      ${baseCtes}
      select *
      from ranked
      order by ${orderBy}
      limit $${params.length}
    `, params);

        const totalsPromise = pool.query(`
      ${baseCtes}
      select
        coalesce(sum(n_dead_tup), 0)::bigint as total_dead_tup,
        (
          select row_to_json(w)
          from (
            select
              schemaname,
              relname,
              datname,
              dead_pct::double precision as dead_pct,
              n_dead_tup::bigint as n_dead_tup
            from ranked
            where dead_pct is not null
            order by dead_pct desc nulls last, n_dead_tup desc nulls last
            limit 1
          ) w
        ) as worst_dead_pct,
        (
          select row_to_json(o)
          from (
            select
              schemaname,
              relname,
              datname,
              days_since_vacuum::double precision as days_since_vacuum
            from ranked
            where days_since_vacuum is not null
            order by days_since_vacuum desc nulls last, n_dead_tup desc nulls last
            limit 1
          ) o
        ) as oldest_vacuum,
        count(*) filter (where dead_pct > 20 and n_live_tup > 1000)::int as bloated_count,
        count(*) filter (where days_since_vacuum > 7 and n_dead_tup > 1000)::int as stale_count
      from ranked
    `, baseParams);

        const settingsPromise = pool.query(`
      select distinct on (setting_name)
        setting_name,
        setting_value,
        unit
      from fact.pg_settings_snapshot
      where instance_pk = $1
        and setting_name in (
          'autovacuum',
          'autovacuum_max_workers',
          'autovacuum_naptime',
          'autovacuum_vacuum_scale_factor',
          'autovacuum_vacuum_threshold',
          'autovacuum_analyze_scale_factor',
          'autovacuum_analyze_threshold'
        )
      order by setting_name, snapshot_ts desc
    `, [id]);

        const [rowsResult, totalsResult, settingsResult] = await Promise.all([
            rowsPromise,
            totalsPromise,
            settingsPromise,
        ]);

        const settingsByName = new Map(settingsResult.rows.map((r: any) => [String(r.setting_name), r]));
        const settingText = (name: string): string | null => {
            const row = settingsByName.get(name) as any;
            return row?.setting_value == null ? null : String(row.setting_value);
        };
        const settingNumber = (name: string): number | null => {
            const row = settingsByName.get(name) as any;
            if (row?.setting_value == null) return null;
            const value = Number(row.setting_value);
            if (!Number.isFinite(value)) return null;
            const unit = String(row.unit || '').toLowerCase();
            if (unit === 'ms') return value / 1000;
            if (unit === 'min') return value * 60;
            if (unit === 'h') return value * 3600;
            return value;
        };

        const totalsRow = totalsResult.rows[0] ?? {};
        const worstDead = totalsRow.worst_dead_pct as any;
        const oldestVacuum = totalsRow.oldest_vacuum as any;

        res.json({
            rows: rowsResult.rows,
            totals: {
                total_dead_tup: Number(totalsRow.total_dead_tup ?? 0),
                worst_dead_pct: worstDead ? {
                    schemaname: worstDead.schemaname,
                    relname: worstDead.relname,
                    datname: worstDead.datname,
                    dead_pct: Number(worstDead.dead_pct),
                    n_dead_tup: Number(worstDead.n_dead_tup),
                } : null,
                oldest_vacuum: oldestVacuum ? {
                    schemaname: oldestVacuum.schemaname,
                    relname: oldestVacuum.relname,
                    datname: oldestVacuum.datname,
                    days_since_vacuum: Number(oldestVacuum.days_since_vacuum),
                } : null,
                bloated_count: Number(totalsRow.bloated_count ?? 0),
                stale_count: Number(totalsRow.stale_count ?? 0),
                autovacuum_settings: {
                    autovacuum: settingText('autovacuum'),
                    autovacuum_max_workers: settingNumber('autovacuum_max_workers'),
                    autovacuum_naptime_sec: settingNumber('autovacuum_naptime'),
                    autovacuum_vacuum_scale_factor: settingNumber('autovacuum_vacuum_scale_factor'),
                    autovacuum_vacuum_threshold: settingNumber('autovacuum_vacuum_threshold'),
                    autovacuum_analyze_scale_factor: settingNumber('autovacuum_analyze_scale_factor'),
                    autovacuum_analyze_threshold: settingNumber('autovacuum_analyze_threshold'),
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/insights/:id/vacuum-lag-trend?from=&to=&datname=&search=&compare=
router.get('/:id/vacuum-lag-trend', async (req, res, next) => {
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

        const current = await fetchVacuumLagTrendData(id, fromIso, toIso, datname, searchRaw, windowHours);
        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchVacuumLagTrendData(
                id,
                shiftedIso(fromIso, offset.seconds),
                shiftedIso(toIso, offset.seconds),
                datname,
                searchRaw,
                windowHours,
                offset.intervalSql,
            )).rows;
        }

        res.json({ current: current.rows, previous, compare });
    } catch (err) {
        next(err);
    }
});

// GET /api/insights/:id/table-vacuum-trend?dbid=N&relid=M&from=&to=&compare=
router.get('/:id/table-vacuum-trend', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        let compare: CompareKey | null = null;
        try {
            compare = parseCompareParam(req.query.compare);
        } catch {
            res.status(400).json({ error: 'Invalid compare' });
            return;
        }

        const dbidRaw = String(req.query.dbid || '');
        const relidRaw = String(req.query.relid || '');
        if (!/^\d+$/.test(dbidRaw) || !/^\d+$/.test(relidRaw)) {
            res.status(400).json({ error: 'Invalid dbid or relid' });
            return;
        }

        const windowHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
        const bucketExpr = pgssBucketExpr(windowHours);

        const current = await fetchTableVacuumTrend(id, dbidRaw, relidRaw, fromIso, toIso, bucketExpr, windowHours);
        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchTableVacuumTrend(
                id,
                dbidRaw,
                relidRaw,
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

// =========================================================================
// WAL SPIKE sekmesi
// =========================================================================

async function fetchWalTrendData(id: string, fromIso: string, toIso: string, datname: string, searchRaw: string, bucketExpr: string, windowHours: number, alignIntervalSql?: string) {
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
            coalesce(sum(coalesce(d.wal_bytes_delta, 0)), 0)::double precision as wal_bytes,
            coalesce(sum(coalesce(d.wal_records_delta, 0)), 0)::bigint as wal_records,
            coalesce(sum(coalesce(d.wal_fpi_delta, 0)), 0)::bigint as wal_fpi,
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
          coalesce(b.wal_bytes, 0)::double precision as wal_bytes,
          coalesce(b.wal_records, 0)::bigint as wal_records,
          coalesce(b.wal_fpi, 0)::bigint as wal_fpi,
          coalesce(b.calls, 0)::bigint as calls
        from grid g
        left join buckets b on b.bucket_start = g.bucket_start
        order by g.bucket_start
    `, params);
}

// GET /api/insights/:id/wal-spike?sort=wal|wal_per_call|fpi_ratio|wal_per_row&from=&to=&limit=20
router.get('/:id/wal-spike', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        const limit = parseLimit(req.query.limit, 20);
        const sort = String(req.query.sort || 'wal').toLowerCase();

        let orderBy: string;
        if (sort === 'wal_per_call') {
            orderBy = 'sum(coalesce(d.wal_bytes_delta, 0))::numeric / nullif(sum(d.calls_delta), 0) desc nulls last';
        } else if (sort === 'fpi_ratio') {
            orderBy = 'case when sum(coalesce(d.wal_records_delta, 0)) > 100 then sum(coalesce(d.wal_fpi_delta, 0))::numeric / nullif(sum(coalesce(d.wal_records_delta, 0)), 0) else null end desc nulls last';
        } else if (sort === 'wal_per_row') {
            orderBy = 'sum(coalesce(d.wal_bytes_delta, 0))::numeric / nullif(sum(coalesce(d.rows_delta, 0)), 0) desc nulls last';
        } else {
            orderBy = 'sum(coalesce(d.wal_bytes_delta, 0)) desc nulls last';
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
        const totalsParams = [...params];
        params.push(limit);

        const windowHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
        const bucketExpr = pgssBucketExpr(windowHours);

        const resultPromise = pool.query(`
      with toplam_wal as (
        select sum(coalesce(d.wal_bytes_delta, 0)) as total_bytes
        from fact.pgss_delta d
        join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
        left join dim.query_text qt on qt.query_text_id = ss.query_text_id
        left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
          ${searchWhere}
      )
      select
        dbr.datname,
        ss.queryid::text as queryid,
        ss.query_text_id,
        ss.statement_series_id,
        left(qt.query_text, 200) as query_short,
        qt.query_text as query_full,
        sum(d.calls_delta)::bigint as toplam_cagri,
        sum(coalesce(d.wal_bytes_delta, 0))::bigint as toplam_wal_bytes,
        round((sum(coalesce(d.wal_bytes_delta, 0)) / 1048576.0)::numeric, 2) as wal_mb,
        sum(coalesce(d.wal_records_delta, 0))::bigint as toplam_wal_records,
        sum(coalesce(d.wal_fpi_delta, 0))::bigint as toplam_wal_fpi,
        case when sum(d.calls_delta) > 0
          then round(((sum(coalesce(d.wal_bytes_delta, 0)) / 1048576.0) / sum(d.calls_delta)::numeric)::numeric, 4)
          else null end as wal_mb_per_call,
        round((
          max(case when d.calls_delta > 0
            then (coalesce(d.wal_bytes_delta, 0) / 1048576.0) / d.calls_delta::numeric
            else 0 end)
        )::numeric, 2) as max_wal_mb_per_call,
        case when sum(coalesce(d.wal_records_delta, 0)) > 0
          then round((sum(coalesce(d.wal_fpi_delta, 0))::numeric / sum(coalesce(d.wal_records_delta, 0))::numeric)::numeric, 4)
          else null end as fpi_ratio,
        round((100.0 * sum(coalesce(d.wal_bytes_delta, 0)) / nullif((select total_bytes from toplam_wal), 0))::numeric, 1) as pct_of_total_wal,
        case when sum(coalesce(d.rows_delta, 0)) > 0
          then round((sum(coalesce(d.wal_bytes_delta, 0))::numeric / sum(coalesce(d.rows_delta, 0))::numeric)::numeric, 2)
          else null end as wal_bytes_per_row,
        sum(d.total_exec_time_ms_delta)::bigint as toplam_exec_ms,
        round((sum(d.total_exec_time_ms_delta) / 1000.0 / 60.0)::numeric, 2) as toplam_dk,
        round(avg(d.mean_exec_time_ms)::numeric, 2) as ort_ms,
        sum(d.rows_delta)::bigint as toplam_satir
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
      group by dbr.datname, ss.queryid, ss.query_text_id, qt.query_text, ss.statement_series_id
      having sum(coalesce(d.wal_bytes_delta, 0)) > 0
      order by ${orderBy}
      limit $${params.length}
    `, params);

        const tpsParams: any[] = [id, fromIso, toIso];
        let tpsDatnameWhere = '';
        if (datname) {
            tpsParams.push(datname);
            tpsDatnameWhere = ` and dbr.datname = $${tpsParams.length}`;
        }

        const [result, totalWalResult, topDbResult, peakResult, settingsResult, replicationLagResult, spillBytesResult, tpsResult, archiverResult] = await Promise.all([
            resultPromise,
            pool.query(`
      select coalesce(sum(coalesce(d.wal_bytes_delta, 0)), 0)::double precision as total_wal_bytes
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
    `, totalsParams),
            pool.query(`
      with per_db as (
        select
          dbr.datname,
          sum(coalesce(d.wal_bytes_delta, 0))::double precision as wal_bytes
        from fact.pgss_delta d
        join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
        left join dim.query_text qt on qt.query_text_id = ss.query_text_id
        left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
          ${searchWhere}
        group by dbr.datname
      ),
      total as (
        select sum(wal_bytes) as total_bytes from per_db
      )
      select
        per_db.datname,
        (per_db.wal_bytes / 1048576.0)::double precision as wal_mb,
        (100.0 * per_db.wal_bytes / nullif(total.total_bytes, 0))::double precision as pct
      from per_db, total
      where per_db.wal_bytes > 0
      order by per_db.wal_bytes desc
      limit 1
    `, totalsParams),
            pool.query(`
      select
        ${bucketExpr} as bucket_start,
        (sum(coalesce(d.wal_bytes_delta, 0)) / 1048576.0)::double precision as mb
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
      group by bucket_start
      having sum(coalesce(d.wal_bytes_delta, 0)) > 0
      order by mb desc
      limit 1
    `, totalsParams),
            pool.query(`
      select distinct on (setting_name)
        setting_name,
        setting_value,
        unit,
        case
          when setting_name = 'max_wal_size' and unit = 'kB' then setting_value::bigint
          when setting_name = 'max_wal_size' and unit = 'MB' then setting_value::bigint * 1024
          when setting_name = 'max_wal_size' and unit = 'GB' then setting_value::bigint * 1024 * 1024
          when setting_name = 'max_wal_size' then setting_value::bigint
          else null
        end as kb
      from fact.pg_settings_snapshot
      where instance_pk = $1
        and setting_name in (
          'max_wal_size',
          'min_wal_size',
          'checkpoint_timeout',
          'checkpoint_completion_target',
          'wal_compression',
          'wal_level',
          'wal_buffers'
        )
      order by setting_name, snapshot_ts desc
    `, [id]),
            pool.query(`
      select
        slot_name,
        slot_lag_bytes as lag_bytes,
        wal_status,
        active
      from fact.pg_replication_slot_snapshot s
      where s.instance_pk = $1
        and s.sample_ts = (
          select max(sample_ts)
          from fact.pg_replication_slot_snapshot
          where instance_pk = $1
            and sample_ts between $2::timestamptz and $3::timestamptz
        )
      order by coalesce(slot_lag_bytes, 0) desc
      limit 1
    `, [id, fromIso, toIso]),
            pool.query(`
      select coalesce(sum(coalesce(spill_bytes, 0)), 0)::double precision as total
      from fact.pg_replication_slot_snapshot s
      where s.instance_pk = $1
        and s.slot_type = 'logical'
        and s.sample_ts = (
          select max(sample_ts)
          from fact.pg_replication_slot_snapshot
          where instance_pk = $1
            and sample_ts between $2::timestamptz and $3::timestamptz
        )
    `, [id, fromIso, toIso]),
            pool.query(`
      select
        (sum(coalesce(d.xact_commit_delta, 0))::double precision / nullif(extract(epoch from ($3::timestamptz - $2::timestamptz)), 0)) as commit_per_sec,
        (sum(coalesce(d.xact_rollback_delta, 0))::double precision / nullif(extract(epoch from ($3::timestamptz - $2::timestamptz)), 0)) as rollback_per_sec
      from fact.pg_database_delta d
      left join dim.database_ref dbr on dbr.instance_pk = d.instance_pk and dbr.dbid = d.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${tpsDatnameWhere}
    `, tpsParams),
            pool.query(`
      select
        archived_count,
        last_archived_time,
        failed_count,
        last_failed_time,
        extract(epoch from (now() - last_archived_time))::int as lag_seconds
      from fact.pg_archiver_snapshot
      where instance_pk = $1
      order by sample_ts desc
      limit 1
    `, [id]),
        ]);

        const topDb = topDbResult.rows[0] ?? null;
        const peak = peakResult.rows[0] ?? null;
        const settingByName = new Map(settingsResult.rows.map((r: any) => [String(r.setting_name), r]));
        const sizeKb = (name: string): number | null => {
            const row = settingByName.get(name) as any;
            if (!row?.setting_value) return null;
            const value = Number(row.setting_value);
            if (!Number.isFinite(value)) return null;
            const unit = String(row.unit ?? '');
            if (unit === 'GB') return value * 1024 * 1024;
            if (unit === 'MB') return value * 1024;
            return value;
        };
        const durationSec = (name: string): number | null => {
            const row = settingByName.get(name) as any;
            if (!row?.setting_value) return null;
            const value = Number(row.setting_value);
            if (!Number.isFinite(value)) return null;
            const unit = String(row.unit ?? '');
            if (unit === 'min') return value * 60;
            if (unit === 'ms') return value / 1000;
            return value;
        };
        const textSetting = (name: string): string | null => {
            const row = settingByName.get(name) as any;
            return row?.setting_value == null ? null : String(row.setting_value);
        };
        const numberSetting = (name: string): number | null => {
            const row = settingByName.get(name) as any;
            if (row?.setting_value == null) return null;
            const value = Number(row.setting_value);
            return Number.isFinite(value) ? value : null;
        };
        const maxWalSizeKb = sizeKb('max_wal_size');
        const walCompression = textSetting('wal_compression');
        const totalWalBytes = Number(totalWalResult.rows[0]?.total_wal_bytes ?? 0);
        const windowSeconds = Math.max(0, (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000);
        const tpsRow = tpsResult.rows[0] ?? null;
        const commitPerSec = Number(tpsRow?.commit_per_sec ?? 0);
        const rollbackPerSec = Number(tpsRow?.rollback_per_sec ?? 0);
        const totalTps = commitPerSec + rollbackPerSec;
        const archiverRow = archiverResult.rows[0] ?? null;
        const walSettings = {
            max_wal_size_kb: maxWalSizeKb,
            min_wal_size_kb: sizeKb('min_wal_size'),
            checkpoint_timeout_sec: durationSec('checkpoint_timeout'),
            checkpoint_completion_target: numberSetting('checkpoint_completion_target'),
            wal_compression: walCompression,
            wal_level: textSetting('wal_level'),
            wal_buffers_kb: sizeKb('wal_buffers'),
        };

        res.json({
            rows: result.rows,
            totals: {
                total_wal_bytes: totalWalBytes,
                top_datname: topDb ? { datname: topDb.datname, wal_mb: Number(topDb.wal_mb), pct: Number(topDb.pct) } : null,
                peak: peak ? { bucket_start: peak.bucket_start, mb: Number(peak.mb) } : null,
                max_wal_size_kb: maxWalSizeKb,
                wal_compression: walCompression,
                fpi_heavy_count: result.rows.filter((r: any) => Number(r.fpi_ratio ?? 0) > 0.5).length,
                wal_throughput_mb_per_sec: windowSeconds > 0 ? totalWalBytes / 1048576.0 / windowSeconds : 0,
                replication_lag: replicationLagResult.rows[0] ? {
                    slot_name: replicationLagResult.rows[0].slot_name,
                    lag_bytes: Number(replicationLagResult.rows[0].lag_bytes ?? 0),
                    wal_status: replicationLagResult.rows[0].wal_status,
                    active: replicationLagResult.rows[0].active,
                } : null,
                spill_bytes_total: Number(spillBytesResult.rows[0]?.total ?? 0),
                tps: totalTps > 0 ? {
                    commit_per_sec: commitPerSec,
                    rollback_per_sec: rollbackPerSec,
                    total_per_sec: totalTps,
                } : null,
                archiver: archiverRow ? {
                    archived_count: Number(archiverRow.archived_count ?? 0),
                    last_archived_time: archiverRow.last_archived_time ?? null,
                    failed_count: Number(archiverRow.failed_count ?? 0),
                    last_failed_time: archiverRow.last_failed_time ?? null,
                    lag_seconds: archiverRow.lag_seconds == null ? null : Number(archiverRow.lag_seconds),
                } : null,
                wal_settings: walSettings,
            },
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/insights/:id/wal-trend?from=&to=&datname=&search=&compare=&include_baseline=1
router.get('/:id/wal-trend', async (req, res, next) => {
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
            fetchWalTrendData(id, fromIso, toIso, datname, searchRaw, bucketExpr, windowHours),
            baselineNeeded
                ? fetchWalTrendData(id, fromIso, toIso, datname, '', bucketExpr, windowHours)
                : Promise.resolve(null),
        ]);

        let previous: any[] = [];
        if (compare) {
            const offset = COMPARE_OFFSETS[compare];
            previous = (await fetchWalTrendData(
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
        const totalsParams = [...params];
        params.push(limit);

        const windowHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
        const bucketExpr = pgssBucketExpr(windowHours);

        const result = await pool.query(`
      with toplam_temp as (
        select sum(coalesce(d.temp_blks_written_delta, 0)) as total_blks
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
        -- En kotu sample periyodundaki tek-cagri temp ortalamasi (MB).
        -- Sample = collector cycle. 0 calls'a karsi nullif ile korunur.
        round((
          max(
            case when d.calls_delta > 0
              then (coalesce(d.temp_blks_written_delta, 0) / 128.0)
                   / d.calls_delta::numeric
              else 0
            end
          )
        )::numeric, 2) as max_temp_mb_per_call,
        -- Cagri basina ortalama paralel worker sayisi. calls'a normalize edilmis toplam worker.
        case when sum(d.calls_delta) > 0
          then round((sum(coalesce(d.parallel_workers_launched_delta, 0))::numeric
                      / sum(d.calls_delta)::numeric), 2)
          else 0 end as avg_parallel_workers,
        -- Onerilen work_mem alt siniri (MB). Tek cagrida yazilan temp'i worker'a paylastir.
        case when sum(coalesce(d.temp_blks_written_delta, 0)) > 0
             and sum(d.calls_delta) > 0
          then round((
            (sum(coalesce(d.temp_blks_written_delta, 0)) / 128.0)
            / sum(d.calls_delta)::numeric
            / greatest(
                1,
                sum(coalesce(d.parallel_workers_launched_delta, 0))::numeric
                  / nullif(sum(d.calls_delta), 0)::numeric
              )
          )::numeric, 2)
          else null end as recommended_work_mem_mb_min,
        round((sum(coalesce(d.temp_blk_write_time_ms_delta, 0)) / 1000.0)::numeric, 2) as temp_write_time_sec,
        case when sum(coalesce(d.temp_blks_written_delta, 0)) > 0
          then round((sum(coalesce(d.rows_delta, 0))::numeric
                      / (sum(coalesce(d.temp_blks_written_delta, 0)) / 128.0))::numeric, 0)
          else null end as rows_per_temp_mb,
        round((100.0 * sum(coalesce(d.temp_blks_written_delta, 0))
               / nullif((select total_blks from toplam_temp), 0))::numeric, 1) as pct_of_total_temp,
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

        const [totalIoResult, topDbResult, peakResult, workMemResult] = await Promise.all([
            pool.query(`
      select coalesce((
        sum(coalesce(d.temp_blk_write_time_ms_delta, 0))
        + sum(coalesce(d.temp_blk_read_time_ms_delta, 0))
      ) / 1000.0, 0)::double precision as total_temp_write_time_sec
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
    `, totalsParams),
            pool.query(`
      with per_db as (
        select
          dbr.datname,
          sum(coalesce(d.temp_blks_written_delta, 0))::double precision as temp_blks
        from fact.pgss_delta d
        join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
        left join dim.query_text qt on qt.query_text_id = ss.query_text_id
        left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
          ${searchWhere}
        group by dbr.datname
      ),
      total as (
        select sum(temp_blks) as total_blks from per_db
      )
      select
        per_db.datname,
        (per_db.temp_blks / 128.0)::double precision as mb,
        (100.0 * per_db.temp_blks / nullif(total.total_blks, 0))::double precision as pct
      from per_db, total
      where per_db.temp_blks > 0
      order by per_db.temp_blks desc
      limit 1
    `, totalsParams),
            pool.query(`
      select
        ${bucketExpr} as bucket_start,
        (sum(coalesce(d.temp_blks_written_delta, 0)) / 128.0)::double precision as mb
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${searchWhere}
      group by bucket_start
      having sum(coalesce(d.temp_blks_written_delta, 0)) > 0
      order by mb desc
      limit 1
    `, totalsParams),
            pool.query(`
      select setting_value::bigint as kb
      from fact.pg_settings_snapshot
      where instance_pk = $1
        and setting_name = 'work_mem'
      order by snapshot_ts desc
      limit 1
    `, [id]),
        ]);

        const topDb = topDbResult.rows[0] ?? null;
        const peak = peakResult.rows[0] ?? null;
        const workMem = workMemResult.rows[0] ?? null;
        res.json({
            rows: result.rows,
            totals: {
                total_temp_write_time_sec: Number(totalIoResult.rows[0]?.total_temp_write_time_sec ?? 0),
                top_datname: topDb ? { datname: topDb.datname, mb: Number(topDb.mb), pct: Number(topDb.pct) } : null,
                peak: peak ? { bucket_start: peak.bucket_start, mb: Number(peak.mb) } : null,
                work_mem_kb: workMem?.kb == null ? null : Number(workMem.kb),
            },
        });
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
