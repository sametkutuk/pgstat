package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;

/**
 * pgss_epoch_key uretimi ve karsilastirmasi.
 *
 * Format: <system_identifier>_<pg_major>_<stats_reset_iso8601_utc>
 * Ornek: "7289462832894628_17_2026-04-15T10:30:00Z"
 *
 * Epoch degisimi su durumlarda olur:
 * - pg_stat_statements_reset() cagrildi
 * - PostgreSQL yeniden baslatildi (postmaster_start_time degisti)
 * - pg_upgrade ile major versiyon degisti
 *
 * Epoch degistiginde:
 * - In-memory delta cache temizlenir
 * - Ilk sample baseline olarak kaydedilir (delta yazilmaz)
 * - Yeni epoch_key ile statement_series satirlari olusur
 */
@Service
public class EpochManager {

    private static final Logger log = LoggerFactory.getLogger(EpochManager.class);

    private static final DateTimeFormatter ISO_UTC = DateTimeFormatter.ISO_OFFSET_DATE_TIME;

    /**
     * pgss_epoch_key olusturur.
     *
     * @param systemIdentifier PG system identifier (pg_control_system)
     * @param pgMajor          PG major versiyon (17, 16 vb.)
     * @param statsResetAt     pg_stat_statements son reset zamani
     *                         (null ise postmaster start time kullanilir)
     * @param postmasterStartAt postmaster baslama zamani (fallback)
     * @return epoch key string
     */
    public String buildEpochKey(long systemIdentifier, int pgMajor,
                                OffsetDateTime statsResetAt,
                                OffsetDateTime postmasterStartAt) {
        // Reset zamani: pgss stats_reset > postmaster_start_time > "unknown"
        OffsetDateTime effectiveReset = statsResetAt != null ? statsResetAt : postmasterStartAt;
        String resetStr = effectiveReset != null ? effectiveReset.format(ISO_UTC) : "unknown";

        return systemIdentifier + "_" + pgMajor + "_" + resetStr;
    }

    /**
     * Mevcut epoch key ile yeni hesaplanan key'i karsilastirir.
     *
     * @param currentKey  DB'deki kayitli epoch key (null olabilir — ilk baslatma)
     * @param newKey      yeni hesaplanan epoch key
     * @return true ise epoch degismis → delta cache temizlenmeli
     */
    public boolean hasEpochChanged(String currentKey, String newKey) {
        if (currentKey == null) {
            // Ilk baslatma — epoch "degismis" sayilir, baseline alinacak
            log.info("Ilk epoch key ataniyor: {}", newKey);
            return true;
        }

        if (!currentKey.equals(newKey)) {
            log.warn("Epoch degisimi tespit edildi: {} → {}", currentKey, newKey);
            return true;
        }

        return false;
    }
}
