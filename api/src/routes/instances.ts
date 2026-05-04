import { Router } from 'express';
import { pool } from '../config/database';
import { saveSecret, hasSecret } from '../config/secrets';
import { parseHours, parseLimit, parseOrderBy } from '../middleware/validation';

const router = Router();

// GET /api/instances — Instance listesi
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(`
      select
        i.instance_pk, i.instance_id, i.display_name, i.environment,
        i.service_group, i.host, i.port, i.is_active, i.bootstrap_state,
        i.admin_dbname, i.collector_username, i.secret_ref, i.ssl_mode,
        i.ssl_root_cert_path, i.collector_group, i.notes,
        i.schedule_profile_id, i.retention_policy_id,
        c.pg_major, c.is_reachable, c.is_primary, c.collector_sql_family,
        s.last_cluster_collect_at, s.last_statements_collect_at,
        s.consecutive_failures, s.backoff_until,
        s.last_error, s.last_error_at
      from control.instance_inventory i
      left join control.instance_capability c on c.instance_pk = i.instance_pk
      left join control.instance_state s on s.instance_pk = i.instance_pk
      order by i.display_name
    `);
    res.json(result.rows.map((r: any) => ({ ...r, secret_ref: maskSecretRef(r.secret_ref) })));
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/storage-summary — Collector DB'de instance bazli gerçek veri kullanimi
router.get('/storage-summary', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      with storage_usage as (${collectorStorageUnionSql()}),
      per_instance as (
        select
          instance_pk,
          sum(row_count)::bigint as collector_rows,
          sum(data_bytes)::bigint as collector_bytes
        from storage_usage
        group by instance_pk
      )
      select
        instance_pk,
        collector_rows,
        collector_bytes,
        (select sum(collector_bytes) from per_instance)::bigint as collector_db_bytes
      from per_instance
    `);
    res.json(result.rows);
  } catch (err: any) {
    console.error('[storage-summary] error:', err.message);
    res.json([]);
  }
});

// GET /api/instances/:id/storage — Collector DB'de instance + database kirilimi
router.get('/:id/storage', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      with storage_usage as (${collectorStorageUnionSql()}),
      filtered as (
        select * from storage_usage where instance_pk = $1
      ),
      total as (
        select
          coalesce(sum(row_count), 0)::bigint as total_rows,
          coalesce(sum(data_bytes), 0)::bigint as total_bytes
        from filtered
      ),
      dbs as (
        select
          dbid,
          coalesce(datname, case when dbid is null then '(cluster)' else '(unknown)' end) as datname,
          sum(row_count)::bigint as row_count,
          sum(data_bytes)::bigint as data_bytes
        from filtered
        group by dbid, coalesce(datname, case when dbid is null then '(cluster)' else '(unknown)' end)
      ),
      tables as (
        select
          source_table,
          coalesce(datname, case when dbid is null then '(cluster)' else '(unknown)' end) as datname,
          sum(row_count)::bigint as row_count,
          sum(data_bytes)::bigint as data_bytes
        from filtered
        group by source_table, coalesce(datname, case when dbid is null then '(cluster)' else '(unknown)' end)
      )
      select json_build_object(
        'instance_pk', $1::bigint,
        'collector_db_bytes', pg_database_size(current_database())::bigint,
        'total_rows', (select total_rows from total),
        'total_bytes', (select total_bytes from total),
        'databases', coalesce((select json_agg(dbs order by data_bytes desc) from dbs), '[]'::json),
        'tables', coalesce((select json_agg(tables order by data_bytes desc) from tables), '[]'::json)
      ) as storage
    `, [id]);
    res.json(result.rows[0]?.storage ?? {});
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id — Instance detayı
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      select
        i.*, c.*, s.*
      from control.instance_inventory i
      left join control.instance_capability c on c.instance_pk = i.instance_pk
      left join control.instance_state s on s.instance_pk = i.instance_pk
      where i.instance_pk = $1
    `, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const row = { ...result.rows[0], secret_ref: maskSecretRef(result.rows[0].secret_ref), has_password: hasSecret(result.rows[0].instance_id) };
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// POST /api/instances — Yeni instance ekle
router.post('/', async (req, res, next) => {
  try {
    const {
      instance_id, display_name, environment, service_group,
      host, port, admin_dbname, secret_ref, password, ssl_mode,
      ssl_root_cert_path, schedule_profile_id, retention_policy_id,
      collector_group, notes
    } = req.body;

    // Şifre gelirse encrypt edip dosyaya yaz, secret_ref oluştur
    let finalSecretRef = secret_ref;
    if (password && password.trim()) {
      finalSecretRef = saveSecret(instance_id, password);
    }

    if (!finalSecretRef) {
      res.status(400).json({ error: 'Şifre veya secret_ref zorunludur' });
      return;
    }

    const result = await pool.query(`
      insert into control.instance_inventory (
        instance_id, display_name, environment, service_group,
        host, port, admin_dbname, collector_username, secret_ref, ssl_mode, ssl_root_cert_path,
        schedule_profile_id, retention_policy_id, collector_group, notes
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      returning *
    `, [
      instance_id, display_name, environment || null, service_group || null,
      host, port || 5432, admin_dbname || 'postgres',
      req.body.collector_username || 'pgstats_collector',
      finalSecretRef,
      ssl_mode || 'prefer', ssl_root_cert_path || null,
      schedule_profile_id, retention_policy_id, collector_group || null, notes || null
    ]);
    // secret_ref'i response'dan maskele
    const row = { ...result.rows[0], secret_ref: maskSecretRef(result.rows[0].secret_ref) };
    res.status(201).json(row);
  } catch (err: any) {
    // Duplicate instance_id
    if (err.code === '23505' && err.constraint === 'uq_instance_inventory_instance_id') {
      res.status(409).json({ error: `"${req.body.instance_id}" ID\'li instance zaten mevcut` });
      return;
    }
    next(err);
  }
});

// PUT /api/instances/:id — Instance güncelle
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      display_name, environment, service_group, host, port,
      admin_dbname, secret_ref, password, ssl_mode, ssl_root_cert_path,
      schedule_profile_id, retention_policy_id, collector_group, notes
    } = req.body;

    // Şifre değiştirilmişse yeniden encrypt et
    let finalSecretRef = secret_ref;
    if (password && password.trim()) {
      // instance_id'yi DB'den al
      const existing = await pool.query('select instance_id from control.instance_inventory where instance_pk = $1', [id]);
      if (existing.rows.length > 0) {
        finalSecretRef = saveSecret(existing.rows[0].instance_id, password);
      }
    }

    const result = await pool.query(`
      update control.instance_inventory set
        display_name = $2, environment = $3, service_group = $4,
        host = $5, port = $6, admin_dbname = $7,
        collector_username = coalesce($8, collector_username),
        secret_ref = coalesce($9, secret_ref),
        ssl_mode = $10, ssl_root_cert_path = $11,
        schedule_profile_id = $12, retention_policy_id = $13,
        collector_group = $14, notes = $15, updated_at = now()
      where instance_pk = $1
      returning *
    `, [
      id, display_name, environment || null, service_group || null,
      host, port, admin_dbname,
      req.body.collector_username || null,
      finalSecretRef,
      ssl_mode, ssl_root_cert_path || null,
      schedule_profile_id, retention_policy_id, collector_group || null, notes || null
    ]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const row = { ...result.rows[0], secret_ref: maskSecretRef(result.rows[0].secret_ref) };
    res.json(row);
  } catch (err: any) {
    // Unique constraint ihlali — anlamlı hata mesajı dön
    if (err.code === '23505' && err.constraint === 'uq_instance_inventory_host_port_db') {
      res.status(409).json({ error: `Bu host:port:dbname kombinasyonu zaten başka bir instance'ta kayıtlı (${err.detail})` });
      return;
    }
    next(err);
  }
});

// PATCH /api/instances/:id/toggle — Instance aktif/pasif toggle
router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      update control.instance_inventory
      set is_active = not is_active, updated_at = now()
      where instance_pk = $1
      returning instance_pk, instance_id, is_active
    `, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/instances/:id/retry — Bootstrap'ı pending'e döndür, yeniden dene
router.patch('/:id/retry', async (req, res, next) => {
  try {
    const { id } = req.params;
    // bootstrap_state'i pending'e al, retry sayacini sifirla, last_error'ı temizle
    // V035 sonrasi bootstrap_retry_count + next_bootstrap_retry_at kolonlari var.
    // Eski DB'lerde yoksa silently atla.
    const colsRes = await pool.query(
      `select column_name from information_schema.columns
       where table_schema='control' and table_name='instance_inventory'
         and column_name in ('bootstrap_retry_count','next_bootstrap_retry_at')`
    );
    const hasRetryCols = colsRes.rows.length === 2;
    const setSql = hasRetryCols
      ? `bootstrap_state = 'pending', bootstrap_retry_count = 0, next_bootstrap_retry_at = null, updated_at = now()`
      : `bootstrap_state = 'pending', updated_at = now()`;
    await pool.query(`update control.instance_inventory set ${setSql} where instance_pk = $1`, [id]);
    await pool.query(`
      update control.instance_state
      set last_error = null, last_error_at = null,
          consecutive_failures = 0, backoff_until = null
      where instance_pk = $1
    `, [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/databases — Instance'a ait database listesi
router.get('/:id/databases', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      select
        dr.database_ref_id, dr.dbid, dr.datname, dr.is_template,
        dr.first_seen_at, dr.last_seen_at,
        ds.last_db_objects_collect_at, ds.next_db_objects_collect_at,
        ds.consecutive_failures
      from dim.database_ref dr
      left join control.database_state ds
        on ds.instance_pk = dr.instance_pk and ds.dbid = dr.dbid
      where dr.instance_pk = $1
      order by dr.datname
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/capability — Instance capability detayı
router.get('/:id/capability', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      select * from control.instance_capability where instance_pk = $1
    `, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Capability not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/statements — Instance'a ait top statement'lar
// Filtreler: hours, limit, order_by, datname, rolname
router.get('/:id/statements', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const limit = parseLimit(req.query.limit, 100);
    const datname = (req.query.datname as string) || null;
    const rolname = (req.query.rolname as string) || null;

    const orderMap: Record<string, string> = {
      exec_time: 'total_exec_time_ms',
      avg_time: 'avg_exec_time_ms',
      calls: 'total_calls',
      rows: 'total_rows',
      blks_read: 'total_shared_blks_read',
      temp_blks: 'total_temp_blks_written',
    };
    const orderCol = orderMap[(req.query.order_by as string) || ''] || 'total_exec_time_ms';

    const params: any[] = [id, hours, limit];
    let whereExtra = '';
    if (datname) { params.push(datname); whereExtra += ` and dbr.datname = $${params.length}`; }
    if (rolname) { params.push(rolname); whereExtra += ` and rr.rolname = $${params.length}`; }

    const result = await pool.query(`
      select
        ss.statement_series_id,
        ss.dbid, ss.userid, ss.queryid,
        left(qt.query_text, 500) as query_text,
        rr.rolname,
        dbr.datname,
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
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts >= now() - make_interval(hours => $2)
        ${whereExtra}
      group by ss.statement_series_id, ss.dbid, ss.userid, ss.queryid,
               qt.query_text, rr.rolname, dbr.datname
      order by ${orderCol} desc nulls last
      limit $3
    `, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/statements/hourly — Saatlik statement rollup
router.get('/:id/statements/hourly', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 24);

    const result = await pool.query(`
      select
        h.bucket_start,
        sum(h.calls_sum) as total_calls,
        sum(h.exec_time_ms_sum) as total_exec_time_ms,
        sum(h.rows_sum) as total_rows,
        sum(h.shared_blks_read_sum) as total_shared_blks_read,
        sum(h.shared_blks_hit_sum) as total_shared_blks_hit
      from agg.pgss_hourly h
      where h.instance_pk = $1
        and h.bucket_start >= now() - make_interval(hours => $2)
      group by h.bucket_start
      order by h.bucket_start
    `, [id, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/cluster-metrics — Cluster metrikleri zaman serisi
router.get('/:id/cluster-metrics', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const family = req.query.family as string; // pg_stat_bgwriter, pg_stat_wal, vb.

    let query = `
      select sample_ts, metric_family, metric_name, metric_value_num
      from fact.pg_cluster_delta
      where instance_pk = $1
        and sample_ts >= now() - make_interval(hours => $2)
    `;
    const params: any[] = [id, hours];

    if (family) {
      query += ` and metric_family = $3`;
      params.push(family);
    }

    query += ` order by sample_ts, metric_family, metric_name`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/activity — Aktif session snapshot
router.get('/:id/activity', async (req, res, next) => {
  try {
    const { id } = req.params;
    // En son snapshot'i getir
    const result = await pool.query(`
      select *
      from fact.pg_activity_snapshot
      where instance_pk = $1
        and snapshot_ts = (
          select max(snapshot_ts) from fact.pg_activity_snapshot
          where instance_pk = $1
        )
      order by state, query_start
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/replication — Replication durumu
router.get('/:id/replication', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      select *
      from fact.pg_replication_snapshot
      where instance_pk = $1
        and snapshot_ts = (
          select max(snapshot_ts) from fact.pg_replication_snapshot
          where instance_pk = $1
        )
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/databases/:dbid/tables — Database tablo istatistikleri
router.get('/:id/databases/:dbid/tables', async (req, res, next) => {
  try {
    const { id, dbid } = req.params;
    const hours = parseHours(req.query.hours, 1);

    const result = await pool.query(`
      select
        t.relid, t.schemaname, t.relname,
        sum(t.seq_scan_delta) as total_seq_scan,
        sum(t.idx_scan_delta) as total_idx_scan,
        sum(t.n_tup_ins_delta) as total_inserts,
        sum(t.n_tup_upd_delta) as total_updates,
        sum(t.n_tup_del_delta) as total_deletes,
        sum(t.heap_blks_read_delta) as total_heap_blks_read,
        sum(t.heap_blks_hit_delta) as total_heap_blks_hit,
        max(t.n_live_tup_estimate) as n_live_tup,
        max(t.n_dead_tup_estimate) as n_dead_tup
      from fact.pg_table_stat_delta t
      where t.instance_pk = $1
        and t.dbid = $2
        and t.sample_ts >= now() - make_interval(hours => $3)
      group by t.relid, t.schemaname, t.relname
      order by total_seq_scan desc nulls last
      limit 100
    `, [id, dbid, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/databases/:dbid/indexes — Database index istatistikleri
router.get('/:id/databases/:dbid/indexes', async (req, res, next) => {
  try {
    const { id, dbid } = req.params;
    const hours = parseHours(req.query.hours, 1);

    const result = await pool.query(`
      select
        ix.index_relid, ix.table_relid, ix.schemaname,
        ix.table_relname, ix.index_relname,
        sum(ix.idx_scan_delta) as total_idx_scan,
        sum(ix.idx_tup_read_delta) as total_idx_tup_read,
        sum(ix.idx_tup_fetch_delta) as total_idx_tup_fetch,
        sum(ix.idx_blks_read_delta) as total_idx_blks_read,
        sum(ix.idx_blks_hit_delta) as total_idx_blks_hit
      from fact.pg_index_stat_delta ix
      where ix.instance_pk = $1
        and ix.dbid = $2
        and ix.sample_ts >= now() - make_interval(hours => $3)
      group by ix.index_relid, ix.table_relid, ix.schemaname,
               ix.table_relname, ix.index_relname
      order by total_idx_scan desc nulls last
      limit 100
    `, [id, dbid, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/databases/:dbid/stats — Database genel istatistikleri
router.get('/:id/databases/:dbid/stats', async (req, res, next) => {
  try {
    const { id, dbid } = req.params;
    const hours = parseHours(req.query.hours, 24);

    const result = await pool.query(`
      select
        sample_ts, numbackends,
        xact_commit_delta, xact_rollback_delta,
        blks_read_delta, blks_hit_delta,
        tup_returned_delta, tup_fetched_delta,
        tup_inserted_delta, tup_updated_delta, tup_deleted_delta,
        temp_files_delta, temp_bytes_delta, deadlocks_delta
      from fact.pg_database_delta
      where instance_pk = $1
        and dbid = $2
        and sample_ts >= now() - make_interval(hours => $3)
      order by sample_ts
    `, [id, dbid, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/health-report — Anlık sağlık raporu
// Tüm metrikleri tek seferde kontrol eder, checklist + trend verisi döner
router.get('/:id/health-report', async (req, res, next) => {
  try {
    const { id } = req.params;
    const days = parseInt(req.query.days as string) || 7;

    // Yardımcı: sorgu hatası olursa boş sonuç dön (500 yerine graceful)
    const safeQuery = async (sql: string, params: any[] = []) => {
      try { return await pool.query(sql, params); }
      catch (e: any) { console.error('[health-report] safeQuery error:', e.message, sql.slice(0, 80)); return { rows: [] }; }
    };

    // Paralel sorgular — tüm metrikleri aynı anda çek
    const [
      instanceInfo, cacheHit, connections, tempFiles, deadlocks,
      walProduction, openAlerts, tpsDaily, connectionDaily, walDaily, cpuProxyDaily, bloatTop, indexSuspect,
      unusedIndex, settings
    ] = await Promise.all([
      // Instance bilgisi
      safeQuery(`select i.*, c.pg_major, c.is_primary, s.last_cluster_collect_at, s.consecutive_failures
        from control.instance_inventory i
        left join control.instance_capability c on c.instance_pk = i.instance_pk
        left join control.instance_state s on s.instance_pk = i.instance_pk
        where i.instance_pk = $1`, [id]),

      // Cache hit ratio (son 24h)
      pool.query(`select round(100.0 * sum(blks_hit_delta)::numeric /
        nullif(sum(blks_hit_delta + blks_read_delta), 0), 2) as cache_hit_pct
        from fact.pg_database_delta where instance_pk = $1
        and sample_ts > now() - interval '24 hours'`, [id]),

      // Bağlantı kullanımı (son snapshot)
      pool.query(`select coalesce(sum(numbackends), 0) as total_backends
        from fact.pg_database_delta d
        where d.instance_pk = $1
        and d.sample_ts = (select max(sample_ts) from fact.pg_database_delta where instance_pk = $1)`, [id]),

      // Temp files (son 24h)
      pool.query(`select coalesce(sum(temp_files_delta), 0) as temp_files,
        coalesce(sum(temp_bytes_delta), 0) as temp_bytes
        from fact.pg_database_delta where instance_pk = $1
        and sample_ts > now() - interval '24 hours'`, [id]),

      // Deadlocks (son 24h)
      pool.query(`select coalesce(sum(deadlocks_delta), 0) as deadlocks
        from fact.pg_database_delta where instance_pk = $1
        and sample_ts > now() - interval '24 hours'`, [id]),

      // WAL üretimi (son 24h)
      pool.query(`select coalesce(sum(period_wal_size_byte), 0) as wal_bytes
        from fact.pg_wal_snapshot where instance_pk = $1
        and sample_ts > now() - interval '24 hours'`, [id]),

      // Açık alert'ler
      pool.query(`select severity, count(*) as cnt from ops.alert
        where instance_pk = $1 and status = 'open'
        group by severity`, [id]),

      // Günlük TPS trendi (son N gün, eksik günler 0 olarak doldurulur)
      safeQuery(`with days_series as (
        select generate_series(
          (now() - make_interval(days => $2))::date,
          current_date,
          '1 day'::interval
        )::date as day
      ),
      tps_agg as (
        select date_trunc('day', sample_ts)::date as day,
          sum(xact_commit_delta + xact_rollback_delta) as total_xact,
          round(sum(xact_commit_delta + xact_rollback_delta)::numeric / 86400) as avg_tps
        from fact.pg_database_delta where instance_pk = $1
        and sample_ts > now() - make_interval(days => $2)
        group by 1
      )
      select d.day, coalesce(t.total_xact, 0) as total_xact, coalesce(t.avg_tps, 0) as avg_tps
      from days_series d left join tps_agg t on t.day = d.day
      order by d.day`, [id, days]),

      // Günlük max bağlantı trendi (eksik günler 0)
      safeQuery(`with days_series as (
        select generate_series(
          (now() - make_interval(days => $2))::date,
          current_date,
          '1 day'::interval
        )::date as day
      ),
      conn_agg as (
        select date_trunc('day', sample_ts)::date as day,
          max(numbackends) as max_connections
        from fact.pg_database_delta where instance_pk = $1
        and sample_ts > now() - make_interval(days => $2)
        group by 1
      )
      select d.day, coalesce(c.max_connections, 0) as max_connections
      from days_series d left join conn_agg c on c.day = d.day
      order by d.day`, [id, days]),

      // Günlük WAL üretimi (MB cinsinden, eksik günler 0 olarak doldurulur)
      safeQuery(`with days_series as (
        select generate_series(
          (now() - make_interval(days => $2))::date,
          current_date,
          '1 day'::interval
        )::date as day
      ),
      wal_agg as (
        select date_trunc('day', sample_ts)::date as day,
          sum(period_wal_size_byte) as wal_bytes
        from fact.pg_wal_snapshot where instance_pk = $1
        and sample_ts > now() - make_interval(days => $2)
        group by 1
      )
      select d.day, coalesce(round(w.wal_bytes::numeric / 1048576, 1), 0) as wal_mb
      from days_series d left join wal_agg w on w.day = d.day
      order by d.day`, [id, days]),

      // CPU proxy: active_time / session_time (PG14+, session_time > 0 olan günler)
      safeQuery(`select date_trunc('day', sample_ts)::date as day,
        (100.0 * sum(active_time_ms_delta) / nullif(sum(session_time_ms_delta), 0))::numeric(5,1) as active_pct
        from fact.pg_database_delta where instance_pk = $1
        and sample_ts > now() - make_interval(days => $2)
        group by 1
        having sum(session_time_ms_delta) > 0
        order by 1`, [id, days]),

      // Top bloat tabloları
      pool.query(`with latest as (select max(sample_ts) as ts from fact.pg_table_stat_delta where instance_pk = $1)
        select schemaname || '.' || relname as relation,
        n_dead_tup_estimate as dead_tup, n_live_tup_estimate as live_tup,
        round(100.0 * n_dead_tup_estimate::numeric / nullif(n_live_tup_estimate + n_dead_tup_estimate, 0), 1) as dead_pct
        from fact.pg_table_stat_delta t join latest l on l.ts = t.sample_ts
        where t.instance_pk = $1 and (n_live_tup_estimate + n_dead_tup_estimate) > 1000
        order by dead_pct desc nulls last limit 5`, [id]),

      // Missing index suspect sayısı
      pool.query(`select count(*) as cnt from (
        select 1 from fact.pg_table_stat_delta t
        where t.instance_pk = $1 and t.sample_ts > now() - interval '24 hours'
        group by t.schemaname, t.relname
        having coalesce(sum(seq_scan_delta), 0) > coalesce(nullif(sum(idx_scan_delta), 0), 1) * 100
        and coalesce(sum(seq_tup_read_delta), 0) > 100000
      ) sub`, [id]),

      // Unused index sayısı
      pool.query(`select count(*) as cnt from (
        select 1 from fact.pg_index_stat_delta i
        where i.instance_pk = $1 and i.sample_ts > now() - interval '30 days'
        group by i.schemaname, i.index_relname
        having coalesce(sum(idx_scan_delta), 0) = 0
      ) sub`, [id]),

      // PG settings (son snapshot — sadece onemli parametreler)
      safeQuery(`select setting_name, setting_value, unit from fact.pg_settings_snapshot
        where instance_pk = $1
        and setting_name in ('shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem',
          'max_connections', 'max_wal_size', 'checkpoint_timeout', 'checkpoint_completion_target',
          'autovacuum_max_workers', 'autovacuum_vacuum_scale_factor', 'random_page_cost')
        and snapshot_ts = (
          select max(snapshot_ts) from fact.pg_settings_snapshot where instance_pk = $1
        )
        order by setting_name`, [id]),
    ]);

    const inst = instanceInfo.rows[0];
    if (!inst) return res.status(404).json({ error: 'Instance bulunamadı' });

    // max_connections settings'ten
    const maxConn = settings.rows.find((s: any) => s.setting_name === 'max_connections');
    const maxConnections = maxConn ? parseInt(maxConn.setting_value) : 200;
    const totalBackends = parseInt(connections.rows[0]?.total_backends || '0');
    const connPct = Math.round(100 * totalBackends / maxConnections);

    const cacheHitPct = parseFloat(cacheHit.rows[0]?.cache_hit_pct || '0');
    const tempFilesCount = parseInt(tempFiles.rows[0]?.temp_files || '0');
    const tempBytesTotal = parseInt(tempFiles.rows[0]?.temp_bytes || '0');
    const deadlocksCount = parseInt(deadlocks.rows[0]?.deadlocks || '0');
    const walBytes = parseInt(walProduction.rows[0]?.wal_bytes || '0');
    const missingIndexCount = parseInt(indexSuspect.rows[0]?.cnt || '0');
    const unusedIndexCount = parseInt(unusedIndex.rows[0]?.cnt || '0');

    // Alert sayıları
    const alertCounts: Record<string, number> = {};
    openAlerts.rows.forEach((r: any) => { alertCounts[r.severity] = parseInt(r.cnt); });
    const totalAlerts = Object.values(alertCounts).reduce((a, b) => a + b, 0);

    // Overall status
    let overallStatus = 'healthy';
    if (alertCounts.critical > 0 || connPct > 90) overallStatus = 'critical';
    else if (alertCounts.warning > 0 || cacheHitPct < 95 || tempFilesCount > 100 || connPct > 80) overallStatus = 'warning';

    // Checks
    const checks = [
      { section: 'Genel Durum', name: 'Bootstrap State', status: inst.bootstrap_state === 'ready' ? 'ok' : 'critical', value: inst.bootstrap_state },
      { section: 'Genel Durum', name: 'Cache Hit Ratio', status: cacheHitPct >= 99 ? 'ok' : cacheHitPct >= 95 ? 'warning' : 'critical', value: cacheHitPct + '%', threshold: '> 95%' },
      { section: 'Genel Durum', name: 'Bağlantı Kullanımı', status: connPct < 80 ? 'ok' : connPct < 90 ? 'warning' : 'critical', value: `${totalBackends}/${maxConnections} (${connPct}%)`, threshold: '< 80%' },
      { section: 'Performans', name: 'Temp Files (son 24 saat)', status: tempFilesCount === 0 ? 'ok' : tempFilesCount < 100 ? 'warning' : 'critical', value: `${tempFilesCount} dosya` },
      { section: 'Performans', name: 'Deadlock (son 24 saat)', status: deadlocksCount === 0 ? 'ok' : 'warning', value: String(deadlocksCount) },
      { section: 'Depolama', name: 'WAL Üretimi (son 24 saat)', status: walBytes < 5_000_000_000 ? 'ok' : 'warning', value: formatBytes(walBytes) },
      { section: 'Index Sağlığı', name: 'Missing Index Suspect', status: missingIndexCount === 0 ? 'ok' : 'warning', value: `${missingIndexCount} tablo` },
      { section: 'Index Sağlığı', name: 'Unused Index', status: unusedIndexCount === 0 ? 'ok' : 'info', value: `${unusedIndexCount} index` },
      { section: 'Alert', name: 'Açık Alert', status: totalAlerts === 0 ? 'ok' : alertCounts.critical ? 'critical' : 'warning', value: `${totalAlerts} alert` },
    ];

    res.json({
      instance_pk: parseInt(id as string),
      display_name: inst.display_name,
      host: inst.host,
      port: inst.port,
      pg_major: inst.pg_major,
      is_primary: inst.is_primary,
      generated_at: new Date().toISOString(),
      period_days: days,
      overall_status: overallStatus,
      checks,
      trends: {
        tps_daily: tpsDaily.rows,
        connection_daily: connectionDaily.rows,
        wal_daily: walDaily.rows,
        cpu_proxy_daily: cpuProxyDaily.rows,
        bloat_top: bloatTop.rows,
      },
      settings: settings.rows,
      alert_counts: alertCounts,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/tps — Günlük ve saatlik TPS tablosu
router.get('/:id/tps', async (req, res, next) => {
  try {
    const { id } = req.params;
    const days = parseInt(req.query.days as string) || 7;

    const [daily, hourly] = await Promise.all([
      pool.query(`
        select
          date_trunc('day', d.sample_ts)::date as day,
          dbr.datname,
          sum(d.xact_commit_delta) as commits,
          sum(d.xact_rollback_delta) as rollbacks,
          sum(d.xact_commit_delta + d.xact_rollback_delta) as total_xact,
          round(sum(d.xact_commit_delta + d.xact_rollback_delta)::numeric / 86400) as avg_tps
        from fact.pg_database_delta d
        left join dim.database_ref dbr on dbr.instance_pk = d.instance_pk and dbr.dbid = d.dbid
        where d.instance_pk = $1
          and d.sample_ts >= now() - make_interval(days => $2)
        group by 1, dbr.datname
        order by 1 desc, dbr.datname
      `, [id, days]),
      pool.query(`
        select
          date_trunc('hour', d.sample_ts) as hour,
          dbr.datname,
          sum(d.xact_commit_delta) as commits,
          sum(d.xact_rollback_delta) as rollbacks,
          sum(d.xact_commit_delta + d.xact_rollback_delta) as total_xact,
          round(sum(d.xact_commit_delta + d.xact_rollback_delta)::numeric / 3600) as avg_tps
        from fact.pg_database_delta d
        left join dim.database_ref dbr on dbr.instance_pk = d.instance_pk and dbr.dbid = d.dbid
        where d.instance_pk = $1
          and d.sample_ts >= now() - interval '25 hours'
        group by 1, dbr.datname
        order by 1 desc, dbr.datname
      `, [id]),
    ]);

    res.json({ daily: daily.rows, hourly: hourly.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/functions — User function istatistikleri
router.get('/:id/functions', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const result = await pool.query(`
      select
        f.funcid, f.schemaname, f.funcname,
        sum(f.calls_delta) as total_calls,
        sum(f.total_time_delta) as total_time_ms,
        sum(f.self_time_delta) as self_time_ms,
        case when sum(f.calls_delta) > 0
          then sum(f.total_time_delta) / sum(f.calls_delta)
          else 0 end as avg_time_ms
      from fact.pg_user_function_snapshot f
      where f.instance_pk = $1
        and f.snapshot_ts >= now() - make_interval(hours => $2)
      group by f.funcid, f.schemaname, f.funcname
      order by total_time_ms desc nulls last
      limit 100
    `, [id, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/sequences — Sequence I/O istatistikleri
router.get('/:id/sequences', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const result = await pool.query(`
      select
        s.relid, s.schemaname, s.relname,
        sum(s.blks_read_delta) as total_blks_read,
        sum(s.blks_hit_delta) as total_blks_hit,
        case when sum(s.blks_read_delta) + sum(s.blks_hit_delta) > 0
          then round(100.0 * sum(s.blks_hit_delta) / (sum(s.blks_read_delta) + sum(s.blks_hit_delta)), 1)
          else 100 end as hit_ratio
      from fact.pg_sequence_io_snapshot s
      where s.instance_pk = $1
        and s.snapshot_ts >= now() - make_interval(hours => $2)
      group by s.relid, s.schemaname, s.relname
      order by total_blks_read desc nulls last
      limit 100
    `, [id, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/wal — WAL + Archiver istatistikleri
router.get('/:id/wal', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const [walResult, archiverResult] = await Promise.all([
      pool.query(`
        select snapshot_ts, wal_records_delta, wal_fpi_delta, wal_bytes_delta,
               wal_buffers_full_delta, wal_write_delta, wal_sync_delta,
               wal_write_time_delta, wal_sync_time_delta
        from fact.pg_wal_snapshot
        where instance_pk = $1
          and snapshot_ts >= now() - make_interval(hours => $2)
        order by snapshot_ts
      `, [id, hours]),
      pool.query(`
        select snapshot_ts, archived_count, last_archived_wal, last_archived_time,
               failed_count, last_failed_wal, last_failed_time
        from fact.pg_archiver_snapshot
        where instance_pk = $1
          and snapshot_ts >= now() - make_interval(hours => $2)
        order by snapshot_ts
      `, [id, hours]),
    ]);
    res.json({ wal: walResult.rows, archiver: archiverResult.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/slru — SLRU cache istatistikleri
router.get('/:id/slru', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const result = await pool.query(`
      select
        s.name,
        sum(s.blks_zeroed_delta) as total_blks_zeroed,
        sum(s.blks_hit_delta) as total_blks_hit,
        sum(s.blks_read_delta) as total_blks_read,
        sum(s.blks_written_delta) as total_blks_written,
        sum(s.blks_exists_delta) as total_blks_exists,
        sum(s.flushes_delta) as total_flushes,
        sum(s.truncates_delta) as total_truncates,
        case when sum(s.blks_read_delta) + sum(s.blks_hit_delta) > 0
          then round(100.0 * sum(s.blks_hit_delta) / (sum(s.blks_read_delta) + sum(s.blks_hit_delta)), 1)
          else 100 end as hit_ratio
      from fact.pg_slru_snapshot s
      where s.instance_pk = $1
        and s.snapshot_ts >= now() - make_interval(hours => $2)
      group by s.name
      order by total_blks_read desc nulls last
    `, [id, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

function collectorStorageUnionSql(): string {
  return `
    select 'pgss_delta' as source_table, d.instance_pk, ss.dbid::bigint as dbid, dbr.datname,
           count(*)::bigint as row_count, coalesce(sum(pg_column_size(d)),0)::bigint as data_bytes
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
     group by d.instance_pk, ss.dbid, dbr.datname
    union all
    select 'statement_series', ss.instance_pk, ss.dbid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(ss) + coalesce(pg_column_size(qt),0)),0)::bigint
      from dim.statement_series ss
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
     group by ss.instance_pk, ss.dbid, dbr.datname
    union all
    select 'pg_database_delta', d.instance_pk, d.dbid::bigint, d.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(d)),0)::bigint
      from fact.pg_database_delta d
     group by d.instance_pk, d.dbid, d.datname
    union all
    select 'pg_table_stat_delta', t.instance_pk, t.dbid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(t)),0)::bigint
      from fact.pg_table_stat_delta t
      left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid
     group by t.instance_pk, t.dbid, dbr.datname
    union all
    select 'pg_index_stat_delta', i.instance_pk, i.dbid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(i)),0)::bigint
      from fact.pg_index_stat_delta i
      left join dim.database_ref dbr on dbr.instance_pk = i.instance_pk and dbr.dbid = i.dbid
     group by i.instance_pk, i.dbid, dbr.datname
    union all
    select 'pg_relation_size_snapshot', r.instance_pk, r.dbid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(r)),0)::bigint
      from fact.pg_relation_size_snapshot r
      left join dim.database_ref dbr on dbr.instance_pk = r.instance_pk and dbr.dbid = r.dbid
     group by r.instance_pk, r.dbid, dbr.datname
    union all
    select 'pg_sequence_io_snapshot', s.instance_pk, s.dbid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(s)),0)::bigint
      from fact.pg_sequence_io_snapshot s
      left join dim.database_ref dbr on dbr.instance_pk = s.instance_pk and dbr.dbid = s.dbid
     group by s.instance_pk, s.dbid, dbr.datname
    union all
    select 'pg_sequence_state_snapshot', s.instance_pk, s.dbid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(s)),0)::bigint
      from fact.pg_sequence_state_snapshot s
      left join dim.database_ref dbr on dbr.instance_pk = s.instance_pk and dbr.dbid = s.dbid
     group by s.instance_pk, s.dbid, dbr.datname
    union all
    select 'pg_database_freeze_snapshot', f.instance_pk, f.dbid::bigint, f.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(f)),0)::bigint
      from fact.pg_database_freeze_snapshot f
     group by f.instance_pk, f.dbid, f.datname
    union all
    select 'pg_cluster_delta', c.instance_pk, null::bigint, null::text,
           count(*)::bigint, coalesce(sum(pg_column_size(c)),0)::bigint
      from fact.pg_cluster_delta c
     group by c.instance_pk
    union all
    select 'pg_io_stat_delta', io.instance_pk, null::bigint, null::text,
           count(*)::bigint, coalesce(sum(pg_column_size(io)),0)::bigint
      from fact.pg_io_stat_delta io
     group by io.instance_pk
    union all
    select 'pg_activity_snapshot', a.instance_pk, dbr.dbid::bigint, a.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(a)),0)::bigint
      from fact.pg_activity_snapshot a
      left join dim.database_ref dbr on dbr.instance_pk = a.instance_pk and dbr.datname = a.datname
     group by a.instance_pk, dbr.dbid, a.datname
    union all
    select 'pg_lock_snapshot', l.instance_pk, l.database_oid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(l)),0)::bigint
      from fact.pg_lock_snapshot l
      left join dim.database_ref dbr on dbr.instance_pk = l.instance_pk and dbr.dbid = l.database_oid
     group by l.instance_pk, l.database_oid, dbr.datname
    union all
    select 'pg_progress_snapshot', p.instance_pk, dbr.dbid::bigint, p.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(p)),0)::bigint
      from fact.pg_progress_snapshot p
      left join dim.database_ref dbr on dbr.instance_pk = p.instance_pk and dbr.datname = p.datname
     group by p.instance_pk, dbr.dbid, p.datname
    union all
    select 'pg_replication_snapshot', r.instance_pk, null::bigint, null::text,
           count(*)::bigint, coalesce(sum(pg_column_size(r)),0)::bigint
      from fact.pg_replication_snapshot r
     group by r.instance_pk
    union all
    select 'pg_wal_snapshot', w.instance_pk, null::bigint, null::text,
           count(*)::bigint, coalesce(sum(pg_column_size(w)),0)::bigint
      from fact.pg_wal_snapshot w
     group by w.instance_pk
    union all
    select 'pg_archiver_snapshot', a.instance_pk, null::bigint, null::text,
           count(*)::bigint, coalesce(sum(pg_column_size(a)),0)::bigint
      from fact.pg_archiver_snapshot a
     group by a.instance_pk
    union all
    select 'pg_slru_snapshot', s.instance_pk, null::bigint, null::text,
           count(*)::bigint, coalesce(sum(pg_column_size(s)),0)::bigint
      from fact.pg_slru_snapshot s
     group by s.instance_pk
    union all
    select 'pg_subscription_snapshot', s.instance_pk, null::bigint, null::text,
           count(*)::bigint, coalesce(sum(pg_column_size(s)),0)::bigint
      from fact.pg_subscription_snapshot s
     group by s.instance_pk
    union all
    select 'pg_recovery_prefetch_snapshot', p.instance_pk, null::bigint, null::text,
           count(*)::bigint, coalesce(sum(pg_column_size(p)),0)::bigint
      from fact.pg_recovery_prefetch_snapshot p
     group by p.instance_pk
    union all
    select 'pg_user_function_snapshot', f.instance_pk, f.dbid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(f)),0)::bigint
      from fact.pg_user_function_snapshot f
      left join dim.database_ref dbr on dbr.instance_pk = f.instance_pk and dbr.dbid = f.dbid
     group by f.instance_pk, f.dbid, dbr.datname
    union all
    select 'pgss_hourly', h.instance_pk, ss.dbid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(h)),0)::bigint
      from agg.pgss_hourly h
      join dim.statement_series ss on ss.statement_series_id = h.statement_series_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
     group by h.instance_pk, ss.dbid, dbr.datname
    union all
    select 'pgss_daily', d.instance_pk, ss.dbid::bigint, dbr.datname,
           count(*)::bigint, coalesce(sum(pg_column_size(d)),0)::bigint
      from agg.pgss_daily d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
     group by d.instance_pk, ss.dbid, dbr.datname
  `;
}

export default router;

/** secret_ref'i UI'da göstermek için maskeler */
function maskSecretRef(ref: string | null): string {
  if (!ref) return '';
  if (ref.startsWith('file:')) return 'file:●●●●●●';
  if (ref.startsWith('env:')) return 'env:' + ref.substring(4);
  if (ref.startsWith('vault:')) return 'vault:●●●●●●';
  return '●●●●●●';
}

/** Byte değerini okunabilir formata çevirir */
function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + ' GB';
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
  if (bytes >= 1_024) return (bytes / 1_024).toFixed(1) + ' KB';
  return bytes + ' B';
}
