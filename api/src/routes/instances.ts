import { Router } from 'express';
import { pool } from '../config/database';
import { saveSecret, hasSecret } from '../config/secrets';
import { parseHours, parseLimit, parseOrderBy, parseTimeRange } from '../middleware/validation';
import { PGSS_COLUMNS, parseRequestedColumns } from './statements';

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

// GET /api/instances/storage-summary — Instance bazlı disk kullanımı (oransal)
router.get('/storage-summary', async (_req, res, next) => {
  try {
    // pg_database_size * (instance satır oranı) — index+TOAST+overhead dahil
    const result = await pool.query(`
      with instance_rows as (
        select instance_pk, count(*) as rcount
        from fact.pg_database_delta
        group by instance_pk
      ),
      total as (
        select coalesce(nullif(sum(rcount), 0), 1) as total_rows from instance_rows
      ),
      db as (
        select pg_database_size(current_database())::bigint as db_bytes
      )
      select
        ir.instance_pk,
        ir.rcount::bigint as collector_rows,
        (ir.rcount::double precision / t.total_rows * d.db_bytes)::bigint as collector_bytes,
        d.db_bytes as collector_db_bytes
      from instance_rows ir
      cross join total t
      cross join db d
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
// PATCH /api/instances/:id/manual-cluster — manuel küme grubu ata (logical replication
// veya farklı initdb'lerle aynı uygulamaya hizmet eden serverlar için)
router.patch('/:id/manual-cluster', async (req, res, next) => {
  try {
    const { id } = req.params;
    const groupId = req.body?.manual_cluster_group_id;
    const value = (typeof groupId === 'string' && groupId.trim()) ? groupId.trim().slice(0, 50) : null;
    const r = await pool.query(
      `update control.instance_inventory set manual_cluster_group_id = $1
             where instance_pk = $2 returning instance_pk, manual_cluster_group_id`,
      [value, id]
    );
    if (r.rowCount === 0) { res.status(404).json({ error: 'Instance bulunamadı' }); return; }
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/instances/:id/cluster — bu instance'ın küme bağlamı
router.get('/:id/cluster', async (req, res, next) => {
  try {
    const { id } = req.params;
    const r = await pool.query(`
            select vic.cluster_id, vic.cluster_kind,
                   vic.system_identifier, vic.manual_cluster_group_id,
                   coalesce(c.is_primary, false) as is_primary,
                   case
                     when vic.cluster_id is null then 'standalone'
                     when coalesce(c.is_primary, false) then 'primary'
                     else 'replica'
                   end as role
            from control.v_instance_cluster vic
            left join control.instance_capability c on c.instance_pk = vic.instance_pk
            where vic.instance_pk = $1
        `, [id]);
    const me = r.rows[0];
    if (!me) { res.status(404).json({ error: 'Instance bulunamadı' }); return; }

    let siblings: any[] = [];
    if (me.cluster_id) {
      const s = await pool.query(`
                select i.instance_pk, i.display_name, coalesce(c.is_primary, false) as is_primary,
                       i.bootstrap_state
                from control.v_instance_cluster vic
                join control.instance_inventory i on i.instance_pk = vic.instance_pk
                left join control.instance_capability c on c.instance_pk = i.instance_pk
                where vic.cluster_id = $1 and vic.instance_pk <> $2
                order by c.is_primary desc nulls last, i.display_name
            `, [me.cluster_id, id]);
      siblings = s.rows;
    }
    res.json({ ...me, siblings });
  } catch (err) { next(err); }
});

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

// POST /api/instances/:id/refresh-settings — pg_settings'i hemen yenile
// (kullanıcı ALTER SYSTEM yaptığında alert'in eski değer görmemesi için)
// Collector polling'de pending komutu görür ve hot settings çeker.
router.post('/:id/refresh-settings', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (Number.isNaN(id) || id <= 0) { res.status(400).json({ error: 'Geçersiz id' }); return; }
        const r = await pool.query(
            `insert into control.collector_command (command, instance_pk)
             values ('refresh_settings', $1) returning command_id, status, requested_at`,
            [id]);
        res.json(r.rows[0]);
    } catch (err) { next(err); }
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
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const limit = parseLimit(req.query.limit, 100);
    const datname = (req.query.datname as string) || null;
    const rolname = (req.query.rolname as string) || null;

    // Dinamik kolon destegi — statements.ts ile ayni whitelist
    const requestedCols = parseRequestedColumns(req.query.columns as string | undefined);
    const orderColRaw = (req.query.order_by as string) || 'total_exec_time_ms';
    const orderCol = requestedCols.includes(orderColRaw) ? orderColRaw
                     : (requestedCols.includes('total_exec_time_ms') ? 'total_exec_time_ms'
                        : requestedCols[0]);

    const params: any[] = [id, fromIso, toIso, limit];
    let whereExtra = '';
    if (datname) { params.push(datname); whereExtra += ` and dbr.datname = $${params.length}`; }
    if (rolname) { params.push(rolname); whereExtra += ` and rr.rolname = $${params.length}`; }

    const selectCols = requestedCols
      .map(c => `${PGSS_COLUMNS[c].sql} as ${c}`)
      .join(',\n        ');

    const result = await pool.query(`
      select ss.statement_series_id, ss.dbid, ss.userid, ss.queryid,
        ss.query_text_id,
        left(qt.query_text, 80) as query_text_short,
        rr.rolname, dbr.datname,
        ${selectCols}
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
        ${whereExtra}
      group by ss.statement_series_id, ss.dbid, ss.userid, ss.queryid,
               ss.query_text_id, qt.query_text, rr.rolname, dbr.datname
      order by ${orderCol} desc nulls last
      limit $4
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

// GET /api/instances/:id/tables — Instance genelinde tablo istatistikleri
router.get('/:id/tables', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);

    const result = await pool.query(`
      select
        t.dbid, dbr.datname,
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
      left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid
      where t.instance_pk = $1
        and t.sample_ts >= now() - make_interval(hours => $2)
      group by t.dbid, dbr.datname, t.relid, t.schemaname, t.relname
      order by total_seq_scan desc nulls last
      limit 500
    `, [id, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/indexes — Instance genelinde index istatistikleri
router.get('/:id/indexes', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const limit = parseLimit(req.query.limit, 500);
    const dbid = req.query.dbid ? Number(req.query.dbid) : null;
    const unusedOnly = req.query.unused === 'true';
    const invalidOnly = req.query.invalid === 'true';

    const params: Array<string | number> = [id, hours];
    const where = [
      'ix.instance_pk = $1',
      'ix.sample_ts >= b.window_start'
    ];
    if (Number.isFinite(dbid) && dbid && dbid > 0) {
      params.push(dbid);
      where.push(`ix.dbid = $${params.length}`);
    }
    params.push(limit);
    const limitParam = `$${params.length}`;
    const havingClauses: string[] = [];
    if (unusedOnly) {
      havingClauses.push("coalesce(sum(ix.idx_scan_delta), 0) = 0 and min(ix.sample_ts) <= b.window_start + b.tolerance and max(ix.sample_ts) >= b.window_end - b.tolerance");
    }
    if (invalidOnly) {
      havingClauses.push("(coalesce(lf.is_valid, true) = false or coalesce(lf.is_ready, true) = false)");
    }
    const havingSql = havingClauses.length ? `having ${havingClauses.join('\n        and ')}` : '';

    const result = await pool.query(`
      with bounds as (
        select
          now() - make_interval(hours => $2) as window_start,
          now() as window_end,
          least(greatest(make_interval(hours => $2) * 0.05, interval '10 minutes'), interval '6 hours') as tolerance
      ),
      latest_flags as (
        select distinct on (ix.instance_pk, ix.dbid, ix.index_relid)
          ix.instance_pk, ix.dbid, ix.index_relid,
          ix.is_valid, ix.is_ready, ix.is_primary, ix.is_unique
        from fact.pg_index_stat_delta ix
        where ix.instance_pk = $1
        order by ix.instance_pk, ix.dbid, ix.index_relid, ix.sample_ts desc
      )
      select
        ix.dbid, dbr.datname,
        ix.index_relid, ix.table_relid, ix.schemaname,
        ix.table_relname, ix.index_relname,
        coalesce(sum(ix.idx_scan_delta), 0) as total_idx_scan,
        coalesce(sum(ix.idx_tup_read_delta), 0) as total_idx_tup_read,
        coalesce(sum(ix.idx_tup_fetch_delta), 0) as total_idx_tup_fetch,
        coalesce(sum(ix.idx_blks_read_delta), 0) as total_idx_blks_read,
        coalesce(sum(ix.idx_blks_hit_delta), 0) as total_idx_blks_hit,
        coalesce(lf.is_valid, true) as is_valid,
        coalesce(lf.is_ready, true) as is_ready,
        coalesce(lf.is_primary, false) as is_primary,
        coalesce(lf.is_unique, false) as is_unique,
        min(ix.sample_ts) as observed_since,
        max(ix.sample_ts) as observed_until,
        round(extract(epoch from (max(ix.sample_ts) - min(ix.sample_ts))) / 3600.0, 1) as observed_hours,
        (min(ix.sample_ts) <= b.window_start + b.tolerance and max(ix.sample_ts) >= b.window_end - b.tolerance) as unused_window_covered
      from fact.pg_index_stat_delta ix
      cross join bounds b
      left join latest_flags lf on lf.instance_pk = ix.instance_pk and lf.dbid = ix.dbid and lf.index_relid = ix.index_relid
      left join dim.database_ref dbr on dbr.instance_pk = ix.instance_pk and dbr.dbid = ix.dbid
      where ${where.join('\n        and ')}
      group by ix.dbid, dbr.datname, ix.index_relid, ix.table_relid, ix.schemaname,
               ix.table_relname, ix.index_relname, lf.is_valid, lf.is_ready, lf.is_primary, lf.is_unique,
               b.window_start, b.window_end, b.tolerance
      ${havingSql}
      order by ${unusedOnly ? 'total_idx_blks_read desc nulls last, dbr.datname, ix.schemaname, ix.index_relname' : 'total_idx_scan desc nulls last'}
      limit ${limitParam}
    `, params);
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
    const invalidOnly = req.query.invalid === 'true';

    const result = await pool.query(`
      with latest_flags as (
        select distinct on (ix.instance_pk, ix.dbid, ix.index_relid)
          ix.instance_pk, ix.dbid, ix.index_relid,
          ix.is_valid, ix.is_ready, ix.is_primary, ix.is_unique
        from fact.pg_index_stat_delta ix
        where ix.instance_pk = $1
          and ix.dbid = $2
        order by ix.instance_pk, ix.dbid, ix.index_relid, ix.sample_ts desc
      )
      select
        ix.index_relid, ix.table_relid, ix.schemaname,
        ix.table_relname, ix.index_relname,
        sum(ix.idx_scan_delta) as total_idx_scan,
        sum(ix.idx_tup_read_delta) as total_idx_tup_read,
        sum(ix.idx_tup_fetch_delta) as total_idx_tup_fetch,
        sum(ix.idx_blks_read_delta) as total_idx_blks_read,
        sum(ix.idx_blks_hit_delta) as total_idx_blks_hit,
        coalesce(lf.is_valid, true) as is_valid,
        coalesce(lf.is_ready, true) as is_ready,
        coalesce(lf.is_primary, false) as is_primary,
        coalesce(lf.is_unique, false) as is_unique
      from fact.pg_index_stat_delta ix
      left join latest_flags lf on lf.instance_pk = ix.instance_pk and lf.dbid = ix.dbid and lf.index_relid = ix.index_relid
      where ix.instance_pk = $1
        and ix.dbid = $2
        and ix.sample_ts >= now() - make_interval(hours => $3)
      group by ix.index_relid, ix.table_relid, ix.schemaname,
               ix.table_relname, ix.index_relname, lf.is_valid, lf.is_ready, lf.is_primary, lf.is_unique
      ${invalidOnly ? "having coalesce(lf.is_valid, true) = false or coalesce(lf.is_ready, true) = false" : ''}
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
      unusedIndex, invalidIndex, settings, workloadProfile, settingsChanges
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
          greatest(
            (now() - make_interval(days => $2))::date,
            coalesce((select min(sample_ts)::date from fact.pg_database_delta where instance_pk = $1),
                     (now() - make_interval(days => $2))::date)
          ),
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
          greatest(
            (now() - make_interval(days => $2))::date,
            coalesce((select min(sample_ts)::date from fact.pg_database_delta where instance_pk = $1),
                     (now() - make_interval(days => $2))::date)
          ),
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
      // ÖNCE pg_wal_snapshot.period_wal_size_byte (LSN farkı — tüm PG sürümleri)
      // YOKSA pg_cluster_delta'dan metric_family='pg_stat_wal' (PG13+)
      // pg_wal_snapshot retention sadece saat bazlı (default 48h), bu yüzden
      // eski günler için cluster_delta yedek kaynağıdır.
      // SERİ BAŞLANGICI: instance için ilk gerçek veri tarihinden başla
      // (collector geç başladıysa eski günlerin 0 çizilmesini engeller)
      safeQuery(`with first_data as (
        select greatest(
          (now() - make_interval(days => $2))::date,
          coalesce(
            (select min(sample_ts)::date from fact.pg_wal_snapshot where instance_pk = $1),
            (select min(sample_ts)::date from fact.pg_cluster_delta where instance_pk = $1 and metric_family = 'pg_stat_wal'),
            (now() - make_interval(days => $2))::date
          )
        ) as start_day
      ),
      days_series as (
        select generate_series((select start_day from first_data), current_date, '1 day'::interval)::date as day
      ),
      snap_agg as (
        select date_trunc('day', sample_ts)::date as day,
          sum(period_wal_size_byte) as wal_bytes
        from fact.pg_wal_snapshot where instance_pk = $1
        and sample_ts > now() - make_interval(days => $2)
        group by 1
      ),
      hourly_agg as (
        select date_trunc('day', hour_ts)::date as day,
          sum(wal_bytes_total) as wal_bytes
        from agg.pg_wal_hourly where instance_pk = $1
        and hour_ts > now() - make_interval(days => $2)
        group by 1
      ),
      cluster_agg as (
        select date_trunc('day', sample_ts)::date as day,
          sum(metric_value_num) as wal_bytes
        from fact.pg_cluster_delta where instance_pk = $1
        and metric_family = 'pg_stat_wal' and metric_name = 'wal_bytes'
        and sample_ts > now() - make_interval(days => $2)
        group by 1
      )
      select d.day,
        coalesce(
          round(s.wal_bytes::numeric / 1048576, 1),
          round(h.wal_bytes::numeric / 1048576, 1),
          round(c.wal_bytes::numeric / 1048576, 1),
          0
        ) as wal_mb
      from days_series d
      left join snap_agg s on s.day = d.day
      left join hourly_agg h on h.day = d.day
      left join cluster_agg c on c.day = d.day
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
      pool.query(`with bounds as (
        select now() - interval '30 days' as window_start, now() as window_end, interval '6 hours' as tolerance
      )
      select count(*) as cnt from (
        select 1 from fact.pg_index_stat_delta i
        cross join bounds b
        where i.instance_pk = $1 and i.sample_ts >= b.window_start
        group by i.schemaname, i.index_relname, b.window_start, b.window_end, b.tolerance
        having coalesce(sum(idx_scan_delta), 0) = 0
        and min(i.sample_ts) <= b.window_start + b.tolerance
        and max(i.sample_ts) >= b.window_end - b.tolerance
      ) sub`, [id]),

      pool.query(`select count(*) as cnt from (
        select distinct on (i.dbid, i.index_relid)
          i.is_valid, i.is_ready
        from fact.pg_index_stat_delta i
        where i.instance_pk = $1
        order by i.dbid, i.index_relid, i.sample_ts desc
      ) latest
      where coalesce(latest.is_valid, true) = false
         or coalesce(latest.is_ready, true) = false`, [id]),

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

      // Workload profili — instance'in tum DB'leri icin 24h ve 90g sınıflandırması
      // (V047/V049 ile WorkloadClassifier tarafından doldurulur)
      safeQuery(`select dbid, datname,
                        workload_label, workload_label_auto, workload_scores,
                        workload_classified_at,
                        workload_label_long, workload_scores_long,
                        workload_classified_long_at
                 from dim.database_ref
                 where instance_pk = $1
                 order by datname`, [id]),

      // Son N gun pg_settings degisiklik sayisi (ozet)
      safeQuery(`with snapshots as (
        select setting_name, setting_value,
          lag(setting_value) over (partition by setting_name order by snapshot_ts) as prev_value
        from fact.pg_settings_snapshot
        where instance_pk = $1
          and snapshot_ts > now() - make_interval(days => $2)
      )
      select count(*) as change_count
      from snapshots
      where prev_value is not null and prev_value <> setting_value`, [id, days]),
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
    const invalidIndexCount = parseInt(invalidIndex.rows[0]?.cnt || '0');

    // Alert sayıları
    const alertCounts: Record<string, number> = {};
    openAlerts.rows.forEach((r: any) => { alertCounts[r.severity] = parseInt(r.cnt); });
    const totalAlerts = Object.values(alertCounts).reduce((a, b) => a + b, 0);

    // Overall status
    let overallStatus = 'healthy';
    if (alertCounts.critical > 0 || connPct > 90) overallStatus = 'critical';
    else if (alertCounts.warning > 0 || invalidIndexCount > 0 || cacheHitPct < 95 || tempFilesCount > 100 || connPct > 80) overallStatus = 'warning';

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
      { section: 'Index Sağlığı', name: 'Invalid / Not-ready Index', status: invalidIndexCount === 0 ? 'ok' : 'warning', value: `${invalidIndexCount} index` },
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
      workload: workloadProfile.rows,
      settings_change_count: parseInt(settingsChanges.rows[0]?.change_count || '0'),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/settings/diff — pg_settings degisikliklerini listele
// Query: days (varsayilan 30), important_only (true/false)
//
// Mantik: her setting icin ardisik snapshot'lar arasinda LAG() ile degisim tespit
// Sadece setting_value degisen satirlari donder (degisim zamani = setting'in
// yeni degerle ilk gorundugu snapshot)
// GET /api/instances/:id/settings — Her parametrenin EN SON değeri
// Nightly (27 param, UTC 03:00) ve hot refresh (11 kritik, 3 saatte bir) farklı
// snapshot_ts'lerde olduğundan max(snapshot_ts) filtrelemek 16'yı kaybediyordu.
// distinct on ile her parametrenin son değeri döner.
router.get('/:id/settings', async (req, res, next) => {
    try {
        const { id } = req.params;
        const r = await pool.query(`
            select distinct on (setting_name)
                   setting_name, setting_value, unit, context, source, snapshot_ts
            from fact.pg_settings_snapshot
            where instance_pk = $1
            order by setting_name, snapshot_ts desc
        `, [id]);
        // En son snapshot_ts (göstermek için)
        const lastTs = r.rows.reduce((acc: string | null, row: any) =>
            !acc || row.snapshot_ts > acc ? row.snapshot_ts : acc, null);
        res.json({ settings: r.rows, last_snapshot_ts: lastTs });
    } catch (err) { next(err); }
});

router.get('/:id/settings/diff', async (req, res, next) => {
  try {
    const { id } = req.params;
    const days = parseInt(req.query.days as string) || 30;
    const importantOnly = req.query.important_only === 'true';

    // Onemli parametreler — tuning + restart-required olanlar
    const importantSettings = [
      'shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem',
      'max_connections', 'max_wal_size', 'min_wal_size', 'wal_buffers',
      'checkpoint_timeout', 'checkpoint_completion_target',
      'random_page_cost', 'seq_page_cost', 'effective_io_concurrency',
      'autovacuum_max_workers', 'autovacuum_vacuum_scale_factor',
      'autovacuum_analyze_scale_factor', 'autovacuum_naptime',
      'shared_preload_libraries', 'max_worker_processes', 'max_parallel_workers',
      'max_parallel_workers_per_gather', 'max_locks_per_transaction',
      'wal_level', 'archive_mode', 'archive_command',
      'log_min_duration_statement', 'track_io_timing', 'track_functions',
    ];

    const params: any[] = [id, days];
    let importantFilter = '';
    if (importantOnly) {
      params.push(importantSettings);
      importantFilter = `and setting_name = any($${params.length})`;
    }

    const result = await pool.query(`
      with snapshots as (
        select
          snapshot_ts, setting_name, setting_value, unit,
          lag(setting_value) over (partition by setting_name order by snapshot_ts) as prev_value,
          lag(snapshot_ts) over (partition by setting_name order by snapshot_ts) as prev_ts
        from fact.pg_settings_snapshot
        where instance_pk = $1
          and snapshot_ts > now() - make_interval(days => $2)
          ${importantFilter}
      ),
      changes as (
        select setting_name, prev_value, setting_value as new_value,
               prev_ts, snapshot_ts as changed_at, unit
        from snapshots
        where prev_value is not null and prev_value <> setting_value
      )
      select setting_name, prev_value, new_value, prev_ts, changed_at, unit,
             setting_name = any($${importantOnly ? params.length : params.length + 1}) as is_important
      from changes
      order by changed_at desc, setting_name
    `, importantOnly ? params : [...params, importantSettings]);

    res.json({
      instance_pk: parseInt(id as string),
      period_days: days,
      total_changes: result.rows.length,
      changes: result.rows,
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
      with deltas as (
        select
          f.dbid,
          dbr.datname,
          f.funcid,
          f.schemaname,
          f.funcname,
          greatest(f.calls - lag(f.calls) over w, 0) as calls_d,
          greatest(f.total_time - lag(f.total_time) over w, 0) as total_time_d,
          greatest(f.self_time - lag(f.self_time) over w, 0) as self_time_d
        from fact.pg_user_function_snapshot f
        left join dim.database_ref dbr
          on dbr.instance_pk = f.instance_pk
         and dbr.dbid = f.dbid
        where f.instance_pk = $1
          and f.sample_ts >= now() - make_interval(hours => $2)
        window w as (partition by f.dbid, f.funcid order by f.sample_ts)
      )
      select
        dbid, datname, funcid, schemaname, funcname,
        coalesce(sum(calls_d), 0)::bigint as total_calls,
        coalesce(sum(total_time_d), 0) as total_time_ms,
        coalesce(sum(self_time_d), 0) as self_time_ms,
        case when coalesce(sum(calls_d), 0) > 0
          then coalesce(sum(total_time_d), 0) / sum(calls_d)
          else 0 end as avg_time_ms
      from deltas
      group by dbid, datname, funcid, schemaname, funcname
      order by total_time_ms desc nulls last
      limit 100
    `, [id, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/sequences — Sequence I/O istatistikleri
// Snapshot'lar arasındaki delta'yı window function ile hesaplar
router.get('/:id/sequences', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const result = await pool.query(`
      with deltas as (
        select
          relid, schemaname, relname,
          greatest(blks_read - lag(blks_read) over w, 0) as read_d,
          greatest(blks_hit - lag(blks_hit) over w, 0) as hit_d
        from fact.pg_sequence_io_snapshot
        where instance_pk = $1
          and sample_ts >= now() - make_interval(hours => $2)
        window w as (partition by relid order by sample_ts)
      )
      select
        relid, schemaname, relname,
        coalesce(sum(read_d), 0)::bigint as total_blks_read,
        coalesce(sum(hit_d), 0)::bigint as total_blks_hit,
        case when sum(read_d) + sum(hit_d) > 0
          then round((100.0 * sum(hit_d) / (sum(read_d) + sum(hit_d)))::numeric, 1)
          else 100 end as hit_ratio
      from deltas
      group by relid, schemaname, relname
      order by total_blks_read desc nulls last
      limit 100
    `, [id, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/wal — WAL + Archiver istatistikleri
//
// pg_wal_snapshot tablosu (V023) sample_ts kullanir, kolonlar:
//   current_wal_lsn, current_wal_file, wal_directory_size_byte,
//   wal_file_count, period_wal_size_byte
// pg_stat_wal'dan gelen wal_records/wal_fpi/wal_bytes ise PG13+ icin
// fact.pg_cluster_delta'da metric_family='pg_stat_wal' olarak tutulur.
router.get('/:id/wal', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const [walResult, statWalResult, archiverResult] = await Promise.all([
      pool.query(`
        select sample_ts,
               current_wal_lsn,
               current_wal_file,
               wal_directory_size_byte,
               wal_file_count,
               period_wal_size_byte
        from fact.pg_wal_snapshot
        where instance_pk = $1
          and sample_ts >= now() - make_interval(hours => $2)
        order by sample_ts
      `, [id, hours]),
      pool.query(`
        select sample_ts,
               max(case when metric_name = 'wal_records' then metric_value_num end) as wal_records,
               max(case when metric_name = 'wal_fpi'     then metric_value_num end) as wal_fpi,
               max(case when metric_name = 'wal_bytes'   then metric_value_num end) as wal_bytes
        from fact.pg_cluster_delta
        where instance_pk = $1
          and metric_family = 'pg_stat_wal'
          and sample_ts >= now() - make_interval(hours => $2)
        group by sample_ts
        order by sample_ts
      `, [id, hours]),
      pool.query(`
        select sample_ts, archived_count, last_archived_wal, last_archived_time,
               failed_count, last_failed_wal, last_failed_time
        from fact.pg_archiver_snapshot
        where instance_pk = $1
          and sample_ts >= now() - make_interval(hours => $2)
        order by sample_ts
      `, [id, hours]),
    ]);
    res.json({
      wal: walResult.rows,
      stat_wal: statWalResult.rows,
      archiver: archiverResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/slru — SLRU cache istatistikleri
// Snapshot'lar arasındaki delta'yı window function ile hesaplar
router.get('/:id/slru', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 1);
    const result = await pool.query(`
      with deltas as (
        select
          name,
          greatest(blks_zeroed - lag(blks_zeroed) over w, 0) as zeroed_d,
          greatest(blks_hit - lag(blks_hit) over w, 0) as hit_d,
          greatest(blks_read - lag(blks_read) over w, 0) as read_d,
          greatest(blks_written - lag(blks_written) over w, 0) as written_d,
          greatest(blks_exists - lag(blks_exists) over w, 0) as exists_d,
          greatest(flushes - lag(flushes) over w, 0) as flushes_d,
          greatest(truncates - lag(truncates) over w, 0) as truncates_d
        from fact.pg_slru_snapshot
        where instance_pk = $1
          and sample_ts >= now() - make_interval(hours => $2)
        window w as (partition by name order by sample_ts)
      )
      select
        name,
        coalesce(sum(zeroed_d), 0)::bigint as total_blks_zeroed,
        coalesce(sum(hit_d), 0)::bigint as total_blks_hit,
        coalesce(sum(read_d), 0)::bigint as total_blks_read,
        coalesce(sum(written_d), 0)::bigint as total_blks_written,
        coalesce(sum(exists_d), 0)::bigint as total_blks_exists,
        coalesce(sum(flushes_d), 0)::bigint as total_flushes,
        coalesce(sum(truncates_d), 0)::bigint as total_truncates,
        case when sum(read_d) + sum(hit_d) > 0
          then round((100.0 * sum(hit_d) / (sum(read_d) + sum(hit_d)))::numeric, 1)
          else 100 end as hit_ratio
      from deltas
      group by name
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
