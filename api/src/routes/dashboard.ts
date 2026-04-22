import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

// GET /api/dashboard/summary — Dashboard özet verileri
router.get('/summary', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select
        (select count(*) from control.instance_inventory where is_active) as total_instances,
        (select count(*) from control.instance_inventory where is_active and bootstrap_state = 'ready') as ready_instances,
        (select count(*) from control.instance_inventory where is_active and bootstrap_state = 'degraded') as degraded_instances,
        (select count(*) from control.instance_inventory where is_active
           and bootstrap_state in ('pending','discovering','baselining','enriching')) as bootstrapping_instances,
        (select count(*) from ops.alert where status = 'open') as open_alerts,
        (select count(*) from ops.alert where status = 'open' and severity = 'critical') as critical_alerts,
        (select count(*) from ops.alert where status = 'open' and severity = 'warning') as warning_alerts
    `);
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/recent-jobs — Son job çalıştırmaları
router.get('/recent-jobs', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select job_run_id, job_type, started_at, finished_at, status,
             rows_written, instances_succeeded, instances_failed
      from ops.job_run
      order by started_at desc
      limit 20
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/instance-health — Instance sağlık durumu özeti
router.get('/instance-health', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select
        i.instance_pk, i.instance_id, i.display_name,
        i.environment, i.service_group,
        i.host, i.port,
        i.bootstrap_state, c.pg_major, c.is_primary,
        s.last_cluster_collect_at, s.last_statements_collect_at,
        s.consecutive_failures, s.last_success_at,
        (select count(*) from ops.alert a
           where a.instance_pk = i.instance_pk and a.status = 'open') as open_alerts,
        (select count(*) from ops.alert a
           where a.instance_pk = i.instance_pk and a.status = 'open' and a.severity = 'critical') as critical_alerts
      from control.instance_inventory i
      left join control.instance_capability c on c.instance_pk = i.instance_pk
      left join control.instance_state s on s.instance_pk = i.instance_pk
      where i.is_active
      order by s.consecutive_failures desc nulls last, i.display_name
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/instance-metrics — Instance başına QPS, bağlantı, replikasyon gecikmesi, dead tuple
router.get('/instance-metrics', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select
        i.instance_pk,
        round(coalesce((
          select sum(d.calls_delta)::numeric / 300
          from fact.pgss_delta d
          where d.instance_pk = i.instance_pk
            and d.sample_ts >= now() - interval '5 minutes'
        ), 0), 1) as qps,
        coalesce((
          select count(*)
          from fact.pg_activity_snapshot a
          where a.instance_pk = i.instance_pk
            and a.snapshot_ts = (
              select max(snapshot_ts) from fact.pg_activity_snapshot
              where instance_pk = i.instance_pk
            )
            and a.backend_type = 'client backend'
        ), 0) as client_connections,
        (
          select max(extract(epoch from r.replay_lag))
          from fact.pg_replication_snapshot r
          where r.instance_pk = i.instance_pk
            and r.snapshot_ts = (
              select max(snapshot_ts) from fact.pg_replication_snapshot
              where instance_pk = i.instance_pk
            )
        ) as max_replay_lag_sec,
        coalesce((
          select sum(t.n_dead_tup_estimate)
          from fact.pg_table_stat_delta t
          where t.instance_pk = i.instance_pk
            and t.sample_ts = (
              select max(sample_ts) from fact.pg_table_stat_delta
              where instance_pk = i.instance_pk
            )
        ), 0) as total_dead_tuples
      from control.instance_inventory i
      where i.is_active
      order by i.display_name
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/top-statements — En yoğun statement'lar (son 1 saat)
router.get('/top-statements', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const result = await pool.query(`
      select
        d.instance_pk, d.statement_series_id,
        sum(d.calls_delta) as total_calls,
        sum(d.total_exec_time_ms_delta) as total_exec_time_ms,
        sum(d.rows_delta) as total_rows,
        sum(d.shared_blks_read_delta) as total_shared_blks_read,
        qt.query_text
      from fact.pgss_delta d
      join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
      left join dim.query_text qt on qt.query_text_id = ss.query_text_id
      where d.sample_ts >= now() - interval '1 hour'
      group by d.instance_pk, d.statement_series_id, qt.query_text
      order by total_exec_time_ms desc nulls last
      limit $1
    `, [limit]);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

export default router;
