package com.pgstat.collector.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * ops.report_history — gonderilen rapor kayitlari.
 * UI'dan listelenir, retention'a gore otomatik temizlenir.
 */
@Repository
public class ReportHistoryRepository {

    private final JdbcTemplate jdbc;

    public ReportHistoryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Yeni rapor kaydi ekler.
     *
     * @param reportType    'daily' veya 'weekly'
     * @param title         rapor basligi
     * @param body          rapor govdesi (markdown)
     * @param recipientsJson kanal listesi JSON ('[{"id":1,"type":"email"}, ...]')
     * @param sentStatus    'sent' / 'failed' / 'partial'
     * @param channelsCount basariyla gonderilen kanal sayisi
     * @param errorMessage  hata varsa kisa aciklama
     * @return olusturulan report_id
     */
    public long insert(String reportType, String title, String body,
                       String recipientsJson, String sentStatus,
                       int channelsCount, String errorMessage) {
        return jdbc.queryForObject("""
            insert into ops.report_history
              (report_type, title, body, recipients_json, sent_status, channels_count, error_message)
            values (?, ?, ?, ?::jsonb, ?, ?, ?)
            returning report_id
            """, Long.class,
            reportType, title, body, recipientsJson, sentStatus, channelsCount, errorMessage);
    }

    /**
     * Belirli gunden eski raporlari siler.
     *
     * @param days retention gunu (kac gun saklanacak)
     * @return silinen satir sayisi
     */
    public int purgeOlderThan(int days) {
        return jdbc.update(
            "delete from ops.report_history where generated_at < now() - make_interval(days => ?)",
            days);
    }
}
