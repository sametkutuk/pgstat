import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

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
            `select * from control.maintenance_window order by window_name`
        );
        res.json(result.rows);
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

        const result = await pool.query(
            `insert into control.notification_channel 
       (channel_name, channel_type, config, min_severity, instance_pks, metric_categories)
       values ($1, $2, $3, $4, $5, $6)
       returning channel_id`,
            [channel_name, channel_type, JSON.stringify(config), min_severity, instance_pks, metric_categories]
        );

        res.json({
            channel_id: result.rows[0].channel_id,
            message: 'Notification channel created'
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/notification-channels
router.get('/notification-channels', async (_req, res, next) => {
    try {
        const result = await pool.query(
            `select * from control.notification_channel order by channel_name`
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
            'select * from control.notification_channel where channel_id = $1',
            [req.params.channel_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // TODO: Implement actual notification sending
        res.json({ message: 'Test notification sent (not implemented yet)' });
    } catch (err) {
        next(err);
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
            active_snoozes:       parseInt(snoozes.rows[0].active, 10),
            enabled_maintenance:  parseInt(maintenance.rows[0].enabled, 10),
            enabled_channels:     parseInt(channels.rows[0].enabled, 10),
        });
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
            `select * from control.baseline_version
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
