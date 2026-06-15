// Rapor konfigurasyonu + tarihce API'leri
//   GET    /api/reports/config           — mevcut config (singleton)
//   PATCH  /api/reports/config           — config guncelle
//   GET    /api/reports/history          — gonderilen rapor listesi (filter: type, limit)
//   GET    /api/reports/history/:id      — tek rapor detay (body dahil)
//   DELETE /api/reports/history/:id      — manuel sil

import { Router } from 'express';
import { pool } from '../config/database';
import { parseLimit } from '../middleware/validation';

const router = Router();

// ----- CONFIG -----
router.get('/config', async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select daily_enabled, daily_hour_utc, daily_retention_days,
                   weekly_enabled, weekly_hour_utc, weekly_retention_days,
                   notification_log_retention_days, updated_at
            from control.report_config where config_id = 1
        `);
        if (result.rows.length === 0) {
            // Henuz seed yapilmamis, defaults dön
            res.json({
                daily_enabled: true,
                daily_hour_utc: 6,
                daily_retention_days: 30,
                weekly_enabled: true,
                weekly_hour_utc: 6,
                weekly_retention_days: 90,
                notification_log_retention_days: 14,
                updated_at: null,
            });
            return;
        }
        res.json(result.rows[0]);
    } catch (err) { next(err); }
});

router.patch('/config', async (req, res, next) => {
    try {
        const b = req.body || {};

        // Validation — UI'dan gelir ama yine de sınırla
        const dailyHour = b.daily_hour_utc !== undefined
            ? Math.max(0, Math.min(23, Number(b.daily_hour_utc))) : null;
        const weeklyHour = b.weekly_hour_utc !== undefined
            ? Math.max(0, Math.min(23, Number(b.weekly_hour_utc))) : null;
        const dailyRet = b.daily_retention_days !== undefined
            ? Math.max(1, Math.min(3650, Number(b.daily_retention_days))) : null;
        const weeklyRet = b.weekly_retention_days !== undefined
            ? Math.max(1, Math.min(3650, Number(b.weekly_retention_days))) : null;
        const notifRet = b.notification_log_retention_days !== undefined
            ? Math.max(1, Math.min(3650, Number(b.notification_log_retention_days))) : null;
        const dailyEn = b.daily_enabled !== undefined ? Boolean(b.daily_enabled) : null;
        const weeklyEn = b.weekly_enabled !== undefined ? Boolean(b.weekly_enabled) : null;

        const result = await pool.query(`
            update control.report_config set
              daily_enabled = coalesce($1, daily_enabled),
              daily_hour_utc = coalesce($2, daily_hour_utc),
              daily_retention_days = coalesce($3, daily_retention_days),
              weekly_enabled = coalesce($4, weekly_enabled),
              weekly_hour_utc = coalesce($5, weekly_hour_utc),
              weekly_retention_days = coalesce($6, weekly_retention_days),
              notification_log_retention_days = coalesce($7, notification_log_retention_days)
            where config_id = 1
            returning *
        `, [dailyEn, dailyHour, dailyRet, weeklyEn, weeklyHour, weeklyRet, notifRet]);

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'report_config bulunamadı (V045 uygulanmamış olabilir)' });
            return;
        }
        res.json(result.rows[0]);
    } catch (err) { next(err); }
});

// ----- MANUAL TRIGGER -----
router.post('/trigger/:type', async (req, res, next) => {
    try {
        const reportType = req.params.type;
        if (reportType !== 'weekly' && reportType !== 'daily') {
            res.status(400).json({ error: 'Geçersiz rapor tipi (daily | weekly)' });
            return;
        }
        const requestedBy = (req as any).user?.username || (req as any).user?.email || 'ui';
        const result = await pool.query(
            `insert into control.report_trigger (report_type, requested_by)
             values ($1, $2)
             returning trigger_id, report_type, status, requested_at`,
            [reportType, requestedBy]
        );
        res.status(202).json(result.rows[0]);
    } catch (err) { next(err); }
});

router.get('/triggers', async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select trigger_id, report_type, requested_by, requested_at,
                   started_at, completed_at, status, report_id, error_message
            from control.report_trigger
            order by requested_at desc
            limit 20
        `);
        res.json(result.rows);
    } catch (err) { next(err); }
});

// ----- HISTORY -----
router.get('/history', async (req, res, next) => {
    try {
        const reportType = req.query.type as string | undefined; // daily | weekly
        const limit = parseLimit(req.query.limit, 100);

        const params: any[] = [];
        let where = 'where 1=1';
        if (reportType === 'daily' || reportType === 'weekly') {
            params.push(reportType);
            where += ` and report_type = $${params.length}`;
        }
        params.push(limit);

        const result = await pool.query(
            `select report_id, report_type, generated_at, title,
                    sent_status, channels_count, recipients_json,
                    length(body) as body_length,
                    error_message
             from ops.report_history
             ${where}
             order by generated_at desc
             limit $${params.length}`,
            params
        );
        res.json(result.rows);
    } catch (err) { next(err); }
});

router.get('/history/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (Number.isNaN(id)) {
            res.status(400).json({ error: 'Geçersiz id' });
            return;
        }
        const result = await pool.query(
            `select * from ops.report_history where report_id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Rapor bulunamadı' });
            return;
        }
        res.json(result.rows[0]);
    } catch (err) { next(err); }
});

router.delete('/history/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (Number.isNaN(id)) {
            res.status(400).json({ error: 'Geçersiz id' });
            return;
        }
        const result = await pool.query(
            `delete from ops.report_history where report_id = $1 returning report_id`,
            [id]
        );
        if (result.rowCount === 0) {
            res.status(404).json({ error: 'Rapor bulunamadı' });
            return;
        }
        res.json({ ok: true, deleted_id: id });
    } catch (err) { next(err); }
});

export default router;
