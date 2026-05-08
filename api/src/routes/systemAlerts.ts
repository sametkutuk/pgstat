import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

// Alert metadata — her alert kodunun kategorisi, açıklaması, eşik bilgisi
// Collector'daki SystemAlertMetadata'nın JS karşılığı
const ALERT_METADATA: Record<string, { label: string; category: string; thresholdUnit: string | null; thresholdDesc: string | null; severity: string; description: string }> = {
    connection_failure: { label: 'Bağlantı Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, severity: 'critical', description: 'Instance\'a bağlantı kurulamadığında tetiklenir' },
    authentication_failure: { label: 'Auth Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, severity: 'critical', description: 'Şifre/auth doğrulaması başarısız' },
    permission_denied: { label: 'Yetki Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, severity: 'error', description: 'pg_monitor yetkisi eksik' },
    extension_missing: { label: 'Extension Eksik', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, severity: 'warning', description: 'pg_stat_statements yüklü değil' },
    secret_ref_error: { label: 'Secret Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, severity: 'critical', description: 'Şifre dosyası/env çözümlenemedi' },
    bootstrap_failed: { label: 'Bootstrap Hatası', category: 'connectivity', thresholdUnit: null, thresholdDesc: null, severity: 'error', description: 'Instance bootstrap aşamasında kırıldı' },
    stale_data: { label: 'Veri Toplama Durdu', category: 'collection', thresholdUnit: null, thresholdDesc: null, severity: 'warning', description: 'Uzun süredir metrik toplanamıyor' },
    stats_reset_detected: { label: 'Stats Reset', category: 'collection', thresholdUnit: null, thresholdDesc: null, severity: 'info', description: 'pg_stat_statements reset edildi' },
    high_connection_usage: { label: 'Bağlantı Doluyor', category: 'performance', thresholdUnit: 'percent', thresholdDesc: 'Bağlantı kullanım oranı (%)', severity: 'warning', description: 'numbackends / max_connections oranı eşik üstü' },
    long_running_query: { label: 'Uzun Sorgu', category: 'performance', thresholdUnit: 'seconds', thresholdDesc: 'Sorgu süresi (saniye)', severity: 'warning', description: 'Eşik süreyi aşan aktif sorgu' },
    lock_contention: { label: 'Kilit Bekleme', category: 'performance', thresholdUnit: 'seconds', thresholdDesc: 'Lock bekleme süresi (saniye)', severity: 'warning', description: 'Kilit bekleme zinciri tespit edildi' },
    high_temp_files: { label: 'Temp File Yüksek', category: 'performance', thresholdUnit: 'count', thresholdDesc: 'Temp file sayısı/saat', severity: 'warning', description: 'Sorgular sort/hash için disk kullanıyor' },
    high_temp_files_daily: { label: 'Günlük Temp File', category: 'performance', thresholdUnit: 'count', thresholdDesc: 'Temp file sayısı/24s', severity: 'warning', description: 'Son 24 saatte temp file sayısı yüksek' },
    high_temp_sqls_daily: { label: 'Temp-heavy SQL', category: 'performance', thresholdUnit: 'count', thresholdDesc: '100MB+ temp yazan SQL sayısı/24s', severity: 'warning', description: 'Son 24 saatte çok sayıda SQL diske temp yazıyor' },
    idle_in_tx_time_high: { label: 'Idle in Tx Yüksek', category: 'performance', thresholdUnit: 'percent', thresholdDesc: 'Idle in tx oranı (%)', severity: 'warning', description: 'Idle in transaction süresi yüksek' },
    high_bloat_ratio: { label: 'Bloat Yüksek', category: 'index_table', thresholdUnit: 'percent', thresholdDesc: 'Dead tuple oranı (%)', severity: 'info', description: 'Tablo dead tuple oranı yüksek' },
    index_suspect_missing: { label: 'Index Gerekiyor', category: 'index_table', thresholdUnit: 'ratio', thresholdDesc: 'Seq/Idx scan oranı (×)', severity: 'warning', description: 'Seq scan/idx scan oranı çok yüksek' },
    index_unused: { label: 'Kullanılmayan Index', category: 'index_table', thresholdUnit: null, thresholdDesc: null, severity: 'info', description: '30 gün tam gözlemde idx_scan = 0; boyut sadece bilgi' },
    index_invalid: { label: 'Invalid Index', category: 'index_table', thresholdUnit: null, thresholdDesc: null, severity: 'warning', description: 'Index invalid veya not-ready durumda' },
    replication_lag: { label: 'Replikasyon Gecikmesi', category: 'replication', thresholdUnit: 'MB', thresholdDesc: 'Max lag (MB)', severity: 'warning', description: 'Streaming replication gecikmesi' },
    replication_slot_inactive: { label: 'Inactive Slot', category: 'replication', thresholdUnit: 'MB', thresholdDesc: 'Min slot lag (MB)', severity: 'warning', description: 'Inactive replication slot WAL tutuyor' },
    job_partial_failure: { label: 'Job Kısmen Başarısız', category: 'job', thresholdUnit: null, thresholdDesc: null, severity: 'warning', description: 'Bir job içinde bazı instance\'lar başarısız' },
    job_failed: { label: 'Job Başarısız', category: 'job', thresholdUnit: null, thresholdDesc: null, severity: 'error', description: 'Job tamamen başarısız' },
    advisory_lock_skip: { label: 'Lock Skip', category: 'job', thresholdUnit: null, thresholdDesc: null, severity: 'info', description: 'Önceki run henüz bitmedi' },
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
                } : { is_enabled: true, threshold_value: null, cooldown_minutes: 60 },
                overrides: (g?.overrides || []).map((o: any) => ({
                    instance_pk: o.instance_pk,
                    display_name: o.display_name,
                    is_enabled: o.is_enabled,
                    threshold_value: o.threshold_value,
                    cooldown_minutes: o.cooldown_minutes,
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
        const { is_enabled, threshold_value, cooldown_minutes } = req.body;

        await pool.query(
            `insert into control.system_alert_config (alert_code, instance_pk, is_enabled, threshold_value, cooldown_minutes, updated_at, updated_by)
       values ($1, null, $2, $3, $4, now(), 'admin')
       on conflict (alert_code) where instance_pk is null
       do update set is_enabled = $2, threshold_value = $3, cooldown_minutes = $4, updated_at = now(), updated_by = 'admin'`,
            [alert_code, is_enabled, threshold_value || null, cooldown_minutes || 60]
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
        const { is_enabled, threshold_value, cooldown_minutes } = req.body;

        await pool.query(
            `insert into control.system_alert_config (alert_code, instance_pk, is_enabled, threshold_value, cooldown_minutes, updated_at, updated_by)
       values ($1, $2, $3, $4, $5, now(), 'admin')
       on conflict (alert_code, instance_pk) where instance_pk is not null
       do update set is_enabled = $3, threshold_value = $4, cooldown_minutes = $5, updated_at = now(), updated_by = 'admin'`,
            [alert_code, instance_pk, is_enabled, threshold_value || null, cooldown_minutes || 60]
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

export default router;
