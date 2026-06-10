package com.pgstat.collector.service;

import com.pgstat.collector.model.AlertCode;
import com.pgstat.collector.repository.AlertRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@Service
public class XidFreezeEvaluator {

    private static final Logger log = LoggerFactory.getLogger(XidFreezeEvaluator.class);
    private static final long DEFAULT_XID_MAX_AGE = 200_000_000L;
    private static final long DEFAULT_MXID_MAX_AGE = 400_000_000L;

    private final JdbcTemplate jdbc;
    private final AlertRepository alertRepo;

    public XidFreezeEvaluator(JdbcTemplate jdbc, AlertRepository alertRepo) {
        this.jdbc = jdbc;
        this.alertRepo = alertRepo;
    }

    @Scheduled(fixedDelay = 60 * 60 * 1000L, initialDelay = 120_000L)
    public void evaluate() {
        seedMissingSubscriptions();
        List<Subscription> subscriptions = loadSubscriptions();
        log.info("XidFreezeEvaluator cycle started, subscriptions={}", subscriptions.size());
        for (Subscription subscription : subscriptions) {
            try {
                evaluateInstance(subscription);
            } catch (Exception e) {
                log.warn("XidFreezeEvaluator failed for instance_pk={}: {}", subscription.instancePk(), e.getMessage());
            }
        }
        log.info("XidFreezeEvaluator cycle finished");
    }

    private void seedMissingSubscriptions() {
        jdbc.update("""
            insert into control.xid_freeze_subscription (instance_pk)
            select instance_pk
            from control.instance_inventory
            where is_active = true
            on conflict (instance_pk) do nothing
            """);
    }

    private List<Subscription> loadSubscriptions() {
        return jdbc.query("""
            select s.instance_pk, s.warning_pct, s.critical_pct,
                   s.notify_on_xid, s.notify_on_mxid,
                   ii.instance_id, ii.host
            from control.xid_freeze_subscription s
            join control.instance_inventory ii using (instance_pk)
            where s.is_enabled = true
            """, (rs, rowNum) -> new Subscription(
            rs.getLong("instance_pk"),
            rs.getInt("warning_pct"),
            rs.getInt("critical_pct"),
            rs.getBoolean("notify_on_xid"),
            rs.getBoolean("notify_on_mxid"),
            rs.getString("instance_id"),
            rs.getString("host")
        ));
    }

    private void evaluateInstance(Subscription subscription) {
        OffsetDateTime snapshotTs = latestFreshFreezeSnapshot(subscription.instancePk());
        if (snapshotTs == null) {
            log.debug("XidFreezeEvaluator skipped stale instance_pk={}", subscription.instancePk());
            return;
        }

        FreezeSettings settings = loadSettings(subscription.instancePk());
        Set<String> activeAlertKeys = new HashSet<>();
        for (FreezeRow row : loadFreezeRows(subscription.instancePk(), snapshotTs)) {
            evaluateXid(subscription, row, settings.xidMaxAge(), activeAlertKeys);
            evaluateMxid(subscription, row, settings.mxidMaxAge(), activeAlertKeys);
        }
        resolveRecoveredAlerts(subscription, activeAlertKeys);
    }

    private FreezeSettings loadSettings(long instancePk) {
        List<SettingRow> rows = jdbc.query("""
            select setting_name, setting_value
            from fact.pg_settings_snapshot
            where instance_pk = ?
              and setting_name in (
                'autovacuum_freeze_max_age',
                'autovacuum_multixact_freeze_max_age'
              )
              and snapshot_ts = (
                select max(snapshot_ts)
                from fact.pg_settings_snapshot
                where instance_pk = ?
                  and snapshot_ts > now() - interval '36 hours'
              )
            """, (rs, rowNum) -> new SettingRow(
            rs.getString("setting_name"),
            rs.getString("setting_value")
        ), instancePk, instancePk);

        long xidMaxAge = DEFAULT_XID_MAX_AGE;
        long mxidMaxAge = DEFAULT_MXID_MAX_AGE;
        if (rows.isEmpty()) {
            log.debug("XidFreezeEvaluator using default GUC values for instance_pk={}", instancePk);
        }
        for (SettingRow row : rows) {
            long parsed = parsePositiveLong(row.settingValue(), 0);
            if ("autovacuum_freeze_max_age".equals(row.settingName()) && parsed > 0) {
                xidMaxAge = parsed;
            } else if ("autovacuum_multixact_freeze_max_age".equals(row.settingName()) && parsed > 0) {
                mxidMaxAge = parsed;
            }
        }
        return new FreezeSettings(xidMaxAge, mxidMaxAge);
    }

    private OffsetDateTime latestFreshFreezeSnapshot(long instancePk) {
        List<OffsetDateTime> rows = jdbc.query("""
            select max(snapshot_ts) as snapshot_ts
            from fact.pg_database_freeze_snapshot
            where instance_pk = ?
              and snapshot_ts > now() - interval '36 hours'
            """, (rs, rowNum) -> toOffsetDateTime(rs.getObject("snapshot_ts")), instancePk);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private List<FreezeRow> loadFreezeRows(long instancePk, OffsetDateTime snapshotTs) {
        return jdbc.query("""
            select dbid, datname, datfrozenxid_age, datminmxid_age
            from fact.pg_database_freeze_snapshot
            where instance_pk = ?
              and snapshot_ts = ?
            """, (rs, rowNum) -> new FreezeRow(
            rs.getLong("dbid"),
            rs.getString("datname"),
            nullableLong(rs.getObject("datfrozenxid_age")),
            nullableLong(rs.getObject("datminmxid_age"))
        ), instancePk, snapshotTs);
    }

    private void evaluateXid(Subscription subscription, FreezeRow row, long xidMaxAge, Set<String> activeAlertKeys) {
        if (!subscription.notifyOnXid() || row.datfrozenxidAge() == null) {
            return;
        }
        double pct = (double) row.datfrozenxidAge() * 100.0 / xidMaxAge;
        AlertCode code = freezeCode(pct, subscription, AlertCode.XID_FREEZE_WARNING, AlertCode.XID_FREEZE_CRITICAL);
        if (code == null) {
            return;
        }
        String alertKey = key("xid_freeze", subscription.instancePk(), row.dbid());
        activeAlertKeys.add(alertKey);
        int displayPct = (int) Math.round(pct);
        String title = "XID freeze riski: " + safe(row.datname()) + " %" + displayPct + " - " + subscription.label();
        String message = "datname=" + safe(row.datname()) + ", datfrozenxid_age=" + row.datfrozenxidAge()
            + " / max=" + xidMaxAge + " (%" + displayPct + "). Wraparound 2.1B'de. autovacuum freeze gerekli.";
        String details = new AlertDetailsBuilder()
            .setKind("xid_freeze")
            .addContext("dbid", row.dbid())
            .addContext("datname", row.datname())
            .addContext("xid_age", row.datfrozenxidAge())
            .addContext("xid_max_age", xidMaxAge)
            .addContext("pct", displayPct)
            .addContext("kind", "xid")
            .addContext("instance_id", subscription.instanceId())
            .addContext("host", subscription.host())
            .build();
        // critical -> her cycle hatirlat (ALWAYS); warning -> ilk kez/reopen/severity-degisimi (FIRST_ONLY)
        AlertRepository.NotifyMode notifyMode = (code == AlertCode.XID_FREEZE_CRITICAL)
            ? AlertRepository.NotifyMode.ALWAYS
            : AlertRepository.NotifyMode.FIRST_ONLY;
        alertRepo.upsert(alertKey, code, subscription.instancePk(), null, null, title, message, details, notifyMode);
    }

    private void evaluateMxid(Subscription subscription, FreezeRow row, long mxidMaxAge, Set<String> activeAlertKeys) {
        if (!subscription.notifyOnMxid() || row.datminmxidAge() == null) {
            return;
        }
        double pct = (double) row.datminmxidAge() * 100.0 / mxidMaxAge;
        AlertCode code = freezeCode(pct, subscription, AlertCode.MXID_FREEZE_WARNING, AlertCode.MXID_FREEZE_CRITICAL);
        if (code == null) {
            return;
        }
        String alertKey = key("mxid_freeze", subscription.instancePk(), row.dbid());
        activeAlertKeys.add(alertKey);
        int displayPct = (int) Math.round(pct);
        String title = "MXID freeze riski: " + safe(row.datname()) + " %" + displayPct + " - " + subscription.label();
        String message = "datname=" + safe(row.datname()) + ", datminmxid_age=" + row.datminmxidAge()
            + " / max=" + mxidMaxAge + " (%" + displayPct + "). autovacuum freeze gerekli.";
        String details = new AlertDetailsBuilder()
            .setKind("xid_freeze")
            .addContext("dbid", row.dbid())
            .addContext("datname", row.datname())
            .addContext("mxid_age", row.datminmxidAge())
            .addContext("mxid_max_age", mxidMaxAge)
            .addContext("pct", displayPct)
            .addContext("kind", "mxid")
            .addContext("instance_id", subscription.instanceId())
            .addContext("host", subscription.host())
            .build();
        AlertRepository.NotifyMode notifyMode = (code == AlertCode.MXID_FREEZE_CRITICAL)
            ? AlertRepository.NotifyMode.ALWAYS
            : AlertRepository.NotifyMode.FIRST_ONLY;
        alertRepo.upsert(alertKey, code, subscription.instancePk(), null, null, title, message, details, notifyMode);
    }

    private AlertCode freezeCode(double pct, Subscription subscription, AlertCode warningCode, AlertCode criticalCode) {
        if (pct >= subscription.criticalPct()) {
            return criticalCode;
        }
        if (pct >= subscription.warningPct()) {
            return warningCode;
        }
        return null;
    }

    private void resolveRecoveredAlerts(Subscription subscription, Set<String> activeAlertKeys) {
        long instancePk = subscription.instancePk();
        List<OpenAlert> openAlerts = jdbc.query("""
            select alert_key, title
            from ops.alert
            where instance_pk = ?
              and status = 'open'
              and alert_code in (
                'xid_freeze_warning',
                'xid_freeze_critical',
                'mxid_freeze_warning',
                'mxid_freeze_critical'
              )
            """, (rs, rowNum) -> new OpenAlert(rs.getString("alert_key"), rs.getString("title")), instancePk);
        for (OpenAlert open : openAlerts) {
            if (!activeAlertKeys.contains(open.alertKey())) {
                // Risk gecti -> resolve + "Resolved:" bildirimi (warning ve critical ikisi de)
                String message = "Freeze riski gecti. Age esigin altina dustu. " + subscription.label();
                alertRepo.resolveAndNotify(open.alertKey(), open.title(), message);
            }
        }
    }

    private static String key(String kind, long instancePk, long dbid) {
        return "adaptive." + kind + ":instance=" + instancePk + ":dbid=" + dbid;
    }

    private static String safe(String value) {
        return value == null ? "-" : value;
    }

    private static Long nullableLong(Object value) {
        if (value == null) {
            return null;
        }
        return ((Number) value).longValue();
    }

    private static long parsePositiveLong(String value, long fallback) {
        if (value == null) {
            return fallback;
        }
        try {
            long parsed = Long.parseLong(value.trim());
            return parsed > 0 ? parsed : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
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
        int warningPct,
        int criticalPct,
        boolean notifyOnXid,
        boolean notifyOnMxid,
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

    private record FreezeSettings(long xidMaxAge, long mxidMaxAge) {}

    private record SettingRow(String settingName, String settingValue) {}

    private record FreezeRow(long dbid, String datname, Long datfrozenxidAge, Long datminmxidAge) {}

    private record OpenAlert(String alertKey, String title) {}
}
