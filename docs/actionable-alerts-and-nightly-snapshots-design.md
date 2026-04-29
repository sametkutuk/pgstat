# Tasarım: Gece PG Snapshot + 5 Aksiyon-Odaklı Alert

## Özet

| Bileşen | Açıklama |
|---------|----------|
| A. Gece Snapshot | UTC 03:00'te pg_settings, tablo/index boyutları, sequence durumu, xid age toplanır |
| B. 5 Alert | UTC 04:00'te snapshot + fact verisi üzerinden aksiyon-odaklı alert'ler tetiklenir |

---

## A. Gece PG Parametre Snapshot

### Problem
Alert'ler "work_mem ne?" veya "tablo boyutu ne?" bilgisine ihtiyaç duyuyor ama bu bilgiler runtime delta tablolarında yok. Statik/yarı-statik catalog bilgileri günde 1 kez toplanmalı.

### V039 — 4 Yeni Tablo

| Tablo | İçerik | Kaynak |
|-------|--------|--------|
| `fact.pg_settings_snapshot` | Seçili PG parametreleri (work_mem, shared_buffers, vb.) | `pg_settings` |
| `fact.pg_relation_size_snapshot` | Tablo/index/toast boyutları | `pg_class` + `pg_total_relation_size()` |
| `fact.pg_sequence_state_snapshot` | Sequence doluluk oranı | `pg_sequences` (PG10+) |
| `fact.pg_database_freeze_snapshot` | XID age (wraparound riski) | `pg_database` |

### Collector Mimarisi

```
JobOrchestrator (UTC 03:00)
  └── NightlySnapshotCollector.collectAll(instance)
        ├── collectSettings(conn, instancePk, now)      → pg_settings_snapshot
        ├── collectRelationSizes(conn, instancePk, now) → pg_relation_size_snapshot (per-DB)
        ├── collectSequenceStates(conn, instancePk, now)→ pg_sequence_state_snapshot (per-DB)
        └── collectFreezeAge(conn, instancePk, now)     → pg_database_freeze_snapshot
```

### Per-DB Bağlantı
`pg_relation_size` ve `pg_sequences` her DB'ye ayrı bağlantı gerektirir. Mevcut `SourceConnectionFactory` admin DB'ye bağlanır. Her aktif DB için `connectToDatabase(instance, datname)` metodu eklenir.

### PG Sürüm Uyumluluğu
- `pg_sequences` view: PG10+ (tüm izlenen instance'lar PG12+, sorun yok)
- `idle_in_transaction_time`: PG14+ (PG12'de graceful skip)
- `mxid_age()`: PG9.4+ (sorun yok)

### Partition & Retention
- Daily partition (mevcut PartitionManager'a eklenir)
- Default retention: 30 gün (mevcut purge schedule ile uyumlu)

---

## B. 5 Aksiyon-Odaklı Alert

### Genel Mimari

```
JobOrchestrator (UTC 04:00, snapshot'tan 1 saat sonra)
  └── ActionableAlertEvaluator.evaluateAll()
        ├── checkIndexSuspectMissing()
        ├── checkIndexUnused()
        ├── checkHighTempFiles()
        ├── checkIdleInTxTimeHigh()
        └── checkReplicationSlotInactive()
```

### Alert Detayları

#### 1. INDEX_SUSPECT_MISSING
- **Koşul:** seq_scan/idx_scan > 100 AND seq_tup_read > 100K AND tablo > 10MB
- **Veri kaynağı:** `fact.pg_table_stat_delta` (son 24h) + `fact.pg_relation_size_snapshot`
- **Severity:** warning
- **Aksiyon:** CREATE INDEX CONCURRENTLY önerisi + EXPLAIN sorgusu

#### 2. INDEX_UNUSED
- **Koşul:** 30 gün idx_scan = 0 AND index > 100MB
- **Veri kaynağı:** `fact.pg_index_stat_delta` (son 30g) + `fact.pg_relation_size_snapshot`
- **Severity:** info
- **Aksiyon:** DROP INDEX CONCURRENTLY önerisi

#### 3. HIGH_TEMP_FILES
- **Koşul:** temp_files > 100/saat
- **Veri kaynağı:** `fact.pg_database_delta` (son 1h) + `fact.pg_settings_snapshot` (work_mem)
- **Severity:** warning
- **Aksiyon:** ALTER SYSTEM SET work_mem önerisi + top 3 temp üreten sorgu

#### 4. IDLE_IN_TX_TIME_HIGH
- **Koşul:** idle_in_transaction_time / session_time > 30% (PG14+)
- **Veri kaynağı:** `fact.pg_database_delta` (son 1h)
- **Severity:** warning
- **Aksiyon:** pg_stat_activity sorgusu + pg_terminate_backend önerisi

#### 5. REPLICATION_SLOT_INACTIVE
- **Koşul:** active=false, 1 saat boyunca hep inactive, slot_lag > 1GB
- **Veri kaynağı:** `fact.pg_replication_slot_snapshot` (son 1h)
- **Severity:** warning
- **Aksiyon:** pg_drop_replication_slot önerisi

### Cooldown
- Mevcut `alertRepo.upsert()` zaten idempotent (occurrence_count++)
- NotificationService spam koruma: sadece yeni alert veya severity yükseldiğinde bildirim
- Alert key format: `actionable:{alert_code}:instance:{pk}:db:{dbid}` (veya `:table:{name}`)

### Snapshot Yoksa Ne Olur?
- `pg_relation_size_snapshot` boşsa → INDEX_SUSPECT_MISSING ve INDEX_UNUSED boyut kontrolü atlanır (sadece scan oranına bakılır)
- `pg_settings_snapshot` boşsa → HIGH_TEMP_FILES'da work_mem bilgisi "?" gösterilir
- Graceful skip, hata vermez

---

## Risk Analizi

| Risk | Etki | Mitigasyon |
|------|------|-----------|
| Per-DB bağlantı yavaş (çok DB) | Snapshot job uzar | max 5 DB/instance limiti, timeout 30s |
| pg_total_relation_size büyük tablolarda yavaş | Snapshot job uzar | Sadece > 1MB relation'lar |
| PG12'de idle_in_transaction_time yok | Alert tetiklenmez | Graceful skip (kolon yoksa catch) |
| İlk gece snapshot boş | Alert'ler tetiklenmez | Beklenen davranış, ertesi gece çalışır |
| Çok fazla unused index alert | Gürültü | > 100MB filtresi + günde 1 kez |

---

## Doğrulama Checklist

- [ ] `cd collector && mvn clean compile -DskipTests` → BUILD SUCCESS
- [ ] `cd api && npx tsc --noEmit` → EXIT 0
- [ ] `cd ui && npx tsc --noEmit` → EXIT 0
- [ ] V039 migration idempotent
- [ ] V040 migration idempotent
- [ ] PartitionManager 4 yeni tabloyu partition'lıyor
- [ ] NightlySnapshotCollector UTC 03:00'te çalışıyor (log)
- [ ] ActionableAlertEvaluator UTC 04:00'te çalışıyor (log)
- [ ] 5 alert kodu AlertCode enum'unda
- [ ] Snapshot yokken alert'ler graceful skip
