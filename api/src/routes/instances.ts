import { Router } from 'express';
import { pool } from '../config/database';
import { saveSecret, hasSecret } from '../config/secrets';

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
  } catch (err) {
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
    // bootstrap_state'i pending'e al, last_error'ı temizle
    await pool.query(`
      update control.instance_inventory
      set bootstrap_state = 'pending', updated_at = now()
      where instance_pk = $1
    `, [id]);
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
    const hours   = parseInt(req.query.hours as string) || 1;
    const limit   = parseInt(req.query.limit as string) || 100;
    const datname = (req.query.datname as string) || null;
    const rolname = (req.query.rolname as string) || null;

    const orderMap: Record<string, string> = {
      exec_time: 'total_exec_time_ms',
      avg_time:  'avg_exec_time_ms',
      calls:     'total_calls',
      rows:      'total_rows',
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
    const hours = parseInt(req.query.hours as string) || 24;

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
    const hours = parseInt(req.query.hours as string) || 1;
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
    const hours = parseInt(req.query.hours as string) || 1;

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
    const hours = parseInt(req.query.hours as string) || 1;

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
    const hours = parseInt(req.query.hours as string) || 24;

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

export default router;

/** secret_ref'i UI'da göstermek için maskeler */
function maskSecretRef(ref: string | null): string {
  if (!ref) return '';
  if (ref.startsWith('file:')) return 'file:●●●●●●';
  if (ref.startsWith('env:')) return 'env:' + ref.substring(4);
  if (ref.startsWith('vault:')) return 'vault:●●●●●●';
  return '●●●●●●';
}
