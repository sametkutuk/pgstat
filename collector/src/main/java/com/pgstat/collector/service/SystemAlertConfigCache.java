package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.math.BigDecimal;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Sistem alert konfigürasyonu in-memory cache.
 * 60 saniyede bir DB'den yenilenir.
 *
 * Kullanım:
 *   configCache.isEnabled("high_temp_files", instancePk)
 *   configCache.getThreshold("high_temp_files", instancePk, new BigDecimal("100"))
 *
 * Öncelik sırası: instance override > global config > default (true/hardcoded)
 * Config tablosu boşsa veya satır yoksa → alert aktif (geriye uyumlu).
 */
@Service
public class SystemAlertConfigCache {

    private static final Logger log = LoggerFactory.getLogger(SystemAlertConfigCache.class);

    private final JdbcTemplate jdbc;

    // alert_code → global config
    private volatile Map<String, ConfigEntry> globalConfigs = new ConcurrentHashMap<>();
    // alert_code → (instance_pk → override config)
    private volatile Map<String, Map<Long, ConfigEntry>> instanceOverrides = new ConcurrentHashMap<>();

    public SystemAlertConfigCache(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @PostConstruct
    void init() {
        reload();
    }

    /** 60 saniyede bir DB'den config'i yeniler. */
    @Scheduled(fixedDelay = 60_000)
    public void reload() {
        try {
            List<Map<String, Object>> rows = jdbc.queryForList(
                "select alert_code, instance_pk, is_enabled, threshold_value, cooldown_minutes " +
                "from control.system_alert_config");

            Map<String, ConfigEntry> newGlobal = new HashMap<>();
            Map<String, Map<Long, ConfigEntry>> newOverrides = new HashMap<>();

            for (Map<String, Object> row : rows) {
                String code = (String) row.get("alert_code");
                Object ipk = row.get("instance_pk");
                boolean enabled = Boolean.TRUE.equals(row.get("is_enabled"));
                BigDecimal threshold = row.get("threshold_value") != null
                    ? new BigDecimal(row.get("threshold_value").toString()) : null;
                int cooldown = row.get("cooldown_minutes") != null
                    ? ((Number) row.get("cooldown_minutes")).intValue() : 60;

                ConfigEntry entry = new ConfigEntry(enabled, threshold, cooldown);

                if (ipk == null) {
                    newGlobal.put(code, entry);
                } else {
                    long instancePk = ((Number) ipk).longValue();
                    newOverrides.computeIfAbsent(code, k -> new HashMap<>()).put(instancePk, entry);
                }
            }

            globalConfigs = newGlobal;
            instanceOverrides = newOverrides;
            log.debug("SystemAlertConfig yüklendi: {} global, {} override",
                newGlobal.size(), newOverrides.values().stream().mapToInt(Map::size).sum());
        } catch (Exception e) {
            // Tablo henüz yoksa (V042 uygulanmamış) sessizce geç — default davranış korunur
            log.debug("SystemAlertConfig yüklenemedi (tablo yok olabilir): {}", e.getMessage());
        }
    }

    /**
     * Alert aktif mi? Öncelik: instance override > global > default (true).
     * Config tablosu boşsa veya satır yoksa → true (geriye uyumlu).
     */
    public boolean isEnabled(String alertCode, Long instancePk) {
        // 1. Instance override var mı?
        if (instancePk != null) {
            Map<Long, ConfigEntry> overrides = instanceOverrides.get(alertCode);
            if (overrides != null) {
                ConfigEntry override = overrides.get(instancePk);
                if (override != null) return override.enabled;
            }
        }
        // 2. Global config
        ConfigEntry global = globalConfigs.get(alertCode);
        if (global != null) return global.enabled;
        // 3. Default: aktif (config tablosu boşsa bile çalışır)
        return true;
    }

    /**
     * Eşik değeri. Öncelik: instance override > global > hardcoded default.
     * Eşiği olmayan alert'ler için hardcodedDefault döner.
     */
    public BigDecimal getThreshold(String alertCode, Long instancePk, BigDecimal hardcodedDefault) {
        // 1. Instance override
        if (instancePk != null) {
            Map<Long, ConfigEntry> overrides = instanceOverrides.get(alertCode);
            if (overrides != null) {
                ConfigEntry override = overrides.get(instancePk);
                if (override != null && override.threshold != null) return override.threshold;
            }
        }
        // 2. Global config
        ConfigEntry global = globalConfigs.get(alertCode);
        if (global != null && global.threshold != null) return global.threshold;
        // 3. Hardcoded default
        return hardcodedDefault;
    }

    /**
     * Cooldown süresi (dakika). Bildirim tekrar aralığı.
     */
    public int getCooldownMinutes(String alertCode, Long instancePk) {
        if (instancePk != null) {
            Map<Long, ConfigEntry> overrides = instanceOverrides.get(alertCode);
            if (overrides != null) {
                ConfigEntry override = overrides.get(instancePk);
                if (override != null) return override.cooldownMinutes;
            }
        }
        ConfigEntry global = globalConfigs.get(alertCode);
        if (global != null) return global.cooldownMinutes;
        return 60; // default
    }

    /** İç veri yapısı */
    private record ConfigEntry(boolean enabled, BigDecimal threshold, int cooldownMinutes) {}
}
