import { Router } from 'express';
import { pool } from '../config/database';
import { parseTimeRange, parseLimit } from '../middleware/validation';

const router = Router();

// GET /api/insights/:id/db-time-trend?from=...&to=...[&datname=...]
router.get('/:id/db-time-trend', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        const datname = (req.query.datname as string || '').trim();
        const params: any[] = [id, fromIso, toIso];
        let dbWhere = '';
        if (datname) {
            params.push(datname);
            dbWhere = ` and dbr.datname = $${params.length}`;
        }

        // Bucket granulu pencereye gore secilir — hourly aggregate'in gec
        // gelmesi sorununu by-pass etmek icin fact.pgss_delta'dan okuyoruz.
        //   <= 6 saat  → 5 dakika
        //   <= 48 saat → 1 saat
        //   otesi      → 1 gun
        const windowHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
        const bucketExpr = windowHours <= 6
            ? `date_trunc('hour', d.sample_ts) + make_interval(mins => (extract(minute from d.sample_ts)::int / 5) * 5)`
            : windowHours <= 48
                ? `date_trunc('hour', d.sample_ts)`
                : `date_trunc('day', d.sample_ts)`;

        const result = await pool.query(`
            select
              ${bucketExpr} as bucket_start,
              coalesce(sum(d.total_exec_time_ms_delta), 0)::double precision as total_ms,
              coalesce(sum(d.calls_delta), 0)::bigint as total_calls
            from fact.pgss_delta d
            join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
            left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
            where d.instance_pk = $1
              and d.sample_ts between $2::timestamptz and $3::timestamptz
              ${dbWhere}
            group by bucket_start
            order by bucket_start
        `, params);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// GET /api/insights/:id/query-trend?series_id=N&from=...&to=...
router.get('/:id/query-trend', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { fromIso, toIso } = parseTimeRange(req.query, 1);
        const seriesIdRaw = String(req.query.series_id || '');
        if (!/^\d+$/.test(seriesIdRaw)) {
            res.status(400).json({ error: 'Invalid series_id' });
            return;
        }

        const windowHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
        const bucketExpr = windowHours <= 6
            ? `date_trunc('hour', d.sample_ts) + make_interval(mins => (extract(minute from d.sample_ts)::int / 5) * 5)`
            : windowHours <= 48
                ? `date_trunc('hour', d.sample_ts)`
                : `date_trunc('day', d.sample_ts)`;

        const result = await pool.query(`
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
            order by bucket_start
        `, [id, seriesIdRaw, fromIso, toIso]);
        res.json(result.rows);
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
        sum(d.calls_delta)::bigint as toplam_cagri,
        sum(d.total_exec_time_ms_delta)::bigint as toplam_exec_ms,
        round((sum(d.total_exec_time_ms_delta) / 1000.0 / 60.0)::numeric, 2) as toplam_dk,
        round((100.0 * sum(d.total_exec_time_ms_delta) / nullif((select total_ms from toplam), 0))::numeric, 1) as pct_of_total,
        round(min(d.min_exec_time_ms)::numeric, 2) as min_ms,
        round(avg(d.mean_exec_time_ms)::numeric, 2) as ort_ms,
        round(max(d.max_exec_time_ms)::numeric, 2) as max_ms,
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
      having sum(d.total_exec_time_ms_delta) > 0
      order by ${orderBy}
      limit $${params.length}
    `, params);

        res.json(result.rows);
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
