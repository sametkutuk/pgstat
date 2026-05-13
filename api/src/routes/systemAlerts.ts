import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

// Alert metadata — her alert kodunun kategorisi, açıklaması, eşik bilgisi
// Collector'daki SystemAlertMetadata'nın JS karşılığı
// windowDesc: null ise UI'da window input gosterilmez (pencere kavrami olmayan alert)
const ALERT_METADATA: Record<string, { label: string; category: string; thresholdUnit: string | null; thresholdDesc: string | null; windowDesc: string | null; severity: string; description: string }> = {
    connection_failure: { label: 'Bağlantı Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'critical', description: 'Instance\'a bağlantı kurulamadığında tetiklenir' },
    authentication_failure: { label: 'Auth Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'critical', description: 'Şifre/auth doğrulaması başarısız' },
    permission_denied: { label: 'Yetki Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'error', description: 'pg_monitor yetkisi eksik' },
    extension_missing: { label: 'Extension Eksik', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'warning', description: 'pg_stat_statements yüklü değil' },
    secret_ref_error: { label: 'Secret Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'critical', description: 'Şifre dosyası/env çözümlenemedi' },
    bootstrap_failed: { label: 'Bootstrap Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'error', description: 'Instance bootstrap aşamasında kırıldı' },
    stale_data: { label: 'Veri Toplama Durdu', category: 'collection', thresholdUnit: null, thresholdDesc: null, windowDesc: 'Veri kaç dakikadır gelmiyorsa tetikle', severity: 'warning', description: 'Uzun süredir metrik toplanamıyor' },
    stats_reset_detected: { label: 'Stats Reset', category: 'collection', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'info', description: 'pg_stat_statements reset edildi' },
    high_connection_usage: { label: 'Bağlantı Doluyor', category: 'performance', thresholdUnit: 'percent', thresholdDesc: 'Bağlantı kullanım oranı (%)', windowDesc: null, severity: 'warning', description: 'numbackends / max_connections oranı eşik üstü' },
    long_running_query: { label: 'Uzun Sorgu', category: 'performance', thresholdUnit: 'seconds', thresholdDesc: 'Sorgu süresi (saniye)', windowDesc: null, severity: 'warning', description: 'Eşik süreyi aşan aktif sorgu' },
    lock_contention: { label: 'Kilit Bekleme', category: 'performance', thresholdUnit: 'seconds', thresholdDesc: 'Lock bekleme süresi (saniye)', windowDesc: null, severity: 'warning', description: 'Kilit bekleme zinciri tespit edildi' },
    high_temp_files: { label: 'Temp File Yüksek', category: 'performance', thresholdUnit: 'count', thresholdDesc: 'Pencere içindeki temp file sayısı', windowDesc: 'Eval penceresi (dakika)', severity: 'warning', description: 'Sorgular sort/hash için disk kullanıyor' },
    high_temp_files_daily: { label: 'Günlük Temp File', category: 'performance', thresholdUnit: 'count', thresholdDesc: 'Pencere içindeki temp file sayısı', windowDesc: 'Eval penceresi (dakika)', severity: 'warning', description: 'Pencere içinde temp file sayısı yüksek' },
    high_temp_sqls_daily: { label: 'Temp-heavy SQL', category: 'performance', thresholdUnit: 'count', thresholdDesc: '100MB+ temp yazan SQL sayısı', windowDesc: 'Eval penceresi (dakika)', severity: 'warning', description: 'Pencere içinde çok sayıda SQL diske temp yazıyor' },
    idle_in_tx_time_high: { label: 'Idle in Tx Yüksek', category: 'performance', thresholdUnit: 'percent', thresholdDesc: 'Idle in tx oranı (%)', windowDesc: 'Eval penceresi (dakika)', severity: 'warning', description: 'Idle in transaction süresi yüksek' },
    high_bloat_ratio: { label: 'Bloat Yüksek', category: 'index_table', thresholdUnit: 'percent', thresholdDesc: 'Dead tuple oranı (%)', windowDesc: null, severity: 'info', description: 'Tablo dead tuple oranı yüksek' },
    index_suspect_missing: { label: 'Index Gerekiyor', category: 'index_table', thresholdUnit: 'ratio', thresholdDesc: 'Seq/Idx scan oranı (×)', windowDesc: 'Eval penceresi (dakika)', severity: 'warning', description: 'Seq scan/idx scan oranı çok yüksek' },
    index_unused: { label: 'Kullanılmayan Index', category: 'index_table', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'info', description: '30 gün tam gözlemde idx_scan = 0; boyut sadece bilgi' },
    index_invalid: { label: 'Invalid Index', category: 'index_table', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'warning', description: 'Index invalid veya not-ready durumda' },
    replication_lag: { label: 'Replikasyon Gecikmesi', category: 'replication', thresholdUnit: 'MB', thresholdDesc: 'Max lag (MB)', windowDesc: null, severity: 'warning', description: 'Streaming replication gecikmesi' },
    replication_slot_inactive: { label: 'Inactive Slot', category: 'replication', thresholdUnit: 'MB', thresholdDesc: 'Min slot lag (MB)', windowDesc: 'Slot kaç dakikadır inactive', severity: 'warning', description: 'Inactive replication slot WAL tutuyor' },
    job_partial_failure: { label: 'Job Kısmen Başarısız', category: 'job', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'warning', description: 'Bir job içinde bazı instance\'lar başarısız' },
    job_failed: { label: 'Job Başarısız', category: 'job', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'error', description: 'Job tamamen başarısız' },
    advisory_lock_skip: { label: 'Lock Skip', category: 'job', thresholdUnit: null, thresholdDesc: null, windowDesc: null, severity: 'info', description: 'Önceki run henüz bitmedi' },
};

// GET /api/system-alerts/config — Tüm alert kodları + config + override'lar
router.get('/config', async (_req, res, next) => {
    try {
        const configs = await pool.query(
            `select c.*, i.display_name
       from control.system_alert_config c
       left join control.instance_inventory i on i.instance_pk = c.instance_pk
       order by c.alert_code, c.instance_pk nulls first`
        );

        // Grupla: alert_code → { global, overrides[] }
        const result: any[] = [];
        const grouped: Record<string, { global: any; overrides: any[] }> = {};

        for (const row of configs.rows) {
            if (!grouped[row.alert_code]) {
                grouped[row.alert_code] = { global: null, overrides: [] };
            }
            if (row.instance_pk === null) {
                grouped[row.alert_code].global = row;
            } else {
                grouped[row.alert_code].overrides.push(row);
            }
        }

        // Metadata ile birleştir
        for (const [code, meta] of Object.entries(ALERT_METADATA)) {
            const g = grouped[code];
            result.push({
                alert_code: code,
                ...meta,
                global: g?.global ? {
                    is_enabled: g.global.is_enabled,
                    threshold_value: g.global.threshold_value,
                    cooldown_minutes: g.global.cooldown_minutes,
                    window_minutes: g.global.window_minutes,
                    is_event_type: g.global.is_event_type === true,
                    include_in_daily_report: g.global.include_in_daily_report !== false,
                } : { is_enabled: true, threshold_value: null, cooldown_minutes: 60, window_minutes: null,
                      is_event_type: false, include_in_daily_report: true },
                overrides: (g?.overrides || []).map((o: any) => ({
                    instance_pk: o.instance_pk,
                    display_name: o.display_name,
                    is_enabled: o.is_enabled,
                    threshold_value: o.threshold_value,
                    cooldown_minutes: o.cooldown_minutes,
                    window_minutes: o.window_minutes,
                })),
            });
        }

        res.json(result);
    } catch (err) {
        next(err);
    }
});

// PUT /api/system-alerts/config/:alert_code — Global config güncelle
router.put('/config/:alert_code', async (req, res, next) => {
    try {
        const { alert_code } = req.params;
        const { is_enabled, threshold_value, cooldown_minutes, window_minutes,
                is_event_type, include_in_daily_report } = req.body;

        await pool.query(
            `insert into control.system_alert_config
                (alert_code, instance_pk, is_enabled, threshold_value, cooldown_minutes,
                 window_minutes, is_event_type, include_in_daily_report, updated_at, updated_by)
             values ($1, null, $2, $3, $4, $5, $6, $7, now(), 'admin')
             on conflict (alert_code) where instance_pk is null
             do update set is_enabled = $2, threshold_value = $3, cooldown_minutes = $4,
                           window_minutes = $5,
                           is_event_type = coalesce($6, control.system_alert_config.is_event_type),
                           include_in_daily_report = coalesce($7, control.system_alert_config.include_in_daily_report),
                           updated_at = now(), updated_by = 'admin'`,
            [alert_code, is_enabled, threshold_value || null, cooldown_minutes || 60,
             window_minutes ?? null,
             is_event_type ?? null,
             include_in_daily_report ?? null]
        );

        res.json({ message: 'Config güncellendi. 60 saniye içinde etkili olacak.' });
    } catch (err) {
        next(err);
    }
});

// PUT /api/system-alerts/config/:alert_code/instances/:instance_pk — Instance override
router.put('/config/:alert_code/instances/:instance_pk', async (req, res, next) => {
    try {
        const { alert_code, instance_pk } = req.params;
        const { is_enabled, threshold_value, cooldown_minutes, window_minutes } = req.body;

        await pool.query(
            `insert into control.system_alert_config (alert_code, instance_pk, is_enabled, threshold_value, cooldown_minutes, window_minutes, updated_at, updated_by)
       values ($1, $2, $3, $4, $5, $6, now(), 'admin')
       on conflict (alert_code, instance_pk) where instance_pk is not null
       do update set is_enabled = $3, threshold_value = $4, cooldown_minutes = $5, window_minutes = $6, updated_at = now(), updated_by = 'admin'`,
            [alert_code, instance_pk, is_enabled, threshold_value || null, cooldown_minutes || 60, window_minutes ?? null]
        );

        res.json({ message: 'Instance override kaydedildi.' });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/system-alerts/config/:alert_code/instances/:instance_pk — Override sil
router.delete('/config/:alert_code/instances/:instance_pk', async (req, res, next) => {
    try {
        const { alert_code, instance_pk } = req.params;

        await pool.query(
            'delete from control.system_alert_config where alert_code = $1 and instance_pk = $2',
            [alert_code, instance_pk]
        );

        res.json({ message: 'Override silindi, global default geçerli.' });
    } catch (err) {
        next(err);
    }
});

// =========================================================================
// Siklik ayarlari (__system_intervals meta-satiri)
// =========================================================================

// GET /api/system-alerts/intervals
router.get('/intervals', async (_req, res, next) => {
    try {
        const r = await pool.query(
            `select threshold_value as acute_seconds,
                    cooldown_minutes as frequent_seconds,
                    window_minutes as daily_hours
             from control.system_alert_config
             where alert_code = '__system_intervals' and instance_pk is null`
        );
        if (r.rows.length === 0) {
            return res.json({ acute_seconds: 5, frequent_seconds: 900, daily_hours: 24 });
        }
        res.json(r.rows[0]);
    } catch (err) {
        next(err);
    }
});

// PUT /api/system-alerts/intervals
router.put('/intervals', async (req, res, next) => {
    try {
        const { acute_seconds, frequent_seconds, daily_hours } = req.body;
        // Aralık kontrolu
        if (acute_seconds < 5 || acute_seconds > 300)
            return res.status(400).json({ error: 'acute_seconds 5-300 arasi olmali' });
        if (frequent_seconds < 60 || frequent_seconds > 3600)
            return res.status(400).json({ error: 'frequent_seconds 60-3600 arasi olmali' });
        if (daily_hours < 1 || daily_hours > 168)
            return res.status(400).json({ error: 'daily_hours 1-168 arasi olmali' });

        await pool.query(
            `insert into control.system_alert_config
                (alert_code, instance_pk, is_enabled, threshold_value, cooldown_minutes,
                 window_minutes, updated_at, updated_by)
             values ('__system_intervals', null, true, $1, $2, $3, now(), 'admin')
             on conflict (alert_code) where instance_pk is null
             do update set threshold_value = $1, cooldown_minutes = $2, window_minutes = $3,
                           updated_at = now(), updated_by = 'admin'`,
            [acute_seconds, frequent_seconds, daily_hours]
        );
        res.json({ message: 'Sıklık ayarları güncellendi. 60 saniye içinde etkili olacak.' });
    } catch (err) {
        next(err);
    }
});

export default router;
