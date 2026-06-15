package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.json.JsonParser;
import org.springframework.boot.json.JsonParserFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class TelegramCommandPoller {

    private static final Logger log = LoggerFactory.getLogger(TelegramCommandPoller.class);
    private static final int TELEGRAM_SAFE_MESSAGE_LENGTH = 3900;
    private static final Pattern CONFIG_KV =
        Pattern.compile("\"([^\"]+)\"\\s*:\\s*(\"[^\"]*\"|[^,}]+)");
    private static final Pattern DURATION_PATTERN = Pattern.compile("^(\\d+)([mhd]?)$");

    private final JdbcTemplate jdbc;
    private final HttpClient httpClient;
    private final JsonParser jsonParser;

    private record Command(String action, boolean codeScope, String durationToken, Long snoozeId) {}

    private record ReplyAlert(Long alertId, String alertKey, String alertCode, Long instancePk, String instanceName) {}

    public TelegramCommandPoller(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.jsonParser = JsonParserFactory.getJsonParser();
    }

    @Scheduled(fixedDelay = 10_000L, initialDelay = 30_000L)
    public void poll() {
        List<Map<String, Object>> channels;
        try {
            channels = jdbc.queryForList("""
                select channel_id, channel_name, config::text as config
                from control.notification_channel
                where is_enabled = true and channel_type = 'telegram'
                """);
        } catch (Exception e) {
            log.debug("Telegram channel listesi okunamadi: {}", e.getMessage());
            return;
        }

        for (Map<String, Object> channel : channels) {
            try {
                pollChannel(channel);
            } catch (Exception e) {
                log.debug("Telegram poll hatasi channel={}: {}", channel.get("channel_name"), e.getMessage());
            }
        }
    }

    private void pollChannel(Map<String, Object> channel) throws Exception {
        Map<String, String> config = parseConfig(String.valueOf(channel.get("config")));
        String botToken = config.get("bot_token");
        String chatId = config.get("chat_id");
        if (botToken == null || botToken.isBlank() || chatId == null || chatId.isBlank()) return;

        String botKey = botKey(botToken, chatId);
        long lastUpdateId = loadLastUpdateId(botKey);
        String url = "https://api.telegram.org/bot" + botToken
            + "/getUpdates?offset=" + (lastUpdateId + 1)
            + "&timeout=0";

        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofSeconds(15))
            .GET()
            .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400) {
            log.warn("Telegram getUpdates hatasi: HTTP {} - {}", response.statusCode(), response.body());
            return;
        }

        Map<String, Object> root = jsonParser.parseMap(response.body());
        Object resultObj = root.get("result");
        if (!(resultObj instanceof List<?> updates)) return;

        for (Object updateObj : updates) {
            if (!(updateObj instanceof Map<?, ?> updateMap)) continue;
            Long updateId = toLong(updateMap.get("update_id"));
            if (updateId == null) continue;
            try {
                processUpdate(castMap(updateMap), botToken, chatId);
            } catch (Exception e) {
                log.debug("Telegram update islenemedi update_id={}: {}", updateId, e.getMessage());
            } finally {
                saveLastUpdateId(botKey, updateId);
            }
        }
    }

    private void processUpdate(Map<String, Object> update, String botToken, String configuredChatId) {
        Map<String, Object> message = mapValue(update.get("message"));
        if (message == null) return;

        String chatId = chatId(message);
        if (!configuredChatId.equals(chatId)) return;

        String text = stringValue(message.get("text"));
        Command command = parseCommand(text);
        if (command == null) return;

        if ("report".equals(command.action())) {
            sendSnoozeReport(botToken, configuredChatId);
            return;
        }

        if ("unmute".equals(command.action())) {
            handleUnmute(botToken, configuredChatId, message, command);
            return;
        }

        handleMute(botToken, configuredChatId, message, command);
    }

    private Command parseCommand(String text) {
        if (text == null || text.isBlank()) return null;
        String[] tokens = text.trim().split("\\s+");
        if (tokens.length == 0) return null;
        String name = tokens[0].toLowerCase(Locale.ROOT);
        int at = name.indexOf('@');
        if (at > 0) name = name.substring(0, at);

        if ("/mute".equals(name) || "/sustur".equals(name)) {
            if (tokens.length > 1) {
                String second = tokens[1].toLowerCase(Locale.ROOT);
                if ("report".equals(second) || "rapor".equals(second)) {
                    return new Command("report", false, null, null);
                }
            }
            int idx = 1;
            boolean codeScope = false;
            if (tokens.length > idx) {
                String scope = tokens[idx].toLowerCase(Locale.ROOT);
                if ("code".equals(scope) || "kod".equals(scope)) {
                    codeScope = true;
                    idx++;
                }
            }
            String durationToken = tokens.length > idx ? tokens[idx] : null;
            return new Command("mute", codeScope, durationToken, null);
        }

        if ("/unmute".equals(name) || "/ac".equals(name)) {
            Long snoozeId = tokens.length > 1 ? parseLong(tokens[1]) : null;
            return new Command("unmute", false, null, snoozeId);
        }

        return null;
    }

    private void handleMute(String botToken, String chatId, Map<String, Object> message, Command command) {
        ReplyAlert alert = resolveReplyAlert(chatId, message);
        if (alert == null) {
            sendPlain(botToken, chatId, "Hata: Bu komutu alert mesajina reply olarak gonder.");
            return;
        }
        if (command.codeScope() && (alert.alertCode() == null || alert.alertCode().isBlank())) {
            sendPlain(botToken, chatId, "Hata: Reply edilen alert icin alert_code bulunamadi.");
            return;
        }

        OffsetDateTime until = null;
        if (command.durationToken() != null && !command.durationToken().isBlank()) {
            until = parseUntil(command.durationToken());
            if (until == null) {
                sendPlain(botToken, chatId, "Hata: Sure formati gecersiz. Ornek: 30m, 2h, 1d, 90.");
                return;
            }
        }

        String createdBy = createdBy(message);
        String alertKey = command.codeScope() ? null : alert.alertKey();
        String alertCode = command.codeScope() ? alert.alertCode() : null;
        Long instancePk = command.codeScope() ? null : alert.instancePk();

        Integer snoozeId = jdbc.queryForObject("""
            insert into control.alert_snooze
                (alert_key, alert_code, instance_pk, snooze_until, snooze_reason, created_by)
            values (?, ?, ?, ?, 'telegram', ?)
            returning snooze_id
            """,
            Integer.class, alertKey, alertCode, instancePk, until, createdBy);

        String scope = command.codeScope() ? "kod " + alert.alertCode() : alert.alertKey();
        String durationText = until == null ? "suresiz" : command.durationToken();
        sendPlain(botToken, chatId, "OK: " + alert.instanceName() + " uzerindeki " + scope
            + " " + durationText + " susturuldu. /ac " + snoozeId + " ile acabilirsin.");
    }

    private void handleUnmute(String botToken, String chatId, Map<String, Object> message, Command command) {
        int deleted;
        if (command.snoozeId() != null) {
            deleted = jdbc.update("delete from control.alert_snooze where snooze_id = ?", command.snoozeId());
            sendPlain(botToken, chatId, deleted > 0
                ? "OK: Snooze silindi: " + command.snoozeId()
                : "Bilgi: Bu snooze_id bulunamadi: " + command.snoozeId());
            return;
        }

        ReplyAlert alert = resolveReplyAlert(chatId, message);
        if (alert == null) {
            sendPlain(botToken, chatId, "Hata: /ac komutunu alert mesajina reply olarak gonder veya /ac <snooze_id> kullan.");
            return;
        }

        deleted = jdbc.update("""
            delete from control.alert_snooze
            where (snooze_until is null or snooze_until > now())
              and (
                (alert_key is not null and alert_key = ?)
                or (alert_code is not null and alert_code = ? and (instance_pk is null or instance_pk = ?))
              )
            """,
            alert.alertKey(), alert.alertCode(), alert.instancePk());
        sendPlain(botToken, chatId, deleted > 0
            ? "OK: Reply edilen alert icin " + deleted + " aktif snooze silindi."
            : "Bilgi: Reply edilen alert icin aktif snooze bulunamadi.");
    }

    private void sendSnoozeReport(String botToken, String chatId) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
            select s.snooze_id, s.alert_key, s.alert_code, s.instance_pk,
                   coalesce(i.display_name, '-') as instance_name,
                   s.snooze_until, s.snooze_reason, s.created_by
            from control.alert_snooze s
            left join control.instance_inventory i on i.instance_pk = s.instance_pk
            where s.snooze_until is null or s.snooze_until > now()
            order by s.created_at desc
            limit 50
            """);
        if (rows.isEmpty()) {
            sendPlain(botToken, chatId, "Aktif snooze yok.");
            return;
        }

        StringBuilder sb = new StringBuilder("Aktif snooze listesi:\n");
        for (Map<String, Object> row : rows) {
            String scope = row.get("alert_key") != null
                ? "key=" + row.get("alert_key")
                : row.get("alert_code") != null ? "code=" + row.get("alert_code") : "legacy";
            String until = row.get("snooze_until") == null ? "suresiz" : String.valueOf(row.get("snooze_until"));
            sb.append("- id=").append(row.get("snooze_id"))
              .append(" ").append(scope)
              .append(" inst=").append(row.get("instance_name"))
              .append(" until=").append(until)
              .append(" by=").append(row.get("created_by"))
              .append("\n");
        }
        sendPlain(botToken, chatId, sb.toString());
    }

    private ReplyAlert resolveReplyAlert(String chatId, Map<String, Object> message) {
        Map<String, Object> reply = mapValue(message.get("reply_to_message"));
        if (reply == null) return null;
        Long replyMessageId = toLong(reply.get("message_id"));
        if (replyMessageId == null) return null;

        List<Map<String, Object>> rows = jdbc.queryForList("""
            select m.alert_id, m.alert_key, m.alert_code, m.instance_pk,
                   coalesce(i.display_name, '-') as instance_name
            from control.telegram_message_map m
            left join control.instance_inventory i on i.instance_pk = m.instance_pk
            where m.chat_id = ? and m.message_id = ?
            limit 1
            """,
            chatId, replyMessageId);
        if (rows.isEmpty()) return null;
        Map<String, Object> row = rows.get(0);
        return new ReplyAlert(
            toLong(row.get("alert_id")),
            stringValue(row.get("alert_key")),
            stringValue(row.get("alert_code")),
            toLong(row.get("instance_pk")),
            stringValue(row.get("instance_name"))
        );
    }

    private OffsetDateTime parseUntil(String token) {
        if (token == null || token.isBlank()) return null;
        Matcher matcher = DURATION_PATTERN.matcher(token.toLowerCase(Locale.ROOT));
        if (!matcher.matches()) return null;
        long amount = Long.parseLong(matcher.group(1));
        String unit = matcher.group(2);
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        return switch (unit) {
            case "h" -> now.plusHours(amount);
            case "d" -> now.plusDays(amount);
            default -> now.plusMinutes(amount);
        };
    }

    private long loadLastUpdateId(String botKey) {
        try {
            Long val = jdbc.queryForObject(
                "select last_update_id from control.telegram_poll_state where bot_key = ?",
                Long.class, botKey);
            return val != null ? val : 0L;
        } catch (Exception e) {
            return 0L;
        }
    }

    private void saveLastUpdateId(String botKey, long updateId) {
        try {
            jdbc.update("""
                insert into control.telegram_poll_state (bot_key, last_update_id, updated_at)
                values (?, ?, now())
                on conflict (bot_key) do update
                set last_update_id = greatest(control.telegram_poll_state.last_update_id, excluded.last_update_id),
                    updated_at = now()
                """,
                botKey, updateId);
        } catch (Exception e) {
            log.debug("Telegram poll offset yazilamadi: {}", e.getMessage());
        }
    }

    private void sendPlain(String botToken, String chatId, String text) {
        String url = "https://api.telegram.org/bot" + botToken + "/sendMessage";
        for (String part : splitText(text, TELEGRAM_SAFE_MESSAGE_LENGTH)) {
            String payload = """
                {"chat_id": "%s", "text": "%s", "disable_web_page_preview": true}
                """.formatted(chatId, escapeJson(part));
            try {
                HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(payload))
                    .timeout(Duration.ofSeconds(15))
                    .build();
                HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() >= 400) {
                    log.warn("Telegram komut yaniti gonderilemedi: HTTP {} - {}", response.statusCode(), response.body());
                }
            } catch (Exception e) {
                log.warn("Telegram komut yaniti hatasi: {}", e.getMessage());
            }
        }
    }

    private List<String> splitText(String text, int maxLen) {
        if (text == null) return List.of("");
        if (text.length() <= maxLen) return List.of(text);
        List<String> parts = new ArrayList<>();
        int start = 0;
        while (start < text.length()) {
            int end = Math.min(start + maxLen, text.length());
            if (end < text.length()) {
                int boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
                if (boundary > start + 100) end = boundary + 1;
            }
            parts.add(text.substring(start, end));
            start = end;
        }
        return parts;
    }

    private Map<String, String> parseConfig(String json) {
        Map<String, String> result = new HashMap<>();
        if (json == null || json.isBlank()) return result;
        Matcher matcher = CONFIG_KV.matcher(json);
        while (matcher.find()) {
            String key = matcher.group(1);
            String val = matcher.group(2).trim();
            if (val.startsWith("\"") && val.endsWith("\"")) {
                val = val.substring(1, val.length() - 1);
            }
            result.put(key, val);
        }
        return result;
    }

    private String botKey(String botToken, String chatId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest((botToken + ":" + chatId).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (Exception e) {
            return chatId;
        }
    }

    private String chatId(Map<String, Object> message) {
        Map<String, Object> chat = mapValue(message.get("chat"));
        if (chat == null) return "";
        Object id = chat.get("id");
        return id == null ? "" : String.valueOf(id);
    }

    private String createdBy(Map<String, Object> message) {
        Map<String, Object> from = mapValue(message.get("from"));
        if (from == null) return "telegram";
        String username = stringValue(from.get("username"));
        if (username == null || username.isBlank()) username = stringValue(from.get("first_name"));
        if (username == null || username.isBlank()) username = String.valueOf(from.getOrDefault("id", "unknown"));
        return "telegram:" + username;
    }

    private Long parseLong(String value) {
        if (value == null || !value.matches("\\d+")) return null;
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private Long toLong(Object value) {
        if (value == null) return null;
        if (value instanceof Number n) return n.longValue();
        return parseLong(String.valueOf(value));
    }

    private String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> mapValue(Object value) {
        if (value instanceof Map<?, ?> map) return castMap(map);
        return null;
    }

    private Map<String, Object> castMap(Map<?, ?> map) {
        Map<String, Object> result = new HashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (entry.getKey() != null) result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
    }
}
