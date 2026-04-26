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
        if (channel_name      !== undefined) cols.push({ name: 'channel_name',      val: channel_name });
        if (channel_type      !== undefined) cols.push({ name: 'channel_type',      val: channel_type });
        if (config            !== undefined) cols.push({ name: 'config',            val: JSON.stringify(config) });
        if (min_severity      !== undefined) cols.push({ name: 'min_severity',      val: min_severity });
        if (instance_pks      !== undefined) cols.push({ name: 'instance_pks',      val: instance_pks });
        if (metric_categories !== undefined) cols.push({ name: 'metric_categories', val: metric_categories });
        if (is_enabled        !== undefined) cols.push({ name: 'is_enabled',        val: is_enabled });

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
