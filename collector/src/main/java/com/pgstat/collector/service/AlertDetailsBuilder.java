package com.pgstat.collector.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Alert details_json inşa eden builder.
 * Tüm alert'ler için standart JSON formatı üretir.
 *
 * Kullanım:
 *   String json = new AlertDetailsBuilder()
 *       .setKind("temp_files")
 *       .addContext("work_mem", "4096")
 *       .addContext("suggested", "64MB")
 *       .addRecord(Map.of("query_text", "SELECT...", "current_val", 1500))
 *       .build();
 *
 * Üretilen format:
 *   {"kind":"temp_files","context":{...},"records":[{...}]}
 *
 * UI tarafı (AlertDetails component) bu formatı otomatik render eder:
 * - kind → özel panel seçimi (temp_files, connection_diag, usage_summary, data_quality)
 * - context → key-value bilgi kartı
 * - records[] → tablo satırları (query_text, current_val, prev_val, change_pct, label)
 */
public class AlertDetailsBuilder {

    private String kind;
    private final Map<String, Object> context = new LinkedHashMap<>();
    private final List<Map<String, Object>> records = new ArrayList<>();

    /** Alert tipini belirler — UI'da özel panel seçimi için */
    public AlertDetailsBuilder setKind(String kind) {
        this.kind = kind;
        return this;
    }

    /** Genel context bilgisi ekler (key-value) */
    public AlertDetailsBuilder addContext(String key, Object value) {
        if (value != null) context.put(key, value);
        return this;
    }

    /** Bir record (satır) ekler — UI'da tablo olarak gösterilir */
    public AlertDetailsBuilder addRecord(Map<String, Object> record) {
        if (record != null && !record.isEmpty()) records.add(record);
        return this;
    }

    /** Birden fazla record ekler */
    public AlertDetailsBuilder addRecords(List<Map<String, Object>> recs) {
        if (recs != null) recs.forEach(this::addRecord);
        return this;
    }

    /** JSON string üretir. Boş ise null döner. */
    public String build() {
        if (kind == null && context.isEmpty() && records.isEmpty()) return null;

        StringBuilder sb = new StringBuilder("{");
        boolean first = true;

        if (kind != null) {
            sb.append("\"kind\":").append(escapeJson(kind));
            first = false;
        }

        if (!context.isEmpty()) {
            if (!first) sb.append(",");
            sb.append("\"context\":{");
            boolean cfirst = true;
            for (Map.Entry<String, Object> e : context.entrySet()) {
                if (!cfirst) sb.append(",");
                sb.append(escapeJson(e.getKey())).append(":");
                appendValue(sb, e.getValue());
                cfirst = false;
            }
            sb.append("}");
            first = false;
        }

        if (!records.isEmpty()) {
            if (!first) sb.append(",");
            sb.append("\"records\":[");
            for (int i = 0; i < records.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append("{");
                boolean rfirst = true;
                for (Map.Entry<String, Object> e : records.get(i).entrySet()) {
                    if (!rfirst) sb.append(",");
                    sb.append(escapeJson(e.getKey())).append(":");
                    appendValue(sb, e.getValue());
                    rfirst = false;
                }
                sb.append("}");
            }
            sb.append("]");
        }

        sb.append("}");
        return sb.toString();
    }

    // =========================================================================
    // JSON yardımcıları
    // =========================================================================

    private void appendValue(StringBuilder sb, Object val) {
        if (val == null) {
            sb.append("null");
        } else if (val instanceof Number) {
            sb.append(val);
        } else if (val instanceof Boolean) {
            sb.append(val);
        } else {
            sb.append(escapeJson(val.toString()));
        }
    }

    /** JSON string escape — tırnak içinde güvenli */
    public static String escapeJson(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 32) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append("\"");
        return sb.toString();
    }
}
