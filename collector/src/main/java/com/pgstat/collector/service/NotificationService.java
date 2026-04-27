package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Alert oluştuğunda bildirim gönderen servis.
 * Desteklenen kanallar: Email, Microsoft Teams (webhook), Telegram (Bot API).
 *
 * Kanal tanımları control.notification_channel tablosundan okunur.
 * Her alert upsert sonrası çağrılır — sadece yeni alert'ler (occurrence_count=1)
 * veya severity yükselmeleri için bildirim gönderilir.
 */
@Service
public class NotificationService {

    private static final Logger log = LoggerFactory.getLogger(NotificationService.class);

    private final JdbcTemplate jdbc;
    private final HttpClient httpClient;

    /** JavaMailSender opsiyonel — SMTP ayarları yoksa null kalır */
    @Autowired(required = false)
    private JavaMailSender mailSender;

    public NotificationService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    /**
     * Alert oluşturulduktan/güncellendikten sonra çağrılır.
     * Snooze ve bakım penceresi kontrolü yapılır, uygunsa bildirim gönderilir.
     */
    public void notifyIfNeeded(long alertId, String alertKey, String severity,
                                Long instancePk, String title, String message) {
        try {
            // Spam koruma: ayni alert_id tekrar tetiklendiginde bildirim gonderme.
            // Sadece YENI alert (notification_log'da kayit yok) veya severity
            // yukseldi (eski yuksek severity zaten gonderildi) ise bildirim git.
            try {
                Long previousNotifications = jdbc.queryForObject(
                    "select count(*) from ops.notification_log where alert_id = ? and status = 'sent'",
                    Long.class, alertId);
                if (previousNotifications != null && previousNotifications > 0) {
                    // Bu alert icin daha onceden bildirim gonderildi.
                    // Severity yukseldiyse tekrar gonder, yoksa atla.
                    Long higherSeverityNotifications = jdbc.queryForObject(
                        "select count(*) from ops.notification_log nl " +
                        "join ops.alert a on a.alert_id = nl.alert_id " +
                        "where nl.alert_id = ? and nl.status = 'sent' " +
                        "  and (case a.severity when 'info' then 0 when 'warning' then 1 " +
                        "                       when 'error' then 2 when 'critical' then 3 " +
                        "                       when 'emergency' then 4 else 0 end) >= " +
                        "      (case ? when 'info' then 0 when 'warning' then 1 " +
                        "              when 'error' then 2 when 'critical' then 3 " +
                        "              when 'emergency' then 4 else 0 end)",
                        Long.class, alertId, severity);
                    if (higherSeverityNotifications != null && higherSeverityNotifications > 0) {
                        log.debug("Spam koruma: alert_id={} ayni/dusuk severity zaten gonderilmis, atlandi",
                            alertId);
                        return;
                    }
                }
            } catch (Exception ignore) {
                // Log query hatasi olursa devam et, yine bildirim gonder
            }

            // Snooze kontrolü
            if (isAlertSnoozed(alertKey, instancePk)) {
                log.debug("Alert snoozed, bildirim atlanıyor: {}", alertKey);
                return;
            }

            // Bakım penceresi kontrolü
            if (isInMaintenanceWindow(instancePk)) {
                log.debug("Bakım penceresi aktif, bildirim atlanıyor: {}", alertKey);
                return;
            }

            // Aktif kanalları yükle
            List<Map<String, Object>> channels = loadEnabledChannels(severity);
            if (channels.isEmpty()) return;

            for (Map<String, Object> channel : channels) {
                try {
                    sendToChannel(channel, alertId, severity, instancePk, title, message);
                } catch (Exception e) {
                    log.error("Bildirim gönderme hatası channel_id={}: {}",
                            channel.get("channel_id"), e.getMessage());
                }
            }
        } catch (Exception e) {
            log.error("Bildirim kontrolü hatası alert_id={}: {}", alertId, e.getMessage());
        }
    }

    /**
     * Test bildirimi gönderir (UI'dan tetiklenir).
     */
    public String sendTest(Map<String, Object> channel) {
        String type = (String) channel.get("channel_type");
        String config = channel.get("config") != null ? channel.get("config").toString() : "{}";
        String testTitle = "pgstat Test Bildirimi";
        String testMessage = "Bu bir test bildirimidir. Kanal: " + channel.get("channel_name");

        try {
            switch (type) {
                case "email" -> sendEmail(config, testTitle, testMessage, "info");
                case "teams" -> sendTeams(config, testTitle, testMessage, "info");
                case "telegram" -> sendTelegram(config, testTitle, testMessage, "info");
                case "webhook" -> sendWebhook(config, 0, "info", null, testTitle, testMessage);
                default -> { return "Desteklenmeyen kanal tipi: " + type; }
            }
            return "OK";
        } catch (Exception e) {
            return "Hata: " + e.getMessage();
        }
    }

    // =========================================================================
    // Kanal yönlendirme
    // =========================================================================

    private void sendToChannel(Map<String, Object> channel, long alertId, String severity,
                                Long instancePk, String title, String message) {
        String type = (String) channel.get("channel_type");
        String config = channel.get("config") != null ? channel.get("config").toString() : "{}";

        switch (type) {
            case "email"    -> sendEmail(config, title, message, severity);
            case "teams"    -> sendTeams(config, title, message, severity);
            case "telegram" -> sendTelegram(config, title, message, severity);
            case "webhook"  -> sendWebhook(config, alertId, severity, instancePk, title, message);
            default -> log.warn("Desteklenmeyen kanal tipi: {}", type);
        }

        // Gönderim logla
        try {
            jdbc.update(
                "insert into ops.notification_log (alert_id, channel_id, channel_type, status, sent_at) " +
                "values (?, ?, ?, 'sent', now())",
                alertId, channel.get("channel_id"), type);
        } catch (Exception e) {
            log.debug("Notification log yazma hatası: {}", e.getMessage());
        }
    }

    // =========================================================================
    // Email
    // =========================================================================

    private void sendEmail(String configJson, String title, String message, String severity) {
        if (mailSender == null) {
            log.warn("Email gönderilemedi: SMTP ayarları yapılandırılmamış (PGSTAT_SMTP_HOST)");
            return;
        }
        // config: {"recipients": ["a@b.com", "c@d.com"], "from": "pgstat@example.com"}
        Map<String, Object> config = parseJson(configJson);
        @SuppressWarnings("unchecked")
        List<String> recipients = (List<String>) config.get("recipients");
        if (recipients == null || recipients.isEmpty()) {
            log.warn("Email kanalında alıcı tanımlı değil");
            return;
        }

        String from = config.containsKey("from") ? (String) config.get("from") : "pgstat@localhost";

        SimpleMailMessage mail = new SimpleMailMessage();
        mail.setFrom(from);
        mail.setTo(recipients.toArray(new String[0]));
        mail.setSubject("[pgstat " + severity.toUpperCase() + "] " + title);
        mail.setText(message + "\n\n---\npgstat Monitoring System");

        mailSender.send(mail);
        log.info("Email gönderildi: {} alıcıya, konu: {}", recipients.size(), title);
    }

    // =========================================================================
    // Microsoft Teams (Incoming Webhook)
    // =========================================================================

    private void sendTeams(String configJson, String title, String message, String severity) {
        Map<String, Object> config = parseJson(configJson);
        String webhookUrl = (String) config.get("webhook_url");
        if (webhookUrl == null || webhookUrl.isBlank()) {
            log.warn("Teams kanalında webhook_url tanımlı değil");
            return;
        }

        String color = switch (severity) {
            case "critical", "emergency" -> "FF0000";
            case "warning" -> "FFA500";
            default -> "0078D4";
        };

        // Adaptive Card formatı (Teams webhook)
        String payload = """
            {
                "@type": "MessageCard",
                "@context": "http://schema.org/extensions",
                "themeColor": "%s",
                "summary": "%s",
                "sections": [{
                    "activityTitle": "🔔 pgstat Alert — %s",
                    "activitySubtitle": "%s",
                    "facts": [
                        {"name": "Severity", "value": "%s"},
                        {"name": "Detay", "value": "%s"}
                    ],
                    "markdown": true
                }]
            }
            """.formatted(color, escapeJson(title), severity.toUpperCase(),
                escapeJson(title), severity, escapeJson(message));

        postWebhook(webhookUrl, payload);
        log.info("Teams bildirimi gönderildi: {}", title);
    }

    // =========================================================================
    // Telegram (Bot API)
    // =========================================================================

    private void sendTelegram(String configJson, String title, String message, String severity) {
        Map<String, Object> config = parseJson(configJson);
        String botToken = (String) config.get("bot_token");
        String chatId = config.get("chat_id") != null ? config.get("chat_id").toString() : null;

        if (botToken == null || chatId == null) {
            log.warn("Telegram kanalında bot_token veya chat_id tanımlı değil");
            return;
        }

        String emoji = switch (severity) {
            case "emergency" -> "🚨🚨";
            case "critical" -> "🔴";
            case "warning" -> "🟡";
            default -> "🔵";
        };

        String text = emoji + " *pgstat Alert — " + severity.toUpperCase() + "*\n\n"
                + "*" + escapeMarkdown(title) + "*\n"
                + escapeMarkdown(message);

        String url = "https://api.telegram.org/bot" + botToken + "/sendMessage";
        String payload = """
            {"chat_id": "%s", "text": "%s", "parse_mode": "Markdown", "disable_web_page_preview": true}
            """.formatted(chatId, escapeJson(text));

        postWebhook(url, payload);
        log.info("Telegram bildirimi gönderildi: chat_id={}", chatId);
    }

    // =========================================================================
    // Generic Webhook (body template destekli)
    // =========================================================================

    private void sendWebhook(String configJson, long alertId, String severity,
                              Long instancePk, String title, String message) {
        Map<String, Object> config = parseJson(configJson);
        String url = (String) config.get("url");
        if (url == null || url.isBlank()) {
            log.warn("Webhook kanalında url tanımlı değil");
            return;
        }

        String method = config.containsKey("method") ? (String) config.get("method") : "POST";
        String bodyTemplate = config.containsKey("body_template") ? (String) config.get("body_template") : null;

        // Headers
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/json");
        if (config.containsKey("headers")) {
            Object hdrs = config.get("headers");
            if (hdrs instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> hdrMap = (Map<String, Object>) hdrs;
                hdrMap.forEach((k, v) -> headers.put(k, String.valueOf(v)));
            } else if (hdrs instanceof String) {
                // JSON string olarak gelmiş olabilir
                Map<String, Object> parsed = parseJson((String) hdrs);
                parsed.forEach((k, v) -> headers.put(k, String.valueOf(v)));
            }
        }

        // Body: template varsa değişkenleri değiştir, yoksa default JSON
        String body;
        if (bodyTemplate != null && !bodyTemplate.isBlank()) {
            body = bodyTemplate
                    .replace("{{alert_id}}", String.valueOf(alertId))
                    .replace("{{severity}}", severity != null ? severity : "info")
                    .replace("{{title}}", title != null ? title : "")
                    .replace("{{message}}", message != null ? escapeJson(message) : "")
                    .replace("{{instance_pk}}", instancePk != null ? String.valueOf(instancePk) : "null")
                    .replace("{{timestamp}}", java.time.Instant.now().toString());
        } else {
            body = """
                {"alert_id": %d, "severity": "%s", "title": "%s", "message": "%s", "instance_pk": %s, "timestamp": "%s"}
                """.formatted(alertId, severity, escapeJson(title), escapeJson(message),
                    instancePk != null ? String.valueOf(instancePk) : "null",
                    java.time.Instant.now().toString());
        }

        try {
            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(15));

            headers.forEach(reqBuilder::header);

            switch (method.toUpperCase()) {
                case "PUT"   -> reqBuilder.PUT(HttpRequest.BodyPublishers.ofString(body));
                case "PATCH" -> reqBuilder.method("PATCH", HttpRequest.BodyPublishers.ofString(body));
                default      -> reqBuilder.POST(HttpRequest.BodyPublishers.ofString(body));
            }

            HttpResponse<String> response = httpClient.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 400) {
                log.error("Webhook hatası: HTTP {} — {}", response.statusCode(), response.body());
            } else {
                log.info("Webhook bildirimi gönderildi: {} {}", method, url);
            }
        } catch (Exception e) {
            log.error("Webhook gönderme hatası: {}", e.getMessage());
        }
    }

    // =========================================================================
    // Yardımcı metodlar
    // =========================================================================

    private void postWebhook(String url, String jsonPayload) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
                    .timeout(Duration.ofSeconds(15))
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 400) {
                log.error("Webhook hatası: HTTP {} — {}", response.statusCode(), response.body());
            }
        } catch (Exception e) {
            log.error("Webhook gönderme hatası: {}", e.getMessage());
        }
    }

    private List<Map<String, Object>> loadEnabledChannels(String severity) {
        return jdbc.queryForList(
            "select channel_id, channel_name, channel_type, config::text as config, min_severity " +
            "from control.notification_channel " +
            "where is_enabled = true " +
            "  and (min_severity is null or " +
            "       case min_severity " +
            "         when 'info' then 0 when 'warning' then 1 " +
            "         when 'critical' then 2 when 'emergency' then 3 else 0 end " +
            "       <= case ? " +
            "         when 'info' then 0 when 'warning' then 1 " +
            "         when 'critical' then 2 when 'emergency' then 3 else 0 end)",
            severity);
    }

    private boolean isAlertSnoozed(String alertKey, Long instancePk) {
        try {
            Integer count = jdbc.queryForObject(
                "select count(*) from control.alert_snooze " +
                "where snooze_until > now() " +
                "  and (instance_pk is null or instance_pk = ?)",
                Integer.class, instancePk);
            return count != null && count > 0;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isInMaintenanceWindow(Long instancePk) {
        if (instancePk == null) return false;
        try {
            Integer count = jdbc.queryForObject(
                "select count(*) from control.maintenance_window " +
                "where is_enabled = true " +
                "  and (instance_pks is null or ? = any(instance_pks)) " +
                "  and (day_of_week is null or extract(dow from now())::int = any(day_of_week)) " +
                "  and start_time <= localtime and end_time >= localtime",
                Integer.class, instancePk);
            return count != null && count > 0;
        } catch (Exception e) {
            return false;
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseJson(String json) {
        // Basit JSON parse — Jackson olmadan çalışır
        // Sadece flat key-value ve string array destekler (notification config için yeterli)
        Map<String, Object> result = new HashMap<>();
        if (json == null || json.isBlank()) return result;
        try {
            String trimmed = json.trim();
            if (trimmed.startsWith("{")) trimmed = trimmed.substring(1);
            if (trimmed.endsWith("}")) trimmed = trimmed.substring(0, trimmed.length() - 1);

            // Key-value çiftlerini bul
            Pattern kvPattern = Pattern.compile("\"([^\"]+)\"\\s*:\\s*(\"[^\"]*\"|\\[[^]]*]|[^,}]+)");
            Matcher m = kvPattern.matcher(trimmed);
            while (m.find()) {
                String key = m.group(1);
                String val = m.group(2).trim();
                if (val.startsWith("[")) {
                    // Array parse
                    List<String> list = new ArrayList<>();
                    Pattern arrItem = Pattern.compile("\"([^\"]+)\"");
                    Matcher am = arrItem.matcher(val);
                    while (am.find()) list.add(am.group(1));
                    result.put(key, list);
                } else if (val.startsWith("\"") && val.endsWith("\"")) {
                    result.put(key, val.substring(1, val.length() - 1));
                } else {
                    result.put(key, val);
                }
            }
        } catch (Exception e) {
            log.warn("JSON parse hatası: {}", e.getMessage());
        }
        return result;
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
    }

    private String escapeMarkdown(String s) {
        if (s == null) return "";
        return s.replace("_", "\\_").replace("*", "\\*").replace("[", "\\[").replace("`", "\\`");
    }
}
