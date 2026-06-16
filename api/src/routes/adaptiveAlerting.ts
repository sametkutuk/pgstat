import { Router } from 'express';
import { pool } from '../config/database';
import { parseLimit } from '../middleware/validation';

const router = Router();

const SLOT_LIFECYCLE_ALERT_CODES = [
    'slot_lost',
    'slot_active_deleted',
    'slot_inactive_deleted',
    'slot_inactive_long',
    'slot_recreated',
];

const LONG_QUERY_ALERT_CODES = [
    'long_running_query',
    'idle_in_transaction_long',
    'idle_in_transaction_aborted',
];

const XID_FREEZE_ALERT_CODES = [
    'xid_freeze_warning',
    'xid_freeze_critical',
    'mxid_freeze_warning',
    'mxid_freeze_critical',
];

function parseInstancePk(value: string | undefined): number | null {
    if (!value) return null;
    if (!/^\d+$/.test(value)) return null;
    return Number(value);
}

function requireInstancePk(value: string | undefined): number | null {
    if (!value || !/^\d+$/.test(value)) return null;
    return Number(value);
}

function queryPreview(value: string | null | undefined): string {
    if (!value) return '';
    let preview = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    preview = preview.replace(/(postgres(?:ql)?:\/\/[^\s:]+:)[^@\s]+@/gi, '$1***@');
    preview = preview.replace(/(password|passwd|pass|token|secret)\s*=\s*'[^']*'/gi, "$1='***'");
    preview = preview.replace(/(password|passwd|pass|token|secret)\s*=\s*"[^"]*"/gi, '$1="***"');
    preview = preview.replace(/(password|passwd|pass|token|secret)\s*=\s*[^\s,;)]+/gi, '$1=***');
    return preview.length <= 200 ? preview : preview.slice(0, 200);
}

// ============================================================================
// SLOT LIFECYCLE
// ============================================================================

router.get('/slot-lifecycle/subscriptions', async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select
                s.subscription_id,
                s.instance_pk,
                i.display_name as instance_name,
                s.is_enabled,
                s.inactive_minutes,
                s.retrigger_minutes,
                s.notify_on_lost,
                s.notify_on_active_deleted,
                s.notify_on_inactive_deleted,
                s.notify_on_inactive,
                s.updated_at
            from control.slot_lifecycle_subscription s
            join control.instance_inventory i on i.instance_pk = s.instance_pk
            order by i.display_name, s.instance_pk
        `);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

router.put('/slot-lifecycle/subscriptions/:instancePk', async (req, res, next) => {
    try {
        const instancePk = requireInstancePk(req.params.instancePk);
        if (instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }

        const inactiveMinutes = Number(req.body?.inactive_minutes ?? 30);
        const retriggerMinutes = Number(req.body?.retrigger_minutes ?? 30);
        if (!Number.isFinite(inactiveMinutes) || inactiveMinutes < 5) {
            res.status(400).json({ error: 'inactive_minutes en az 5 olmali' });
            return;
        }
        if (!Number.isFinite(retriggerMinutes) || retriggerMinutes < 5) {
            res.status(400).json({ error: 'retrigger_minutes en az 5 olmali' });
            return;
        }

        const result = await pool.query(`
            insert into control.slot_lifecycle_subscription (
                instance_pk, is_enabled, inactive_minutes, retrigger_minutes,
                notify_on_lost, notify_on_active_deleted,
                notify_on_inactive_deleted, notify_on_inactive, updated_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, now())
            on conflict (instance_pk) do update
            set is_enabled = excluded.is_enabled,
                inactive_minutes = excluded.inactive_minutes,
                retrigger_minutes = excluded.retrigger_minutes,
                notify_on_lost = excluded.notify_on_lost,
                notify_on_active_deleted = excluded.notify_on_active_deleted,
                notify_on_inactive_deleted = excluded.notify_on_inactive_deleted,
                notify_on_inactive = excluded.notify_on_inactive,
                updated_at = now()
            returning
                subscription_id, instance_pk, is_enabled, inactive_minutes,
                retrigger_minutes, notify_on_lost, notify_on_active_deleted,
                notify_on_inactive_deleted, notify_on_inactive, updated_at
        `, [
            instancePk,
            Boolean(req.body?.is_enabled ?? true),
            Math.trunc(inactiveMinutes),
            Math.trunc(retriggerMinutes),
            Boolean(req.body?.notify_on_lost ?? true),
            Boolean(req.body?.notify_on_active_deleted ?? true),
            Boolean(req.body?.notify_on_inactive_deleted ?? true),
            Boolean(req.body?.notify_on_inactive ?? true),
        ]);
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

router.get('/slot-lifecycle/state', async (req, res, next) => {
    try {
        const instancePk = parseInstancePk(req.query.instancePk as string | undefined);
        if (req.query.instancePk && instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }
        const params: any[] = [];
        let whereSql = '';
        if (instancePk != null) {
            params.push(instancePk);
            whereSql = 'where st.instance_pk = $1';
        }
        const result = await pool.query(`
            select
                st.instance_pk,
                i.display_name as instance_name,
                st.slot_name,
                st.last_seen_at,
                st.last_restart_lsn::text as last_restart_lsn,
                st.last_stats_reset,
                st.last_active,
                st.last_wal_status,
                st.inactive_since,
                st.last_retrigger_at,
                st.tombstone_at
            from control.slot_observation_state st
            join control.instance_inventory i on i.instance_pk = st.instance_pk
            ${whereSql}
            order by i.display_name, st.slot_name
        `, params);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

router.delete('/slot-lifecycle/state/:instancePk/:slotName', async (req, res, next) => {
    try {
        const instancePk = requireInstancePk(req.params.instancePk);
        if (instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }
        const result = await pool.query(`
            delete from control.slot_observation_state
            where instance_pk = $1
              and slot_name = $2
              and tombstone_at is not null
            returning instance_pk, slot_name
        `, [instancePk, req.params.slotName]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Tombstone state bulunamadi' });
            return;
        }
        res.json({ message: 'Slot state silindi', slot_name: result.rows[0].slot_name });
    } catch (err) {
        next(err);
    }
});

router.get('/slot-lifecycle/events', async (req, res, next) => {
    try {
        const limit = parseLimit(req.query.limit, 100);
        const instancePk = parseInstancePk(req.query.instancePk as string | undefined);
        const severity = req.query.severity as string | undefined;
        if (req.query.instancePk && instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }

        const params: any[] = [SLOT_LIFECYCLE_ALERT_CODES];
        let paramIdx = 2;
        let whereSql = 'where a.alert_code = any($1)';
        if (instancePk != null) {
            whereSql += ` and a.instance_pk = $${paramIdx++}`;
            params.push(instancePk);
        }
        if (severity) {
            whereSql += ` and a.severity = $${paramIdx++}`;
            params.push(severity);
        }
        params.push(limit);

        const result = await pool.query(`
            select
                a.alert_id,
                a.alert_key,
                a.alert_code,
                a.severity,
                a.status,
                a.instance_pk,
                i.display_name as instance_name,
                a.first_seen_at,
                a.last_seen_at,
                a.occurrence_count,
                a.title,
                a.message,
                a.details_json
            from ops.alert a
            left join control.instance_inventory i on i.instance_pk = a.instance_pk
            ${whereSql}
            order by a.last_seen_at desc
            limit $${paramIdx}
        `, params);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// LONG QUERY
// ============================================================================

router.get('/long-query/subscriptions', async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select
                s.subscription_id,
                s.instance_pk,
                i.display_name as instance_name,
                s.is_enabled,
                s.long_query_minutes,
                s.idle_tx_minutes,
                s.notify_on_long_query,
                s.notify_on_idle_tx,
                s.notify_on_idle_tx_aborted,
                s.updated_at
            from control.long_query_subscription s
            join control.instance_inventory i on i.instance_pk = s.instance_pk
            order by i.display_name, s.instance_pk
        `);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

router.put('/long-query/subscriptions/:instancePk', async (req, res, next) => {
    try {
        const instancePk = requireInstancePk(req.params.instancePk);
        if (instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }

        const longQueryMinutes = Number(req.body?.long_query_minutes ?? 5);
        const idleTxMinutes = Number(req.body?.idle_tx_minutes ?? 30);
        if (!Number.isFinite(longQueryMinutes) || longQueryMinutes < 1) {
            res.status(400).json({ error: 'long_query_minutes en az 1 olmali' });
            return;
        }
        if (!Number.isFinite(idleTxMinutes) || idleTxMinutes < 1) {
            res.status(400).json({ error: 'idle_tx_minutes en az 1 olmali' });
            return;
        }

        const result = await pool.query(`
            insert into control.long_query_subscription (
                instance_pk, is_enabled, long_query_minutes, idle_tx_minutes,
                notify_on_long_query, notify_on_idle_tx, notify_on_idle_tx_aborted, updated_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, now())
            on conflict (instance_pk) do update
            set is_enabled = excluded.is_enabled,
                long_query_minutes = excluded.long_query_minutes,
                idle_tx_minutes = excluded.idle_tx_minutes,
                notify_on_long_query = excluded.notify_on_long_query,
                notify_on_idle_tx = excluded.notify_on_idle_tx,
                notify_on_idle_tx_aborted = excluded.notify_on_idle_tx_aborted,
                updated_at = now()
            returning
                subscription_id, instance_pk, is_enabled, long_query_minutes,
                idle_tx_minutes, notify_on_long_query, notify_on_idle_tx,
                notify_on_idle_tx_aborted, updated_at
        `, [
            instancePk,
            Boolean(req.body?.is_enabled ?? true),
            Math.trunc(longQueryMinutes),
            Math.trunc(idleTxMinutes),
            Boolean(req.body?.notify_on_long_query ?? true),
            Boolean(req.body?.notify_on_idle_tx ?? true),
            Boolean(req.body?.notify_on_idle_tx_aborted ?? true),
        ]);
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// DATABASE ACCESS (database_inaccessible alert) SUBSCRIPTIONS
// ============================================================================

// GET — tum aktif instance'lar + ayarlari (satir yoksa varsayilan gosterilir)
router.get('/database-access/subscriptions', async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select
                i.instance_pk,
                i.display_name as instance_name,
                coalesce(s.is_enabled, true) as is_enabled,
                coalesce(s.fail_threshold, 2) as fail_threshold,
                coalesce(s.severity, 'warning') as severity,
                coalesce(s.notify_on_inaccessible, true) as notify_on_inaccessible,
                s.updated_at
            from control.instance_inventory i
            left join control.database_access_subscription s on s.instance_pk = i.instance_pk
            where i.is_active = true
            order by i.display_name, i.instance_pk
        `);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// PUT — instance ayarini kaydet (upsert)
router.put('/database-access/subscriptions/:instancePk', async (req, res, next) => {
    try {
        const instancePk = requireInstancePk(req.params.instancePk);
        if (instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }

        const failThreshold = Number(req.body?.fail_threshold ?? 2);
        if (!Number.isFinite(failThreshold) || failThreshold < 1) {
            res.status(400).json({ error: 'fail_threshold en az 1 olmali' });
            return;
        }
        const severity = String(req.body?.severity ?? 'warning');
        if (severity !== 'warning' && severity !== 'critical') {
            res.status(400).json({ error: 'severity warning veya critical olmali' });
            return;
        }

        const result = await pool.query(`
            insert into control.database_access_subscription (
                instance_pk, is_enabled, fail_threshold, severity, notify_on_inaccessible, updated_at
            )
            values ($1, $2, $3, $4, $5, now())
            on conflict (instance_pk) do update
            set is_enabled = excluded.is_enabled,
                fail_threshold = excluded.fail_threshold,
                severity = excluded.severity,
                notify_on_inaccessible = excluded.notify_on_inaccessible,
                updated_at = now()
            returning
                subscription_id, instance_pk, is_enabled, fail_threshold,
                severity, notify_on_inaccessible, updated_at
        `, [
            instancePk,
            Boolean(req.body?.is_enabled ?? true),
            Math.trunc(failThreshold),
            severity,
            Boolean(req.body?.notify_on_inaccessible ?? true),
        ]);
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

router.get('/long-query/events', async (req, res, next) => {
    try {
        const limit = parseLimit(req.query.limit, 100);
        const instancePk = parseInstancePk(req.query.instancePk as string | undefined);
        const severity = req.query.severity as string | undefined;
        const status = req.query.status as string | undefined;
        if (req.query.instancePk && instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }

        const params: any[] = [LONG_QUERY_ALERT_CODES];
        let paramIdx = 2;
        let whereSql = 'where a.alert_code = any($1)';
        if (instancePk != null) {
            whereSql += ` and a.instance_pk = $${paramIdx++}`;
            params.push(instancePk);
        }
        if (severity) {
            whereSql += ` and a.severity = $${paramIdx++}`;
            params.push(severity);
        }
        if (status) {
            whereSql += ` and a.status = $${paramIdx++}`;
            params.push(status);
        }
        params.push(limit);

        const result = await pool.query(`
            select
                a.alert_id,
                a.alert_key,
                a.alert_code,
                a.severity,
                a.status,
                a.occurrence_count,
                a.instance_pk,
                i.display_name as instance_name,
                a.title,
                a.message,
                a.first_seen_at,
                a.last_seen_at,
                a.resolved_at,
                a.details_json
            from ops.alert a
            left join control.instance_inventory i on i.instance_pk = a.instance_pk
            ${whereSql}
            order by a.last_seen_at desc
            limit $${paramIdx}
        `, params);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

router.get('/long-query/live', async (req, res, next) => {
    try {
        const limit = parseLimit(req.query.limit, 100);
        const instancePk = parseInstancePk(req.query.instancePk as string | undefined);
        if (req.query.instancePk && instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }

        const params: any[] = [];
        let paramIdx = 1;
        let instanceFilterSql = '';
        if (instancePk != null) {
            instanceFilterSql = `and a.instance_pk = $${paramIdx++}`;
            params.push(instancePk);
        }
        params.push(limit);

        const result = await pool.query(`
            with latest as (
                select instance_pk, max(snapshot_ts) as snapshot_ts
                from fact.pg_activity_snapshot
                where snapshot_ts > now() - interval '5 minutes'
                group by instance_pk
            )
            select
                i.display_name as instance_name,
                a.pid,
                a.datname,
                a.usename,
                a.state,
                floor(extract(epoch from (
                    now() - case
                        when a.state = 'active' then a.query_start
                        else a.xact_start
                    end
                )) / 60)::int as duration_minutes,
                a.query as query_text
            from fact.pg_activity_snapshot a
            join latest l on l.instance_pk = a.instance_pk and l.snapshot_ts = a.snapshot_ts
            join control.instance_inventory i on i.instance_pk = a.instance_pk
            where a.backend_type = 'client backend'
              and nullif(btrim(coalesce(a.query, '')), '') is not null
              and (
                (a.state = 'active' and a.query_start is not null)
                or (a.state in ('idle in transaction', 'idle in transaction (aborted)') and a.xact_start is not null)
              )
              ${instanceFilterSql}
            order by duration_minutes desc, i.display_name, a.pid
            limit $${paramIdx}
        `, params);
        res.json(result.rows.map((row) => ({
            instance_name: row.instance_name,
            pid: row.pid,
            datname: row.datname,
            usename: row.usename,
            state: row.state,
            duration_minutes: row.duration_minutes,
            query_preview: queryPreview(row.query_text),
        })));
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// XID FREEZE
// ============================================================================

router.get('/xid-freeze/subscriptions', async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select
                s.subscription_id,
                s.instance_pk,
                i.display_name as instance_name,
                s.is_enabled,
                s.warning_pct,
                s.critical_pct,
                s.notify_on_xid,
                s.notify_on_mxid,
                s.updated_at
            from control.xid_freeze_subscription s
            join control.instance_inventory i on i.instance_pk = s.instance_pk
            order by i.display_name, s.instance_pk
        `);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

router.put('/xid-freeze/subscriptions/:instancePk', async (req, res, next) => {
    try {
        const instancePk = requireInstancePk(req.params.instancePk);
        if (instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }

        const warningPct = Number(req.body?.warning_pct ?? 80);
        const criticalPct = Number(req.body?.critical_pct ?? 95);
        if (!Number.isFinite(warningPct) || warningPct < 1 || warningPct > 100) {
            res.status(400).json({ error: 'warning_pct 1-100 arasinda olmali' });
            return;
        }
        if (!Number.isFinite(criticalPct) || criticalPct < 1 || criticalPct > 100) {
            res.status(400).json({ error: 'critical_pct 1-100 arasinda olmali' });
            return;
        }
        if (criticalPct <= warningPct) {
            res.status(400).json({ error: "critical_pct warning_pct'den buyuk olmali" });
            return;
        }

        const result = await pool.query(`
            insert into control.xid_freeze_subscription (
                instance_pk, is_enabled, warning_pct, critical_pct,
                notify_on_xid, notify_on_mxid, updated_at
            )
            values ($1, $2, $3, $4, $5, $6, now())
            on conflict (instance_pk) do update
            set is_enabled = excluded.is_enabled,
                warning_pct = excluded.warning_pct,
                critical_pct = excluded.critical_pct,
                notify_on_xid = excluded.notify_on_xid,
                notify_on_mxid = excluded.notify_on_mxid,
                updated_at = now()
            returning
                subscription_id, instance_pk, is_enabled, warning_pct, critical_pct,
                notify_on_xid, notify_on_mxid, updated_at
        `, [
            instancePk,
            Boolean(req.body?.is_enabled ?? true),
            Math.trunc(warningPct),
            Math.trunc(criticalPct),
            Boolean(req.body?.notify_on_xid ?? true),
            Boolean(req.body?.notify_on_mxid ?? true),
        ]);
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

router.get('/xid-freeze/current-state', async (req, res, next) => {
    try {
        const instancePk = parseInstancePk(req.query.instancePk as string | undefined);
        if (req.query.instancePk && instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }

        const params: any[] = [];
        const freezeFilterSql = instancePk != null ? 'and fs.instance_pk = $1' : '';
        const settingsFilterSql = instancePk != null ? 'and ps.instance_pk = $1' : '';
        if (instancePk != null) params.push(instancePk);

        const result = await pool.query(`
            with latest_freeze as (
                select fs.instance_pk, max(fs.snapshot_ts) as snapshot_ts
                from fact.pg_database_freeze_snapshot fs
                where fs.snapshot_ts > now() - interval '36 hours'
                  ${freezeFilterSql}
                group by fs.instance_pk
            ),
            latest_settings as (
                select ps.instance_pk, max(ps.snapshot_ts) as snapshot_ts
                from fact.pg_settings_snapshot ps
                where ps.snapshot_ts > now() - interval '36 hours'
                  ${settingsFilterSql}
                group by ps.instance_pk
            ),
            settings as (
                select
                    ls.instance_pk,
                    coalesce(
                        max(nullif(regexp_replace(ps.setting_value, '[^0-9]', '', 'g'), '')::bigint)
                            filter (where ps.setting_name = 'autovacuum_freeze_max_age'),
                        200000000::bigint
                    ) as xid_max_age,
                    coalesce(
                        max(nullif(regexp_replace(ps.setting_value, '[^0-9]', '', 'g'), '')::bigint)
                            filter (where ps.setting_name = 'autovacuum_multixact_freeze_max_age'),
                        400000000::bigint
                    ) as mxid_max_age
                from latest_settings ls
                join fact.pg_settings_snapshot ps
                  on ps.instance_pk = ls.instance_pk
                 and ps.snapshot_ts = ls.snapshot_ts
                 and ps.setting_name in (
                    'autovacuum_freeze_max_age',
                    'autovacuum_multixact_freeze_max_age'
                 )
                group by ls.instance_pk
            )
            select
                i.display_name as instance_name,
                f.datname,
                f.dbid,
                f.datfrozenxid_age,
                f.datminmxid_age,
                coalesce(s.xid_max_age, 200000000::bigint) as xid_max_age,
                coalesce(s.mxid_max_age, 400000000::bigint) as mxid_max_age,
                round(f.datfrozenxid_age * 100.0 / nullif(coalesce(s.xid_max_age, 200000000::bigint), 0))::int as xid_pct,
                round(f.datminmxid_age * 100.0 / nullif(coalesce(s.mxid_max_age, 400000000::bigint), 0))::int as mxid_pct,
                f.snapshot_ts
            from latest_freeze lf
            join fact.pg_database_freeze_snapshot f
              on f.instance_pk = lf.instance_pk
             and f.snapshot_ts = lf.snapshot_ts
            join control.instance_inventory i on i.instance_pk = f.instance_pk
            left join settings s on s.instance_pk = f.instance_pk
            order by xid_pct desc nulls last, i.display_name, f.datname
        `, params);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

router.get('/xid-freeze/events', async (req, res, next) => {
    try {
        const limit = parseLimit(req.query.limit, 100);
        const instancePk = parseInstancePk(req.query.instancePk as string | undefined);
        const severity = req.query.severity as string | undefined;
        const status = req.query.status as string | undefined;
        if (req.query.instancePk && instancePk == null) {
            res.status(400).json({ error: 'Gecersiz instancePk' });
            return;
        }

        const params: any[] = [XID_FREEZE_ALERT_CODES];
        let paramIdx = 2;
        let whereSql = 'where a.alert_code = any($1)';
        if (instancePk != null) {
            whereSql += ` and a.instance_pk = $${paramIdx++}`;
            params.push(instancePk);
        }
        if (severity) {
            whereSql += ` and a.severity = $${paramIdx++}`;
            params.push(severity);
        }
        if (status) {
            whereSql += ` and a.status = $${paramIdx++}`;
            params.push(status);
        }
        params.push(limit);

        const result = await pool.query(`
            select
                a.alert_id,
                a.alert_key,
                a.alert_code,
                a.severity,
                a.status,
                a.occurrence_count,
                a.instance_pk,
                i.display_name as instance_name,
                a.title,
                a.message,
                a.first_seen_at,
                a.last_seen_at,
                a.resolved_at,
                a.details_json
            from ops.alert a
            left join control.instance_inventory i on i.instance_pk = a.instance_pk
            ${whereSql}
            order by a.last_seen_at desc
            limit $${paramIdx}
        `, params);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// ALERT SNOOZE
// ============================================================================

// POST /api/alerts/snooze
router.post('/snooze', async (req, res, next) => {
    try {
        const { rule_id, instance_pk, metric_key, queryid, duration_minutes, reason } = req.body;
        const created_by = 'admin'; // Single admin user system

        const snoozeUntil = new Date(Date.now() + duration_minutes * 60 * 1000);

        const result = await pool.query(
            `insert into control.alert_snooze 
       (rule_id, instance_pk, metric_key, queryid, snooze_until, snooze_reason, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning snooze_id, snooze_until`,
            [rule_id, instance_pk, metric_key, queryid, snoozeUntil, reason, created_by]
        );

        res.json({
            snooze_id: result.rows[0].snooze_id,
            snoozed_until: result.rows[0].snooze_until,
            message: `Alert snoozed for ${duration_minutes} minutes`
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/alerts/snooze — Active snoozes
router.get('/snooze', async (_req, res, next) => {
    try {
        const result = await pool.query(
            `select s.*, 
              r.rule_name,
              i.display_name as instance_name
       from control.alert_snooze s
       left join control.alert_rule r on r.rule_id = s.rule_id
       left join control.instance_inventory i on i.instance_pk = s.instance_pk
       where s.snooze_until > now()
       order by s.snooze_until asc`
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// DELETE /api/alerts/snooze/:snooze_id
router.delete('/snooze/:snooze_id', async (req, res, next) => {
    try {
        await pool.query(
            'delete from control.alert_snooze where snooze_id = $1',
            [req.params.snooze_id]
        );
        res.json({ message: 'Snooze removed' });
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// MAINTENANCE WINDOWS
// ============================================================================

// POST /api/maintenance-windows
router.post('/maintenance-windows', async (req, res, next) => {
    try {
        const {
            window_name,
            description,
            instance_pks,
            day_of_week,
            start_time,
            end_time,
            timezone,
            suppress_all_alerts,
            suppress_severity
        } = req.body;

        const result = await pool.query(
            `insert into control.maintenance_window 
       (window_name, description, instance_pks, day_of_week, start_time, end_time, 
        timezone, suppress_all_alerts, suppress_severity)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning window_id`,
            [window_name, description, instance_pks, day_of_week, start_time, end_time,
                timezone, suppress_all_alerts, suppress_severity]
        );

        res.json({
            window_id: result.rows[0].window_id,
            message: 'Maintenance window created'
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/maintenance-windows
router.get('/maintenance-windows', async (_req, res, next) => {
    try {
        const result = await pool.query(
            `select window_id, window_name, description, instance_pks, day_of_week,
                    start_time, end_time, timezone, suppress_all_alerts,
                    suppress_severity, is_enabled, created_at
             from control.maintenance_window
             order by window_name`
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// PUT /api/maintenance-windows/:window_id
router.put('/maintenance-windows/:window_id', async (req, res, next) => {
    try {
        const {
            window_name, description, instance_pks, day_of_week,
            start_time, end_time, timezone, suppress_all_alerts,
            suppress_severity, is_enabled
        } = req.body;

        const result = await pool.query(
            `update control.maintenance_window set
                window_name = coalesce($1, window_name),
                description = $2,
                instance_pks = $3,
                day_of_week = $4,
                start_time = coalesce($5, start_time),
                end_time = coalesce($6, end_time),
                timezone = coalesce($7, timezone),
                suppress_all_alerts = coalesce($8, suppress_all_alerts),
                suppress_severity = $9,
                is_enabled = coalesce($10, is_enabled)
             where window_id = $11
             returning *`,
            [window_name, description, instance_pks, day_of_week,
                start_time, end_time, timezone, suppress_all_alerts,
                suppress_severity, is_enabled, req.params.window_id]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Window not found' });
        res.json({ ...result.rows[0], message: 'Maintenance window updated' });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/maintenance-windows/:window_id
router.delete('/maintenance-windows/:window_id', async (req, res, next) => {
    try {
        await pool.query(
            'delete from control.maintenance_window where window_id = $1',
            [req.params.window_id]
        );
        res.json({ message: 'Maintenance window deleted' });
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// NOTIFICATION CHANNELS
// ============================================================================

// POST /api/notification-channels
router.post('/notification-channels', async (req, res, next) => {
    try {
        const {
            channel_name,
            channel_type,
            config,
            min_severity,
            instance_pks,
            metric_categories
        } = req.body;

        if (!channel_name || !channel_type) {
            return res.status(400).json({ error: 'channel_name ve channel_type zorunlu' });
        }

        // Dinamik kolon tespiti — eski DB'lerde metric_categories olmayabilir
        const colsRes = await pool.query(
            `select column_name from information_schema.columns
             where table_schema='control' and table_name='notification_channel'`
        );
        const existingCols = new Set<string>(colsRes.rows.map((r: any) => r.column_name));

        const cols: { name: string; val: any }[] = [
            { name: 'channel_name', val: channel_name },
            { name: 'channel_type', val: channel_type },
            { name: 'config', val: JSON.stringify(config || {}) },
            { name: 'min_severity', val: min_severity ?? null },
            { name: 'instance_pks', val: instance_pks ?? null },
            { name: 'metric_categories', val: metric_categories ?? null },
        ];
        const active = cols.filter(c => existingCols.has(c.name));
        const colList = active.map(c => c.name).join(', ');
        const placeholders = active.map((_, i) => `$${i + 1}`).join(', ');
        const values = active.map(c => c.val);

        const result = await pool.query(
            `insert into control.notification_channel (${colList}) values (${placeholders}) returning channel_id`,
            values
        );

        res.json({
            channel_id: result.rows[0].channel_id,
            message: 'Notification channel created'
        });
    } catch (err: any) {
        console.error('notification-channel POST hatasi:', err.message, err.code, err.detail);
        res.status(500).json({ error: err.message || 'Insert failed', detail: err.detail, code: err.code });
    }
});

// POST /api/notification-channels/detect-chat
// Telegram chat_id otomatik tespit: bot_token alir, getUpdates ile bota en son
// gelen mesajin/postun chat_id'sini bulur. Kullanici botu gruba ekleyip bir
// mesaj attiktan sonra cagirir -> chat_id'yi elle /getUpdates ile bulma derdi biter.
router.post('/notification-channels/detect-chat', async (req, res) => {
    const botToken = req.body?.bot_token ? String(req.body.bot_token).trim() : '';
    // Telegram bot token formati: <digits>:<35+ alfanumerik>. Kabaca dogrula.
    if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
        return res.status(400).json({ error: 'Gecersiz bot_token formati' });
    }
    try {
        const url = `https://api.telegram.org/bot${botToken}/getUpdates?limit=20&timeout=0`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        let resp: Response;
        try {
            resp = await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
        if (resp.status === 409) {
            return res.status(409).json({ error: 'Bota webhook bagli (getUpdates kullanilamaz). Once webhook silinmeli: deleteWebhook' });
        }
        if (!resp.ok) {
            return res.status(502).json({ error: `Telegram API hatasi: HTTP ${resp.status}` });
        }
        const data: any = await resp.json();
        if (!data?.ok || !Array.isArray(data.result)) {
            return res.status(502).json({ error: 'Telegram yaniti gecersiz (ok=false)' });
        }
        // En son gelen update'ten geriye dogru ilk chat'i al (message veya channel_post).
        const candidates: { chat_id: string; title: string; type: string }[] = [];
        const seen = new Set<string>();
        for (let i = data.result.length - 1; i >= 0; i--) {
            const u = data.result[i];
            const msg = u?.message || u?.channel_post || u?.my_chat_member;
            const chat = msg?.chat;
            if (!chat?.id) continue;
            const id = String(chat.id);
            if (seen.has(id)) continue;
            seen.add(id);
            candidates.push({
                chat_id: id,
                title: chat.title || chat.username || chat.first_name || '(isimsiz)',
                type: chat.type || '-',
            });
        }
        if (candidates.length === 0) {
            return res.json({
                detected: null,
                candidates: [],
                hint: 'Hic mesaj bulunamadi. Botu gruba/kanala ekleyip bir mesaj atin, sonra tekrar deneyin. (Eski mesajlar islenmis olabilir.)'
            });
        }
        res.json({ detected: candidates[0], candidates });
    } catch (err: any) {
        const aborted = err?.name === 'AbortError';
        res.status(aborted ? 504 : 500).json({
            error: aborted ? 'Telegram API zaman asimi' : (err?.message || 'Tespit basarisiz')
        });
    }
});

// GET /api/notification-channels
router.get('/notification-channels', async (_req, res, next) => {
    try {
        const result = await pool.query(
            `select channel_id, channel_name, channel_type, config, min_severity,
                    instance_pks, metric_categories, is_enabled, created_at
             from control.notification_channel
             order by channel_name`
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// POST /api/notification-channels/:channel_id/test
router.post('/notification-channels/:channel_id/test', async (req, res, next) => {
    try {
        const result = await pool.query(
            `select channel_id, channel_name, channel_type, config, min_severity,
                    instance_pks, metric_categories, is_enabled, created_at
             from control.notification_channel
             where channel_id = $1`,
            [req.params.channel_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        const channel = result.rows[0];
        const config = typeof channel.config === 'string' ? JSON.parse(channel.config) : channel.config;
        const testTitle = 'pgstat Test Bildirimi';
        const testMessage = `Bu bir test bildirimidir. Kanal: ${channel.channel_name}`;

        try {
            switch (channel.channel_type) {
                case 'teams': {
                    const webhookUrl = config.webhook_url;
                    if (!webhookUrl) return res.status(400).json({ error: 'webhook_url tanımlı değil' });
                    const payload = {
                        '@type': 'MessageCard',
                        '@context': 'http://schema.org/extensions',
                        themeColor: '0078D4',
                        summary: testTitle,
                        sections: [{
                            activityTitle: '🔔 pgstat Test',
                            activitySubtitle: testTitle,
                            facts: [{ name: 'Durum', value: 'Test başarılı' }],
                            markdown: true
                        }]
                    };
                    const resp = await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    if (!resp.ok) return res.status(502).json({ error: `Teams webhook hatası: ${resp.status}` });
                    break;
                }
                case 'telegram': {
                    const botToken = config.bot_token;
                    const chatId = config.chat_id;
                    if (!botToken || !chatId) return res.status(400).json({ error: 'bot_token veya chat_id tanımlı değil' });
                    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: chatId, text: `🔔 ${testTitle}\n${testMessage}`, parse_mode: 'Markdown' })
                    });
                    if (!resp.ok) {
                        const body = await resp.json().catch(() => ({}));
                        return res.status(502).json({ error: `Telegram hatası: ${(body as any).description || resp.status}` });
                    }
                    break;
                }
                case 'webhook': {
                    const url = config.url || config.webhook_url;
                    if (!url) return res.status(400).json({ error: 'url tanımlı değil' });
                    const method = (config.method || 'POST').toUpperCase();
                    const headers: Record<string, string> = {
                        'Content-Type': 'application/json',
                        ...(config.headers || {}),
                    };
                    // body_template varsa kullan, yoksa varsayılan JSON
                    let body: string;
                    if (config.body_template) {
                        body = String(config.body_template)
                            .replace(/\{\{title\}\}/g, testTitle)
                            .replace(/\{\{message\}\}/g, testMessage)
                            .replace(/\{\{severity\}\}/g, 'info')
                            .replace(/\{\{instance\}\}/g, channel.channel_name)
                            .replace(/\{\{metric\}\}/g, 'test')
                            .replace(/\{\{value\}\}/g, '0');
                    } else {
                        body = JSON.stringify({
                            title: testTitle,
                            message: testMessage,
                            severity: 'info',
                            channel: channel.channel_name,
                            test: true,
                        });
                    }
                    const resp = await fetch(url, { method, headers, body });
                    if (!resp.ok) {
                        const txt = await resp.text().catch(() => '');
                        return res.status(502).json({ error: `Webhook hatası: ${resp.status} ${txt.slice(0, 200)}` });
                    }
                    break;
                }
                case 'email':
                    // Email testi collector tarafında yapılır (SMTP ayarları collector'da)
                    return res.json({ message: 'Email testi collector üzerinden yapılır. Collector loglarını kontrol edin.' });
                default:
                    return res.json({ message: `${channel.channel_type} test henüz desteklenmiyor` });
            }
            res.json({ message: 'Test bildirimi başarıyla gönderildi' });
        } catch (sendErr: any) {
            res.status(502).json({ error: `Gönderim hatası: ${sendErr.message}` });
        }
    } catch (err) {
        next(err);
    }
});

// PUT /api/notification-channels/:channel_id — kanal düzenle
router.put('/notification-channels/:channel_id', async (req, res, _next) => {
    try {
        const id = parseInt(req.params.channel_id, 10);
        if (!id) return res.status(400).json({ error: 'Geçersiz channel_id' });

        const { channel_name, channel_type, config, min_severity, instance_pks,
            metric_categories, is_enabled } = req.body;

        // Dinamik kolon tespiti — eski DB'lerde bazı kolonlar olmayabilir
        const colsRes = await pool.query(
            `select column_name from information_schema.columns
             where table_schema='control' and table_name='notification_channel'`
        );
        const existingCols = new Set<string>(colsRes.rows.map((r: any) => r.column_name));

        const cols: { name: string; val: any }[] = [];
        if (channel_name !== undefined) cols.push({ name: 'channel_name', val: channel_name });
        if (channel_type !== undefined) cols.push({ name: 'channel_type', val: channel_type });
        if (config !== undefined) cols.push({ name: 'config', val: JSON.stringify(config) });
        if (min_severity !== undefined) cols.push({ name: 'min_severity', val: min_severity });
        if (instance_pks !== undefined) cols.push({ name: 'instance_pks', val: instance_pks });
        if (metric_categories !== undefined) cols.push({ name: 'metric_categories', val: metric_categories });
        if (is_enabled !== undefined) cols.push({ name: 'is_enabled', val: is_enabled });

        const active = cols.filter(c => existingCols.has(c.name));
        if (active.length === 0) return res.status(400).json({ error: 'Güncellenecek alan yok' });

        const setSql = active.map((c, i) => `${c.name}=$${i + 1}`).join(', ');
        const values = active.map(c => c.val);
        values.push(id);

        const result = await pool.query(
            `update control.notification_channel set ${setSql} where channel_id=$${values.length} returning *`,
            values
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Kanal bulunamadı' });
        res.json({ ...result.rows[0], message: 'Kanal güncellendi' });
    } catch (err: any) {
        console.error('notification-channel PUT hatasi:', err.message, err.code, err.detail);
        res.status(500).json({ error: err.message || 'Update failed', detail: err.detail, code: err.code });
    }
});

// DELETE /api/notification-channels/:channel_id
router.delete('/notification-channels/:channel_id', async (req, res, next) => {
    try {
        await pool.query(
            'delete from control.notification_channel where channel_id = $1',
            [req.params.channel_id]
        );
        res.json({ message: 'Notification channel deleted' });
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// BASELINE MANAGEMENT
// ============================================================================

// GET /api/instances/:instance_pk/baseline/:metric_key
router.get('/instances/:instance_pk/baseline/:metric_key', async (req, res, next) => {
    try {
        const { instance_pk, metric_key } = req.params;
        const hour_of_day = req.query.hour_of_day as string | undefined;

        // Tek bir saat istendiyse sadece o saati, yoksa hem genel (-1) hem tüm saatler dön
        let query = `
            select hour_of_day, avg_value, stddev_value, min_value, max_value,
                   p50_value, p95_value, p99_value, sample_count,
                   baseline_start, baseline_end, updated_at
            from control.metric_baseline
            where instance_pk = $1 and metric_key = $2
        `;
        const params: any[] = [instance_pk, metric_key];
        if (hour_of_day !== undefined) {
            query += ' and hour_of_day = $3';
            params.push(parseInt(hour_of_day, 10));
        }
        query += ' order by hour_of_day';

        const result = await pool.query(query, params);
        res.json({
            instance_pk: Number(instance_pk),
            metric_key,
            general: result.rows.find(r => r.hour_of_day === -1) || null,
            hourly: result.rows.filter(r => r.hour_of_day !== -1),
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/adaptive-alerting/instances/:instance_pk/baseline — tüm metric_key'ler özet
router.get('/instances/:instance_pk/baseline', async (req, res, next) => {
    try {
        const { instance_pk } = req.params;
        const result = await pool.query(`
            select metric_key,
                   max(updated_at) as updated_at,
                   count(*) filter (where hour_of_day = -1) as has_general,
                   count(*) filter (where hour_of_day >= 0) as hourly_count,
                   avg(sample_count) as avg_sample_count
            from control.metric_baseline
            where instance_pk = $1
            group by metric_key
            order by metric_key
        `, [instance_pk]);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// GET /api/adaptive-alerting/overview — dashboard kartı için özet
router.get('/overview', async (_req, res, next) => {
    try {
        const [baselines, snoozes, maintenance, channels] = await Promise.all([
            pool.query(`select count(distinct instance_pk) as instances,
                               count(*) as total_baselines,
                               max(updated_at) as latest_update
                        from control.metric_baseline`),
            pool.query(`select count(*) as active
                        from control.alert_snooze where snooze_until > now()`),
            pool.query(`select count(*) as enabled
                        from control.maintenance_window where is_enabled = true`),
            pool.query(`select count(*) as enabled
                        from control.notification_channel where is_enabled = true`),
        ]);
        res.json({
            baselines: {
                instance_count: parseInt(baselines.rows[0].instances, 10),
                total_baselines: parseInt(baselines.rows[0].total_baselines, 10),
                latest_update: baselines.rows[0].latest_update,
            },
            active_snoozes: parseInt(snoozes.rows[0].active, 10),
            enabled_maintenance: parseInt(maintenance.rows[0].enabled, 10),
            enabled_channels: parseInt(channels.rows[0].enabled, 10),
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/adaptive-alerting/baselines/trigger
// Manuel baseline hesaplama istegi. instance_pk null = tum instance'lar.
router.post('/baselines/trigger', async (req, res, next) => {
    try {
        const { instance_pk } = req.body;
        const result = await pool.query(
            `insert into control.baseline_trigger (instance_pk, requested_by)
             values ($1, $2)
             returning trigger_id, status, requested_at`,
            [instance_pk || null, 'admin']
        );
        res.json({
            ...result.rows[0],
            message: 'Baseline hesaplamasi istegi kuyruga alindi. Collector 5 saniye icinde isleme baslayacak.',
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/adaptive-alerting/baselines/triggers — son 20 trigger
router.get('/baselines/triggers', async (_req, res, next) => {
    try {
        const result = await pool.query(
            `select t.*, i.display_name as instance_name
             from control.baseline_trigger t
             left join control.instance_inventory i on i.instance_pk = t.instance_pk
             order by t.requested_at desc
             limit 20`
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// POST /api/adaptive-alerting/nightly-snapshot/trigger
// Manuel nightly snapshot tetikleme. Collector 5sn icinde baslar.
router.post('/nightly-snapshot/trigger', async (_req, res, next) => {
    try {
        const result = await pool.query(
            `insert into control.nightly_snapshot_trigger (status, requested_by)
             values ('pending', 'admin')
             returning trigger_id, status, requested_at`
        );
        res.json({
            ...result.rows[0],
            message: 'Nightly snapshot tetiklendi. Collector 5 saniye içinde başlayacak.',
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/adaptive-alerting/nightly-snapshot/triggers — son tetiklemeler
router.get('/nightly-snapshot/triggers', async (_req, res, next) => {
    try {
        const result = await pool.query(
            `select trigger_id, status, requested_by, requested_at, started_at,
                    finished_at, rows_written
             from control.nightly_snapshot_trigger
             order by requested_at desc
             limit 10`
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// POST /api/instances/:instance_pk/baseline/invalidate
router.post('/instances/:instance_pk/baseline/invalidate', async (req, res, next) => {
    try {
        const { instance_pk } = req.params;
        const { reason } = req.body;
        const invalidated_by = 'admin'; // Single admin user system

        // Get old version
        const oldVersion = await pool.query(
            'select version_number from control.baseline_version where instance_pk = $1 and is_active = true',
            [instance_pk]
        );

        // Count baseline records
        const countResult = await pool.query(
            'select count(*) from control.metric_baseline where instance_pk = $1',
            [instance_pk]
        );

        // Invalidate
        await pool.query(
            'select control.invalidate_baseline($1, $2, $3)',
            [instance_pk, reason, invalidated_by]
        );

        // Get new version
        const newVersion = await pool.query(
            'select version_number from control.baseline_version where instance_pk = $1 and is_active = true',
            [instance_pk]
        );

        res.json({
            success: true,
            old_version: oldVersion.rows[0]?.version_number || 0,
            new_version: newVersion.rows[0]?.version_number || 1,
            message: 'Baseline invalidated. New baseline will be calculated over next 7 days.',
            baseline_records_deleted: parseInt(countResult.rows[0].count)
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/instances/:instance_pk/baseline/versions
router.get('/instances/:instance_pk/baseline/versions', async (req, res, next) => {
    try {
        const { instance_pk } = req.params;

        const result = await pool.query(
            `select version_id, instance_pk, version_number, pg_version,
                    invalidation_reason, invalidated_at, invalidated_by,
                    baseline_start, baseline_end, is_active, created_at
             from control.baseline_version
             where instance_pk = $1
             order by version_number desc`,
            [instance_pk]
        );

        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// INSTANCE GROUPS
// ============================================================================

// POST /api/instance-groups
router.post('/instance-groups', async (req, res, next) => {
    try {
        const { group_name, description } = req.body;

        const result = await pool.query(
            'insert into control.instance_group (group_name, description) values ($1, $2) returning group_id',
            [group_name, description]
        );

        res.json({
            group_id: result.rows[0].group_id,
            message: 'Instance group created'
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/instance-groups
router.get('/instance-groups', async (_req, res, next) => {
    try {
        const result = await pool.query(
            `select g.*, 
              array_agg(m.instance_pk) filter (where m.instance_pk is not null) as instance_pks,
              count(m.instance_pk) as member_count
       from control.instance_group g
       left join control.instance_group_member m on m.group_id = g.group_id
       group by g.group_id
       order by g.group_name`
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// POST /api/instance-groups/:group_id/members
router.post('/instance-groups/:group_id/members', async (req, res, next) => {
    try {
        const { group_id } = req.params;
        const { instance_pk } = req.body;

        await pool.query(
            'insert into control.instance_group_member (group_id, instance_pk) values ($1, $2) on conflict do nothing',
            [group_id, instance_pk]
        );

        res.json({ message: 'Instance added to group' });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/instance-groups/:group_id/members/:instance_pk
router.delete('/instance-groups/:group_id/members/:instance_pk', async (req, res, next) => {
    try {
        const { group_id, instance_pk } = req.params;

        await pool.query(
            'delete from control.instance_group_member where group_id = $1 and instance_pk = $2',
            [group_id, instance_pk]
        );

        res.json({ message: 'Instance removed from group' });
    } catch (err) {
        next(err);
    }
});

export default router;
