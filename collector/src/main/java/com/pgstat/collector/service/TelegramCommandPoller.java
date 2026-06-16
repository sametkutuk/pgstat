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
import java.util.Collections;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class TelegramCommandPoller {

    private static final Logger log = LoggerFactory.getLogger(TelegramCommandPoller.class);
    private static final int TELEGRAM_SAFE_MESSAGE_LENGTH = 3900;
    private static final int MAX_UPDATES_PER_CYCLE = 20;
    private static final int MAX_COMMAND_TEXT_LENGTH = 256;
    private static final int RATE_LIMIT_MAX_COMMANDS = 10;
    private static final int AUDIT_TEXT_LENGTH = 50;
    private static final Duration HTTP_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration RATE_LIMIT_WINDOW = Duration.ofMinutes(1);
    private static final Duration MAX_SNOOZE_DURATION = Duration.ofDays(30);
    private static final Pattern CONFIG_KV =
        Pattern.compile("\"([^\"]+)\"\\s*:\\s*(\"[^\"]*\"|[^,}]+)");
    private static final Pattern DURATION_PATTERN = Pattern.compile("^(\\d{1,4})([mhd]?)$");

    private final JdbcTemplate jdbc;
    private final HttpClient httpClient;
    private final JsonParser jsonParser;
    // Kullanici basina komut zaman damgalari (rate limit). Thread-safe: scheduler
    // su an tek-thread ama ileride async/pool'a gecerse race olmamasi icin
    // ConcurrentHashMap + senkron liste. Pencere disi kayitlar isRateLimited'da
    // temizleniyor, ayrica bos kalan kullanici girdileri map'ten dusuruluyor.
    private final Map<Long, List<Long>> commandRateWindow = new ConcurrentHashMap<>();

    private record Command(String action, boolean codeScope, String durationToken, Long snoozeId, String errorMessage) {}

    private record ReplyAlert(Long alertId, String alertKey, String alertCode, Long instancePk, String instanceName) {}

    private record DurationParseResult(OffsetDateTime until, boolean clamped, String effectiveText) {}

    public TelegramCommandPoller(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(HTTP_TIMEOUT)
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
        pruneRateWindow();
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
            + "&limit=" + MAX_UPDATES_PER_CYCLE
            + "&timeout=0";

        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(HTTP_TIMEOUT)
            .GET()
            .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() == 409) {
            log.warn("Telegram getUpdates 409: webhook aktif olabilir, bot={}, chat={}",
                maskBotToken(botToken), chatId);
            return;
        }
        if (response.statusCode() >= 400) {
            log.warn("Telegram getUpdates hatasi: HTTP {} bot={} chat={} - {}",
                response.statusCode(), maskBotToken(botToken), chatId, response.body());
            return;
        }

        Map<String, Object> root = jsonParser.parseMap(response.body());
        Object resultObj = root.get("result");
        if (!(resultObj instanceof List<?> updates)) return;

        int processed = 0;
        for (Object updateObj : updates) {
            if (processed >= MAX_UPDATES_PER_CYCLE) break;
            processed++;
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
        // Telegram normal grup/DM mesajlarini "message", KANAL gonderilerini
        // "channel_post" alaninda yollar. Ikisini de destekle.
        Map<String, Object> message = mapValue(update.get("message"));
        boolean isChannelPost = false;
        if (message == null) {
            message = mapValue(update.get("channel_post"));
            isChannelPost = true;
        }
        if (message == null) return;

        String chatId = chatId(message);
        if (!configuredChatId.equals(chatId)) return;

        String text = limitText(stringValue(message.get("text")), MAX_COMMAND_TEXT_LENGTH);
        if (text == null || text.isBlank()) return;

        // GUVENLIK — yetkilendirme kanal/grup'a gore farkli:
        //  - KANAL postu: from.id YOKTUR (gonderiler kanal kimligiyle, anonim admin).
        //    Kanala SADECE adminler yazabilir, yani Telegram admin yetkisi = komut
        //    yetkisi. Yetki = chat_id eslesmesi (yukarida zaten dogrulandi). user_id
        //    allowlist kanal icin UYGULANAMAZ, atlanir.
        //  - Normal grup/DM: from.id gelir -> user_id allowlist TAM uygulanir (fail-closed).
        Long userId = senderUserId(message);
        if (!isChannelPost) {
            if (!isAllowedUser(userId)) {
                if (text.trim().startsWith("/")) auditUnauthorized(message, chatId, text);
                return;
            }
        }
        // Rate limit: kanalda userId null olabilir -> chat_id'yi anahtar yap.
        long rateKey = userId != null ? userId : channelRateKey(chatId);
        if (isRateLimited(rateKey)) {
            auditRateLimited(message, chatId, text);
            return;
        }

        Command command = parseCommand(text);
        if (command == null) return;
        if (command.errorMessage() != null) {
            sendPlain(botToken, configuredChatId, command.errorMessage());
            return;
        }

        if ("help".equals(command.action())) {
            sendHelp(botToken, configuredChatId);
            return;
        }

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

        // Yardim: kullanilabilir komutlari ve parametreleri listele.
        if ("/yardim".equals(name) || "/help".equals(name)
            || "/kullan".equals(name) || "/use".equals(name)) {
            return new Command("help", false, null, null, null);
        }

        if ("/mute".equals(name) || "/sustur".equals(name)) {
            if (tokens.length > 1) {
                String second = tokens[1].toLowerCase(Locale.ROOT);
                if ("report".equals(second) || "rapor".equals(second)) {
                    return new Command("report", false, null, null, null);
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
            return new Command("mute", codeScope, durationToken, null, null);
        }

        if ("/unmute".equals(name) || "/ac".equals(name)) {
            if (tokens.length > 1) {
                Long snoozeId = parsePositiveLong(tokens[1]);
                if (snoozeId == null) {
                    return new Command("unmute", false, null, null, "Hata: snooze_id pozitif integer olmali.");
                }
                return new Command("unmute", false, null, snoozeId, null);
            }
            return new Command("unmute", false, null, null, null);
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

        DurationParseResult duration = null;
        OffsetDateTime until = null;
        if (command.durationToken() != null && !command.durationToken().isBlank()) {
            duration = parseDuration(command.durationToken());
            if (duration == null) {
                sendPlain(botToken, chatId, "Hata: Sure formati gecersiz. Ornek: 30m, 2h, 1d, 90. Ust sinir 30d.");
                return;
            }
            until = duration.until();
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
        String durationText = until == null ? "suresiz" : duration.effectiveText();
        String warning = duration != null && duration.clamped() ? " Uyari: sure 30 gun ile sinirlandi." : "";
        sendPlain(botToken, chatId, "OK: " + alert.instanceName() + " uzerindeki " + scope
            + " " + durationText + " susturuldu. /ac " + snoozeId + " ile acabilirsin." + warning);
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

    private void sendHelp(String botToken, String chatId) {
        String help = """
            pgstat Telegram komutlari

            Alert susturma (mute/snooze):
            - Bir ALERT mesajini REPLY edip yaz:
              /sustur 30m   -> o alerti 30 dakika sustur
              /sustur 2h    -> 2 saat
              /sustur 1d    -> 1 gun
              /sustur 90    -> 90 dakika (cipsiz = dakika)
              /sustur       -> SURESIZ sustur (sure yok)
              /sustur kod 2h -> ayni TIPTEKI (alert_code) tum alertleri 2 saat sustur
            (Ingilizce esdegeri: /mute)

            Sure birimleri: m=dakika, h=saat, d=gun. Ust sinir 30 gun (30d).

            Susturmayi acma:
            - /ac 123          -> snooze_id=123 olan susturmayi kaldir
            - alert mesajini REPLY edip /ac -> o alertin aktif susturmasini kaldir
            (Ingilizce esdegeri: /unmute)

            Aktif susturmalari listele:
            - /sustur rapor    (veya /mute report)
              Her satirda snooze_id var; /ac <id> ile o susturmayi kaldirabilirsin.

            Bu yardim:
            - /yardim  /help  /kullan  /use

            Not: Susturulmus bir alert COZULUNCE (resolved) bildirim yine gelir.
            """;
        sendPlain(botToken, chatId, help);
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

    private DurationParseResult parseDuration(String token) {
        if (token == null || token.isBlank()) return null;
        Matcher matcher = DURATION_PATTERN.matcher(token.toLowerCase(Locale.ROOT));
        if (!matcher.matches()) return null;
        long amount = Long.parseLong(matcher.group(1));
        String unit = matcher.group(2);
        Duration requested = switch (unit) {
            case "h" -> Duration.ofHours(amount);
            case "d" -> Duration.ofDays(amount);
            default -> Duration.ofMinutes(amount);
        };
        boolean clamped = requested.compareTo(MAX_SNOOZE_DURATION) > 0;
        Duration effective = clamped ? MAX_SNOOZE_DURATION : requested;
        String suffix = unit == null || unit.isBlank() ? "m" : unit;
        long effectiveAmount = switch (suffix) {
            case "h" -> effective.toHours();
            case "d" -> effective.toDays();
            default -> effective.toMinutes();
        };
        return new DurationParseResult(
            OffsetDateTime.now(ZoneOffset.UTC).plus(effective),
            clamped,
            effectiveAmount + suffix
        );
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

    private boolean isAllowedUser(Long userId) {
        if (userId == null) return false;
        try {
            Boolean allowed = jdbc.queryForObject("""
                select exists (
                  select 1
                  from control.telegram_command_allowlist
                  where telegram_user_id = ? and is_enabled = true
                )
                """,
                Boolean.class, userId);
            return Boolean.TRUE.equals(allowed);
        } catch (Exception e) {
            log.debug("Telegram allowlist kontrolu fail-closed: {}", e.getMessage());
            return false;
        }
    }

    private boolean isRateLimited(Long userId) {
        if (userId == null) return true;
        long now = System.currentTimeMillis();
        long cutoff = now - RATE_LIMIT_WINDOW.toMillis();
        // Senkron liste — ayni kullanici icin eszamanli erisimde de tutarli.
        List<Long> window = commandRateWindow.computeIfAbsent(
            userId, ignored -> Collections.synchronizedList(new ArrayList<>()));
        synchronized (window) {
            window.removeIf(ts -> ts < cutoff);
            if (window.size() >= RATE_LIMIT_MAX_COMMANDS) return true;
            window.add(now);
        }
        return false;
    }

    /**
     * Bellek sizintisini onler: poll cycle sonunda penceresi tamamen bosalmis
     * (son 1 dk komut yok) kullanici girdilerini map'ten dusur.
     */
    private void pruneRateWindow() {
        long cutoff = System.currentTimeMillis() - RATE_LIMIT_WINDOW.toMillis();
        commandRateWindow.entrySet().removeIf(entry -> {
            List<Long> window = entry.getValue();
            synchronized (window) {
                window.removeIf(ts -> ts < cutoff);
                return window.isEmpty();
            }
        });
    }

    private void auditUnauthorized(Map<String, Object> message, String chatId, String text) {
        log.warn("telegram yetkisiz komut: user_id={}, username={}, chat={}, text={}",
            senderUserId(message), username(message), chatId, auditText(text));
    }

    private void auditRateLimited(Map<String, Object> message, String chatId, String text) {
        log.warn("telegram rate limit: user_id={}, username={}, chat={}, text={}",
            senderUserId(message), username(message), chatId, auditText(text));
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
                    .timeout(HTTP_TIMEOUT)
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

    private String limitText(String text, int maxLen) {
        if (text == null) return null;
        return text.length() <= maxLen ? text : text.substring(0, maxLen);
    }

    private String auditText(String text) {
        if (text == null) return "";
        String clean = text.replace("\n", " ").replace("\r", " ");
        return clean.length() <= AUDIT_TEXT_LENGTH ? clean : clean.substring(0, AUDIT_TEXT_LENGTH);
    }

    private String maskBotToken(String botToken) {
        if (botToken == null || botToken.isBlank()) return "bot***";
        return "bot***";
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

    private Long senderUserId(Map<String, Object> message) {
        Map<String, Object> from = mapValue(message.get("from"));
        return from == null ? null : toLong(from.get("id"));
    }

    /**
     * Kanal postlarinda from.id olmadigi icin rate limit anahtari olarak
     * chat_id'den deterministik (negatif olmayan) bir long uret. Gercek user_id'lerle
     * (pozitif, ayni aralikta) cakismasin diye negatif uzaya tasi.
     */
    private long channelRateKey(String chatId) {
        return -Math.abs((long) chatId.hashCode()) - 1;
    }

    private String username(Map<String, Object> message) {
        Map<String, Object> from = mapValue(message.get("from"));
        if (from == null) return "";
        String username = stringValue(from.get("username"));
        if (username == null || username.isBlank()) username = stringValue(from.get("first_name"));
        return username == null ? "" : username;
    }

    private Long parsePositiveLong(String value) {
        Long parsed = parseLong(value);
        return parsed != null && parsed > 0 ? parsed : null;
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
