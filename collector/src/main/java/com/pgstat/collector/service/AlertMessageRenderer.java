package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Alert başlık ve mesaj şablonlarını render eder.
 *
 * Lookup sırası:
 *   1. Kullanıcı tanımlı kural (rule.title_template / rule.message_template)
 *   2. control.alert_message_template tablosundaki alert_code default'u
 *   3. Çağıranın verdiği fallback string
 *
 * Şablon sözdizimi: Mustache benzeri {{placeholder}} — tek geçişli replace.
 * Bilinmeyen placeholder boş string ile değiştirilir (kırılma yapmaz).
 *
 * Şablon cache'i 60 saniyede bir yenilenir; UI'dan yapılan template güncellemeleri
 * en geç bir dakika içinde devreye girer.
 */
@Service
public class AlertMessageRenderer {

    private static final Logger log = LoggerFactory.getLogger(AlertMessageRenderer.class);
    private static final Pattern PLACEHOLDER = Pattern.compile("\\{\\{\\s*([a-zA-Z0-9_]+)\\s*}}");
    private static final DateTimeFormatter TS_FMT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ZoneId.systemDefault());

    private final JdbcTemplate jdbc;

    /** alert_code → [titleTemplate, messageTemplate] */
    private final Map<String, String[]> defaultTemplates = new ConcurrentHashMap<>();

    public AlertMessageRenderer(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @PostConstruct
    void init() {
        reloadDefaults();
    }

    /** Default şablonları DB'den yükler — 60 saniyede bir tekrar eder. */
    @Scheduled(fixedDelay = 60_000)
    public void reloadDefaults() {
        try {
            List<Map<String, Object>> rows = jdbc.queryForList(
                "select alert_code, title_template, message_template " +
                "from control.alert_message_template");
            Map<String, String[]> next = new HashMap<>();
            for (Map<String, Object> r : rows) {
                next.put((String) r.get("alert_code"), new String[]{
                    (String) r.get("title_template"),
                    (String) r.get("message_template"),
                });
            }
            defaultTemplates.clear();
            defaultTemplates.putAll(next);
            log.debug("Alert mesaj şablonları yüklendi: {} kayıt", next.size());
        } catch (Exception e) {
            log.warn("Alert şablonları yüklenemedi: {}", e.getMessage());
        }
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Kullanıcı kuralı için render — rule içindeki template > default > fallback.
     *
     * @param rule          alert_rule satırı (Map)
     * @param ctx           placeholder değerleri (instance, value, threshold vs.)
     * @param fallbackTitle template çözülemezse kullanılacak başlık
     * @param fallbackMsg   template çözülemezse kullanılacak mesaj
     * @return [renderedTitle, renderedMessage]
     */
    public String[] renderForRule(Map<String, Object> rule, Map<String, Object> ctx,
                                   String fallbackTitle, String fallbackMsg) {
        Map<String, Object> fullCtx = enrichContext(ctx);

        String titleTpl = strOrNull(rule.get("title_template"));
        String msgTpl   = strOrNull(rule.get("message_template"));

        if (titleTpl == null || msgTpl == null) {
            String[] def = defaultTemplates.get("user_defined_rule");
            if (def != null) {
                if (titleTpl == null) titleTpl = def[0];
                if (msgTpl == null) msgTpl = def[1];
            }
        }

        String title = titleTpl != null ? render(titleTpl, fullCtx) : fallbackTitle;
        String msg   = msgTpl   != null ? render(msgTpl,   fullCtx) : fallbackMsg;
        return new String[]{title, msg};
    }

    /**
     * Sistem alert kodu için render — default template > fallback.
     */
    public String[] renderForCode(String alertCode, Map<String, Object> ctx,
                                   String fallbackTitle, String fallbackMsg) {
        Map<String, Object> fullCtx = enrichContext(ctx);
        String[] def = defaultTemplates.get(alertCode);
        String title = (def != null && def[0] != null) ? render(def[0], fullCtx) : fallbackTitle;
        String msg   = (def != null && def[1] != null) ? render(def[1], fullCtx) : fallbackMsg;
        return new String[]{title, msg};
    }

    /**
     * Düz template + context render (UI önizleme için API'den çağrılabilir).
     */
    public String render(String template, Map<String, Object> ctx) {
        if (template == null || template.isEmpty()) return "";
        Matcher m = PLACEHOLDER.matcher(template);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String key = m.group(1);
            Object val = ctx.get(key);
            String replacement = val == null ? "" : formatValue(val);
            m.appendReplacement(out, Matcher.quoteReplacement(replacement));
        }
        m.appendTail(out);
        return out.toString();
    }

    // =========================================================================
    // Yardımcılar
    // =========================================================================

    /**
     * Context'e türetilmiş alanlar ekler: severity_emoji, severity_upper,
     * timestamps vb. Çağıran tarafta her seferinde manuel doldurmamak için.
     */
    private Map<String, Object> enrichContext(Map<String, Object> ctx) {
        Map<String, Object> out = new HashMap<>(ctx == null ? Map.of() : ctx);

        // severity türevleri
        Object sev = out.get("severity");
        String sevStr = sev != null ? sev.toString().toLowerCase(Locale.ROOT) : "info";
        out.putIfAbsent("severity", sevStr);
        out.putIfAbsent("severity_upper", sevStr.toUpperCase(Locale.ROOT));
        out.putIfAbsent("severity_emoji", switch (sevStr) {
            case "emergency" -> "🚨";
            case "critical"  -> "🔴";
            case "error"     -> "🟠";
            case "warning"   -> "🟡";
            default          -> "🔵";
        });

        // timestamp türevleri
        if (!out.containsKey("started_at")) {
            out.put("started_at", TS_FMT.format(Instant.now()));
        }
        if (!out.containsKey("now")) {
            out.put("now", TS_FMT.format(Instant.now()));
        }

        // duration_minutes — started_at varsa hesapla
        if (!out.containsKey("duration_minutes") && out.get("started_at") instanceof String s) {
            try {
                LocalDateTime started = LocalDateTime.parse(s, TS_FMT);
                long mins = Duration.between(started, LocalDateTime.now()).toMinutes();
                out.put("duration_minutes", mins);
            } catch (Exception ignore) {
                // başarısızsa atla
            }
        }

        return out;
    }

    /**
     * Sayısal değerleri kısa biçime sokar (BigDecimal'da gereksiz ondalıkları kırpar).
     */
    private String formatValue(Object val) {
        if (val instanceof BigDecimal bd) {
            return bd.stripTrailingZeros().setScale(
                Math.max(0, Math.min(2, bd.scale())), RoundingMode.HALF_UP
            ).toPlainString();
        }
        return val.toString();
    }

    private String strOrNull(Object o) {
        if (o == null) return null;
        String s = o.toString().trim();
        return s.isEmpty() ? null : s;
    }
}
