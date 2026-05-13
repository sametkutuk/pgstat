import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

// =========================================================================
// Database cleanup — silinmis veya erisilemeyen DB'leri takipten cikar
// =========================================================================

// GET /api/database-cleanup/candidates
// "does not exist" / connection failure gibi hatalardan etkilenen DB'leri listele.
router.get('/candidates', async (_req, res, next) => {
    try {
        // job_failed / job_partial_failure alert'lerinde "database ... does not exist"
        // mesajlari geciyor — bunlardan dbname extract edelim. Plus instance_state
        // bootstrap_state degisiklikleri.
        const result = await pool.query(`
            with alert_hits as (
                select a.instance_pk,
                       a.alert_id,
                       a.first_seen_at,
                       a.last_seen_at,
                       a.severity,
                       a.title,
                       a.message,
                       a.status,
                       substring(a.message from 'database "([^"]+)" does not exist') as datname_match
                from ops.alert a
                where a.alert_code in ('job_failed', 'job_partial_failure', 'connection_failure', 'permission_denied')
                  and a.status in ('open', 'acknowledged')
                  and a.message ilike '%does not exist%'
            ),
            dbs as (
                select distinct
                       ah.instance_pk,
                       i.display_name as instance_name,
                       i.host as instance_host,
                       ah.datname_match as datname,
                       dr.dbid,
                       dr.is_active,
                       dr.disabled_at,
                       dr.disabled_reason,
                       min(ah.first_seen_at) over (partition by ah.instance_pk, ah.datname_match) as first_error_at,
                       max(ah.last_seen_at) over (partition by ah.instance_pk, ah.datname_match) as last_error_at,
                       count(*) over (partition by ah.instance_pk, ah.datname_match) as error_count,
                       max(ah.alert_id) over (partition by ah.instance_pk, ah.datname_match) as latest_alert_id
                from alert_hits ah
                join control.instance_inventory i on i.instance_pk = ah.instance_pk
                left join dim.database_ref dr
                    on dr.instance_pk = ah.instance_pk and dr.datname = ah.datname_match
                where ah.datname_match is not null
            )
            select distinct instance_pk, instance_name, instance_host, datname, dbid,
                            is_active, disabled_at, disabled_reason,
                            first_error_at, last_error_at, error_count, latest_alert_id
            from dbs
            order by last_error_at desc
        `);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// POST /api/database-cleanup/disable
// { instance_pk, datname, reason, alert_id (optional) }
router.post('/disable', async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('begin');
        const { instance_pk, datname, reason, alert_id } = req.body;
        if (!instance_pk || !datname) {
            await client.query('rollback');
            return res.status(400).json({ error: 'instance_pk ve datname zorunlu' });
        }

        // database_ref soft-delete (dbid lookup)
        const refResult = await client.query(
            `update dim.database_ref
             set is_active = false,
                 disabled_at = now(),
                 disabled_reason = $3
             where instance_pk = $1 and datname = $2
             returning dbid, is_active`,
            [instance_pk, datname, reason || 'manuel takipten cikarildi']
        );
        const dbid = refResult.rows[0]?.dbid || null;

        // Audit log
        await client.query(
            `insert into control.database_action_log
                (instance_pk, dbid, datname, action, reason, alert_id, actioned_by)
             values ($1, $2, $3, 'disabled', $4, $5, 'admin')`,
            [instance_pk, dbid, datname, reason || null, alert_id || null]
        );

        // Alert'i resolve et (varsa)
        if (alert_id) {
            await client.query(
                `update ops.alert
                 set status = 'resolved', resolved_at = now()
                 where alert_id = $1 and status in ('open', 'acknowledged')`,
                [alert_id]
            );
        }

        await client.query('commit');
        res.json({
            message: 'Database takipten cikarildi. Yeni delta toplanmayacak; gecmis veri retention politikasi ile temizlenir.',
            dbid: dbid
        });
    } catch (err) {
        await client.query('rollback');
        next(err);
    } finally {
        client.release();
    }
});

// POST /api/database-cleanup/reenable
// { instance_pk, datname }
router.post('/reenable', async (req, res, next) => {
    const client = await pool.connect();
    try {
        await client.query('begin');
        const { instance_pk, datname } = req.body;
        if (!instance_pk || !datname) {
            await client.query('rollback');
            return res.status(400).json({ error: 'instance_pk ve datname zorunlu' });
        }
        const r = await client.query(
            `update dim.database_ref
             set is_active = true,
                 disabled_at = null,
                 disabled_reason = null
             where instance_pk = $1 and datname = $2
             returning dbid`,
            [instance_pk, datname]
        );
        const dbid = r.rows[0]?.dbid || null;
        await client.query(
            `insert into control.database_action_log
                (instance_pk, dbid, datname, action, actioned_by)
             values ($1, $2, $3, 're_enabled', 'admin')`,
            [instance_pk, dbid, datname]
        );
        await client.query('commit');
        res.json({ message: 'Database tekrar takibe alindi.' });
    } catch (err) {
        await client.query('rollback');
        next(err);
    } finally {
        client.release();
    }
});

// GET /api/database-cleanup/log
router.get('/log', async (_req, res, next) => {
    try {
        const r = await pool.query(`
            select dal.log_id, dal.instance_pk, i.display_name as instance_name,
                   dal.dbid, dal.datname, dal.action, dal.reason, dal.alert_id,
                   dal.actioned_by, dal.actioned_at
            from control.database_action_log dal
            left join control.instance_inventory i on i.instance_pk = dal.instance_pk
            order by dal.actioned_at desc
            limit 100
        `);
        res.json(r.rows);
    } catch (err) {
        next(err);
    }
});

export default router;
