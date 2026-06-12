import { Router } from 'express';
import { pool } from '../config/database';
import { saveSecret, hasSecret } from '../config/secrets';
import { parseHours, parseLimit, parseOrderBy, parseTimeRange } from '../middleware/validation';
import { PGSS_COLUMNS, parseRequestedColumns, parseStatementsOrderBy } from './statements';
import { parseColumns, parseOrderBy as parseGenericOrderBy, columnsMetaResponse, rawSelectExpr, type ColumnRegistry } from './_columnsHelper';
import {
  generateInstanceInventoryPdf,
  generateInstanceInventoryXlsx,
  getInstanceInventoryReportRows,
  inventoryReportFilename,
} from '../services/reportGenerator';

const router = Router();

const RAW_PAGE_SIZE = 200;

function isRawMode(mode: unknown): boolean {
  return mode === 'raw';
}

function parseRawLimit(val: unknown): number {
  return Math.min(parseLimit(val, RAW_PAGE_SIZE), RAW_PAGE_SIZE);
}

function addRawCursorWhere(params: any[], cursor: unknown, columnRef: string): string {
  if (typeof cursor !== 'string' || cursor.trim() === '') return '';
  const d = new Date(cursor);
  if (Number.isNaN(d.getTime())) return '';
  params.push(d.toISOString());
  return ` and ${columnRef} < $${params.length}::timestamptz`;
}

function rawPage(rows: any[], limit: number) {
  return {
    rows,
    next_cursor: rows.length === limit ? rows[rows.length - 1]?.sample_ts ?? null : null,
  };
}

function clusterMetricRawExpr(registry: ColumnRegistry, key: string, metricFamily: string): string {
  const m = /metric_name='([a-z_0-9]+)'/i.exec(registry[key].sql);
  if (!m) return `${registry[key].sql} as ${key}`;
  const metricName = m[1].replace(/'/g, "''");
  const family = metricFamily.replace(/'/g, "''");
  return `(select x.metric_value_num
            from fact.pg_cluster_delta x
            where x.instance_pk = s.instance_pk
              and x.sample_ts = s.sample_ts
              and x.metric_family = '${family}'
              and x.metric_name = '${metricName}') as ${key}`;
}

const PGSS_RAW_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 'd.sample_ts', since: 11, label: 'Zaman' },
  ...PGSS_COLUMNS,
};
const PGSS_RAW_DEFAULTS = ['sample_ts', 'total_calls', 'total_exec_time_ms', 'mean_exec_time_ms', 'min_exec_time_ms', 'max_exec_time_ms', 'stddev_exec_time_ms', 'total_rows', 'total_shared_blks_hit', 'total_shared_blks_read', 'total_temp_blks_written', 'total_blk_read_time'];

function parseRawStatementColumns(raw: string | undefined): string[] {
  if (!raw) return PGSS_RAW_DEFAULTS;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  const safe = list.filter(c => Object.prototype.hasOwnProperty.call(PGSS_RAW_COLUMNS, c));
  return safe.length > 0 ? safe : PGSS_RAW_DEFAULTS;
}

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

// GET /api/instances/footprint-summary?hours=24
// FLEET GENELI yuk guvencesi: her instance'ta pgstat collector'un toplam sorgu
// yukundeki (exec time + buffer) payi. "pgstat DB'lerimi ne kadar yoruyor"
// sorusunun kanitli cevabi. Veri zaten fact.pgss_delta'da.
router.get('/footprint-summary', async (req, res, next) => {
  try {
    const hours = parseHours(req.query.hours, 24);
    const result = await pool.query(`
      with grouped as (
        select
          d.instance_pk,
          case when rr.rolname = ii.collector_username then 'pgstat' else 'diger' end as grup,
          sum(d.total_exec_time_ms_delta) as exec_ms,
          sum(d.calls_delta) as calls,
          sum(d.shared_blks_hit_delta + d.shared_blks_read_delta) as buffers
        from fact.pgss_delta d
        join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
        join control.instance_inventory ii on ii.instance_pk = d.instance_pk
        left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
        where d.sample_ts >= now() - make_interval(hours => $1)
        group by d.instance_pk, case when rr.rolname = ii.collector_username then 'pgstat' else 'diger' end
      ),
      pivot as (
        select
          instance_pk,
          coalesce(sum(exec_ms) filter (where grup = 'pgstat'), 0) as pg_exec,
          coalesce(sum(exec_ms) filter (where grup = 'diger'), 0) as ot_exec,
          coalesce(sum(buffers) filter (where grup = 'pgstat'), 0) as pg_buf,
          coalesce(sum(buffers) filter (where grup = 'diger'), 0) as ot_buf,
          coalesce(sum(calls) filter (where grup = 'pgstat'), 0) as pg_calls
        from grouped group by instance_pk
      )
      select
        p.instance_pk,
        ii.display_name as instance_name,
        round((p.pg_exec * 100.0 / nullif(p.pg_exec + p.ot_exec, 0))::numeric, 2) as exec_pct,
        round((p.pg_buf * 100.0 / nullif(p.pg_buf + p.ot_buf, 0))::numeric, 2) as buf_pct,
        p.pg_calls::bigint as pgstat_calls,
        round(p.pg_exec::numeric, 0) as pgstat_exec_ms
      from pivot p
      join control.instance_inventory ii on ii.instance_pk = p.instance_pk
      where ii.is_active
      order by exec_pct desc nulls last
    `, [hours]);

    // Fleet ozeti: ortalama + max pgstat exec payi
    const rows = result.rows;
    const execPcts = rows.map((r: any) => Number(r.exec_pct)).filter((v: number) => Number.isFinite(v));
    const bufPcts = rows.map((r: any) => Number(r.buf_pct)).filter((v: number) => Number.isFinite(v));
    const avg = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    const max = (a: number[]) => a.length ? Math.max(...a) : 0;

    res.json({
      hours,
      instance_count: rows.length,
      avg_exec_pct: Math.round(avg(execPcts) * 100) / 100,
      max_exec_pct: Math.round(max(execPcts) * 100) / 100,
      avg_buf_pct: Math.round(avg(bufPcts) * 100) / 100,
      max_buf_pct: Math.round(max(bufPcts) * 100) / 100,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/report — Aktif instance envanteri raporu
router.get('/report', async (req, res) => {
  try {
    const format = String(req.query.format || 'json').toLowerCase();
    if (!['json', 'pdf', 'xlsx'].includes(format)) {
      res.status(400).json({ error: 'Unsupported report format. Use json, pdf, or xlsx.' });
      return;
    }

    const rows = await getInstanceInventoryReportRows(pool);
    if (format === 'json') {
      res.json(rows);
      return;
    }

    if (format === 'pdf') {
      const buffer = await generateInstanceInventoryPdf(rows);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${inventoryReportFilename('pdf')}"`);
      res.send(buffer);
      return;
    }

    const buffer = await generateInstanceInventoryXlsx(rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${inventoryReportFilename('xlsx')}"`);
    res.send(buffer);
  } catch (err: any) {
    console.error('[instances-report] error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Instance report could not be generated.' });
  }
});

// GET /api/instances/:id/storage — latest pg_relation_size snapshot
const STORAGE_COLUMNS: ColumnRegistry = {
  dbid: { sql: 'rs.dbid', since: 10, label: 'DB OID' },
  datname: { sql: 'dbr.datname', since: 10, label: 'Database' },
  schemaname: { sql: 'rs.schemaname', since: 10, label: 'Schema' },
  relname: { sql: 'rs.relname', since: 10, label: 'Relation' },
  total_size_bytes: { sql: 'rs.total_size_bytes', since: 10, label: 'Total Size' },
  table_size_bytes: { sql: 'rs.table_size_bytes', since: 10, label: 'Table Size' },
  index_size_bytes: { sql: 'rs.index_size_bytes', since: 10, label: 'Index Size' },
  toast_size_bytes: { sql: 'rs.toast_size_bytes', since: 10, label: 'TOAST Size' },
};
const STORAGE_DEFAULTS = ['datname', 'schemaname', 'relname', 'total_size_bytes', 'table_size_bytes', 'index_size_bytes'];

router.get('/:id/storage/columns', (_req, res) => {
  res.json(columnsMetaResponse(STORAGE_COLUMNS, STORAGE_DEFAULTS));
});

router.get('/:id/storage', async (req, res, next) => {
  try {
    const { id } = req.params;
    const requestedCols = parseColumns(req.query.columns as string | undefined, STORAGE_COLUMNS, STORAGE_DEFAULTS);
    const selectParts = requestedCols.map(c => `${STORAGE_COLUMNS[c].sql} as ${c}`);
    const orderBy = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, requestedCols.includes('total_size_bytes') ? 'total_size_bytes' : requestedCols[0]);
    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_relation_size_snapshot rs
      left join dim.database_ref dbr on dbr.instance_pk = rs.instance_pk and dbr.dbid = rs.dbid
      where rs.instance_pk = $1
        and rs.snapshot_ts = (
          select max(snapshot_ts)
          from fact.pg_relation_size_snapshot
          where instance_pk = $1
        )
      order by ${orderBy}
    `, [id]);
    res.json(result.rows);
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

// GET /api/instances/:id/databases/stats — pg_database_delta istatistikleri
const DATABASE_STAT_COLUMNS: ColumnRegistry = {
  datname: { sql: 'coalesce(dbr.datname, d.datname)', since: 11, label: 'Database' },
  dbid: { sql: 'd.dbid', since: 11, label: 'DB OID' },
  numbackends: { sql: 'max(d.numbackends)', since: 11, label: 'Backends' },
  xact_commit_delta: { sql: 'sum(d.xact_commit_delta)', since: 11, label: 'Commits' },
  xact_rollback_delta: { sql: 'sum(d.xact_rollback_delta)', since: 11, label: 'Rollbacks' },
  blks_read_delta: { sql: 'sum(d.blks_read_delta)', since: 11, label: 'Blks Read' },
  blks_hit_delta: { sql: 'sum(d.blks_hit_delta)', since: 11, label: 'Blks Hit' },
  tup_returned_delta: { sql: 'sum(d.tup_returned_delta)', since: 11, label: 'Tup Returned' },
  tup_fetched_delta: { sql: 'sum(d.tup_fetched_delta)', since: 11, label: 'Tup Fetched' },
  tup_inserted_delta: { sql: 'sum(d.tup_inserted_delta)', since: 11, label: 'Tup Inserted' },
  tup_updated_delta: { sql: 'sum(d.tup_updated_delta)', since: 11, label: 'Tup Updated' },
  tup_deleted_delta: { sql: 'sum(d.tup_deleted_delta)', since: 11, label: 'Tup Deleted' },
  conflicts_delta: { sql: 'sum(d.conflicts_delta)', since: 11, label: 'Conflicts' },
  temp_files_delta: { sql: 'sum(d.temp_files_delta)', since: 11, label: 'Temp Files' },
  temp_bytes_delta: { sql: 'sum(d.temp_bytes_delta)', since: 11, label: 'Temp Bytes' },
  deadlocks_delta: { sql: 'sum(d.deadlocks_delta)', since: 11, label: 'Deadlocks' },
  blk_read_time_ms_delta: { sql: 'sum(d.blk_read_time_ms_delta)', since: 11, label: 'Read Time (ms)' },
  blk_write_time_ms_delta: { sql: 'sum(d.blk_write_time_ms_delta)', since: 11, label: 'Write Time (ms)' },
  checksum_failures_delta: { sql: 'sum(d.checksum_failures_delta)', since: 12, label: 'Checksum Failures' },
  checksum_last_failure: { sql: 'max(d.checksum_last_failure)', since: 12, label: 'Last Checksum Failure' },
  session_time_ms_delta: { sql: 'sum(d.session_time_ms_delta)', since: 14, label: 'Session Time (ms)' },
  active_time_ms_delta: { sql: 'sum(d.active_time_ms_delta)', since: 14, label: 'Active Time (ms)' },
  idle_in_transaction_time_ms_delta: { sql: 'sum(d.idle_in_transaction_time_ms_delta)', since: 14, label: 'Idle In Xact Time (ms)' },
  sessions_delta: { sql: 'sum(d.sessions_delta)', since: 14, label: 'Sessions' },
  sessions_abandoned_delta: { sql: 'sum(d.sessions_abandoned_delta)', since: 14, label: 'Sessions Abandoned' },
  sessions_fatal_delta: { sql: 'sum(d.sessions_fatal_delta)', since: 14, label: 'Sessions Fatal' },
  sessions_killed_delta: { sql: 'sum(d.sessions_killed_delta)', since: 14, label: 'Sessions Killed' },
  parallel_workers_to_launch_delta: { sql: 'sum(d.parallel_workers_to_launch_delta)', since: 18, label: 'Parallel To Launch' },
  parallel_workers_launched_delta: { sql: 'sum(d.parallel_workers_launched_delta)', since: 18, label: 'Parallel Launched' },
};
const DATABASE_STAT_DEFAULTS = ['datname', 'xact_commit_delta', 'xact_rollback_delta', 'blks_read_delta', 'blks_hit_delta', 'deadlocks_delta', 'temp_bytes_delta'];
const DATABASE_STAT_RAW_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 'd.sample_ts', since: 11, label: 'Zaman' },
  ...DATABASE_STAT_COLUMNS,
};
const DATABASE_STAT_RAW_DEFAULTS = ['sample_ts', ...DATABASE_STAT_DEFAULTS];

router.get('/:id/databases/stats/columns', (_req, res) => {
  res.json(columnsMetaResponse(DATABASE_STAT_COLUMNS, DATABASE_STAT_DEFAULTS));
});

router.get('/:id/databases/stats', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);

    if (isRawMode(req.query.mode)) {
      const limit = parseRawLimit(req.query.limit);
      const requestedCols = parseColumns(req.query.columns as string | undefined, DATABASE_STAT_RAW_COLUMNS, DATABASE_STAT_RAW_DEFAULTS);
      const rawCols = requestedCols.includes('sample_ts') ? requestedCols : ['sample_ts', ...requestedCols];
      const params: any[] = [id, fromIso, toIso];
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'd.sample_ts');
      params.push(limit);
      const selectCols = rawCols.map(c => rawSelectExpr(DATABASE_STAT_RAW_COLUMNS[c], c)).join(',\n        ');

      const result = await pool.query(`
        select ${selectCols}
        from fact.pg_database_delta d
        left join dim.database_ref dbr on dbr.instance_pk = d.instance_pk and dbr.dbid = d.dbid
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
          ${cursorWhere}
        order by d.sample_ts desc
        limit $${params.length}
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }

    const requestedCols = parseColumns(req.query.columns as string | undefined, DATABASE_STAT_COLUMNS, DATABASE_STAT_DEFAULTS);
    const orderClause = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, 'xact_commit_delta');
    const selectCols = requestedCols.map(c => `${DATABASE_STAT_COLUMNS[c].sql} as ${c}`).join(',\n        ');

    const result = await pool.query(`
      select ${selectCols}
      from fact.pg_database_delta d
      left join dim.database_ref dbr on dbr.instance_pk = d.instance_pk and dbr.dbid = d.dbid
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
      group by d.dbid, coalesce(dbr.datname, d.datname)
      order by ${orderClause}
      limit 500
    `, [id, fromIso, toIso]);
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
router.get('/:id/statements/raw', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const limit = parseRawLimit(req.query.limit);
    const datname = (req.query.datname as string) || null;
    const rolname = (req.query.rolname as string) || null;
    const requestedCols = parseRawStatementColumns(req.query.columns as string | undefined);
    const rawCols = requestedCols.includes('sample_ts') ? requestedCols : ['sample_ts', ...requestedCols];
    const selectCols = rawCols.map(c => rawSelectExpr(PGSS_RAW_COLUMNS[c], c)).join(',\n        ');

    const params: any[] = [id, fromIso, toIso];
    let whereExtra = '';
    if (datname) {
      params.push(datname);
      whereExtra += ` and dbr.datname = $${params.length}`;
    }
    if (rolname) {
      params.push(rolname);
      whereExtra += ` and rr.rolname = $${params.length}`;
    }
    const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'd.sample_ts');
    params.push(limit);

    const result = await pool.query(`
      select
        ss.statement_series_id, ss.dbid, ss.userid, ss.queryid,
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
        ${cursorWhere}
      order by d.sample_ts desc
      limit $${params.length}
    `, params);
    res.json(rawPage(result.rows, limit));
  } catch (err) {
    next(err);
  }
});

router.get('/:id/statements', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const limit = parseLimit(req.query.limit, 100);
    const datname = (req.query.datname as string) || null;
    const rolname = (req.query.rolname as string) || null;

    // Dinamik kolon destegi — statements.ts ile ayni whitelist
    const requestedCols = parseRequestedColumns(req.query.columns as string | undefined);
    const orderClause = parseStatementsOrderBy(req.query.order_by as string | undefined, requestedCols);

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
      order by ${orderClause}
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
    const { fromIso, toIso } = parseTimeRange(req.query, 24);

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
        and h.bucket_start between $2::timestamptz and $3::timestamptz
      group by h.bucket_start
      order by h.bucket_start
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/cluster-metrics — Cluster metrikleri zaman serisi
router.get('/:id/cluster-metrics', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const family = req.query.family as string; // pg_stat_bgwriter, pg_stat_wal, vb.

    let query = `
      select sample_ts, metric_family, metric_name, metric_value_num
      from fact.pg_cluster_delta
      where instance_pk = $1
        and sample_ts between $2::timestamptz and $3::timestamptz
    `;
    const params: any[] = [id, fromIso, toIso];

    if (family) {
      query += ` and metric_family = $4`;
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
const ACTIVITY_COLUMNS: ColumnRegistry = {
  datid: { sql: 'dbr.dbid::bigint', since: 10, label: 'DB OID' },
  datname: { sql: 'a.datname', since: 10, label: 'Database' },
  pid: { sql: 'a.pid', since: 10, label: 'PID' },
  leader_pid: { sql: 'a.leader_pid', since: 13, label: 'Leader PID' },
  usesysid: { sql: 'a.usesysid', since: 10, label: 'User OID' },
  usename: { sql: 'a.usename', since: 10, label: 'User' },
  application_name: { sql: 'a.application_name', since: 10, label: 'Application' },
  client_addr: { sql: 'a.client_addr', since: 10, label: 'Client Addr' },
  client_hostname: { sql: 'a.client_hostname', since: 10, label: 'Client Hostname' },
  client_port: { sql: 'a.client_port', since: 10, label: 'Client Port' },
  backend_start: { sql: 'a.backend_start', since: 10, label: 'Backend Start' },
  xact_start: { sql: 'a.xact_start', since: 10, label: 'Xact Start' },
  query_start: { sql: 'a.query_start', since: 10, label: 'Query Start' },
  state_change: { sql: 'a.state_change', since: 10, label: 'State Change' },
  wait_event_type: { sql: 'a.wait_event_type', since: 10, label: 'Wait Type' },
  wait_event: { sql: 'a.wait_event', since: 10, label: 'Wait Event' },
  state: { sql: 'a.state', since: 10, label: 'State' },
  backend_xid: { sql: 'a.backend_xid', since: 10, label: 'Backend XID' },
  backend_xmin: { sql: 'a.backend_xmin', since: 10, label: 'Backend Xmin' },
  query_id: { sql: 'a.query_id', since: 14, label: 'Query ID' },
  query: { sql: 'a.query', since: 10, label: 'Query' },
  backend_type: { sql: 'a.backend_type', since: 10, label: 'Backend Type' },
};
const ACTIVITY_DEFAULTS = ['pid', 'usename', 'datname', 'state', 'query_start', 'wait_event', 'query'];

router.get('/:id/activity/columns', (_req, res) => {
  res.json(columnsMetaResponse(ACTIVITY_COLUMNS, ACTIVITY_DEFAULTS));
});

router.get('/:id/activity', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const requestedCols = parseColumns(req.query.columns as string | undefined, ACTIVITY_COLUMNS, ACTIVITY_DEFAULTS);
    const selectParts = requestedCols.map(c => `${ACTIVITY_COLUMNS[c].sql} as ${c}`);
    const orderBy = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, requestedCols.includes('state') ? 'state' : requestedCols[0]);
    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_activity_snapshot a
      left join lateral (
        select dbid
        from dim.database_ref d
        where d.instance_pk = a.instance_pk
          and d.datname = a.datname
        order by d.last_seen_at desc
        limit 1
      ) dbr on true
      where a.instance_pk = $1
        and a.snapshot_ts between $2::timestamptz and $3::timestamptz
        and a.snapshot_ts = (
          select max(snapshot_ts) from fact.pg_activity_snapshot
          where instance_pk = $1 and snapshot_ts between $2::timestamptz and $3::timestamptz
        )
      order by ${orderBy}
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/replication — Replication durumu
const REPLICATION_COLUMNS: ColumnRegistry = {
  pid: { sql: 'r.pid', since: 10, label: 'PID' },
  usesysid: { sql: 'r.usesysid', since: 10, label: 'User OID' },
  usename: { sql: 'r.usename', since: 10, label: 'User' },
  application_name: { sql: 'r.application_name', since: 10, label: 'Application' },
  client_addr: { sql: 'r.client_addr', since: 10, label: 'Client Addr' },
  client_hostname: { sql: 'r.client_hostname', since: 10, label: 'Client Hostname' },
  client_port: { sql: 'r.client_port', since: 10, label: 'Client Port' },
  backend_start: { sql: 'r.backend_start', since: 10, label: 'Backend Start' },
  backend_xmin: { sql: 'r.backend_xmin', since: 10, label: 'Backend Xmin' },
  state: { sql: 'r.state', since: 10, label: 'State' },
  sent_lsn: { sql: 'r.sent_lsn', since: 10, label: 'Sent LSN' },
  write_lsn: { sql: 'r.write_lsn', since: 10, label: 'Write LSN' },
  flush_lsn: { sql: 'r.flush_lsn', since: 10, label: 'Flush LSN' },
  replay_lsn: { sql: 'r.replay_lsn', since: 10, label: 'Replay LSN' },
  write_lag: { sql: 'r.write_lag', since: 10, label: 'Write Lag' },
  flush_lag: { sql: 'r.flush_lag', since: 10, label: 'Flush Lag' },
  replay_lag: { sql: 'r.replay_lag', since: 10, label: 'Replay Lag' },
  sync_priority: { sql: 'r.sync_priority', since: 10, label: 'Sync Priority' },
  sync_state: { sql: 'r.sync_state', since: 10, label: 'Sync State' },
  reply_time: { sql: 'r.reply_time', since: 12, label: 'Reply Time' },
  replay_lag_bytes: { sql: 'r.replay_lag_bytes', since: 10, label: 'Replay Lag Bytes' },
};
const REPLICATION_DEFAULTS = ['usename', 'application_name', 'state', 'sync_state', 'write_lag', 'flush_lag', 'replay_lag', 'replay_lag_bytes'];

router.get('/:id/replication/columns', (_req, res) => {
  res.json(columnsMetaResponse(REPLICATION_COLUMNS, REPLICATION_DEFAULTS));
});

router.get('/:id/replication', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const requestedCols = parseColumns(req.query.columns as string | undefined, REPLICATION_COLUMNS, REPLICATION_DEFAULTS);
    const selectParts = requestedCols.map(c => `${REPLICATION_COLUMNS[c].sql} as ${c}`);
    const orderBy = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, requestedCols.includes('application_name') ? 'application_name' : requestedCols[0]);
    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_replication_snapshot r
      where r.instance_pk = $1
        and r.snapshot_ts between $2::timestamptz and $3::timestamptz
        and r.snapshot_ts = (
          select max(snapshot_ts) from fact.pg_replication_snapshot
          where instance_pk = $1 and snapshot_ts between $2::timestamptz and $3::timestamptz
        )
      order by ${orderBy}
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/tables — Instance genelinde tablo istatistikleri
const TABLE_STAT_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 't.sample_ts', since: 11, label: 'Zaman' },
  dbid: { sql: 't.dbid', since: 11, label: 'DB OID' },
  datname: { sql: 'dbr.datname', since: 11, label: 'Database' },
  relid: { sql: 't.relid', since: 11, label: 'Rel OID' },
  schemaname: { sql: 't.schemaname', since: 11, label: 'Schema' },
  relname: { sql: 't.relname', since: 11, label: 'Table' },
  total_seq_scan: { sql: 'sum(t.seq_scan_delta)', since: 11, label: 'Seq Scan' },
  seq_tup_read_delta: { sql: 'sum(t.seq_tup_read_delta)', since: 11, label: 'Seq Tup Read' },
  total_idx_scan: { sql: 'sum(t.idx_scan_delta)', since: 11, label: 'Idx Scan' },
  idx_tup_fetch_delta: { sql: 'sum(t.idx_tup_fetch_delta)', since: 11, label: 'Idx Tup Fetch' },
  total_inserts: { sql: 'sum(t.n_tup_ins_delta)', since: 11, label: 'Inserts' },
  total_updates: { sql: 'sum(t.n_tup_upd_delta)', since: 11, label: 'Updates' },
  total_deletes: { sql: 'sum(t.n_tup_del_delta)', since: 11, label: 'Deletes' },
  n_tup_hot_upd_delta: { sql: 'sum(t.n_tup_hot_upd_delta)', since: 11, label: 'HOT Updates' },
  vacuum_count_delta: { sql: 'sum(t.vacuum_count_delta)', since: 11, label: 'Vacuum Count' },
  autovacuum_count_delta: { sql: 'sum(t.autovacuum_count_delta)', since: 11, label: 'Autovacuum Count' },
  analyze_count_delta: { sql: 'sum(t.analyze_count_delta)', since: 11, label: 'Analyze Count' },
  autoanalyze_count_delta: { sql: 'sum(t.autoanalyze_count_delta)', since: 11, label: 'Autoanalyze Count' },
  total_heap_blks_read: { sql: 'sum(t.heap_blks_read_delta)', since: 11, label: 'Heap Read' },
  total_heap_blks_hit: { sql: 'sum(t.heap_blks_hit_delta)', since: 11, label: 'Heap Hit' },
  idx_blks_read_delta: { sql: 'sum(t.idx_blks_read_delta)', since: 11, label: 'Idx Blks Read' },
  idx_blks_hit_delta: { sql: 'sum(t.idx_blks_hit_delta)', since: 11, label: 'Idx Blks Hit' },
  toast_blks_read_delta: { sql: 'sum(t.toast_blks_read_delta)', since: 11, label: 'TOAST Blks Read' },
  toast_blks_hit_delta: { sql: 'sum(t.toast_blks_hit_delta)', since: 11, label: 'TOAST Blks Hit' },
  tidx_blks_read_delta: { sql: 'sum(t.tidx_blks_read_delta)', since: 11, label: 'TOAST Idx Blks Read' },
  tidx_blks_hit_delta: { sql: 'sum(t.tidx_blks_hit_delta)', since: 11, label: 'TOAST Idx Blks Hit' },
  n_live_tup: { sql: 'max(t.n_live_tup_estimate)', since: 11, label: 'Live Tuples' },
  n_dead_tup: { sql: 'max(t.n_dead_tup_estimate)', since: 11, label: 'Dead Tuples' },
  n_mod_since_analyze: { sql: 'max(t.n_mod_since_analyze)', since: 11, label: 'Mod Since Analyze' },
  last_vacuum: { sql: 'max(t.last_vacuum)', since: 11, label: 'Last Vacuum' },
  last_autovacuum: { sql: 'max(t.last_autovacuum)', since: 11, label: 'Last Autovacuum' },
  last_analyze: { sql: 'max(t.last_analyze)', since: 11, label: 'Last Analyze' },
  last_autoanalyze: { sql: 'max(t.last_autoanalyze)', since: 11, label: 'Last Autoanalyze' },
  n_ins_since_vacuum: { sql: 'max(t.n_ins_since_vacuum)', since: 13, label: 'Ins Since Vacuum' },
  last_seq_scan: { sql: 'max(t.last_seq_scan)', since: 16, label: 'Last Seq Scan' },
  last_idx_scan: { sql: 'max(t.last_idx_scan)', since: 16, label: 'Last Idx Scan' },
  total_n_tup_newpage_upd: { sql: 'sum(t.n_tup_newpage_upd)', since: 16, label: 'Newpage Updates' },
  total_vacuum_time_ms: { sql: 'sum(t.total_vacuum_time_ms_delta)', since: 18, label: 'Vacuum Time (ms)' },
  total_autovacuum_time_ms: { sql: 'sum(t.total_autovacuum_time_ms_delta)', since: 18, label: 'Autovacuum Time (ms)' },
  total_analyze_time_ms: { sql: 'sum(t.total_analyze_time_ms_delta)', since: 18, label: 'Analyze Time (ms)' },
  total_autoanalyze_time_ms: { sql: 'sum(t.total_autoanalyze_time_ms_delta)', since: 18, label: 'Autoanalyze Time (ms)' },
};
const TABLE_STAT_DEFAULTS = ['dbid', 'datname', 'schemaname', 'relname', 'total_seq_scan', 'total_idx_scan', 'total_inserts', 'total_updates', 'total_deletes', 'total_heap_blks_read', 'total_heap_blks_hit', 'n_live_tup', 'n_dead_tup'];
const TABLE_STAT_RAW_DEFAULTS = ['sample_ts', ...TABLE_STAT_DEFAULTS];

router.get('/:id/tables/columns', (_req, res) => {
  res.json(columnsMetaResponse(TABLE_STAT_COLUMNS, TABLE_STAT_DEFAULTS));
});

const INDEX_STAT_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 'ix.sample_ts', since: 11, label: 'Zaman' },
  dbid: { sql: 'ix.dbid', since: 11, label: 'DB OID' },
  datname: { sql: 'dbr.datname', since: 11, label: 'Database' },
  index_relid: { sql: 'ix.index_relid', since: 11, label: 'Index OID' },
  table_relid: { sql: 'ix.table_relid', since: 11, label: 'Table OID' },
  schemaname: { sql: 'ix.schemaname', since: 11, label: 'Schema' },
  table_relname: { sql: 'ix.table_relname', since: 11, label: 'Table' },
  index_relname: { sql: 'ix.index_relname', since: 11, label: 'Index' },
  total_idx_scan: { sql: 'sum(ix.idx_scan_delta)', since: 11, label: 'Idx Scan' },
  total_idx_tup_read: { sql: 'sum(ix.idx_tup_read_delta)', since: 11, label: 'Idx Tup Read' },
  total_idx_tup_fetch: { sql: 'sum(ix.idx_tup_fetch_delta)', since: 11, label: 'Idx Tup Fetch' },
  total_idx_blks_read: { sql: 'sum(ix.idx_blks_read_delta)', since: 11, label: 'Idx Blks Read' },
  total_idx_blks_hit: { sql: 'sum(ix.idx_blks_hit_delta)', since: 11, label: 'Idx Blks Hit' },
  is_valid: { sql: 'ix.is_valid', since: 11, label: 'Valid' },
  is_ready: { sql: 'ix.is_ready', since: 11, label: 'Ready' },
  is_primary: { sql: 'ix.is_primary', since: 11, label: 'Primary' },
  is_unique: { sql: 'ix.is_unique', since: 11, label: 'Unique' },
  last_idx_scan: { sql: 'max(ix.last_idx_scan)', since: 16, label: 'Last Idx Scan' },
};
const INDEX_STAT_DEFAULTS = ['dbid', 'datname', 'schemaname', 'table_relname', 'index_relname', 'total_idx_scan', 'total_idx_tup_read', 'total_idx_tup_fetch', 'total_idx_blks_read', 'total_idx_blks_hit', 'is_valid', 'is_ready', 'is_primary', 'is_unique'];
const INDEX_STAT_RAW_DEFAULTS = ['sample_ts', ...INDEX_STAT_DEFAULTS];

router.get('/:id/indexes/columns', (_req, res) => {
  res.json(columnsMetaResponse(INDEX_STAT_COLUMNS, INDEX_STAT_DEFAULTS));
});

router.get('/:id/tables', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);

    if (isRawMode(req.query.mode)) {
      const limit = parseRawLimit(req.query.limit);
      const requestedCols = parseColumns(req.query.columns as string | undefined, TABLE_STAT_COLUMNS, TABLE_STAT_RAW_DEFAULTS);
      const rawCols = requestedCols.includes('sample_ts') ? requestedCols : ['sample_ts', ...requestedCols];
      const params: any[] = [id, fromIso, toIso];
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 't.sample_ts');
      params.push(limit);
      const selectCols = rawCols.map(c => rawSelectExpr(TABLE_STAT_COLUMNS[c], c)).join(',\n        ');

      const result = await pool.query(`
        select ${selectCols}
        from fact.pg_table_stat_delta t
        left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid
        where t.instance_pk = $1
          and t.sample_ts between $2::timestamptz and $3::timestamptz
          ${cursorWhere}
        order by t.sample_ts desc
        limit $${params.length}
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }

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
        max(t.n_dead_tup_estimate) as n_dead_tup,
        max(t.last_vacuum) as last_vacuum,
        max(t.last_autovacuum) as last_autovacuum,
        max(t.last_analyze) as last_analyze,
        max(t.last_autoanalyze) as last_autoanalyze,
        max(t.n_ins_since_vacuum) as n_ins_since_vacuum,
        max(t.last_seq_scan) as last_seq_scan,
        max(t.last_idx_scan) as last_idx_scan,
        sum(t.n_tup_newpage_upd) as total_n_tup_newpage_upd,
        sum(t.total_vacuum_time_ms_delta) as total_vacuum_time_ms,
        sum(t.total_autovacuum_time_ms_delta) as total_autovacuum_time_ms,
        sum(t.total_analyze_time_ms_delta) as total_analyze_time_ms,
        sum(t.total_autoanalyze_time_ms_delta) as total_autoanalyze_time_ms
      from fact.pg_table_stat_delta t
      left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid
      where t.instance_pk = $1
        and t.sample_ts between $2::timestamptz and $3::timestamptz
      group by t.dbid, dbr.datname, t.relid, t.schemaname, t.relname
      order by total_seq_scan desc nulls last
      limit 500
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/indexes — Instance genelinde index istatistikleri
router.get('/:id/indexes', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const limit = parseLimit(req.query.limit, 500);
    const dbid = req.query.dbid ? Number(req.query.dbid) : null;
    const unusedOnly = req.query.unused === 'true';
    const invalidOnly = req.query.invalid === 'true';

    if (isRawMode(req.query.mode)) {
      const limit = parseRawLimit(req.query.limit);
      const requestedCols = parseColumns(req.query.columns as string | undefined, INDEX_STAT_COLUMNS, INDEX_STAT_RAW_DEFAULTS);
      const rawCols = requestedCols.includes('sample_ts') ? requestedCols : ['sample_ts', ...requestedCols];
      const params: any[] = [id, fromIso, toIso];
      const where = [
        'ix.instance_pk = $1',
        'ix.sample_ts between $2::timestamptz and $3::timestamptz'
      ];
      if (Number.isFinite(dbid) && dbid && dbid > 0) {
        params.push(dbid);
        where.push(`ix.dbid = $${params.length}`);
      }
      if (invalidOnly) {
        where.push('(coalesce(ix.is_valid, true) = false or coalesce(ix.is_ready, true) = false)');
      }
      if (unusedOnly) {
        where.push('coalesce(ix.idx_scan_delta, 0) = 0');
      }
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'ix.sample_ts');
      if (cursorWhere) where.push(cursorWhere.replace(/^\s*and\s+/, ''));
      params.push(limit);
      const selectCols = rawCols.map(c => rawSelectExpr(INDEX_STAT_COLUMNS[c], c)).join(',\n        ');

      const result = await pool.query(`
        select ${selectCols}
        from fact.pg_index_stat_delta ix
        left join dim.database_ref dbr on dbr.instance_pk = ix.instance_pk and dbr.dbid = ix.dbid
        where ${where.join('\n          and ')}
        order by ix.sample_ts desc
        limit $${params.length}
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }

    const params: Array<string | number> = [id, fromIso, toIso];
    const where = [
      'ix.instance_pk = $1',
      'ix.sample_ts between b.window_start and b.window_end'
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
          $2::timestamptz as window_start,
          $3::timestamptz as window_end,
          least(greatest(($3::timestamptz - $2::timestamptz) * 0.05, interval '10 minutes'), interval '6 hours') as tolerance
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
        max(ix.last_idx_scan) as last_idx_scan,
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
    const { fromIso, toIso } = parseTimeRange(req.query, 1);

    if (isRawMode(req.query.mode)) {
      const limit = parseRawLimit(req.query.limit);
      const requestedCols = parseColumns(req.query.columns as string | undefined, TABLE_STAT_COLUMNS, TABLE_STAT_RAW_DEFAULTS);
      const rawCols = requestedCols.includes('sample_ts') ? requestedCols : ['sample_ts', ...requestedCols];
      const params: any[] = [id, dbid, fromIso, toIso];
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 't.sample_ts');
      params.push(limit);
      const selectCols = rawCols.map(c => rawSelectExpr(TABLE_STAT_COLUMNS[c], c)).join(',\n        ');

      const result = await pool.query(`
        select ${selectCols}
        from fact.pg_table_stat_delta t
        left join dim.database_ref dbr on dbr.instance_pk = t.instance_pk and dbr.dbid = t.dbid
        where t.instance_pk = $1
          and t.dbid = $2
          and t.sample_ts between $3::timestamptz and $4::timestamptz
          ${cursorWhere}
        order by t.sample_ts desc
        limit $${params.length}
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }

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
        and t.sample_ts between $3::timestamptz and $4::timestamptz
      group by t.relid, t.schemaname, t.relname
      order by total_seq_scan desc nulls last
      limit 100
    `, [id, dbid, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/databases/:dbid/indexes — Database index istatistikleri
router.get('/:id/databases/:dbid/indexes', async (req, res, next) => {
  try {
    const { id, dbid } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const invalidOnly = req.query.invalid === 'true';

    if (isRawMode(req.query.mode)) {
      const limit = parseRawLimit(req.query.limit);
      const requestedCols = parseColumns(req.query.columns as string | undefined, INDEX_STAT_COLUMNS, INDEX_STAT_RAW_DEFAULTS);
      const rawCols = requestedCols.includes('sample_ts') ? requestedCols : ['sample_ts', ...requestedCols];
      const params: any[] = [id, dbid, fromIso, toIso];
      const where = [
        'ix.instance_pk = $1',
        'ix.dbid = $2',
        'ix.sample_ts between $3::timestamptz and $4::timestamptz'
      ];
      if (invalidOnly) {
        where.push('(coalesce(ix.is_valid, true) = false or coalesce(ix.is_ready, true) = false)');
      }
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'ix.sample_ts');
      if (cursorWhere) where.push(cursorWhere.replace(/^\s*and\s+/, ''));
      params.push(limit);
      const selectCols = rawCols.map(c => rawSelectExpr(INDEX_STAT_COLUMNS[c], c)).join(',\n        ');

      const result = await pool.query(`
        select ${selectCols}
        from fact.pg_index_stat_delta ix
        left join dim.database_ref dbr on dbr.instance_pk = ix.instance_pk and dbr.dbid = ix.dbid
        where ${where.join('\n          and ')}
        order by ix.sample_ts desc
        limit $${params.length}
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }

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
        and ix.sample_ts between $3::timestamptz and $4::timestamptz
      group by ix.index_relid, ix.table_relid, ix.schemaname,
               ix.table_relname, ix.index_relname, lf.is_valid, lf.is_ready, lf.is_primary, lf.is_unique
      ${invalidOnly ? "having coalesce(lf.is_valid, true) = false or coalesce(lf.is_ready, true) = false" : ''}
      order by total_idx_scan desc nulls last
      limit 100
    `, [id, dbid, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/databases/:dbid/stats — Database genel istatistikleri
router.get('/:id/databases/:dbid/stats', async (req, res, next) => {
  try {
    const { id, dbid } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 24);

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
        and sample_ts between $3::timestamptz and $4::timestamptz
      order by sample_ts
    `, [id, dbid, fromIso, toIso]);
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

// GET /api/instances/:id/tps — Günlük (toplam) ve saatlik TPS tablosu
// custom=1: kullanıcı tarih aralığı (tek satır toplam, saatlik aralık küçükse saat granülerliği)
// custom=0 (default): günlük=son 7 gün (gün bazında), saatlik=son 25 saat (saat bazında)
router.get('/:id/tps', async (req, res, next) => {
  try {
    const { id } = req.params;
    const custom = req.query.custom === '1';
    const { fromIso, toIso } = parseTimeRange(req.query, 24);

    if (custom) {
      // Aralığın saat farkı (saatlik mi yoksa tek satır mı karar için)
      const rangeMs = new Date(toIso).getTime() - new Date(fromIso).getTime();
      const rangeHours = rangeMs / 3600_000;
      const rangeSeconds = rangeMs / 1000;

      // Günlük tablo: TEK SATIR/DB — seçili pencerenin toplamı
      // avg_tps = toplam_xact / pencerenin gerçek saniyesi
      const dailyResult = await pool.query(`
        select
          $2::timestamptz as period_start,
          $3::timestamptz as period_end,
          dbr.datname,
          sum(d.xact_commit_delta) as commits,
          sum(d.xact_rollback_delta) as rollbacks,
          sum(d.xact_commit_delta + d.xact_rollback_delta) as total_xact,
          case when $4::numeric > 0
            then round(sum(d.xact_commit_delta + d.xact_rollback_delta)::numeric / $4::numeric)
            else 0 end as avg_tps
        from fact.pg_database_delta d
        left join dim.database_ref dbr on dbr.instance_pk = d.instance_pk and dbr.dbid = d.dbid
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
        group by dbr.datname
        order by total_xact desc nulls last
      `, [id, fromIso, toIso, rangeSeconds]);

      // Saatlik tablo:
      // - Aralık ≤ 24 saat ise saat granülerliği (eskisi gibi)
      // - Aralık > 24 saat ise TEK SATIR/DB toplam (gün/saat granülerliği yerine)
      let hourlyResult;
      if (rangeHours <= 24) {
        hourlyResult = await pool.query(`
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
            and d.sample_ts between $2::timestamptz and $3::timestamptz
          group by 1, dbr.datname
          order by 1 desc, dbr.datname
        `, [id, fromIso, toIso]);
      } else {
        // Tek satır toplam (Günlük ile aynı içerik, UI farklı başlık ile gösterir)
        hourlyResult = { rows: dailyResult.rows };
      }

      res.json({ daily: dailyResult.rows, hourly: hourlyResult.rows });
      return;
    }

    // Default mod (kullanıcı tarih aralığını değiştirmemiş): klasik davranış
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
          and d.sample_ts >= now() - interval '7 days'
        group by 1, dbr.datname
        order by 1 desc, dbr.datname
      `, [id]),
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
const FUNCTION_COLUMNS: ColumnRegistry = {
  dbid: { sql: 'dbid', since: 10, label: 'DB OID' },
  datname: { sql: 'datname', since: 10, label: 'Database' },
  funcid: { sql: 'funcid', since: 10, label: 'Func OID' },
  schemaname: { sql: 'schemaname', since: 10, label: 'Schema' },
  funcname: { sql: 'funcname', since: 10, label: 'Function' },
  total_calls: { sql: 'total_calls', since: 10, label: 'Calls' },
  total_time_ms: { sql: 'total_time_ms', since: 10, label: 'Total Time' },
  self_time_ms: { sql: 'self_time_ms', since: 10, label: 'Self Time' },
  avg_time_ms: { sql: 'avg_time_ms', since: 10, label: 'Avg Time' },
};
const FUNCTION_RAW_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 'sample_ts', since: 10, label: 'Zaman' },
  ...FUNCTION_COLUMNS,
};
const FUNCTION_DEFAULTS = ['datname', 'schemaname', 'funcname', 'total_calls', 'total_time_ms', 'avg_time_ms'];

router.get('/:id/functions/columns', (_req, res) => {
  res.json(columnsMetaResponse(FUNCTION_COLUMNS, FUNCTION_DEFAULTS));
});

router.get('/:id/functions', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const mode = String(req.query.mode || 'summary');
    const registry = isRawMode(mode) ? FUNCTION_RAW_COLUMNS : FUNCTION_COLUMNS;
    const defaults = isRawMode(mode) ? ['sample_ts', ...FUNCTION_DEFAULTS] : FUNCTION_DEFAULTS;
    const requestedCols = parseColumns(req.query.columns as string | undefined, registry, defaults);
    const selectParts = requestedCols.map(c => `${registry[c].sql} as ${c}`);
    const params: any[] = [id, fromIso, toIso];
    if (isRawMode(mode)) {
      const limit = parseRawLimit(req.query.limit);
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'sample_ts');
      params.push(limit);
      const result = await pool.query(`
        with deltas as (
          select
            f.sample_ts,
            f.dbid,
            dbr.datname,
            f.funcid,
            f.schemaname,
            f.funcname,
            greatest(f.calls - lag(f.calls) over w, 0) as total_calls,
            greatest(f.total_time - lag(f.total_time) over w, 0) as total_time_ms,
            greatest(f.self_time - lag(f.self_time) over w, 0) as self_time_ms
          from fact.pg_user_function_snapshot f
          left join dim.database_ref dbr on dbr.instance_pk = f.instance_pk and dbr.dbid = f.dbid
          where f.instance_pk = $1
            and f.sample_ts between $2::timestamptz and $3::timestamptz
          window w as (partition by f.dbid, f.funcid order by f.sample_ts)
        ),
        shaped as (
          select
            sample_ts, dbid, datname, funcid, schemaname, funcname,
            coalesce(total_calls, 0)::bigint as total_calls,
            coalesce(total_time_ms, 0) as total_time_ms,
            coalesce(self_time_ms, 0) as self_time_ms,
            case when coalesce(total_calls, 0) > 0 then coalesce(total_time_ms, 0) / total_calls else 0 end as avg_time_ms
          from deltas
        )
        select ${selectParts.join(', ')}
        from shaped
        where 1 = 1 ${cursorWhere}
        order by sample_ts desc
        limit $${params.length}
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }
    const orderBy = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, requestedCols.includes('total_time_ms') ? 'total_time_ms' : requestedCols[0]);
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
          and f.sample_ts between $2::timestamptz and $3::timestamptz
        window w as (partition by f.dbid, f.funcid order by f.sample_ts)
      )
      , shaped as (
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
      )
      select ${selectParts.join(', ')}
      from shaped
      order by ${orderBy}
      limit 100
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/sequences — Sequence I/O istatistikleri
// Snapshot'lar arasındaki delta'yı window function ile hesaplar
const SEQUENCE_COLUMNS: ColumnRegistry = {
  relid: { sql: 'relid', since: 10, label: 'Rel OID' },
  schemaname: { sql: 'schemaname', since: 10, label: 'Schema' },
  relname: { sql: 'relname', since: 10, label: 'Sequence' },
  total_blks_read: { sql: 'total_blks_read', since: 10, label: 'Blks Read' },
  total_blks_hit: { sql: 'total_blks_hit', since: 10, label: 'Blks Hit' },
  hit_ratio: { sql: 'hit_ratio', since: 10, label: 'Hit Ratio' },
};
const SEQUENCE_RAW_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 'sample_ts', since: 10, label: 'Zaman' },
  ...SEQUENCE_COLUMNS,
};
const SEQUENCE_DEFAULTS = ['schemaname', 'relname', 'total_blks_read', 'total_blks_hit', 'hit_ratio'];

router.get('/:id/sequences/columns', (_req, res) => {
  res.json(columnsMetaResponse(SEQUENCE_COLUMNS, SEQUENCE_DEFAULTS));
});

router.get('/:id/sequences', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const mode = String(req.query.mode || 'summary');
    const registry = isRawMode(mode) ? SEQUENCE_RAW_COLUMNS : SEQUENCE_COLUMNS;
    const defaults = isRawMode(mode) ? ['sample_ts', ...SEQUENCE_DEFAULTS] : SEQUENCE_DEFAULTS;
    const requestedCols = parseColumns(req.query.columns as string | undefined, registry, defaults);
    const selectParts = requestedCols.map(c => `${registry[c].sql} as ${c}`);
    const params: any[] = [id, fromIso, toIso];
    if (isRawMode(mode)) {
      const limit = parseRawLimit(req.query.limit);
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'sample_ts');
      params.push(limit);
      const result = await pool.query(`
        with deltas as (
          select
            sample_ts, relid, schemaname, relname,
            greatest(blks_read - lag(blks_read) over w, 0) as total_blks_read,
            greatest(blks_hit - lag(blks_hit) over w, 0) as total_blks_hit
          from fact.pg_sequence_io_snapshot
          where instance_pk = $1
            and sample_ts between $2::timestamptz and $3::timestamptz
          window w as (partition by relid order by sample_ts)
        ),
        shaped as (
          select
            sample_ts, relid, schemaname, relname,
            coalesce(total_blks_read, 0)::bigint as total_blks_read,
            coalesce(total_blks_hit, 0)::bigint as total_blks_hit,
            case when coalesce(total_blks_read, 0) + coalesce(total_blks_hit, 0) > 0
              then round((100.0 * coalesce(total_blks_hit, 0) / (coalesce(total_blks_read, 0) + coalesce(total_blks_hit, 0)))::numeric, 1)
              else 100 end as hit_ratio
          from deltas
        )
        select ${selectParts.join(', ')}
        from shaped
        where 1 = 1 ${cursorWhere}
        order by sample_ts desc
        limit $${params.length}
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }
    const orderBy = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, requestedCols.includes('total_blks_read') ? 'total_blks_read' : requestedCols[0]);
    const result = await pool.query(`
      with deltas as (
        select
          relid, schemaname, relname,
          greatest(blks_read - lag(blks_read) over w, 0) as read_d,
          greatest(blks_hit - lag(blks_hit) over w, 0) as hit_d
        from fact.pg_sequence_io_snapshot
        where instance_pk = $1
          and sample_ts between $2::timestamptz and $3::timestamptz
        window w as (partition by relid order by sample_ts)
      ),
      shaped as (
        select
          relid, schemaname, relname,
          coalesce(sum(read_d), 0)::bigint as total_blks_read,
          coalesce(sum(hit_d), 0)::bigint as total_blks_hit,
          case when sum(read_d) + sum(hit_d) > 0
            then round((100.0 * sum(hit_d) / (sum(read_d) + sum(hit_d)))::numeric, 1)
            else 100 end as hit_ratio
        from deltas
        group by relid, schemaname, relname
      )
      select ${selectParts.join(', ')}
      from shaped
      order by ${orderBy}
      limit 100
    `, [id, fromIso, toIso]);
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
// ============================================================================
// WAL Position — TAM PAKET (snapshot from pg_wal_snapshot)
// ============================================================================
const WAL_POSITION_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 'sample_ts', since: 10, label: 'Zaman' },
  current_wal_lsn: { sql: 'current_wal_lsn', since: 10, label: 'LSN' },
  current_wal_file: { sql: 'current_wal_file', since: 10, label: 'WAL Dosyası' },
  period_wal_size_byte: { sql: 'period_wal_size_byte', since: 10, label: 'Periyot WAL Üretimi' },
  wal_directory_size_byte: { sql: 'wal_directory_size_byte', since: 10, label: 'pg_wal/ Boyutu' },
  wal_file_count: { sql: 'wal_file_count', since: 10, label: 'Dosya Sayısı' },
};
const WAL_POSITION_DEFAULTS = ['sample_ts', 'current_wal_lsn', 'period_wal_size_byte', 'wal_directory_size_byte', 'wal_file_count'];

router.get('/:id/wal-position/columns', (_req, res) => {
  res.json(columnsMetaResponse(WAL_POSITION_COLUMNS, WAL_POSITION_DEFAULTS));
});

router.get('/:id/wal-position', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const requestedCols = parseColumns(req.query.columns as string | undefined, WAL_POSITION_COLUMNS, WAL_POSITION_DEFAULTS);
    const selectParts = requestedCols.map(c => `${WAL_POSITION_COLUMNS[c].sql} as ${c}`);
    const orderBy = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, requestedCols.includes('sample_ts') ? 'sample_ts' : requestedCols[0]);
    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_wal_snapshot
      where instance_pk = $1
        and sample_ts between $2::timestamptz and $3::timestamptz
      order by ${orderBy}
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// pg_stat_wal — TAM PAKET (pivot from cluster_delta)
// ============================================================================
const STAT_WAL_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 'max(sample_ts)', since: 13, label: 'Zaman' },
  wal_records: { sql: "sum(case when metric_name='wal_records' then metric_value_num end)", since: 13, label: 'WAL Records' },
  wal_fpi: { sql: "sum(case when metric_name='wal_fpi' then metric_value_num end)", since: 13, label: 'WAL FPI' },
  wal_bytes: { sql: "sum(case when metric_name='wal_bytes' then metric_value_num end)", since: 13, label: 'WAL Bytes' },
  wal_buffers_full: { sql: "sum(case when metric_name='wal_buffers_full' then metric_value_num end)", since: 13, label: 'WAL Buffers Full' },
  wal_write: { sql: "sum(case when metric_name='wal_write' then metric_value_num end)", since: 14, label: 'WAL Write' },
  wal_sync: { sql: "sum(case when metric_name='wal_sync' then metric_value_num end)", since: 14, label: 'WAL Sync' },
  wal_write_time: { sql: "sum(case when metric_name='wal_write_time' then metric_value_num end)", since: 14, label: 'WAL Write Time' },
  wal_sync_time: { sql: "sum(case when metric_name='wal_sync_time' then metric_value_num end)", since: 14, label: 'WAL Sync Time' },
  stats_reset: { sql: "max(case when metric_name='stats_reset' then metric_value_num end)", since: 14, label: 'Stats Reset' },
};
const STAT_WAL_DEFAULTS = ['wal_records', 'wal_bytes', 'wal_fpi', 'wal_buffers_full', 'wal_write_time'];
const STAT_WAL_RAW_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 's.sample_ts', since: 13, label: 'Zaman' },
  ...STAT_WAL_COLUMNS,
};
const STAT_WAL_RAW_DEFAULTS = ['sample_ts', ...STAT_WAL_DEFAULTS];

router.get('/:id/stat-wal/columns', (_req, res) => {
  res.json(columnsMetaResponse(STAT_WAL_COLUMNS, STAT_WAL_DEFAULTS));
});

router.get('/:id/stat-wal', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);

    if (isRawMode(req.query.mode)) {
      const limit = parseRawLimit(req.query.limit);
      const requestedCols = parseColumns(req.query.columns as string | undefined, STAT_WAL_RAW_COLUMNS, STAT_WAL_RAW_DEFAULTS);
      const rawCols = requestedCols.includes('sample_ts') ? requestedCols : ['sample_ts', ...requestedCols];
      const params: any[] = [id, fromIso, toIso];
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'sample_ts');
      params.push(limit);
      const selectCols = rawCols
        .map(c => c === 'sample_ts' ? 's.sample_ts' : clusterMetricRawExpr(STAT_WAL_RAW_COLUMNS, c, 'pg_stat_wal'))
        .join(',\n        ');

      const result = await pool.query(`
        with samples as (
          select distinct instance_pk, sample_ts
          from fact.pg_cluster_delta
          where instance_pk = $1
            and metric_family = 'pg_stat_wal'
            and sample_ts between $2::timestamptz and $3::timestamptz
            ${cursorWhere}
          order by sample_ts desc
          limit $${params.length}
        )
        select ${selectCols}
        from samples s
        order by s.sample_ts desc
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }

    const requestedCols = parseColumns(req.query.columns as string | undefined, STAT_WAL_COLUMNS, STAT_WAL_DEFAULTS);
    const selectParts = requestedCols.map(c => `${STAT_WAL_COLUMNS[c].sql} as ${c}`);
    const orderBy = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, requestedCols.includes('wal_bytes') ? 'wal_bytes' : requestedCols[0]);
    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_cluster_delta
      where instance_pk = $1
        and metric_family = 'pg_stat_wal'
        and sample_ts between $2::timestamptz and $3::timestamptz
      order by ${orderBy}
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/wal', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);

    if (isRawMode(req.query.mode)) {
      const limit = parseRawLimit(req.query.limit);
      const params: any[] = [id, fromIso, toIso];
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'sample_ts');
      params.push(limit);
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
            and sample_ts between $2::timestamptz and $3::timestamptz
            ${cursorWhere}
          order by sample_ts desc
          limit $${params.length}
        `, params),
        pool.query(`
          select sample_ts,
                 max(case when metric_name = 'wal_records' then metric_value_num end) as wal_records,
                 max(case when metric_name = 'wal_fpi'     then metric_value_num end) as wal_fpi,
                 max(case when metric_name = 'wal_bytes'   then metric_value_num end) as wal_bytes
          from fact.pg_cluster_delta
          where instance_pk = $1
            and metric_family = 'pg_stat_wal'
            and sample_ts between $2::timestamptz and $3::timestamptz
          group by sample_ts
          order by sample_ts
        `, [id, fromIso, toIso]),
        pool.query(`
          select sample_ts, archived_count, last_archived_wal, last_archived_time,
                 failed_count, last_failed_wal, last_failed_time
          from fact.pg_archiver_snapshot
          where instance_pk = $1
            and sample_ts between $2::timestamptz and $3::timestamptz
          order by sample_ts
        `, [id, fromIso, toIso]),
      ]);
      res.json({
        ...rawPage(walResult.rows, limit),
        stat_wal: statWalResult.rows,
        archiver: archiverResult.rows,
      });
      return;
    }

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
          and sample_ts between $2::timestamptz and $3::timestamptz
        order by sample_ts
      `, [id, fromIso, toIso]),
      pool.query(`
        select sample_ts,
               max(case when metric_name = 'wal_records' then metric_value_num end) as wal_records,
               max(case when metric_name = 'wal_fpi'     then metric_value_num end) as wal_fpi,
               max(case when metric_name = 'wal_bytes'   then metric_value_num end) as wal_bytes
        from fact.pg_cluster_delta
        where instance_pk = $1
          and metric_family = 'pg_stat_wal'
          and sample_ts between $2::timestamptz and $3::timestamptz
        group by sample_ts
        order by sample_ts
      `, [id, fromIso, toIso]),
      pool.query(`
        select sample_ts, archived_count, last_archived_wal, last_archived_time,
               failed_count, last_failed_wal, last_failed_time
        from fact.pg_archiver_snapshot
        where instance_pk = $1
          and sample_ts between $2::timestamptz and $3::timestamptz
        order by sample_ts
      `, [id, fromIso, toIso]),
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
const SLRU_COLUMNS: ColumnRegistry = {
  name: { sql: 'name', since: 13, label: 'SLRU' },
  total_blks_zeroed: { sql: 'total_blks_zeroed', since: 13, label: 'Blks Zeroed' },
  total_blks_hit: { sql: 'total_blks_hit', since: 13, label: 'Blks Hit' },
  total_blks_read: { sql: 'total_blks_read', since: 13, label: 'Blks Read' },
  total_blks_written: { sql: 'total_blks_written', since: 13, label: 'Blks Written' },
  total_blks_exists: { sql: 'total_blks_exists', since: 13, label: 'Blks Exists' },
  total_flushes: { sql: 'total_flushes', since: 13, label: 'Flushes' },
  total_truncates: { sql: 'total_truncates', since: 13, label: 'Truncates' },
  hit_ratio: { sql: 'hit_ratio', since: 13, label: 'Hit Ratio' },
};
const SLRU_RAW_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 'sample_ts', since: 13, label: 'Zaman' },
  ...SLRU_COLUMNS,
};
const SLRU_DEFAULTS = ['name', 'total_blks_hit', 'total_blks_read', 'total_blks_written', 'hit_ratio'];

router.get('/:id/slru/columns', (_req, res) => {
  res.json(columnsMetaResponse(SLRU_COLUMNS, SLRU_DEFAULTS));
});

router.get('/:id/slru', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const mode = String(req.query.mode || 'summary');
    const registry = isRawMode(mode) ? SLRU_RAW_COLUMNS : SLRU_COLUMNS;
    const defaults = isRawMode(mode) ? ['sample_ts', ...SLRU_DEFAULTS] : SLRU_DEFAULTS;
    const requestedCols = parseColumns(req.query.columns as string | undefined, registry, defaults);
    const selectParts = requestedCols.map(c => `${registry[c].sql} as ${c}`);
    const params: any[] = [id, fromIso, toIso];
    if (isRawMode(mode)) {
      const limit = parseRawLimit(req.query.limit);
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'sample_ts');
      params.push(limit);
      const result = await pool.query(`
        with deltas as (
          select
            sample_ts,
            name,
            greatest(blks_zeroed - lag(blks_zeroed) over w, 0) as total_blks_zeroed,
            greatest(blks_hit - lag(blks_hit) over w, 0) as total_blks_hit,
            greatest(blks_read - lag(blks_read) over w, 0) as total_blks_read,
            greatest(blks_written - lag(blks_written) over w, 0) as total_blks_written,
            greatest(blks_exists - lag(blks_exists) over w, 0) as total_blks_exists,
            greatest(flushes - lag(flushes) over w, 0) as total_flushes,
            greatest(truncates - lag(truncates) over w, 0) as total_truncates
          from fact.pg_slru_snapshot
          where instance_pk = $1
            and sample_ts between $2::timestamptz and $3::timestamptz
          window w as (partition by name order by sample_ts)
        ),
        shaped as (
          select
            sample_ts,
            name,
            coalesce(total_blks_zeroed, 0)::bigint as total_blks_zeroed,
            coalesce(total_blks_hit, 0)::bigint as total_blks_hit,
            coalesce(total_blks_read, 0)::bigint as total_blks_read,
            coalesce(total_blks_written, 0)::bigint as total_blks_written,
            coalesce(total_blks_exists, 0)::bigint as total_blks_exists,
            coalesce(total_flushes, 0)::bigint as total_flushes,
            coalesce(total_truncates, 0)::bigint as total_truncates,
            case when coalesce(total_blks_read, 0) + coalesce(total_blks_hit, 0) > 0
              then round((100.0 * coalesce(total_blks_hit, 0) / (coalesce(total_blks_read, 0) + coalesce(total_blks_hit, 0)))::numeric, 1)
              else 100 end as hit_ratio
          from deltas
        )
        select ${selectParts.join(', ')}
        from shaped
        where 1 = 1 ${cursorWhere}
        order by sample_ts desc
        limit $${params.length}
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }
    const orderBy = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, requestedCols.includes('total_blks_read') ? 'total_blks_read' : requestedCols[0]);
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
          and sample_ts between $2::timestamptz and $3::timestamptz
        window w as (partition by name order by sample_ts)
      ),
      shaped as (
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
      )
      select ${selectParts.join(', ')}
      from shaped
      order by ${orderBy}
    `, [id, fromIso, toIso]);
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

// ============================================================================
// I/O Stats (pg_stat_io, PG16+) — Madde 1 Tab
// ============================================================================
const IO_STAT_COLUMNS: ColumnRegistry = {
  backend_type: { sql: 'backend_type', since: 16, label: 'Backend Type' },
  object: { sql: 'object', since: 16, label: 'Object' },
  context: { sql: 'context', since: 16, label: 'Context' },
  reads_delta: { sql: 'sum(reads_delta)', since: 16, label: 'Reads' },
  read_time_ms_delta: { sql: 'sum(read_time_ms_delta)', since: 16, label: 'Read Time (ms)' },
  writes_delta: { sql: 'sum(writes_delta)', since: 16, label: 'Writes' },
  write_time_ms_delta: { sql: 'sum(write_time_ms_delta)', since: 16, label: 'Write Time (ms)' },
  extends_delta: { sql: 'sum(extends_delta)', since: 16, label: 'Extends' },
  extend_time_ms_delta: { sql: 'sum(extend_time_ms_delta)', since: 16, label: 'Extend Time (ms)' },
  hits_delta: { sql: 'sum(hits_delta)', since: 16, label: 'Hits' },
  evictions_delta: { sql: 'sum(evictions_delta)', since: 16, label: 'Evictions' },
  reuses_delta: { sql: 'sum(reuses_delta)', since: 16, label: 'Reuses' },
  fsyncs_delta: { sql: 'sum(fsyncs_delta)', since: 16, label: 'Fsyncs' },
  fsync_time_ms_delta: { sql: 'sum(fsync_time_ms_delta)', since: 16, label: 'Fsync Time (ms)' },
  writebacks_delta: { sql: 'sum(writebacks_delta)', since: 16, label: 'Writebacks' },
  writeback_time_ms_delta: { sql: 'sum(writeback_time_ms_delta)', since: 16, label: 'Writeback Time (ms)' },
  op_bytes: { sql: 'max(op_bytes)', since: 16, label: 'Op Bytes' },
  read_bytes_delta: { sql: 'sum(read_bytes_delta)', since: 18, label: 'Read Bytes' },
  write_bytes_delta: { sql: 'sum(write_bytes_delta)', since: 18, label: 'Write Bytes' },
  extend_bytes_delta: { sql: 'sum(extend_bytes_delta)', since: 18, label: 'Extend Bytes' },
};
const IO_STAT_DEFAULTS = ['backend_type', 'object', 'context', 'reads_delta', 'read_time_ms_delta', 'writes_delta', 'write_time_ms_delta', 'hits_delta', 'evictions_delta'];
const IO_STAT_RAW_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 'd.sample_ts', since: 16, label: 'Zaman' },
  ...IO_STAT_COLUMNS,
};
const IO_STAT_RAW_DEFAULTS = ['sample_ts', ...IO_STAT_DEFAULTS];

router.get('/:id/io-stats/columns', (_req, res) => {
  res.json(columnsMetaResponse(IO_STAT_COLUMNS, IO_STAT_DEFAULTS));
});

router.get('/:id/io-stats', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const limit = parseLimit(req.query.limit, 200);
    const requestedCols = parseColumns(req.query.columns as string | undefined, IO_STAT_COLUMNS, IO_STAT_DEFAULTS);

    if (isRawMode(req.query.mode)) {
      const rawLimit = parseRawLimit(req.query.limit);
      const rawRequestedCols = parseColumns(req.query.columns as string | undefined, IO_STAT_RAW_COLUMNS, IO_STAT_RAW_DEFAULTS);
      const rawCols = rawRequestedCols.includes('sample_ts') ? rawRequestedCols : ['sample_ts', ...rawRequestedCols];
      const params: any[] = [id, fromIso, toIso];
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'd.sample_ts');
      params.push(rawLimit);
      const selectCols = rawCols.map(c => rawSelectExpr(IO_STAT_RAW_COLUMNS[c], c)).join(',\n        ');

      const result = await pool.query(`
        select ${selectCols}
        from fact.pg_io_stat_delta d
        where d.instance_pk = $1
          and d.sample_ts between $2::timestamptz and $3::timestamptz
          ${cursorWhere}
        order by d.sample_ts desc
        limit $${params.length}
      `, params);
      res.json(rawPage(result.rows, rawLimit));
      return;
    }

    const orderClause = parseGenericOrderBy(req.query.order_by as string | undefined, requestedCols, 'reads_delta');

    const dims = ['backend_type', 'object', 'context'].filter(d => requestedCols.includes(d));
    const metrics = requestedCols.filter(c => !dims.includes(c));
    const selectParts = [
      ...dims.map(d => `d.${d}`),
      ...metrics.map(c => `${IO_STAT_COLUMNS[c].sql} as ${c}`),
    ];
    const groupBy = dims.length > 0 ? `group by ${dims.map(d => `d.${d}`).join(', ')}` : '';

    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_io_stat_delta d
      where d.instance_pk = $1
        and d.sample_ts between $2::timestamptz and $3::timestamptz
      ${groupBy}
      order by ${orderClause}
      limit $4
    `, [id, fromIso, toIso, limit]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================================
// Replication Slots — Madde 3 Tab
// ============================================================================
const SLOT_COLUMNS: ColumnRegistry = {
  slot_name: { sql: 'slot_name', since: 11, label: 'Slot Name' },
  plugin: { sql: 'plugin', since: 11, label: 'Plugin' },
  slot_type: { sql: 'slot_type', since: 11, label: 'Type' },
  database: { sql: 'database', since: 11, label: 'Database' },
  active: { sql: 'active', since: 11, label: 'Active' },
  active_pid: { sql: 'active_pid', since: 11, label: 'Active PID' },
  xmin_int: { sql: 'xmin_int', since: 11, label: 'Xmin' },
  catalog_xmin_int: { sql: 'catalog_xmin_int', since: 11, label: 'Catalog Xmin' },
  restart_lsn: { sql: 'restart_lsn', since: 11, label: 'Restart LSN' },
  confirmed_flush_lsn: { sql: 'confirmed_flush_lsn', since: 11, label: 'Confirmed Flush LSN' },
  wal_status: { sql: 'wal_status', since: 13, label: 'WAL Status' },
  safe_wal_size: { sql: 'safe_wal_size', since: 13, label: 'Safe WAL Size' },
  slot_lag_bytes: { sql: 'slot_lag_bytes', since: 11, label: 'Lag (bytes)' },
  spill_txns: { sql: 'spill_txns', since: 14, label: 'Spill Txns' },
  spill_count: { sql: 'spill_count', since: 14, label: 'Spill Count' },
  spill_bytes: { sql: 'spill_bytes', since: 14, label: 'Spill Bytes' },
  stream_txns: { sql: 'stream_txns', since: 14, label: 'Stream Txns' },
  stream_count: { sql: 'stream_count', since: 14, label: 'Stream Count' },
  stream_bytes: { sql: 'stream_bytes', since: 14, label: 'Stream Bytes' },
  total_txns: { sql: 'total_txns', since: 14, label: 'Total Txns' },
  total_bytes: { sql: 'total_bytes', since: 14, label: 'Total Bytes' },
  stats_reset: { sql: 'stats_reset', since: 14, label: 'Stats Reset' },
  temporary: { sql: 'temporary', since: 11, label: 'Temporary' },
  two_phase: { sql: 'two_phase', since: 15, label: 'Two Phase' },
  conflicting: { sql: 'conflicting', since: 17, label: 'Conflicting' },
  invalidation_reason: { sql: 'invalidation_reason', since: 17, label: 'Invalidation Reason' },
  failover: { sql: 'failover', since: 17, label: 'Failover' },
  synced: { sql: 'synced', since: 17, label: 'Synced' },
};
const SLOT_DEFAULTS = ['slot_name', 'slot_type', 'database', 'active', 'wal_status', 'slot_lag_bytes', 'conflicting', 'failover'];

router.get('/:id/replication-slots/columns', (_req, res) => {
  res.json(columnsMetaResponse(SLOT_COLUMNS, SLOT_DEFAULTS));
});

router.get('/:id/replication-slots', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const requestedCols = parseColumns(req.query.columns as string | undefined, SLOT_COLUMNS, SLOT_DEFAULTS);
    // Snapshot — verilen aralıktaki en son sample_ts'in durumunu getir
    const selectParts = requestedCols.map(c => SLOT_COLUMNS[c].sql);
    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_replication_slot_snapshot
      where instance_pk = $1
        and sample_ts between $2::timestamptz and $3::timestamptz
        and sample_ts = (
          select max(sample_ts) from fact.pg_replication_slot_snapshot
          where instance_pk = $1 and sample_ts between $2::timestamptz and $3::timestamptz
        )
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================================
// Checkpointer (PG17+) — TAM PAKET (pivot from cluster_delta)
// ============================================================================
const CHECKPOINTER_COLUMNS: ColumnRegistry = {
  checkpoints_timed: { sql: "sum(case when metric_name='checkpoints_timed' then metric_value_num end)", since: 17, label: 'Timed' },
  checkpoints_req: { sql: "sum(case when metric_name='checkpoints_req' then metric_value_num end)", since: 17, label: 'Requested' },
  checkpoint_write_time: { sql: "sum(case when metric_name='checkpoint_write_time' then metric_value_num end)", since: 17, label: 'Write Time (ms)' },
  checkpoint_sync_time: { sql: "sum(case when metric_name='checkpoint_sync_time' then metric_value_num end)", since: 17, label: 'Sync Time (ms)' },
  buffers_written: { sql: "sum(case when metric_name='buffers_checkpoint' then metric_value_num end)", since: 17, label: 'Buffers Written' },
  restartpoints_timed: { sql: "sum(case when metric_name='restartpoints_timed' then metric_value_num end)", since: 17, label: 'Restartpoints Timed' },
  restartpoints_req: { sql: "sum(case when metric_name='restartpoints_req' then metric_value_num end)", since: 17, label: 'Restartpoints Req' },
  restartpoints_done: { sql: "sum(case when metric_name='restartpoints_done' then metric_value_num end)", since: 17, label: 'Restartpoints Done' },
  num_done: { sql: "sum(case when metric_name='num_done' then metric_value_num end)", since: 18, label: 'Num Done' },
  slru_written: { sql: "sum(case when metric_name='slru_written' then metric_value_num end)", since: 18, label: 'SLRU Written' },
};
const CHECKPOINTER_DEFAULTS = ['checkpoints_timed', 'checkpoints_req', 'checkpoint_write_time', 'checkpoint_sync_time', 'buffers_written'];
const CHECKPOINTER_RAW_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 's.sample_ts', since: 17, label: 'Zaman' },
  ...CHECKPOINTER_COLUMNS,
};
const CHECKPOINTER_RAW_DEFAULTS = ['sample_ts', ...CHECKPOINTER_DEFAULTS];

router.get('/:id/checkpointer/columns', (_req, res) => { res.json(columnsMetaResponse(CHECKPOINTER_COLUMNS, CHECKPOINTER_DEFAULTS)); });

router.get('/:id/checkpointer', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);

    if (isRawMode(req.query.mode)) {
      const limit = parseRawLimit(req.query.limit);
      const requestedCols = parseColumns(req.query.columns as string | undefined, CHECKPOINTER_RAW_COLUMNS, CHECKPOINTER_RAW_DEFAULTS);
      const rawCols = requestedCols.includes('sample_ts') ? requestedCols : ['sample_ts', ...requestedCols];
      const params: any[] = [id, fromIso, toIso];
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'sample_ts');
      params.push(limit);
      const selectCols = rawCols
        .map(c => c === 'sample_ts' ? 's.sample_ts' : clusterMetricRawExpr(CHECKPOINTER_RAW_COLUMNS, c, 'pg_stat_checkpointer'))
        .join(',\n        ');

      const result = await pool.query(`
        with samples as (
          select distinct instance_pk, sample_ts
          from fact.pg_cluster_delta
          where instance_pk = $1
            and metric_family = 'pg_stat_checkpointer'
            and sample_ts between $2::timestamptz and $3::timestamptz
            ${cursorWhere}
          order by sample_ts desc
          limit $${params.length}
        )
        select ${selectCols}
        from samples s
        order by s.sample_ts desc
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }

    const requestedCols = parseColumns(req.query.columns as string | undefined, CHECKPOINTER_COLUMNS, CHECKPOINTER_DEFAULTS);
    const selectParts = requestedCols.map(c => `${CHECKPOINTER_COLUMNS[c].sql} as ${c}`);
    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_cluster_delta
      where instance_pk = $1 and metric_family = 'pg_stat_checkpointer'
        and sample_ts between $2::timestamptz and $3::timestamptz
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================================
// BgWriter — TAM PAKET (pivot from cluster_delta)
// ============================================================================
const BGWRITER_COLUMNS: ColumnRegistry = {
  buffers_clean: { sql: "sum(case when metric_name='buffers_clean' then metric_value_num end)", since: 11, label: 'Buffers Clean' },
  maxwritten_clean: { sql: "sum(case when metric_name='maxwritten_clean' then metric_value_num end)", since: 11, label: 'Max Written Clean' },
  buffers_alloc: { sql: "sum(case when metric_name='buffers_alloc' then metric_value_num end)", since: 11, label: 'Buffers Alloc' },
  checkpoints_timed: { sql: "sum(case when metric_name='checkpoints_timed' then metric_value_num end)", since: 11, label: 'Checkpoints Timed' },
  checkpoints_req: { sql: "sum(case when metric_name='checkpoints_req' then metric_value_num end)", since: 11, label: 'Checkpoints Req' },
  checkpoint_write_time: { sql: "sum(case when metric_name='checkpoint_write_time' then metric_value_num end)", since: 11, label: 'Checkpoint Write (ms)' },
  checkpoint_sync_time: { sql: "sum(case when metric_name='checkpoint_sync_time' then metric_value_num end)", since: 11, label: 'Checkpoint Sync (ms)' },
  buffers_checkpoint: { sql: "sum(case when metric_name='buffers_checkpoint' then metric_value_num end)", since: 11, label: 'Buffers Checkpoint' },
  buffers_backend: { sql: "sum(case when metric_name='buffers_backend' then metric_value_num end)", since: 11, label: 'Buffers Backend' },
  buffers_backend_fsync: { sql: "sum(case when metric_name='buffers_backend_fsync' then metric_value_num end)", since: 11, label: 'Backend Fsync' },
};
const BGWRITER_DEFAULTS = ['buffers_clean', 'maxwritten_clean', 'buffers_alloc'];
const BGWRITER_RAW_COLUMNS: ColumnRegistry = {
  sample_ts: { sql: 's.sample_ts', since: 11, label: 'Zaman' },
  ...BGWRITER_COLUMNS,
};
const BGWRITER_RAW_DEFAULTS = ['sample_ts', ...BGWRITER_DEFAULTS];

router.get('/:id/bgwriter/columns', (_req, res) => { res.json(columnsMetaResponse(BGWRITER_COLUMNS, BGWRITER_DEFAULTS)); });

router.get('/:id/bgwriter', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);

    if (isRawMode(req.query.mode)) {
      const limit = parseRawLimit(req.query.limit);
      const requestedCols = parseColumns(req.query.columns as string | undefined, BGWRITER_RAW_COLUMNS, BGWRITER_RAW_DEFAULTS);
      const rawCols = requestedCols.includes('sample_ts') ? requestedCols : ['sample_ts', ...requestedCols];
      const params: any[] = [id, fromIso, toIso];
      const cursorWhere = addRawCursorWhere(params, req.query.cursor, 'sample_ts');
      params.push(limit);
      const selectCols = rawCols
        .map(c => c === 'sample_ts' ? 's.sample_ts' : clusterMetricRawExpr(BGWRITER_RAW_COLUMNS, c, 'pg_stat_bgwriter'))
        .join(',\n        ');

      const result = await pool.query(`
        with samples as (
          select distinct instance_pk, sample_ts
          from fact.pg_cluster_delta
          where instance_pk = $1
            and metric_family = 'pg_stat_bgwriter'
            and sample_ts between $2::timestamptz and $3::timestamptz
            ${cursorWhere}
          order by sample_ts desc
          limit $${params.length}
        )
        select ${selectCols}
        from samples s
        order by s.sample_ts desc
      `, params);
      res.json(rawPage(result.rows, limit));
      return;
    }

    const requestedCols = parseColumns(req.query.columns as string | undefined, BGWRITER_COLUMNS, BGWRITER_DEFAULTS);
    const selectParts = requestedCols.map(c => `${BGWRITER_COLUMNS[c].sql} as ${c}`);
    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_cluster_delta
      where instance_pk = $1 and metric_family = 'pg_stat_bgwriter'
        and sample_ts between $2::timestamptz and $3::timestamptz
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================================
// Archiver — TAM PAKET
// ============================================================================
const ARCHIVER_COLUMNS: ColumnRegistry = {
  archived_count: { sql: 'archived_count', since: 11, label: 'Archived Count' },
  last_archived_wal: { sql: 'last_archived_wal', since: 11, label: 'Last Archived WAL' },
  last_archived_time: { sql: 'last_archived_time', since: 11, label: 'Last Archived Time' },
  failed_count: { sql: 'failed_count', since: 11, label: 'Failed Count' },
  last_failed_wal: { sql: 'last_failed_wal', since: 11, label: 'Last Failed WAL' },
  last_failed_time: { sql: 'last_failed_time', since: 11, label: 'Last Failed Time' },
  stats_reset: { sql: 'stats_reset', since: 11, label: 'Stats Reset' },
};
const ARCHIVER_DEFAULTS = ['archived_count', 'last_archived_wal', 'last_archived_time', 'failed_count'];

router.get('/:id/archiver/columns', (_req, res) => { res.json(columnsMetaResponse(ARCHIVER_COLUMNS, ARCHIVER_DEFAULTS)); });

router.get('/:id/archiver', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const limit = parseLimit(req.query.limit, 100);
    const requestedCols = parseColumns(req.query.columns as string | undefined, ARCHIVER_COLUMNS, ARCHIVER_DEFAULTS);
    const selectParts = requestedCols.map(c => ARCHIVER_COLUMNS[c].sql);
    const result = await pool.query(`
      select ${selectParts.join(', ')} from fact.pg_archiver_snapshot
      where instance_pk = $1
        and sample_ts between $2::timestamptz and $3::timestamptz
      order by sample_ts desc limit $4
    `, [id, fromIso, toIso, limit]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================================
// Subscriptions — TAM PAKET
// ============================================================================
const SUBSCRIPTION_COLUMNS: ColumnRegistry = {
  subid: { sql: 'subid', since: 10, label: 'Subscription ID' },
  subname: { sql: 'subname', since: 11, label: 'Subscription' },
  pid: { sql: 'pid', since: 11, label: 'PID' },
  leader_pid: { sql: 'leader_pid', since: 17, label: 'Leader PID' },
  worker_type: { sql: 'worker_type', since: 18, label: 'Worker Type' },
  relid: { sql: 'relid', since: 11, label: 'Relid' },
  received_lsn: { sql: 'received_lsn', since: 11, label: 'Received LSN' },
  last_msg_send_time: { sql: 'last_msg_send_time', since: 10, label: 'Son Mesaj Gönderim' },
  last_msg_receipt_time: { sql: 'last_msg_receipt_time', since: 10, label: 'Son Mesaj Alım' },
  latest_end_lsn: { sql: 'latest_end_lsn', since: 10, label: 'Latest End LSN' },
  latest_end_time: { sql: 'latest_end_time', since: 10, label: 'Latest End Time' },
  lag_bytes: { sql: 'lag_bytes', since: 11, label: 'Lag (bytes)' },
  apply_error_count: { sql: 'apply_error_count', since: 15, label: 'Apply Errors' },
  sync_error_count: { sql: 'sync_error_count', since: 15, label: 'Sync Errors' },
  stats_reset: { sql: 'stats_reset', since: 15, label: 'Stats Reset' },
  confl_insert_exists_delta: { sql: 'confl_insert_exists_delta', since: 18, label: 'Confl Insert' },
  confl_update_origin_differs_delta: { sql: 'confl_update_origin_differs_delta', since: 18, label: 'Confl Upd Origin' },
  confl_update_exists_delta: { sql: 'confl_update_exists_delta', since: 18, label: 'Confl Upd Exists' },
  confl_update_missing_delta: { sql: 'confl_update_missing_delta', since: 18, label: 'Confl Upd Missing' },
  confl_delete_origin_differs_delta: { sql: 'confl_delete_origin_differs_delta', since: 18, label: 'Confl Del Origin' },
  confl_delete_missing_delta: { sql: 'confl_delete_missing_delta', since: 18, label: 'Confl Del Missing' },
  confl_multiple_unique_conflicts_delta: { sql: 'confl_multiple_unique_conflicts_delta', since: 18, label: 'Confl Multi Unique' },
};
const SUBSCRIPTION_DEFAULTS = ['subname', 'pid', 'worker_type', 'lag_bytes', 'apply_error_count', 'sync_error_count'];

router.get('/:id/subscriptions/columns', (_req, res) => { res.json(columnsMetaResponse(SUBSCRIPTION_COLUMNS, SUBSCRIPTION_DEFAULTS)); });

router.get('/:id/subscriptions', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const requestedCols = parseColumns(req.query.columns as string | undefined, SUBSCRIPTION_COLUMNS, SUBSCRIPTION_DEFAULTS);
    const selectParts = requestedCols.map(c => SUBSCRIPTION_COLUMNS[c].sql);
    const result = await pool.query(`
      select ${selectParts.join(', ')} from fact.pg_subscription_snapshot
      where instance_pk = $1
        and sample_ts between $2::timestamptz and $3::timestamptz
        and sample_ts = (
          select max(sample_ts) from fact.pg_subscription_snapshot
          where instance_pk = $1 and sample_ts between $2::timestamptz and $3::timestamptz
        )
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================================
// WAL Receiver — TAM PAKET
// ============================================================================
const WAL_RECEIVER_COLUMNS: ColumnRegistry = {
  pid: { sql: 'pid', since: 11, label: 'PID' },
  status: { sql: 'status', since: 11, label: 'Status' },
  receive_start_lsn: { sql: 'receive_start_lsn', since: 11, label: 'Start LSN' },
  receive_start_tli: { sql: 'receive_start_tli', since: 11, label: 'Start TLI' },
  written_lsn: { sql: 'written_lsn', since: 13, label: 'Written LSN' },
  flushed_lsn: { sql: 'flushed_lsn', since: 11, label: 'Flushed LSN' },
  received_tli: { sql: 'received_tli', since: 11, label: 'Received TLI' },
  last_msg_send_time: { sql: 'last_msg_send_time', since: 11, label: 'Last Msg Send' },
  last_msg_receipt_time: { sql: 'last_msg_receipt_time', since: 11, label: 'Last Msg Receipt' },
  latest_end_lsn: { sql: 'latest_end_lsn', since: 11, label: 'Latest End LSN' },
  latest_end_time: { sql: 'latest_end_time', since: 11, label: 'Latest End Time' },
  slot_name: { sql: 'slot_name', since: 11, label: 'Slot' },
  sender_host: { sql: 'sender_host', since: 12, label: 'Sender Host' },
  sender_port: { sql: 'sender_port', since: 12, label: 'Sender Port' },
  lag_bytes: { sql: 'lag_bytes', since: 11, label: 'Lag (bytes)' },
};
const WAL_RECEIVER_DEFAULTS = ['status', 'sender_host', 'flushed_lsn', 'lag_bytes', 'last_msg_receipt_time'];

router.get('/:id/wal-receiver/columns', (_req, res) => { res.json(columnsMetaResponse(WAL_RECEIVER_COLUMNS, WAL_RECEIVER_DEFAULTS)); });

router.get('/:id/wal-receiver', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const limit = parseLimit(req.query.limit, 100);
    const requestedCols = parseColumns(req.query.columns as string | undefined, WAL_RECEIVER_COLUMNS, WAL_RECEIVER_DEFAULTS);
    const selectParts = requestedCols.map(c => WAL_RECEIVER_COLUMNS[c].sql);
    const result = await pool.query(`
      select ${selectParts.join(', ')} from fact.pg_wal_receiver_snapshot
      where instance_pk = $1
        and sample_ts between $2::timestamptz and $3::timestamptz
      order by sample_ts desc limit $4
    `, [id, fromIso, toIso, limit]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================================
// Progress — /columns endpoints (6 sub-types)
// ============================================================================
const PROGRESS_VACUUM_COLS: ColumnRegistry = { pid: { sql: 'pid', since: 11, label: 'PID' }, datname: { sql: 'datname', since: 11, label: 'Database' }, relid: { sql: 'relid', since: 11, label: 'Relid' }, phase: { sql: 'phase', since: 11, label: 'Phase' }, heap_blks_total: { sql: 'heap_blks_total', since: 11, label: 'Heap Total' }, heap_blks_scanned: { sql: 'heap_blks_scanned', since: 11, label: 'Heap Scanned' }, heap_blks_vacuumed: { sql: 'heap_blks_vacuumed', since: 11, label: 'Heap Vacuumed' }, index_vacuum_count: { sql: 'index_vacuum_count', since: 11, label: 'Idx Vac Count' }, max_dead_item_ids: { sql: 'max_dead_item_ids', since: 14, label: 'Max Dead IDs' }, max_dead_tuple_bytes: { sql: 'max_dead_tuple_bytes', since: 17, label: 'Max Dead Bytes' }, num_dead_item_ids: { sql: 'num_dead_item_ids', since: 14, label: 'Dead IDs' }, dead_tuple_bytes: { sql: 'dead_tuple_bytes', since: 17, label: 'Dead Bytes' }, indexes_total: { sql: 'indexes_total', since: 17, label: 'Indexes Total' }, indexes_processed: { sql: 'indexes_processed', since: 17, label: 'Indexes Done' } };
const PROGRESS_ANALYZE_COLS: ColumnRegistry = { pid: { sql: 'pid', since: 13, label: 'PID' }, datname: { sql: 'datname', since: 13, label: 'Database' }, relid: { sql: 'relid', since: 13, label: 'Relid' }, phase: { sql: 'phase', since: 13, label: 'Phase' }, sample_blks_total: { sql: 'sample_blks_total', since: 13, label: 'Sample Total' }, sample_blks_scanned: { sql: 'sample_blks_scanned', since: 13, label: 'Sample Scanned' }, ext_stats_total: { sql: 'ext_stats_total', since: 13, label: 'Ext Stats Total' }, ext_stats_computed: { sql: 'ext_stats_computed', since: 13, label: 'Ext Stats Done' }, child_tables_total: { sql: 'child_tables_total', since: 13, label: 'Child Total' }, child_tables_done: { sql: 'child_tables_done', since: 13, label: 'Child Done' } };
const PROGRESS_CREATE_INDEX_COLS: ColumnRegistry = { pid: { sql: 'pid', since: 12, label: 'PID' }, datname: { sql: 'datname', since: 12, label: 'Database' }, relid: { sql: 'relid', since: 12, label: 'Relid' }, command: { sql: 'command', since: 12, label: 'Command' }, phase: { sql: 'phase', since: 12, label: 'Phase' }, blocks_total: { sql: 'blocks_total', since: 12, label: 'Blocks Total' }, blocks_done: { sql: 'blocks_done', since: 12, label: 'Blocks Done' }, tuples_total: { sql: 'tuples_total', since: 12, label: 'Tuples Total' }, tuples_done: { sql: 'tuples_done', since: 12, label: 'Tuples Done' }, partitions_total: { sql: 'partitions_total', since: 12, label: 'Parts Total' }, partitions_done: { sql: 'partitions_done', since: 12, label: 'Parts Done' } };
const PROGRESS_BASEBACKUP_COLS: ColumnRegistry = { pid: { sql: 'pid', since: 13, label: 'PID' }, phase: { sql: 'phase', since: 13, label: 'Phase' }, backup_total: { sql: 'backup_total', since: 13, label: 'Backup Total' }, backup_streamed: { sql: 'backup_streamed', since: 13, label: 'Streamed' }, tablespaces_total: { sql: 'tablespaces_total', since: 13, label: 'TBS Total' }, tablespaces_streamed: { sql: 'tablespaces_streamed', since: 13, label: 'TBS Streamed' } };
const PROGRESS_COPY_COLS: ColumnRegistry = { pid: { sql: 'pid', since: 14, label: 'PID' }, datname: { sql: 'datname', since: 14, label: 'Database' }, relid: { sql: 'relid', since: 14, label: 'Relid' }, command: { sql: 'command', since: 14, label: 'Command' }, copy_type: { sql: 'copy_type', since: 14, label: 'Type' }, bytes_processed: { sql: 'bytes_processed', since: 14, label: 'Bytes Done' }, bytes_total: { sql: 'bytes_total', since: 14, label: 'Bytes Total' }, tuples_processed: { sql: 'tuples_processed', since: 14, label: 'Tuples Done' }, tuples_excluded: { sql: 'tuples_excluded', since: 14, label: 'Excluded' } };
const PROGRESS_CLUSTER_COLS: ColumnRegistry = { pid: { sql: 'pid', since: 12, label: 'PID' }, datname: { sql: 'datname', since: 12, label: 'Database' }, relid: { sql: 'relid', since: 12, label: 'Relid' }, command: { sql: 'command', since: 12, label: 'Command' }, phase: { sql: 'phase', since: 12, label: 'Phase' }, heap_tuples_scanned: { sql: 'heap_tuples_scanned', since: 12, label: 'Tuples Scanned' }, heap_tuples_written: { sql: 'heap_tuples_written', since: 12, label: 'Tuples Written' }, heap_blks_total: { sql: 'heap_blks_total', since: 12, label: 'Blks Total' }, heap_blks_scanned: { sql: 'heap_blks_scanned', since: 12, label: 'Blks Scanned' }, index_rebuild_count: { sql: 'index_rebuild_count', since: 12, label: 'Idx Rebuild' } };

const PROGRESS_MAP: Record<string, { cols: ColumnRegistry; defaults: string[]; table: string }> = {
  vacuum: { cols: PROGRESS_VACUUM_COLS, defaults: ['pid', 'datname', 'phase', 'heap_blks_scanned', 'heap_blks_total'], table: 'fact.pg_progress_vacuum_snapshot' },
  analyze: { cols: PROGRESS_ANALYZE_COLS, defaults: ['pid', 'datname', 'phase', 'sample_blks_scanned', 'sample_blks_total'], table: 'fact.pg_progress_analyze_snapshot' },
  'create-index': { cols: PROGRESS_CREATE_INDEX_COLS, defaults: ['pid', 'datname', 'command', 'phase', 'blocks_done', 'blocks_total'], table: 'fact.pg_progress_create_index_snapshot' },
  basebackup: { cols: PROGRESS_BASEBACKUP_COLS, defaults: ['pid', 'phase', 'backup_streamed', 'backup_total'], table: 'fact.pg_progress_basebackup_snapshot' },
  copy: { cols: PROGRESS_COPY_COLS, defaults: ['pid', 'datname', 'command', 'copy_type', 'bytes_processed', 'tuples_processed'], table: 'fact.pg_progress_copy_snapshot' },
  cluster: { cols: PROGRESS_CLUSTER_COLS, defaults: ['pid', 'datname', 'command', 'phase', 'heap_tuples_scanned', 'heap_tuples_written'], table: 'fact.pg_progress_cluster_snapshot' },
};

for (const [sub, cfg] of Object.entries(PROGRESS_MAP)) {
  router.get(`/:id/progress-${sub}/columns`, (_req, res) => { res.json(columnsMetaResponse(cfg.cols, cfg.defaults)); });
  router.get(`/:id/progress-${sub}`, async (req, res, next) => {
    try {
      const { id } = req.params;
      const { fromIso, toIso } = parseTimeRange(req.query, 1);
      const limit = parseLimit(req.query.limit, 100);
      const requestedCols = parseColumns(req.query.columns as string | undefined, cfg.cols, cfg.defaults);
      const selectParts = requestedCols.map(c => cfg.cols[c].sql);
      const result = await pool.query(`select ${selectParts.join(', ')} from ${cfg.table} where instance_pk = $1 and sample_ts between $2::timestamptz and $3::timestamptz order by sample_ts desc limit $4`, [id, fromIso, toIso, limit]);
      res.json(result.rows);
    } catch (err) { next(err); }
  });
}

// ============================================================================
// Conflicts — TAM PAKET
// ============================================================================
const CONFLICTS_COLUMNS: ColumnRegistry = {
  datid: { sql: 'datid', since: 11, label: 'DB OID' },
  datname: { sql: 'datname', since: 11, label: 'Database' },
  confl_tablespace: { sql: 'confl_tablespace', since: 11, label: 'Tablespace' },
  confl_lock: { sql: 'confl_lock', since: 11, label: 'Lock' },
  confl_snapshot: { sql: 'confl_snapshot', since: 11, label: 'Snapshot' },
  confl_bufferpin: { sql: 'confl_bufferpin', since: 11, label: 'Bufferpin' },
  confl_deadlock: { sql: 'confl_deadlock', since: 11, label: 'Deadlock' },
  confl_active_logicalslot: { sql: 'confl_active_logicalslot', since: 16, label: 'Logical Slot' },
};
const CONFLICTS_DEFAULTS = ['datname', 'confl_lock', 'confl_snapshot', 'confl_bufferpin', 'confl_deadlock'];

router.get('/:id/conflicts/columns', (_req, res) => { res.json(columnsMetaResponse(CONFLICTS_COLUMNS, CONFLICTS_DEFAULTS)); });

router.get('/:id/conflicts', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const requestedCols = parseColumns(req.query.columns as string | undefined, CONFLICTS_COLUMNS, CONFLICTS_DEFAULTS);
    const selectParts = requestedCols.map(c => CONFLICTS_COLUMNS[c].sql);
    const result = await pool.query(`
      select ${selectParts.join(', ')} from fact.pg_database_conflict_snapshot
      where instance_pk = $1
        and sample_ts between $2::timestamptz and $3::timestamptz
        and sample_ts = (
          select max(sample_ts) from fact.pg_database_conflict_snapshot
          where instance_pk = $1 and sample_ts between $2::timestamptz and $3::timestamptz
        )
    `, [id, fromIso, toIso]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================================
// Recovery Prefetch (PG15+, standby) — TAM PAKET
// ============================================================================
const RECOVERY_PREFETCH_COLUMNS: ColumnRegistry = {
  prefetch: { sql: 'prefetch', since: 15, label: 'Prefetch' },
  hit: { sql: 'hit', since: 15, label: 'Hit' },
  skip_init: { sql: 'skip_init', since: 15, label: 'Skip Init' },
  skip_new: { sql: 'skip_new', since: 15, label: 'Skip New' },
  skip_fpw: { sql: 'skip_fpw', since: 15, label: 'Skip FPW' },
  skip_rep: { sql: 'skip_rep', since: 15, label: 'Skip Rep' },
  wal_distance: { sql: 'wal_distance', since: 15, label: 'WAL Distance' },
  block_distance: { sql: 'block_distance', since: 15, label: 'Block Distance' },
  io_depth: { sql: 'io_depth', since: 15, label: 'I/O Depth' },
  stats_reset: { sql: 'stats_reset', since: 15, label: 'Stats Reset' },
};
const RECOVERY_PREFETCH_DEFAULTS = ['prefetch', 'hit', 'skip_fpw', 'wal_distance', 'io_depth'];

router.get('/:id/recovery-prefetch/columns', (_req, res) => {
  res.json(columnsMetaResponse(RECOVERY_PREFETCH_COLUMNS, RECOVERY_PREFETCH_DEFAULTS));
});

router.get('/:id/recovery-prefetch', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromIso, toIso } = parseTimeRange(req.query, 1);
    const limit = parseLimit(req.query.limit, 100);
    const requestedCols = parseColumns(req.query.columns as string | undefined, RECOVERY_PREFETCH_COLUMNS, RECOVERY_PREFETCH_DEFAULTS);
    const selectParts = requestedCols.map(c => RECOVERY_PREFETCH_COLUMNS[c].sql);
    const result = await pool.query(`
      select ${selectParts.join(', ')}
      from fact.pg_recovery_prefetch_snapshot
      where instance_pk = $1
        and sample_ts between $2::timestamptz and $3::timestamptz
      order by sample_ts desc limit $4
    `, [id, fromIso, toIso, limit]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================================
// COLLECTOR AYAK IZI — pgstat collector'un bu instance'ta calistirdigi sorgular
// Veri zaten fact.pgss_delta'da (her sorgu userid ile toplaniyor). Collector'un
// kendi sorgulari rolname = collector_username ile filtrelenir. Ek toplama YOK.
// ============================================================================

// GET /api/instances/:id/collector-footprint?hours=24&limit=50
// Collector'un kendi sorgulari: sorgu bazli toplam sure/cagri (son N saat).
router.get('/:id/collector-footprint', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 24);
    const limit = parseLimit(req.query.limit, 50);

    // Bu instance'in collector kullanici adi
    const inst = await pool.query(
      'select collector_username from control.instance_inventory where instance_pk = $1',
      [id]
    );
    if (inst.rows.length === 0) {
      res.status(404).json({ error: 'instance bulunamadi' });
      return;
    }
    const collectorUser = inst.rows[0].collector_username || 'pgstats_collector';

    const result = await pool.query(`
      select
        ss.queryid,
        max(dbr.datname) as datname,
        left(max(qt.query_text), 200) as query_text,
        sum(d.calls_delta)::bigint as total_calls,
        round(sum(d.total_exec_time_ms_delta)::numeric, 1) as total_exec_ms,
        round((sum(d.total_exec_time_ms_delta) / nullif(sum(d.calls_delta), 0))::numeric, 2) as mean_exec_ms,
        round(max(d.max_exec_time_ms)::numeric, 1) as max_exec_ms,
        sum(d.rows_delta)::bigint as total_rows,
        sum(d.shared_blks_read_delta)::bigint as shared_blks_read
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
      where d.instance_pk = $1
        and d.sample_ts >= now() - make_interval(hours => $2)
        and rr.rolname = $3
      group by ss.queryid
      having sum(d.calls_delta) > 0
      order by total_exec_ms desc nulls last
      limit $4
    `, [id, hours, collectorUser, limit]);

    res.json({ collector_username: collectorUser, rows: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/collector-footprint/summary?hours=24
// DB'nin TOPLAM yukunun pgstat collector vs uygulama/diger dagilimi.
// "pgstat bu DB'yi ne kadar mesgul ediyor" — exec time + cagri bazli.
router.get('/:id/collector-footprint/summary', async (req, res, next) => {
  try {
    const { id } = req.params;
    const hours = parseHours(req.query.hours, 24);
    const inst = await pool.query(
      'select collector_username from control.instance_inventory where instance_pk = $1', [id]);
    if (inst.rows.length === 0) { res.status(404).json({ error: 'instance bulunamadi' }); return; }
    const collectorUser = inst.rows[0].collector_username || 'pgstats_collector';

    const result = await pool.query(`
      select
        case when rr.rolname = $3 then 'pgstat' else 'diger' end as grup,
        sum(d.calls_delta)::bigint as calls,
        round(sum(d.total_exec_time_ms_delta)::numeric, 1) as exec_ms,
        sum(d.shared_blks_hit_delta + d.shared_blks_read_delta)::bigint as buffers
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.role_ref rr on rr.instance_pk = ss.instance_pk and rr.userid = ss.userid
      where d.instance_pk = $1
        and d.sample_ts >= now() - make_interval(hours => $2)
      group by case when rr.rolname = $3 then 'pgstat' else 'diger' end
    `, [id, hours, collectorUser]);

    let pgstatExec = 0, pgstatCalls = 0, pgstatBuf = 0, digerExec = 0, digerCalls = 0, digerBuf = 0;
    for (const r of result.rows) {
      if (r.grup === 'pgstat') { pgstatExec = Number(r.exec_ms); pgstatCalls = Number(r.calls); pgstatBuf = Number(r.buffers); }
      else { digerExec = Number(r.exec_ms); digerCalls = Number(r.calls); digerBuf = Number(r.buffers); }
    }
    res.json({
      collector_username: collectorUser,
      pgstat: { exec_ms: pgstatExec, calls: pgstatCalls, buffers: pgstatBuf },
      diger: { exec_ms: digerExec, calls: digerCalls, buffers: digerBuf },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/instances/:id/collector-footprint/trend?queryid=N&hours=168
// Tek bir collector sorgusunun zaman icindeki sure/cagri trendi
// (sorgu yavasladi/degisti mi gormek icin).
router.get('/:id/collector-footprint/trend', async (req, res, next) => {
  try {
    const { id } = req.params;
    const queryid = (req.query.queryid as string) || null;
    const hours = parseHours(req.query.hours, 168);
    if (!queryid || !/^-?\d+$/.test(queryid)) {
      res.status(400).json({ error: 'queryid zorunlu (sayisal)' });
      return;
    }
    const result = await pool.query(`
      select
        date_trunc('hour', d.sample_ts) as bucket,
        sum(d.calls_delta)::bigint as calls,
        round(sum(d.total_exec_time_ms_delta)::numeric, 1) as total_exec_ms,
        round((sum(d.total_exec_time_ms_delta) / nullif(sum(d.calls_delta), 0))::numeric, 2) as mean_exec_ms
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      where d.instance_pk = $1
        and ss.queryid = $2::bigint
        and d.sample_ts >= now() - make_interval(hours => $3)
      group by date_trunc('hour', d.sample_ts)
      order by bucket
    `, [id, queryid, hours]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
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
