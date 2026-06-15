package com.pgstat.collector.service;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@Service
public class LongRunningQueryEvaluator {

    private static final Logger log = LoggerFactory.getLogger(LongRunningQueryEvaluator.class);

    private final JdbcTemplate jdbc;
    private final AlertRepository alertRepo;

    public LongRunningQueryEvaluator(JdbcTemplate jdbc, AlertRepository alertRepo) {
        this.jdbc = jdbc;
        this.alertRepo = alertRepo;
    }

    @Scheduled(fixedDelay = 60 * 1000L, initialDelay = 60_000L)
    public void evaluate() {
        seedMissingSubscriptions();
        List<Subscription> subscriptions = loadSubscriptions();
        log.info("LongRunningQueryEvaluator cycle started, subscriptions={}", subscriptions.size());
        for (Subscription subscription : subscriptions) {
            try {
                evaluateInstance(subscription);
            } catch (Exception e) {
                log.warn("LongRunningQueryEvaluator failed for instance_pk={}: {}", subscription.instancePk(), e.getMessage());
            }
        }
        log.info("LongRunningQueryEvaluator cycle finished");
    }

    private void seedMissingSubscriptions() {
        jdbc.update("""
            insert into control.long_query_subscription (instance_pk)
            select instance_pk
            from control.instance_inventory
            where is_active = true
            on conflict (instance_pk) do nothing
            """);
    }

    private List<Subscription> loadSubscriptions() {
        return jdbc.query("""
            select s.instance_pk, s.long_query_minutes, s.idle_tx_minutes,
                   s.notify_on_long_query, s.notify_on_idle_tx, s.notify_on_idle_tx_aborted,
                   ii.instance_id, ii.host
            from control.long_query_subscription s
            join control.instance_inventory ii using (instance_pk)
            where s.is_enabled = true
            """, (rs, rowNum) -> new Subscription(
            rs.getLong("instance_pk"),
            rs.getInt("long_query_minutes"),
            rs.getInt("idle_tx_minutes"),
            rs.getBoolean("notify_on_long_query"),
            rs.getBoolean("notify_on_idle_tx"),
            rs.getBoolean("notify_on_idle_tx_aborted"),
            rs.getString("instance_id"),
            rs.getString("host")
        ));
    }

    private void evaluateInstance(Subscription subscription) {
        OffsetDateTime snapshotTs = latestFreshActivitySnapshot(subscription.instancePk());
        if (snapshotTs == null) {
            log.debug("LongRunningQueryEvaluator skipped stale instance_pk={}", subscription.instancePk());
            return;
        }

        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        Set<String> activeAlertKeys = new HashSet<>();
        for (ActivityRow row : loadActivityRows(subscription.instancePk(), snapshotTs)) {
            evaluateLongRunningQuery(subscription, row, now, activeAlertKeys);
            evaluateIdleInTransaction(subscription, row, now, activeAlertKeys);
            evaluateIdleInTransactionAborted(subscription, row, now, activeAlertKeys);
        }
        resolveFinishedAlerts(subscription.instancePk(), activeAlertKeys);
    }

    private OffsetDateTime latestFreshActivitySnapshot(long instancePk) {
        List<OffsetDateTime> rows = jdbc.query("""
            select max(snapshot_ts) as snapshot_ts
            from fact.pg_activity_snapshot
            where instance_pk = ?
              and snapshot_ts > now() - interval '5 minutes'
            """, (rs, rowNum) -> toOffsetDateTime(rs.getObject("snapshot_ts")), instancePk);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private List<ActivityRow> loadActivityRows(long instancePk, OffsetDateTime snapshotTs) {
        return jdbc.query("""
            select a.pid, a.datname, a.usename, a.state, a.query_start, a.xact_start,
                   a.query, a.backend_type, a.wait_event_type, a.wait_event, a.query_id,
                   a.application_name, a.client_addr::text as client_addr, a.client_hostname
            from fact.pg_activity_snapshot a
            where a.instance_pk = ?
              and a.snapshot_ts = ?
              and a.backend_type = 'client backend'
              and nullif(btrim(coalesce(a.query, '')), '') is not null
            """, (rs, rowNum) -> new ActivityRow(
            rs.getInt("pid"),
            rs.getString("datname"),
            rs.getString("usename"),
            rs.getString("state"),
            toOffsetDateTime(rs.getObject("query_start")),
            toOffsetDateTime(rs.getObject("xact_start")),
            rs.getString("query"),
            rs.getString("backend_type"),
            rs.getString("wait_event_type"),
            rs.getString("wait_event"),
            rs.getObject("query_id") == null ? null : rs.getLong("query_id"),
            rs.getString("application_name"),
            rs.getString("client_addr"),
            rs.getString("client_hostname")
        ), instancePk, snapshotTs);
    }

    private void evaluateLongRunningQuery(Subscription subscription, ActivityRow row, OffsetDateTime now,
                                          Set<String> activeAlertKeys) {
        if (!subscription.notifyOnLongQuery()
            || !"active".equalsIgnoreCase(row.state())
            || row.queryStart() == null) {
            return;
        }
        long durationMinutes = durationMinutes(row.queryStart(), now);
        if (durationMinutes < subscription.longQueryMinutes()) {
            return;
        }
        String alertKey = key("long_running_query", subscription.instancePk(), row.pid(), row.queryStart());
        activeAlertKeys.add(alertKey);
        upsertActivityAlert(
            AlertCode.LONG_RUNNING_QUERY,
            alertKey,
            subscription,
            row,
            row.queryStart(),
            durationMinutes,
            subscription.longQueryMinutes(),
            "Uzun suren sorgu: pid=" + row.pid() + " (" + durationMinutes + " dk) - " + subscription.label(),
            "pid=" + row.pid() + ", datname=" + safe(row.datname()) + ", user=" + safe(row.usename())
                + ", app=" + safe(row.applicationName()) + ", client=" + row.clientLocation()
                + ", sure=" + durationMinutes + " dk. Sorgu: " + queryPreview(row.query())
        );
    }

    private void evaluateIdleInTransaction(Subscription subscription, ActivityRow row, OffsetDateTime now,
                                           Set<String> activeAlertKeys) {
        if (!subscription.notifyOnIdleTx()
            || !"idle in transaction".equalsIgnoreCase(row.state())
            || row.xactStart() == null) {
            return;
        }
        long durationMinutes = durationMinutes(row.xactStart(), now);
        if (durationMinutes < subscription.idleTxMinutes()) {
            return;
        }
        String alertKey = key("idle_in_transaction_long", subscription.instancePk(), row.pid(), row.xactStart());
        activeAlertKeys.add(alertKey);
        upsertActivityAlert(
            AlertCode.IDLE_IN_TRANSACTION_LONG,
            alertKey,
            subscription,
            row,
            row.xactStart(),
            durationMinutes,
            subscription.idleTxMinutes(),
            "Uzun idle transaction: pid=" + row.pid() + " (" + durationMinutes + " dk) - " + subscription.label(),
            "pid=" + row.pid() + ", datname=" + safe(row.datname()) + ", user=" + safe(row.usename())
                + ", app=" + safe(row.applicationName()) + ", client=" + row.clientLocation()
                + ", sure=" + durationMinutes + " dk. Sorgu: " + queryPreview(row.query())
        );
    }

    private void evaluateIdleInTransactionAborted(Subscription subscription, ActivityRow row, OffsetDateTime now,
                                                  Set<String> activeAlertKeys) {
        if (!subscription.notifyOnIdleTxAborted()
            || !"idle in transaction (aborted)".equalsIgnoreCase(row.state())
            || row.xactStart() == null) {
            return;
        }
        long durationMinutes = durationMinutes(row.xactStart(), now);
        if (durationMinutes < subscription.idleTxMinutes()) {
            return;
        }
        String alertKey = key("idle_in_transaction_aborted", subscription.instancePk(), row.pid(), row.xactStart());
        activeAlertKeys.add(alertKey);
        upsertActivityAlert(
            AlertCode.IDLE_IN_TRANSACTION_ABORTED,
            alertKey,
            subscription,
            row,
            row.xactStart(),
            durationMinutes,
            subscription.idleTxMinutes(),
            "Hatali idle transaction: pid=" + row.pid() + " (" + durationMinutes + " dk) - " + subscription.label(),
            "pid=" + row.pid() + ", datname=" + safe(row.datname()) + ", user=" + safe(row.usename())
                + ", app=" + safe(row.applicationName()) + ", client=" + row.clientLocation()
                + ", sure=" + durationMinutes + " dk. Sorgu: " + queryPreview(row.query())
        );
    }

    private void upsertActivityAlert(AlertCode code, String alertKey, Subscription subscription, ActivityRow row,
                                     OffsetDateTime startAt, long durationMinutes, int thresholdMinutes,
                                     String title, String message) {
        String details = new AlertDetailsBuilder()
            .setKind("long_query")
            .addContext("pid", row.pid())
            .addContext("datname", row.datname())
            .addContext("usename", row.usename())
            .addContext("state", row.state())
            .addContext("query_start", row.queryStart())
            .addContext("xact_start", row.xactStart())
            .addContext("start_at", startAt)
            .addContext("duration_minutes", durationMinutes)
            .addContext("threshold_minutes", thresholdMinutes)
            .addContext("query_preview", queryPreview(row.query()))
            .addContext("application_name", row.applicationName())
            .addContext("client_addr", row.clientAddr())
            .addContext("client_hostname", row.clientHostname())
            .addContext("client_location", row.clientLocation())
            .addContext("instance_id", subscription.instanceId())
            .addContext("host", subscription.host())
            .addContext("wait_event_type", row.waitEventType())
            .addContext("wait_event", row.waitEvent())
            .addContext("query_id", row.queryId())
            .build();
        alertRepo.upsert(alertKey, code, subscription.instancePk(), null, null, title, message, details);
    }

    private void resolveFinishedAlerts(long instancePk, Set<String> activeAlertKeys) {
        List<String> openKeys = jdbc.query("""
            select alert_key
            from ops.alert
            where instance_pk = ?
              and status = 'open'
              and alert_code in (
                'long_running_query',
                'idle_in_transaction_long',
                'idle_in_transaction_aborted'
              )
            """, (rs, rowNum) -> rs.getString("alert_key"), instancePk);
        for (String alertKey : openKeys) {
            if (!activeAlertKeys.contains(alertKey)) {
                alertRepo.resolve(alertKey);
            }
        }
    }

    private static long durationMinutes(OffsetDateTime start, OffsetDateTime now) {
        return Math.max(0, Duration.between(start.toInstant(), now.toInstant()).toMinutes());
    }

    private static String key(String code, long instancePk, int pid, OffsetDateTime startAt) {
        return "adaptive." + code + ":instance=" + instancePk + ":pid=" + pid
            + ":start=" + startAt.toInstant().getEpochSecond();
    }

    private static String queryPreview(String query) {
        if (query == null) {
            return "";
        }
        String preview = query.replaceAll("[\\r\\n\\t]+", " ").replaceAll("\\s+", " ").trim();
        preview = preview.replaceAll("(?i)(postgres(?:ql)?://[^\\s:]+:)[^@\\s]+@", "$1***@");
        preview = preview.replaceAll("(?i)(password|passwd|pass|token|secret)\\s*=\\s*'[^']*'", "$1='***'");
        preview = preview.replaceAll("(?i)(password|passwd|pass|token|secret)\\s*=\\s*\"[^\"]*\"", "$1=\"***\"");
        preview = preview.replaceAll("(?i)(password|passwd|pass|token|secret)\\s*=\\s*[^\\s,;)]*", "$1=***");
        return preview.length() <= 200 ? preview : preview.substring(0, 200);
    }

    private static String safe(String value) {
        return value == null ? "-" : value;
    }

    private static OffsetDateTime toOffsetDateTime(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof OffsetDateTime odt) {
            return odt;
        }
        if (value instanceof Timestamp ts) {
            return OffsetDateTime.ofInstant(ts.toInstant(), ZoneOffset.UTC);
        }
        if (value instanceof Instant instant) {
            return OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
        }
        throw new IllegalArgumentException("Unsupported timestamp type: " + value.getClass().getName());
    }

    private record Subscription(
        long instancePk,
        int longQueryMinutes,
        int idleTxMinutes,
        boolean notifyOnLongQuery,
        boolean notifyOnIdleTx,
        boolean notifyOnIdleTxAborted,
        String instanceId,
        String host
    ) {
        String label() {
            if (instanceId == null || instanceId.isEmpty()) {
                return host == null ? "instance=" + instancePk : host;
            }
            if (host == null || host.isEmpty()) {
                return instanceId;
            }
            return instanceId + " (" + host + ")";
        }
    }

    private record ActivityRow(
        int pid,
        String datname,
        String usename,
        String state,
        OffsetDateTime queryStart,
        OffsetDateTime xactStart,
        String query,
        String backendType,
        String waitEventType,
        String waitEvent,
        Long queryId,
        String applicationName,
        String clientAddr,
        String clientHostname
    ) {
        /**
         * Baglantinin geldigi yeri tek string olarak doner:
         * client_addr (IP) varsa onu, yoksa client_hostname (log_hostname=on ise dolu),
         * o da yoksa 'local' (Unix socket — kaynak DB ile ayni makineden baglanti).
         */
        String clientLocation() {
            if (clientAddr != null && !clientAddr.isBlank()) return clientAddr;
            if (clientHostname != null && !clientHostname.isBlank()) return clientHostname;
            return "local";
        }
    }
}
