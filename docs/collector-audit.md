# Collector Coverage Audit — 2026-05-17

Referans: `docs/pg-stat-views-matrix.md` (doğrulanmış)
Kaynak kod: `collector/src/main/java/com/pgstat/collector/`

---

## Özet Tablosu

| View | Toplanıyor mu? | Sorgu Tam mı? | Tablo Var mı? | Bug Riski |
|---|---|---|---|---|
| pg_stat_activity | ✓ | ✓ | ✓ | — |
| pg_stat_replication | ✓ | ✓ | ✓ | — |
| pg_stat_replication_slots | ✓ | ⚠ Kısmi | ✓ | PG17+ kolonlar eksik |
| pg_stat_subscription | ✓ | ⚠ Kısmi | ✓ | PG18 worker_type eksik |
| pg_stat_subscription_stats | ✓ (join ile) | ⚠ Kısmi | ✓ (join) | PG18 conflict kolonları eksik |
| pg_stat_wal_receiver | ✗ YOK | — | ✗ YOK | ORTA (standby monitoring gap) |
| pg_stat_recovery_prefetch | ✓ | ✓ | ✓ | — |
| pg_stat_archiver | ✓ | ✓ | ✓ | — |
| pg_stat_bgwriter | ✓ | ✓ | ✓ | — |
| pg_stat_wal | ✓ | ✓ | ✓ (cluster_delta) | — |
| pg_stat_io | ✓ | ✓ | ✓ | — |
| pg_stat_checkpointer | ✓ | ✓ | ✓ (cluster_delta) | — |
| pg_stat_slru | ✓ | ✓ | ✓ | — |
| pg_replication_slots | ✓ | ⚠ Kısmi | ✓ | PG17+ kolonlar eksik |
| pg_stat_database | ✓ | ✓ | ✓ | — |
| pg_stat_database_conflicts | ✓ | ✓ | ✓ | — |
| pg_stat_user_tables | ✓ | ⚠ Kısmi | ✓ | PG18 vacuum_time eksik |
| pg_statio_user_tables | ✓ (join) | ✓ | ✓ (join) | — |
| pg_stat_user_indexes | ✓ | ✓ | ✓ | — |
| pg_statio_user_indexes | ✓ (join) | ✓ | ✓ (join) | — |
| pg_stat_user_functions | ✓ | ✓ | ✓ | — |
| pg_statio_all_sequences | ✓ | ✓ | ✓ | — |
| pg_stat_progress_vacuum | ✓ | ⚠ Kısmi | ✓ | Sadece temel kolonlar |
| pg_stat_progress_analyze | ✓ | ⚠ Kısmi | ✓ | Sadece temel kolonlar |
| pg_stat_progress_create_index | ✓ | ⚠ Kısmi | ✓ | Sadece temel kolonlar |
| pg_stat_progress_basebackup | ✗ YOK | — | ✗ YOK | DÜŞÜK |
| pg_stat_progress_copy | ✗ YOK | — | ✗ YOK | DÜŞÜK |
| pg_stat_progress_cluster | ✗ YOK | — | ✗ YOK | DÜŞÜK |

---

## Detaylı Bulgular

### View: pg_stat_activity

**Durum:** ✓ Tam

**Sorgu:**
- Mevcut: `Pg11_12Queries.activityQuery()`, `Pg13Queries.activityQuery()`, `Pg14_16Queries.activityQuery()`
- Kolonlar: pid, datname, usename, application_name, client_addr, backend_start, xact_start, query_start, state_change, state, wait_event_type, wait_event, query, backend_type, usesysid, client_hostname, client_port, backend_xid, backend_xmin, leader_pid (PG13+), query_id (PG14+)
- Eksik: datid (OID — mevcut sorgularda yok ama datname var, fonksiyonel olarak yeterli)

**Java okuma:** `ClusterCollector.collectActivity()` — tüm kolonlar okunuyor.

**Tablo:** `fact.pg_activity_snapshot` (V004 + V066)

**Repository:** `FactRepository.insertActivitySnapshot()` — 23 parametre, tümü yazılıyor.

**Tavsiye:** datid eksik ama datname mevcut — düşük öncelik.

---

### View: pg_stat_replication

**Durum:** ✓ Tam

**Sorgu:**
- Mevcut: `Pg11_12Queries.replicationQuery()` — to_jsonb ile reply_time safe-lookup
- Kolonlar: pid, usename, application_name, client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, write_lag, flush_lag, replay_lag, sync_state, replay_lag_bytes (computed), usesysid, client_hostname, client_port, backend_start, backend_xmin, sync_priority, reply_time

**Java okuma:** `ClusterCollector.collectReplication()` — tüm kolonlar okunuyor.

**Tablo:** `fact.pg_replication_snapshot` (V004 + V066)

**Repository:** `FactRepository.insertReplicationSnapshot()` — 23 parametre, tümü yazılıyor.

**Tavsiye:** Tam. Eksik yok.

---

### View: pg_stat_replication_slots

**Durum:** ⚠ Kısmi

**Sorgu:**
- Mevcut: `SourceQueries.replicationSlotsQuery()` (default, PG14+), `Pg11_12Queries` ve `Pg13Queries` override (null/stub)
- Mevcut kolonlar: slot_name, plugin, slot_type, database, active, active_pid, xmin_int, catalog_xmin_int, restart_lsn, confirmed_flush_lsn, wal_status, safe_wal_size, slot_lag_bytes, spill_txns/count/bytes, stream_txns/count/bytes, total_txns/bytes, stats_reset
- Eksik kolonlar (pg_replication_slots catalog view'dan):
  - `temporary` (PG10+)
  - `two_phase` (PG15+)
  - `conflicting` (PG17+)
  - `invalidation_reason` (PG17+)
  - `failover` (PG17+)
  - `synced` (PG17+)

**Java okuma:** `ClusterCollector.collectSlotSnapshot()` — mevcut kolonlar okunuyor.

**Tablo:** `fact.pg_replication_slot_snapshot` (V024 + V066)
- Eksik kolonlar: temporary, two_phase, conflicting, invalidation_reason, failover, synced

**Repository:** `FactRepository.insertSlotSnapshot()` — mevcut kolonlar yazılıyor.

**Tavsiye:** PG17+ slot health monitoring için `conflicting`, `invalidation_reason`, `failover`, `synced` kritik. `two_phase` ve `temporary` orta öncelik.

---

### View: pg_stat_subscription

**Durum:** ⚠ Kısmi

**Sorgu:**
- Mevcut: `SourceQueries.subscriptionQuery()` (default PG15+), `Pg11_12Queries`, `Pg13Queries`, `Pg17_18Queries` override
- Mevcut kolonlar: subid, subname, pid, relid, received_lsn, last_msg_send_time, last_msg_receipt_time, latest_end_lsn, latest_end_time, lag_bytes (computed), apply_error_count (join), sync_error_count (join), stats_reset (join), leader_pid (PG17+ to_jsonb)
- Eksik kolonlar:
  - `worker_type` (PG18+) — worker tipi ayrımı

**Java okuma:** `ClusterCollector.collectSubscriptionSnapshot()` — mevcut kolonlar okunuyor.

**Tablo:** `fact.pg_subscription_snapshot` (V026 + V066 leader_pid)
- Eksik: worker_type

**Tavsiye:** PG18 `worker_type` eklenmeli — parallel apply debugging için önemli.

---

### View: pg_stat_subscription_stats

**Durum:** ⚠ Kısmi (subscription query'ye join ile)

**Sorgu:**
- Mevcut: `subscriptionQuery()` içinde `left join pg_stat_subscription_stats ss` ile
- Mevcut kolonlar: apply_error_count, sync_error_count, stats_reset
- Eksik kolonlar (PG18+):
  - `confl_insert_exists`
  - `confl_update_origin_differs`
  - `confl_update_exists`
  - `confl_update_missing`
  - `confl_delete_origin_differs`
  - `confl_delete_missing`
  - `confl_multiple_unique_conflicts`

**Tablo:** Ayrı tablo yok — subscription_snapshot içinde join kolonları.
- Eksik: 7 conflict kolonu

**Tavsiye:** PG18 logical replication conflict root-cause analizi için 7 conflict kolonu eklenmeli. Ayrı tablo veya mevcut subscription_snapshot'a ek kolonlar.

---

### View: pg_stat_wal_receiver

**Durum:** ✗ Tamamen Yok

**Sorgu:** YOK — `SourceQueries` interface'inde method tanımı yok.

**Java okuma:** YOK — hiçbir collector'da collect metodu yok.

**Tablo:** YOK — fact tablosu mevcut değil.

**Tavsiye:** Standby monitoring için ORTA öncelik. Standby'da WAL receiver durumu, lag, sender bilgisi önemli. Yeni `walReceiverQuery()` method + `fact.pg_wal_receiver_snapshot` tablo + collect metodu gerekli.

---

### View: pg_stat_recovery_prefetch

**Durum:** ✓ Tam

**Sorgu:** `SourceQueries.recoveryPrefetchQuery()` (PG15+), Pg11_12/Pg13 null döner.
- Tüm kolonlar: prefetch, hit, skip_init, skip_new, skip_fpw, skip_rep, stats_reset, wal_distance, block_distance, io_depth

**Tablo:** `fact.pg_recovery_prefetch_snapshot` (V026)

**Tavsiye:** Tam. Eksik yok.

---

### View: pg_stat_archiver

**Durum:** ✓ Tam

**Sorgu:** `SourceQueries.archiverQuery()` — tüm kolonlar mevcut.

**Tablo:** `fact.pg_archiver_snapshot` (V023)

**Tavsiye:** Tam. Eksik yok.

---

### View: pg_stat_bgwriter

**Durum:** ✓ Tam

**Sorgu:**
- `Pg11_12Queries.bgwriterQuery()` — PG11-16: checkpoints_timed, checkpoints_req, checkpoint_write_time, checkpoint_sync_time, buffers_checkpoint, buffers_clean, maxwritten_clean, buffers_backend, buffers_backend_fsync, buffers_alloc, stats_reset
- `Pg17_18Queries.bgwriterQuery()` — PG17+: buffers_clean, maxwritten_clean, buffers_alloc, stats_reset

**Tablo:** `fact.pg_cluster_delta` (key-value model, V004)

**Tavsiye:** Tam. Versiyon geçişi doğru yönetiliyor.

---

### View: pg_stat_wal

**Durum:** ✓ Tam

**Sorgu:**
- `Pg14_16Queries.walQuery()` — PG14+: wal_records, wal_fpi, wal_bytes, wal_buffers_full, wal_write, wal_sync, wal_write_time, wal_sync_time, stats_reset (to_jsonb safe-lookup)
- `Pg17_18Queries.walQuery()` — aynı, PG18'de kaldırılan kolonlar to_jsonb ile 0 döner
- Pg11_12/Pg13: null (view yok)

**Tablo:** `fact.pg_cluster_delta` (key-value model)

**Tavsiye:** Tam. PG18 breaking change doğru yönetiliyor (to_jsonb safe-lookup).

---

### View: pg_stat_io

**Durum:** ✓ Tam

**Sorgu:** `Pg14_16Queries.ioStatQuery()` — PG16+: backend_type, object, context, reads, read_time, writes, write_time, extends, extend_time, hits, evictions, reuses, fsyncs, fsync_time, writebacks, writeback_time, op_bytes, read_bytes, write_bytes, extend_bytes, stats_reset (to_jsonb safe-lookup)

**Java okuma:** `ClusterCollector.collectIoStats()` — reads, read_time, writes, write_time, extends, extend_time, hits, evictions, reuses, fsyncs, fsync_time okunuyor.
- ⚠ writebacks, writeback_time, op_bytes, read_bytes, write_bytes, extend_bytes, stats_reset SQL'de SELECT'leniyor ama `collectIoStats()` bunları OKUMUYOR (ResultSet'ten çekilmiyor).

**Tablo:** `fact.pg_io_stat_delta` (V004 + V066)
- V066'da writebacks_delta, writeback_time_ms_delta, op_bytes, read_bytes_delta, write_bytes_delta, extend_bytes_delta, stats_reset eklendi.

**Repository:** `FactRepository.insertIoStatDelta()` — eski 15 parametre, yeni V066 kolonları parametre olarak EKLENMEMİŞ.

**Tavsiye:** 🔴 Silent data loss — SQL'de 7 yeni kolon SELECT'leniyor, Java'da okunmuyor, Repository'ye geçirilmiyor. `collectIoStats()` ve `insertIoStatDelta()` güncellenmeli.

---

### View: pg_stat_checkpointer

**Durum:** ✓ Tam

**Sorgu:** `Pg17_18Queries.checkpointerQuery()` — PG17+: checkpoints_timed (num_timed), checkpoints_req (num_requested), checkpoint_write_time, checkpoint_sync_time, buffers_checkpoint (buffers_written), restartpoints_timed, restartpoints_req, restartpoints_done, num_done (PG18 to_jsonb), slru_written (PG18 to_jsonb), stats_reset

**Java okuma:** `ClusterCollector.collectClusterMetrics()` → `readMetrics()` — generic key-value okuma, tüm sayısal kolonlar otomatik okunur.

**Tablo:** `fact.pg_cluster_delta` (key-value model)

**Tavsiye:** Tam. Key-value model sayesinde yeni kolonlar otomatik yakalanıyor.

---

### View: pg_stat_slru

**Durum:** ✓ Tam

**Sorgu:** `SourceQueries.slruQuery()` (PG13+), Pg11_12 null döner.
- Tüm kolonlar: name, blks_zeroed, blks_hit, blks_read, blks_written, blks_exists, flushes, truncates, stats_reset

**Tablo:** `fact.pg_slru_snapshot` (V026)

**Tavsiye:** Tam. Eksik yok.

---

### View: pg_replication_slots (catalog)

**Durum:** ⚠ Kısmi

**Sorgu:** `replicationSlotsQuery()` — pg_replication_slots + pg_stat_replication_slots join
- Mevcut: slot_name, plugin, slot_type, database, active, active_pid, xmin, catalog_xmin, restart_lsn, confirmed_flush_lsn, wal_status, safe_wal_size, slot_lag_bytes
- Eksik (catalog kolonları):
  - `temporary` (PG10+)
  - `two_phase` (PG15+)
  - `conflicting` (PG17+)
  - `invalidation_reason` (PG17+)
  - `failover` (PG17+)
  - `synced` (PG17+)

**Tavsiye:** Yukarıda pg_stat_replication_slots ile birlikte değerlendirildi. PG17+ slot health kolonları kritik.

---

### View: pg_stat_database

**Durum:** ✓ Tam

**Sorgu:**
- `Pg11_12Queries.databaseStatsQuery()` — to_jsonb ile checksum_last_failure; sessions/parallel_workers 0 olarak
- `Pg14_16Queries.databaseStatsQuery()` — sessions, sessions_*, parallel_workers to_jsonb
- Tüm kolonlar mevcut

**Java okuma:** `DbObjectsCollector.collectDatabaseStats()` — tüm kolonlar okunuyor.

**Tablo:** `fact.pg_database_delta` (V004 + V066)

**Tavsiye:** Tam. Eksik yok.

---

### View: pg_stat_database_conflicts

**Durum:** ✓ Tam

**Sorgu:** `SourceQueries.databaseConflictsQuery()` — to_jsonb ile confl_active_logicalslot (PG16+)
- Tüm kolonlar: datid, datname, confl_tablespace, confl_lock, confl_snapshot, confl_bufferpin, confl_deadlock, confl_active_logicalslot

**Java okuma:** `ClusterCollector.collectConflictSnapshot()` — tüm kolonlar okunuyor.

**Tablo:** `fact.pg_database_conflict_snapshot` (V024 + V066)

**Tavsiye:** Tam. Eksik yok.

---

### View: pg_stat_user_tables (pg_stat_all_tables + pg_statio_user_tables)

**Durum:** ⚠ Kısmi

**Sorgu:**
- `Pg11_12Queries.tableStatsQuery()` — join ile pg_statio_user_tables dahil
- `Pg13Queries.tableStatsQuery()` — n_ins_since_vacuum eklendi
- `Pg14_16Queries.tableStatsQuery()` — last_seq_scan, last_idx_scan, n_tup_newpage_upd to_jsonb
- Mevcut kolonlar: relid, schemaname, relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch, n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd, vacuum_count, autovacuum_count, analyze_count, autoanalyze_count, heap_blks_read/hit, idx_blks_read/hit, toast_blks_read/hit, tidx_blks_read/hit, n_live_tup, n_dead_tup, n_mod_since_analyze, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze, n_ins_since_vacuum, last_seq_scan, last_idx_scan, n_tup_newpage_upd
- Eksik kolonlar (PG18+):
  - `total_vacuum_time` (float8)
  - `total_autovacuum_time` (float8)
  - `total_analyze_time` (float8)
  - `total_autoanalyze_time` (float8)

**Java okuma:** `DbObjectsCollector.collectTableStats()` — mevcut kolonlar okunuyor.

**Tablo:** `fact.pg_table_stat_delta` (V004 + V066)
- Eksik: total_vacuum_time, total_autovacuum_time, total_analyze_time, total_autoanalyze_time

**Tavsiye:** PG18 vacuum/analyze süre tracking kolonları eklenmeli. Autovacuum performans analizi için değerli.

---

### View: pg_stat_user_indexes (pg_stat_all_indexes + pg_statio_user_indexes)

**Durum:** ✓ Tam

**Sorgu:** `Pg14_16Queries.indexStatsQuery()` — to_jsonb ile last_idx_scan
- Tüm kolonlar mevcut

**Tablo:** `fact.pg_index_stat_delta` (V004 + V066)

**Tavsiye:** Tam. Eksik yok.

---

### View: pg_stat_user_functions

**Durum:** ✓ Tam

**Sorgu:** `SourceQueries.userFunctionsQuery()` — funcid, schemaname, funcname, calls, total_time, self_time

**Tablo:** `fact.pg_user_function_snapshot` (V026)

**Tavsiye:** Tam. Eksik yok.

---

### View: pg_statio_all_sequences

**Durum:** ✓ Tam

**Sorgu:** `SourceQueries.sequenceIoQuery()` — relid, schemaname, relname, blks_read, blks_hit

**Tablo:** `fact.pg_sequence_io_snapshot` (V028)

**Tavsiye:** Tam. Eksik yok.

---

### View: pg_stat_progress_vacuum

**Durum:** ⚠ Kısmi

**Sorgu:** `Pg11_12Queries.progressVacuumQuery()` — normalize edilmiş format: pid, command, datname, relname, phase, blocks_total, blocks_done, tuples_total, tuples_done, progress_pct
- Eksik (ham view kolonları):
  - `heap_blks_total`, `heap_blks_scanned`, `heap_blks_vacuumed` (alias'lanmış ama orijinal isimlerle değil)
  - `index_vacuum_count` — eksik
  - `max_dead_tuple_bytes` (PG17+) — eksik
  - `dead_tuple_bytes` (PG17+) — eksik
  - `num_dead_item_ids` (PG14+) — eksik
  - `indexes_total` (PG17+) — eksik
  - `indexes_processed` (PG17+) — eksik

**Tablo:** `fact.pg_progress_snapshot` (V004) — generic progress tablosu (pid, command, datname, relname, phase, blocks_total, blocks_done, tuples_total, tuples_done, progress_pct)

**Tavsiye:** Progress view'ları generic bir tabloya normalize ediliyor. Vacuum-spesifik kolonlar (dead_tuple_bytes, index_vacuum_count vb.) kaybediliyor. DÜŞÜK öncelik — progress snapshot'lar anlık ve kısa ömürlü.

---

### View: pg_stat_progress_analyze

**Durum:** ⚠ Kısmi (aynı generic normalize)

**Sorgu:** `Pg13Queries.progressAnalyzeQuery()` — generic format

**Tavsiye:** Aynı durum — generic normalize. Düşük öncelik.

---

### View: pg_stat_progress_create_index

**Durum:** ⚠ Kısmi (aynı generic normalize)

**Sorgu:** `Pg11_12Queries.progressCreateIndexQuery()` — generic format

**Tavsiye:** Aynı durum. Düşük öncelik.

---

### View: pg_stat_progress_basebackup

**Durum:** ✗ Tamamen Yok

**Sorgu:** YOK — `SourceQueries` interface'inde method yok.

**Tavsiye:** DÜŞÜK öncelik. Basebackup nadiren çalışır, anlık snapshot.

---

### View: pg_stat_progress_copy

**Durum:** ✗ Tamamen Yok

**Sorgu:** YOK

**Tavsiye:** DÜŞÜK öncelik. COPY operasyonları genelde kısa ömürlü.

---

### View: pg_stat_progress_cluster

**Durum:** ✗ Tamamen Yok

**Sorgu:** YOK

**Tavsiye:** DÜŞÜK öncelik. CLUSTER/VACUUM FULL nadiren çalışır.

---

## Sonuç Özetleri

### 🔴 Kritik Eksikler (must-fix)

1. **pg_stat_io — Silent Data Loss (collectIoStats)**
   - SQL'de 7 yeni kolon SELECT'leniyor (writebacks, writeback_time, op_bytes, read_bytes, write_bytes, extend_bytes, stats_reset)
   - Java `collectIoStats()` bunları ResultSet'ten OKUMUYOR
   - `FactRepository.insertIoStatDelta()` imzası güncellenmemiş
   - V066 migration'da tablo kolonları eklendi ama veri akışı tamamlanmadı
   - **Etki:** PG16+ instance'larda writeback ve byte-level I/O metrikleri kaybolıyor

### ⚠ Orta Öncelik

2. **pg_stat_wal_receiver — Tamamen Yok**
   - Standby instance'larda WAL receiver durumu izlenemiyor
   - Replication monitoring gap: sender tarafı (pg_stat_replication) var ama receiver tarafı yok
   - Gerekli: yeni query method + fact tablosu + collect metodu

3. **pg_replication_slots — PG17+ Slot Health Kolonları Eksik**
   - `conflicting`, `invalidation_reason`, `failover`, `synced` toplanmıyor
   - Slot invalidation alerting için kritik (slot kaybolursa logical replication durur)
   - Gerekli: sorgu genişletme + migration + repository güncelleme

4. **pg_stat_user_tables — PG18 Vacuum/Analyze Time Kolonları Eksik**
   - `total_vacuum_time`, `total_autovacuum_time`, `total_analyze_time`, `total_autoanalyze_time`
   - Autovacuum performans analizi ve "vacuum neden yavaş" sorusuna cevap için değerli
   - Gerekli: sorgu genişletme (to_jsonb) + migration + collector güncelleme

5. **pg_stat_subscription — PG18 worker_type Eksik**
   - Worker tipi ayrımı (apply vs parallel apply vs tablesync) yapılamıyor
   - Gerekli: sorgu genişletme + migration + collector güncelleme

6. **pg_stat_subscription_stats — PG18 Conflict Kolonları Eksik**
   - 7 detaylı conflict kolonu (confl_insert_exists, confl_update_*, confl_delete_*, confl_multiple_unique_conflicts)
   - Logical replication conflict root-cause analizi için kritik
   - Gerekli: sorgu genişletme + migration + collector güncelleme

### Düşük Öncelik / Skip Önerisi

7. **pg_stat_progress_basebackup / _copy / _cluster — Tamamen Yok**
   - Anlık snapshot, kısa ömürlü operasyonlar
   - Mevcut progress_vacuum/analyze/create_index zaten generic tabloya yazılıyor
   - **Öneri:** SKIP — collector polling interval'ı (60s) bu operasyonları yakalamak için çok yavaş

8. **pg_stat_progress_* — Vacuum-Spesifik Kolonlar Eksik**
   - dead_tuple_bytes, index_vacuum_count, indexes_total vb. generic normalize'da kayboluyor
   - **Öneri:** SKIP — progress snapshot'lar debugging amaçlı, alert/dashboard için kullanılmıyor

9. **pg_replication_slots — temporary, two_phase Eksik**
   - Düşük değer — nadiren kullanılan slot özellikleri
   - **Öneri:** PG17+ slot health kolonlarıyla birlikte eklenebilir (ek maliyet yok)

---

### Versiyon-Spesifik Gaps

| PG Sürüm | Eksik Veri |
|---|---|
| PG11-13 | pg_stat_wal yok (walQuery null) — tasarım gereği, sorun değil |
| PG11-12 | pg_stat_slru yok — tasarım gereği |
| PG11-15 | pg_stat_io yok — tasarım gereği |
| PG11-16 | pg_stat_checkpointer yok — bgwriter'da checkpoint metrikleri var |
| PG16+ | pg_stat_io writebacks/bytes okunmuyor — 🔴 BUG |
| PG17+ | Slot conflicting/failover/synced eksik — ⚠ gap |
| PG18+ | vacuum_time, worker_type, 7 conflict kolonu eksik — ⚠ gap |
| Tüm standby | pg_stat_wal_receiver tamamen yok — ⚠ gap |

---

### Aksiyon Planı Önerisi (öncelik sırasıyla)

1. **BUG FIX:** `collectIoStats()` + `insertIoStatDelta()` — writebacks, writeback_time, op_bytes, read_bytes, write_bytes, extend_bytes, stats_reset okuma ve yazma (V066 migration zaten yapıldı, sadece Java tarafı eksik)

2. **PG17+ Slot Health:** replicationSlotsQuery'ye conflicting, invalidation_reason, failover, synced ekle (to_jsonb safe-lookup) + migration + repository

3. **pg_stat_wal_receiver:** Yeni view toplama — query + tablo + collector (standby monitoring tamamlansın)

4. **PG18 Kolonları:** vacuum_time (table), worker_type (subscription), 7 conflict kolonu (subscription_stats) — to_jsonb safe-lookup ile

5. **Skip:** progress_basebackup, progress_copy, progress_cluster, progress vacuum-specific kolonlar
