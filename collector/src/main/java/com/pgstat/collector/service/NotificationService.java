package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;

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
    private final JavaMailSender mailSender;
    private final HttpClient httpClient;

    public NotificationService(JdbcTemplate jdbc, JavaMailSender mailSender) {
        this.jdbc = jdbc;
        this.mailSender = mailSender;
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
        try {
            // Spring Boot'un Jackson'ı classpath'te — basit JSON parse
            com.fasterxml.jackson.databind.ObjectMapper om = new com.fasterxml.jackson.databind.ObjectMapper();
            return om.readValue(json, Map.class);
        } catch (Exception e) {
            log.warn("JSON parse hatası: {}", e.getMessage());
            return Map.of();
        }
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
