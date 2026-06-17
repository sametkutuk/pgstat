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
    private static final int TELEGRAM_SAFE_MESSAGE_LENGTH = 3900;

    private final JdbcTemplate jdbc;
    private final HttpClient httpClient;

    private record TelegramSendResult(boolean ok, String chatId, Long firstMessageId) {}

    private record TelegramPostResult(boolean ok, Long messageId) {}

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
    public void notifyIfNeeded(long alertId, String alertKey, String alertCode, String severity,
                                Long instancePk, String title, String message) {
        try {
            String alertSource = loadAlertSource(alertId);
            boolean systemAlert = "system".equals(alertSource);
            // "Resolved: " prefix'li title -> cozulme bildirimi (source fark etmez).
            // Cozulme bildirimleri cooldown'dan muaf (asagida cooldownMinutes=0).
            boolean isResolvedNotice = title != null && title.startsWith("Resolved:");
            boolean systemResolved = systemAlert && isResolvedNotice;
            if (systemAlert) {
                if (systemResolved && !"critical".equals(severity)) return;
                if (!systemResolved && !"critical".equals(severity) && !"warning".equals(severity)) return;
            }

            // Spam koruma — TEK MANTIK:
            // "Cooldown icinde, ayni veya daha yuksek severity'de SENT kayit varsa atla."
            // - Severity yukselirse otomatik bypass (daha yuksek kayit yok -> suppress yok)
            // - Cooldown gectikten sonra ayni severity tekrar bildirim alir (periyodik hatirlatma)
            // - Hem actionable hem user_defined_rule ayni yolu kullanir, cooldown kaynagi farkli.
            try {
                int cooldownMinutes = isResolvedNotice ? 0 : resolveCooldownMinutes(alertId, alertKey, alertCode, instancePk);
                if (cooldownMinutes > 0) {
                    String rank = "(case %s when 'info' then 0 when 'warning' then 1 " +
                        "when 'error' then 2 when 'critical' then 3 " +
                        "when 'emergency' then 4 else 0 end)";
                    Long suppressing = jdbc.queryForObject(
                        "select count(*) from ops.notification_log nl " +
                        "where nl.alert_id = ? and nl.status = 'sent' " +
                        "  and nl.sent_at >= now() - (? * interval '1 minute') " +
                        "  and " + rank.formatted("nl.severity") + " >= " + rank.formatted("?"),
                        Long.class, alertId, cooldownMinutes, severity);
                    if (suppressing != null && suppressing > 0) {
                        log.debug("Spam koruma: alert_id={} cooldown {} dk icinde ayni/yuksek severity var",
                            alertId, cooldownMinutes);
                        return;
                    }
                }
            } catch (Exception ignore) {
                // Spam sorgusu hata verirse engellemeyelim, bildirim gitsin
            }

            // Snooze kontrolü
            if (!isResolvedNotice && isAlertSnoozed(alertKey, alertCode, instancePk)) {
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
                    sendToChannel(channel, alertId, alertKey, alertCode, severity, instancePk, title, message);
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
            boolean ok = switch (type) {
                case "email" -> sendEmail(config, testTitle, testMessage, "info");
                case "teams" -> sendTeams(config, testTitle, testMessage, "info");
                case "telegram" -> sendTelegram(config, testTitle, testMessage, "info");
                case "webhook" -> sendWebhook(config, 0, "info", null, testTitle, testMessage);
                default -> {
                    yield false;
                }
            };
            return ok ? "OK" : "Gonderim basarisiz (collector log'una bakin)";
        } catch (Exception e) {
            return "Hata: " + e.getMessage();
        }
    }

    private String loadAlertSource(long alertId) {
        try {
            return jdbc.queryForObject(
                "select coalesce(alert_source, 'legacy') from ops.alert where alert_id = ?",
                String.class,
                alertId
            );
        } catch (Exception e) {
            return "legacy";
        }
    }

    // =========================================================================
    // Kanal yönlendirme
    // =========================================================================

    private void sendToChannel(Map<String, Object> channel, long alertId, String alertKey, String alertCode,
                                String severity, Long instancePk, String title, String message) {
        String type = (String) channel.get("channel_type");
        String config = channel.get("config") != null ? channel.get("config").toString() : "{}";

        boolean ok = false;
        String error = null;
        try {
            ok = switch (type) {
                case "email"    -> sendEmail(config, title, message, severity);
                case "teams"    -> sendTeams(config, title, message, severity);
                case "telegram" -> {
                    TelegramSendResult result = sendTelegramWithResult(config, title, message, severity);
                    if (result.ok() && result.firstMessageId() != null) {
                        rememberTelegramMessage(result.chatId(), result.firstMessageId(), alertId, alertKey, alertCode, instancePk);
                    }
                    yield result.ok();
                }
                case "webhook"  -> sendWebhook(config, alertId, severity, instancePk, title, message);
                default -> {
                    log.warn("Desteklenmeyen kanal tipi: {}", type);
                    yield false;
                }
            };
        } catch (Exception e) {
            error = e.getMessage();
            log.error("Bildirim gonderme istisna channel_id={} type={}: {}",
                channel.get("channel_id"), type, error);
        }

        // notification_log'a GERCEK durumu yaz — sent veya failed.
        // Daha onceki bug: HTTP 4xx sessizce yutuluyor + her durumda 'sent' yaziliyordu.
        String status = ok ? "sent" : "failed";
        try {
            jdbc.update(
                "insert into ops.notification_log (alert_id, channel_id, channel_type, status, severity, error_message, sent_at) " +
                "values (?, ?, ?, ?, ?, ?, now())",
                alertId, channel.get("channel_id"), type, status, severity, error);
        } catch (Exception e) {
            log.debug("Notification log yazma hatasi: {}", e.getMessage());
        }
    }

    // =========================================================================
    // Email
    // =========================================================================

    private boolean sendEmail(String configJson, String title, String message, String severity) {
        if (mailSender == null) {
            log.warn("Email gönderilemedi: SMTP ayarları yapılandırılmamış (PGSTAT_SMTP_HOST)");
            return false;
        }
        // config: {"recipients": [...], "from": "...", "subject_template": "...", "body_template": "..."}
        // Template'lerde {{title}} {{message}} {{severity}} {{severity_upper}} kullanilabilir.
        Map<String, Object> config = parseJson(configJson);
        @SuppressWarnings("unchecked")
        List<String> recipients = (List<String>) config.get("recipients");
        if (recipients == null || recipients.isEmpty()) {
            log.warn("Email kanalında alıcı tanımlı değil");
            return false;
        }

        String from = config.containsKey("from") ? (String) config.get("from") : "pgstat@localhost";

        // Subject — kullanıcı subject_template verdi mi?
        String subjectTpl = (String) config.get("subject_template");
        String subject = (subjectTpl != null && !subjectTpl.isBlank())
            ? renderEmailTpl(subjectTpl, title, message, severity)
            : "[pgstat " + severity.toUpperCase() + "] " + title;

        // Body — kullanıcı body_template verdi mi?
        String bodyTpl = (String) config.get("body_template");
        String body = (bodyTpl != null && !bodyTpl.isBlank())
            ? renderEmailTpl(bodyTpl, title, message, severity)
            : message + "\n\n---\npgstat Monitoring System";

        SimpleMailMessage mail = new SimpleMailMessage();
        mail.setFrom(from);
        mail.setTo(recipients.toArray(new String[0]));
        mail.setSubject(subject);
        mail.setText(body);

        try {
            mailSender.send(mail);
            log.info("Email gönderildi: {} alıcıya, konu: {}", recipients.size(), subject);
            return true;
        } catch (Exception e) {
            log.error("Email gonderme hatasi: {}", e.getMessage());
            return false;
        }
    }

    /** Email subject/body template render — basit {{var}} replace */
    private String renderEmailTpl(String tpl, String title, String message, String severity) {
        return tpl
            .replace("{{title}}", title != null ? title : "")
            .replace("{{message}}", message != null ? message : "")
            .replace("{{severity}}", severity != null ? severity : "info")
            .replace("{{severity_upper}}", severity != null ? severity.toUpperCase() : "INFO");
    }

    // =========================================================================
    // Microsoft Teams (Incoming Webhook)
    // =========================================================================

    private boolean sendTeams(String configJson, String title, String message, String severity) {
        Map<String, Object> config = parseJson(configJson);
        String webhookUrl = (String) config.get("webhook_url");
        if (webhookUrl == null || webhookUrl.isBlank()) {
            log.warn("Teams kanalında webhook_url tanımlı değil");
            return false;
        }

        // Kullanıcı theme_color verdi mi? Yoksa severity'ye göre default
        String color = (String) config.get("theme_color");
        if (color == null || color.isBlank()) {
            color = switch (severity) {
                case "critical", "emergency" -> "FF0000";
                case "warning" -> "FFA500";
                default -> "0078D4";
            };
        }

        // Kullanıcı tam custom card_template verdi mi? Verdiyse onu kullan.
        // Template'te {{title}}, {{message}}, {{severity}}, {{severity_upper}}, {{color}} placeholder'lari geçerli.
        String cardTpl = (String) config.get("card_template");
        String payload;
        if (cardTpl != null && !cardTpl.isBlank()) {
            payload = cardTpl
                .replace("{{title}}", escapeJson(title))
                .replace("{{message}}", escapeJson(message))
                .replace("{{severity}}", severity)
                .replace("{{severity_upper}}", severity.toUpperCase())
                .replace("{{color}}", color);
        } else {
            // Default Adaptive Card
            payload = """
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
        }

        boolean ok = postWebhook(webhookUrl, payload);
        if (ok) log.info("Teams bildirimi gönderildi: {}", title);
        return ok;
    }

    // =========================================================================
    // Telegram (Bot API)
    // =========================================================================

    private boolean sendTelegram(String configJson, String title, String message, String severity) {
        return sendTelegramWithResult(configJson, title, message, severity).ok();
    }

    private TelegramSendResult sendTelegramWithResult(String configJson, String title, String message, String severity) {
        Map<String, Object> config = parseJson(configJson);
        String botToken = (String) config.get("bot_token");
        String chatId = config.get("chat_id") != null ? config.get("chat_id").toString() : null;

        if (botToken == null || chatId == null) {
            log.warn("Telegram kanalında bot_token veya chat_id tanımlı değil");
            return new TelegramSendResult(false, chatId, null);
        }

        // Cozulme bildirimi mi? (title "Resolved: " ile baslar) -> yesil + kisa.
        boolean isResolved = title != null && title.startsWith("Resolved:");

        String emoji;
        String header;
        if (isResolved) {
            emoji = "🟢";
            header = "Cozuldu";
        } else {
            emoji = switch (severity) {
                case "emergency" -> "🚨🚨";
                case "critical" -> "🔴";
                case "warning" -> "🟡";
                default -> "🔵";
            };
            header = "pgstat " + severity.toUpperCase();
        }

        // Mobil-dostu kompakt format: tek baslik satiri + satir-satir govde.
        // Cozulmede "Resolved: " prefix'ini govdeden cikar (header zaten Cozuldu diyor).
        // HTML parse_mode: sadece &, <, > escape gerekli. Markdown'dan daha guvenilir.
        String cleanTitle = isResolved ? title.substring("Resolved:".length()).trim() : title;
        String text = emoji + " <b>" + escapeHtml(header) + "</b>\n"
                + escapeHtml(cleanTitle);
        // Cozulme bildiriminde uzun detay (message) gosterme — mobilde gurultu.
        if (!isResolved && message != null && !message.isBlank()) {
            text += "\n" + escapeHtml(formatMessageBody(message));
        }

        String url = "https://api.telegram.org/bot" + botToken + "/sendMessage";
        List<String> parts = splitForTelegram(text, TELEGRAM_SAFE_MESSAGE_LENGTH);

        boolean allOk = true;
        Long firstMessageId = null;
        for (int i = 0; i < parts.size(); i++) {
            String part = parts.get(i);
            if (parts.size() > 1) {
                part = part + "\n\n(" + (i + 1) + "/" + parts.size() + ")";
            }
            String payload = """
                {"chat_id": "%s", "text": "%s", "parse_mode": "HTML", "disable_web_page_preview": true}
                """.formatted(chatId, escapeJson(part));
            TelegramPostResult postResult = postTelegram(url, payload);
            if (i == 0) firstMessageId = postResult.messageId();
            allOk = allOk && postResult.ok();
        }
        if (allOk) log.info("Telegram bildirimi gonderildi: chat_id={}, parts={}", chatId, parts.size());
        return new TelegramSendResult(allOk, chatId, firstMessageId);
    }

    /** HTML parse_mode icin Telegram'da yeterli — sadece 3 karakter. */
    private String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /**
     * Alert govdesini mobil-dostu satir-satir formata cevirir.
     * - Mesaj zaten "•" iceriyorsa (idle-tx gibi onceden formatli) DOKUNMA.
     * - "key=value, key=value. Aciklama cumlesi." formatini:
     *     • key: value
     *     • key: value
     *     Aciklama cumlesi.
     *   seklinde bullet'lar.
     * Pattern'e uymayan mesaj oldugu gibi birakilir (guvenli fallback).
     */
    private String formatMessageBody(String message) {
        if (message == null || message.isBlank()) return message;
        if (message.contains("•") || message.contains("\n")) return message; // zaten formatli

        // Ilk cumle sonuna kadar key=value listesi, sonrasi serbest aciklama.
        // "... (%96). Wraparound..." gibi -> ilk ". " bolme noktasi.
        String kvPart = message;
        String tail = "";
        int dot = message.indexOf(". ");
        if (dot > 0) {
            kvPart = message.substring(0, dot);
            tail = message.substring(dot + 2).trim();
        } else if (message.endsWith(".")) {
            kvPart = message.substring(0, message.length() - 1);
        }

        // kvPart "k=v, k=v" mi? En az bir "=" yoksa bullet'lama, oldugu gibi don.
        if (!kvPart.contains("=")) return message;

        StringBuilder sb = new StringBuilder();
        for (String part : kvPart.split(",\\s*")) {
            String p = part.trim();
            if (p.isEmpty()) continue;
            int eq = p.indexOf('=');
            if (eq > 0) {
                sb.append("• ").append(p.substring(0, eq).trim())
                  .append(": ").append(p.substring(eq + 1).trim()).append("\n");
            } else {
                sb.append("• ").append(p).append("\n");
            }
        }
        if (!tail.isEmpty()) sb.append(tail);
        return sb.toString().trim();
    }

    private List<String> splitForTelegram(String text, int maxLen) {
        if (text == null) return List.of("");
        if (text.length() <= maxLen) return List.of(text);

        List<String> parts = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        String[] blocks = text.split("(?<=\\n\\n)", -1);

        for (String block : blocks) {
            if (block.length() > maxLen) {
                flushTelegramPart(parts, current);
                parts.addAll(splitLongTelegramBlock(block, maxLen));
            } else if (current.length() + block.length() > maxLen) {
                flushTelegramPart(parts, current);
                current.append(block);
            } else {
                current.append(block);
            }
        }

        flushTelegramPart(parts, current);
        return parts.isEmpty() ? List.of("") : parts;
    }

    private void flushTelegramPart(List<String> parts, StringBuilder current) {
        if (current.length() == 0) return;
        parts.add(current.toString());
        current.setLength(0);
    }

    private List<String> splitLongTelegramBlock(String text, int maxLen) {
        List<String> parts = new ArrayList<>();
        int start = 0;
        while (start < text.length()) {
            int end = Math.min(start + maxLen, text.length());
            if (end < text.length()) {
                int boundary = findTelegramSplitBoundary(text, start, end, maxLen);
                if (boundary > start) end = boundary;
            }
            parts.add(text.substring(start, end));
            start = end;
        }
        return parts;
    }

    private int findTelegramSplitBoundary(String text, int start, int end, int maxLen) {
        int minUseful = start + Math.min(200, maxLen / 2);
        int[] candidates = new int[] {
            text.lastIndexOf("\n\n", end),
            text.lastIndexOf("\n", end),
            text.lastIndexOf(". ", end),
            text.lastIndexOf("; ", end),
            text.lastIndexOf(", ", end),
            text.lastIndexOf(" ", end)
        };

        for (int candidate : candidates) {
            if (candidate > minUseful) {
                return avoidHtmlTagCut(text, start, candidate + 1);
            }
        }

        return avoidHtmlTagCut(text, start, end);
    }

    private int avoidHtmlTagCut(String text, int start, int end) {
        int lastLt = text.lastIndexOf('<', end - 1);
        int lastGt = text.lastIndexOf('>', end - 1);
        if (lastLt > lastGt && lastLt > start) return lastLt;
        return end;
    }

    private TelegramPostResult postTelegram(String url, String jsonPayload) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
                    .timeout(Duration.ofSeconds(15))
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 400) {
                log.error("Telegram hatasi: HTTP {} - {}", response.statusCode(), response.body());
                return new TelegramPostResult(false, null);
            }
            // HTTP 200 olsa bile Telegram yaniti "ok":false donebilir (nadiren).
            // Bu durumda message_id parse etme — yanlis bir sayiyi id sanmayalim
            // ve gonderimi basarisiz say (message_map'e bozuk kayit girmesin).
            if (!isTelegramOk(response.body())) {
                log.warn("Telegram yaniti ok=false: {}", response.body());
                return new TelegramPostResult(false, null);
            }
            return new TelegramPostResult(true, extractTelegramMessageId(response.body()));
        } catch (Exception e) {
            log.error("Telegram gonderme hatasi: {}", e.getMessage());
            return new TelegramPostResult(false, null);
        }
    }

    /** Telegram yanitinda "ok":true var mi? (HTTP 200 + ok:false olabilir.) */
    private boolean isTelegramOk(String responseBody) {
        if (responseBody == null || responseBody.isBlank()) return false;
        return Pattern.compile("\"ok\"\\s*:\\s*true").matcher(responseBody).find();
    }

    private Long extractTelegramMessageId(String responseBody) {
        if (responseBody == null || responseBody.isBlank()) return null;
        Matcher matcher = Pattern.compile("\"message_id\"\\s*:\\s*(\\d+)").matcher(responseBody);
        if (!matcher.find()) return null;
        try {
            return Long.parseLong(matcher.group(1));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private void rememberTelegramMessage(String chatId, Long messageId, long alertId, String alertKey,
                                          String alertCode, Long instancePk) {
        if (chatId == null || messageId == null || alertKey == null || alertKey.isBlank()) return;
        try {
            jdbc.update("""
                insert into control.telegram_message_map
                    (chat_id, message_id, alert_id, alert_key, alert_code, instance_pk, sent_at)
                values (?, ?, ?, ?, ?, ?, now())
                on conflict (chat_id, message_id) do update
                set alert_id = excluded.alert_id,
                    alert_key = excluded.alert_key,
                    alert_code = excluded.alert_code,
                    instance_pk = excluded.instance_pk,
                    sent_at = excluded.sent_at
                """,
                chatId, messageId, alertId, alertKey, alertCode, instancePk);
        } catch (Exception e) {
            log.debug("Telegram message map yazilamadi: {}", e.getMessage());
        }
    }

    // =========================================================================
    // Generic Webhook (body template destekli)
    // =========================================================================

    private boolean sendWebhook(String configJson, long alertId, String severity,
                                 Long instancePk, String title, String message) {
        Map<String, Object> config = parseJson(configJson);
        String url = (String) config.get("url");
        if (url == null || url.isBlank()) {
            log.warn("Webhook kanalında url tanımlı değil");
            return false;
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
                return false;
            }
            log.info("Webhook bildirimi gönderildi: {} {}", method, url);
            return true;
        } catch (Exception e) {
            log.error("Webhook gönderme hatası: {}", e.getMessage());
            return false;
        }
    }

    // =========================================================================
    // Yardımcı metodlar
    // =========================================================================
    // Rapor gonderimi (gunluk/haftalik)
    // =========================================================================

    /**
     * Rapor metnini belirtilen kanal tipine gonderir.
     * Alert bildiriminden farkli: severity yok, sadece baslik + body.
     */
    public void sendReport(String channelType, String configJson, String title, String body) {
        boolean ok = switch (channelType) {
            case "email"    -> sendEmail(configJson, title, body, "info");
            case "teams"    -> sendTeams(configJson, title, body, "info");
            case "telegram" -> sendTelegram(configJson, title, body, "info");
            case "webhook"  -> sendWebhook(configJson, 0, "info", null, title, body);
            default -> {
                log.debug("Rapor gonderimi desteklenmeyen kanal: {}", channelType);
                yield false;
            }
        };
        if (!ok) log.warn("Rapor gonderilemedi kanal={}", channelType);
    }

    // =========================================================================

    private boolean postWebhook(String url, String jsonPayload) {
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
                return false;
            }
            return true;
        } catch (Exception e) {
            log.error("Webhook gönderme hatası: {}", e.getMessage());
            return false;
        }
    }

    private List<Map<String, Object>> loadEnabledChannels(String severity) {
        // 5 severity seviyesi: info < warning < error < critical < emergency.
        // Onceki bug: 'error' siralamada yoktu -> error severity alert'leri (job_failed gibi)
        // bircok kanal filtresinden gecemiyordu.
        return jdbc.queryForList(
            "select channel_id, channel_name, channel_type, config::text as config, min_severity " +
            "from control.notification_channel " +
            "where is_enabled = true " +
            "  and (min_severity is null or " +
            "       case min_severity " +
            "         when 'info' then 0 when 'warning' then 1 " +
            "         when 'error' then 2 when 'critical' then 3 " +
            "         when 'emergency' then 4 else 0 end " +
            "       <= case ? " +
            "         when 'info' then 0 when 'warning' then 1 " +
            "         when 'error' then 2 when 'critical' then 3 " +
            "         when 'emergency' then 4 else 0 end)",
            severity);
    }

    private boolean isAlertSnoozed(String alertKey, String alertCode, Long instancePk) {
        try {
            Integer count = jdbc.queryForObject(
                """
                select count(*)
                from control.alert_snooze
                where (snooze_until is null or snooze_until > now())
                  and (
                    (alert_key is not null and alert_key = ?)
                    or (alert_code is not null and alert_code = ? and (instance_pk is null or instance_pk = ?))
                    or (alert_key is null and alert_code is null and (instance_pk is null or instance_pk = ?))
                  )
                """,
                Integer.class, alertKey, alertCode, instancePk, instancePk);
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

    /**
     * Cooldown dakikasini cozumler:
     *   user_defined_rule -> alert_rule.cooldown_minutes (per-rule)
     *   diger -> 15 (temporary default)
     *
     * @return cooldown dakika; 0 -> spam koruma yok
     */
    private int resolveCooldownMinutes(long alertId, String alertKey, String alertCode, Long instancePk) {
        try {
            if ("user_defined_rule".equals(alertCode)) {
                // Per-rule cooldown (alert.rule_id -> alert_rule.cooldown_minutes)
                try {
                    Integer perRule = jdbc.queryForObject(
                        "select ar.cooldown_minutes from ops.alert a " +
                        "join control.alert_rule ar on ar.rule_id = a.rule_id " +
                        "where a.alert_id = ?",
                        Integer.class, alertId);
                    if (perRule != null && perRule > 0) return perRule;
                } catch (Exception ignore) {}
                return 15;
            }
            return 15;
        } catch (Exception e) {
            return 15;
        }
    }
}
