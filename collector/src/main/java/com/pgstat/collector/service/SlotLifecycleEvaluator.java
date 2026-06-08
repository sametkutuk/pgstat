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
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class SlotLifecycleEvaluator {

    private static final Logger log = LoggerFactory.getLogger(SlotLifecycleEvaluator.class);

    private final JdbcTemplate jdbc;
    private final AlertRepository alertRepo;

    public SlotLifecycleEvaluator(JdbcTemplate jdbc, AlertRepository alertRepo) {
        this.jdbc = jdbc;
        this.alertRepo = alertRepo;
    }

    @Scheduled(fixedDelay = 5 * 60 * 1000L, initialDelay = 60_000L)
    public void evaluate() {
        seedMissingSubscriptions();
        List<Subscription> subscriptions = loadSubscriptions();
        log.info("SlotLifecycleEvaluator cycle started, subscriptions={}", subscriptions.size());
        for (Subscription subscription : subscriptions) {
            try {
                evaluateInstance(subscription);
            } catch (Exception e) {
                log.warn("SlotLifecycleEvaluator failed for instance_pk={}: {}", subscription.instancePk(), e.getMessage());
            }
        }
        log.info("SlotLifecycleEvaluator cycle finished");
    }

    private void seedMissingSubscriptions() {
        jdbc.update("""
            insert into control.slot_lifecycle_subscription (instance_pk)
            select instance_pk
            from control.instance_inventory
            where is_active = true
            on conflict (instance_pk) do nothing
            """);
    }

    private List<Subscription> loadSubscriptions() {
        // Alert mesajlarinda instance_id + host gostermek icin instance_inventory join.
        // Birden fazla instance'ta ayni slot_name olabilir; mesajda netlik icin
        // her alert "instance_id (host)" etiketiyle zenginlestirilir.
        return jdbc.query("""
            select s.instance_pk, s.inactive_minutes, s.retrigger_minutes,
                   s.notify_on_lost, s.notify_on_active_deleted,
                   s.notify_on_inactive_deleted, s.notify_on_inactive,
                   ii.instance_id, ii.host
            from control.slot_lifecycle_subscription s
            join control.instance_inventory ii using (instance_pk)
            where s.is_enabled = true
            """, (rs, rowNum) -> new Subscription(
            rs.getLong("instance_pk"),
            rs.getInt("inactive_minutes"),
            rs.getInt("retrigger_minutes"),
            rs.getBoolean("notify_on_lost"),
            rs.getBoolean("notify_on_active_deleted"),
            rs.getBoolean("notify_on_inactive_deleted"),
            rs.getBoolean("notify_on_inactive"),
            rs.getString("instance_id"),
            rs.getString("host")
        ));
    }

    private void evaluateInstance(Subscription subscription) {
        Map<String, CurrentSlot> current = loadCurrentSlots(subscription.instancePk());
        Map<String, MutableSlotState> states = loadObservedStates(subscription.instancePk());
        Set<String> recreatedThisCycle = new HashSet<>();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);

        for (CurrentSlot slot : current.values()) {
            MutableSlotState state = states.computeIfAbsent(slot.slotName(), name -> MutableSlotState.fromCurrent(subscription.instancePk(), slot));

            if ("lost".equalsIgnoreCase(slot.walStatus()) && subscription.notifyOnLost()) {
                upsertSlotAlert(
                    AlertCode.SLOT_LOST,
                    key("slot_lost", subscription.instancePk(), slot.slotName()),
                    subscription.instancePk(),
                    slot,
                    subscription,
                    null,
                    "Replication slot kayboldu: " + slot.slotName() + " — " + subscription.label(),
                    "Slot wal_status=lost durumunda. Slot: " + slot.slotName() + ". Instance: " + subscription.label() + "."
                );
            }

            if (state.tombstoneAt != null) {
                alertRepo.resolve(key("slot_active_deleted", subscription.instancePk(), slot.slotName()));
                alertRepo.resolve(key("slot_inactive_deleted", subscription.instancePk(), slot.slotName()));
                upsertSlotAlert(
                    AlertCode.SLOT_RECREATED,
                    key("slot_recreated", subscription.instancePk(), slot.slotName()),
                    subscription.instancePk(),
                    slot,
                    subscription,
                    null,
                    "Slot tekrar olusturuldu: " + slot.slotName() + " — " + subscription.label(),
                    "Tombstone durumundaki slot tekrar goruldu. Slot: " + slot.slotName() + ". Instance: " + subscription.label() + "."
                );
                state.updateFromCurrent(slot, slot.active() ? null : slot.sampleTs(), null, null);
                recreatedThisCycle.add(slot.slotName());
                continue;
            }

            boolean recreated = isRecreatedByCounters(state, slot);
            OffsetDateTime inactiveSince = slot.active()
                ? null
                : (state.inactiveSince != null ? state.inactiveSince : slot.sampleTs());
            state.updateFromCurrent(slot, inactiveSince, state.lastRetriggerAt, null);
            if (recreated) {
                upsertSlotAlert(
                    AlertCode.SLOT_RECREATED,
                    key("slot_recreated", subscription.instancePk(), slot.slotName()),
                    subscription.instancePk(),
                    slot,
                    subscription,
                    null,
                    "Slot tekrar olusturuldu: " + slot.slotName() + " — " + subscription.label(),
                    "Slot LSN veya stats_reset sinyaliyle tekrar olusturulmus gorunuyor. Slot: " + slot.slotName() + ". Instance: " + subscription.label() + "."
                );
                recreatedThisCycle.add(slot.slotName());
            }
        }

        for (MutableSlotState state : states.values()) {
            if (current.containsKey(state.slotName)) {
                continue;
            }
            handleDeletedSlot(subscription, state, now);
        }

        for (CurrentSlot slot : current.values()) {
            if (recreatedThisCycle.contains(slot.slotName())) {
                continue;
            }
            MutableSlotState state = states.get(slot.slotName());
            if (state == null || state.tombstoneAt != null) {
                continue;
            }
            if (slot.active()) {
                state.inactiveSince = null;
                alertRepo.resolve(key("slot_inactive_long", subscription.instancePk(), slot.slotName()));
                continue;
            }
            if (subscription.notifyOnInactive() && state.inactiveSince != null) {
                long inactiveDuration = Math.max(0, Duration.between(state.inactiveSince.toInstant(), now.toInstant()).toMinutes());
                if (inactiveDuration >= subscription.inactiveMinutes()) {
                    upsertSlotAlert(
                        AlertCode.SLOT_INACTIVE_LONG,
                        key("slot_inactive_long", subscription.instancePk(), slot.slotName()),
                        subscription.instancePk(),
                        slot,
                        subscription,
                        inactiveDuration,
                        "Slot uzun suredir pasif: " + slot.slotName() + " (" + inactiveDuration + " dk) — " + subscription.label(),
                        "Slot " + inactiveDuration + " dakikadir pasif. Slot: " + slot.slotName() + ". Instance: " + subscription.label() + "."
                    );
                }
            }
        }

        for (MutableSlotState state : states.values()) {
            upsertState(state);
        }
    }

    private void handleDeletedSlot(Subscription subscription, MutableSlotState state, OffsetDateTime now) {
        if (state.tombstoneAt == null) {
            // Slot artik yok — varsa eski slot_inactive_long ve slot_lost alert'lerini resolve et
            alertRepo.resolve(key("slot_inactive_long", subscription.instancePk(), state.slotName));
            alertRepo.resolve(key("slot_lost", subscription.instancePk(), state.slotName));

            if (Boolean.TRUE.equals(state.lastActive) && subscription.notifyOnActiveDeleted()) {
                upsertDeletedAlert(AlertCode.SLOT_ACTIVE_DELETED, subscription, state,
                    "Aktif slot silindi: " + state.slotName + " — " + subscription.label(),
                    "Son goruldugunde aktif olan slot artik snapshot'ta yok. Slot: " + state.slotName + ". Instance: " + subscription.label() + ".");
                state.lastRetriggerAt = now;
            } else if (Boolean.FALSE.equals(state.lastActive) && subscription.notifyOnInactiveDeleted()) {
                upsertDeletedAlert(AlertCode.SLOT_INACTIVE_DELETED, subscription, state,
                    "Pasif slot silindi: " + state.slotName + " — " + subscription.label(),
                    "Son goruldugunde pasif olan slot artik snapshot'ta yok. Slot: " + state.slotName + ". Instance: " + subscription.label() + ".");
                state.lastRetriggerAt = null;
            }
            state.tombstoneAt = now;
            return;
        }

        if (Boolean.TRUE.equals(state.lastActive) && subscription.notifyOnActiveDeleted()) {
            OffsetDateTime lastRetrigger = state.lastRetriggerAt == null ? state.tombstoneAt : state.lastRetriggerAt;
            long minutes = Duration.between(lastRetrigger.toInstant(), now.toInstant()).toMinutes();
            if (minutes >= subscription.retriggerMinutes()) {
                upsertDeletedAlert(AlertCode.SLOT_ACTIVE_DELETED, subscription, state,
                    "Aktif slot silindi: " + state.slotName + " — " + subscription.label(),
                    "Aktif silinen slot hala geri gelmedi. Slot: " + state.slotName + ". Instance: " + subscription.label() + ".");
                state.lastRetriggerAt = now;
            }
        }
    }

    private Map<String, CurrentSlot> loadCurrentSlots(long instancePk) {
        // Freshness filter: son 15 dakika icindeki snapshot'lari "current" say.
        // Slot'un fiziksel olarak silinmesi durumunda fact tablosuna yeni satir
        // EKLENMEZ (0 satir donen sorgu insert yapmaz) — bu yuzden eski snapshot
        // sonsuza dek "current" gozukurdu. Filtre olmadan slot silinse bile
        // evaluator slot'u var sanip inactive_long alert'lerini re-fire eder.
        List<CurrentSlot> rows = jdbc.query("""
            select s.slot_name, s.active, s.wal_status, s.restart_lsn::text as restart_lsn,
                   s.stats_reset, s.sample_ts
            from fact.pg_replication_slot_snapshot s
            where s.instance_pk = ?
              and s.sample_ts = (
                select max(sample_ts)
                from fact.pg_replication_slot_snapshot
                where instance_pk = ?
                  and sample_ts > now() - interval '15 minutes'
              )
            """, (rs, rowNum) -> new CurrentSlot(
            rs.getString("slot_name"),
            rs.getObject("active") == null ? false : rs.getBoolean("active"),
            rs.getString("wal_status"),
            rs.getString("restart_lsn"),
            toOffsetDateTime(rs.getObject("stats_reset")),
            toOffsetDateTime(rs.getObject("sample_ts"))
        ), instancePk, instancePk);

        Map<String, CurrentSlot> map = new HashMap<>();
        for (CurrentSlot row : rows) {
            if (row.slotName() != null) {
                map.put(row.slotName(), row);
            }
        }
        return map;
    }

    private Map<String, MutableSlotState> loadObservedStates(long instancePk) {
        List<MutableSlotState> rows = jdbc.query("""
            select slot_name, last_seen_at, last_restart_lsn::text as last_restart_lsn,
                   last_stats_reset, last_active, last_wal_status,
                   inactive_since, last_retrigger_at, tombstone_at
            from control.slot_observation_state
            where instance_pk = ?
            """, (rs, rowNum) -> new MutableSlotState(
            instancePk,
            rs.getString("slot_name"),
            toOffsetDateTime(rs.getObject("last_seen_at")),
            rs.getString("last_restart_lsn"),
            toOffsetDateTime(rs.getObject("last_stats_reset")),
            (Boolean) rs.getObject("last_active"),
            rs.getString("last_wal_status"),
            toOffsetDateTime(rs.getObject("inactive_since")),
            toOffsetDateTime(rs.getObject("last_retrigger_at")),
            toOffsetDateTime(rs.getObject("tombstone_at"))
        ), instancePk);

        Map<String, MutableSlotState> map = new HashMap<>();
        for (MutableSlotState row : rows) {
            map.put(row.slotName, row);
        }
        return map;
    }

    private boolean isRecreatedByCounters(MutableSlotState state, CurrentSlot slot) {
        if (state.lastRestartLsn != null && slot.restartLsn() != null) {
            try {
                if (compareLsn(slot.restartLsn(), state.lastRestartLsn) < 0) {
                    return true;
                }
            } catch (IllegalArgumentException e) {
                log.debug("Invalid LSN while comparing slot lifecycle state: slot={}", slot.slotName());
            }
        }
        return state.lastStatsReset != null
            && slot.statsReset() != null
            && !state.lastStatsReset.toInstant().equals(slot.statsReset().toInstant());
    }

    private void upsertSlotAlert(AlertCode code, String alertKey, long instancePk, CurrentSlot slot,
                                 Subscription subscription, Long inactiveDurationMinutes,
                                 String title, String message) {
        String details = baseDetails(slot.slotName(), slot.walStatus(), slot.restartLsn(), slot.active(),
            subscription, inactiveDurationMinutes).build();
        alertRepo.upsert(alertKey, code, instancePk, null, null, title, message, details);
    }

    private void upsertDeletedAlert(AlertCode code, Subscription subscription, MutableSlotState state,
                                    String title, String message) {
        String alertKey = switch (code) {
            case SLOT_ACTIVE_DELETED -> key("slot_active_deleted", subscription.instancePk(), state.slotName);
            case SLOT_INACTIVE_DELETED -> key("slot_inactive_deleted", subscription.instancePk(), state.slotName);
            default -> key(code.getCode(), subscription.instancePk(), state.slotName);
        };
        String details = baseDetails(state.slotName, state.lastWalStatus, state.lastRestartLsn,
            Boolean.TRUE.equals(state.lastActive), subscription, null).build();
        alertRepo.upsert(alertKey, code, subscription.instancePk(), null, null, title, message, details);
    }

    private AlertDetailsBuilder baseDetails(String slotName, String walStatus, String restartLsn, boolean active,
                                            Subscription subscription, Long inactiveDurationMinutes) {
        AlertDetailsBuilder builder = new AlertDetailsBuilder()
            .setKind("slot_lifecycle")
            .addContext("slot_name", slotName)
            .addContext("wal_status", walStatus)
            .addContext("restart_lsn", restartLsn)
            .addContext("active", active)
            .addContext("instance_id", subscription.instanceId())
            .addContext("host", subscription.host())
            .addContext("inactive_minutes_threshold", subscription.inactiveMinutes());
        if (inactiveDurationMinutes != null) {
            builder.addContext("inactive_duration_minutes", inactiveDurationMinutes);
        }
        return builder;
    }

    private void upsertState(MutableSlotState state) {
        jdbc.update("""
            insert into control.slot_observation_state (
                instance_pk, slot_name, last_seen_at, last_restart_lsn,
                last_stats_reset, last_active, last_wal_status,
                inactive_since, last_retrigger_at, tombstone_at
            ) values (?, ?, ?, ?::pg_lsn, ?, ?, ?, ?, ?, ?)
            on conflict (instance_pk, slot_name) do update
            set last_seen_at = excluded.last_seen_at,
                last_restart_lsn = excluded.last_restart_lsn,
                last_stats_reset = excluded.last_stats_reset,
                last_active = excluded.last_active,
                last_wal_status = excluded.last_wal_status,
                inactive_since = excluded.inactive_since,
                last_retrigger_at = excluded.last_retrigger_at,
                tombstone_at = excluded.tombstone_at
            """,
            state.instancePk,
            state.slotName,
            state.lastSeenAt,
            state.lastRestartLsn,
            state.lastStatsReset,
            state.lastActive,
            state.lastWalStatus,
            state.inactiveSince,
            state.lastRetriggerAt,
            state.tombstoneAt
        );
    }

    static int compareLsn(String a, String b) {
        String[] pa = a.split("/");
        String[] pb = b.split("/");
        if (pa.length != 2 || pb.length != 2) {
            throw new IllegalArgumentException("Invalid LSN");
        }
        long ah = Long.parseUnsignedLong(pa[0], 16);
        long al = Long.parseUnsignedLong(pa[1], 16);
        long bh = Long.parseUnsignedLong(pb[0], 16);
        long bl = Long.parseUnsignedLong(pb[1], 16);
        if (ah != bh) {
            return Long.compareUnsigned(ah, bh);
        }
        return Long.compareUnsigned(al, bl);
    }

    private static String key(String code, long instancePk, String slotName) {
        return "adaptive." + code + ":instance=" + instancePk + ":slot=" + slotName;
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
        int inactiveMinutes,
        int retriggerMinutes,
        boolean notifyOnLost,
        boolean notifyOnActiveDeleted,
        boolean notifyOnInactiveDeleted,
        boolean notifyOnInactive,
        String instanceId,
        String host
    ) {
        /** Alert title/message'lerinde kullanilan instance etiketi: "instance_id (host)". */
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

    private record CurrentSlot(
        String slotName,
        boolean active,
        String walStatus,
        String restartLsn,
        OffsetDateTime statsReset,
        OffsetDateTime sampleTs
    ) {}

    private static final class MutableSlotState {
        final long instancePk;
        final String slotName;
        OffsetDateTime lastSeenAt;
        String lastRestartLsn;
        OffsetDateTime lastStatsReset;
        Boolean lastActive;
        String lastWalStatus;
        OffsetDateTime inactiveSince;
        OffsetDateTime lastRetriggerAt;
        OffsetDateTime tombstoneAt;

        MutableSlotState(long instancePk, String slotName, OffsetDateTime lastSeenAt, String lastRestartLsn,
                         OffsetDateTime lastStatsReset, Boolean lastActive, String lastWalStatus,
                         OffsetDateTime inactiveSince, OffsetDateTime lastRetriggerAt, OffsetDateTime tombstoneAt) {
            this.instancePk = instancePk;
            this.slotName = slotName;
            this.lastSeenAt = lastSeenAt;
            this.lastRestartLsn = lastRestartLsn;
            this.lastStatsReset = lastStatsReset;
            this.lastActive = lastActive;
            this.lastWalStatus = lastWalStatus;
            this.inactiveSince = inactiveSince;
            this.lastRetriggerAt = lastRetriggerAt;
            this.tombstoneAt = tombstoneAt;
        }

        static MutableSlotState fromCurrent(long instancePk, CurrentSlot slot) {
            return new MutableSlotState(instancePk, slot.slotName(), slot.sampleTs(), slot.restartLsn(),
                slot.statsReset(), slot.active(), slot.walStatus(),
                slot.active() ? null : slot.sampleTs(), null, null);
        }

        void updateFromCurrent(CurrentSlot slot, OffsetDateTime inactiveSince,
                               OffsetDateTime lastRetriggerAt, OffsetDateTime tombstoneAt) {
            this.lastSeenAt = slot.sampleTs();
            this.lastRestartLsn = slot.restartLsn();
            this.lastStatsReset = slot.statsReset();
            this.lastActive = slot.active();
            this.lastWalStatus = slot.walStatus();
            this.inactiveSince = inactiveSince;
            this.lastRetriggerAt = lastRetriggerAt;
            this.tombstoneAt = tombstoneAt;
        }
    }
}
