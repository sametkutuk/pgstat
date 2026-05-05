package com.pgstat.collector.repository;

import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.Map;

/**
 * control.report_config — singleton (config_id = 1) rapor ayarlari.
 * Kullanici UI'dan: gunluk/haftalik enable, saat (UTC) ve retention gunu duzenler.
 */
@Repository
public class ReportConfigRepository {

    private final JdbcTemplate jdbc;

    public ReportConfigRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Default config (DB'ye henuz kayit yoksa veya hata olursa fallback). */
    public static Map<String, Object> defaults() {
        return Map.of(
            "daily_enabled", true,
            "daily_hour_utc", 6,
            "daily_retention_days", 30,
            "weekly_enabled", true,
            "weekly_hour_utc", 6,
            "weekly_retention_days", 90,
            "notification_log_retention_days", 14
        );
    }

    /**
     * Aktif config'i doner. Hata olursa default deger ile devam eder
     * (rapor sistemi kritik degil, hata durumunda safe defaults).
     */
    public Map<String, Object> get() {
        try {
            return jdbc.queryForMap(
                "select daily_enabled, daily_hour_utc, daily_retention_days, " +
                "       weekly_enabled, weekly_hour_utc, weekly_retention_days, " +
                "       notification_log_retention_days, updated_at " +
                "from control.report_config where config_id = 1");
        } catch (EmptyResultDataAccessException e) {
            return defaults();
        } catch (Exception e) {
            return defaults();
        }
    }
}
