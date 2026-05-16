# PostgreSQL Core Stat Views — Versiyon Matrisi

Kaynak: postgresql.org/docs/{11..18}/monitoring-stats.html
Tarih: 2026-05-17

---

## pg_stat_activity

- **İlk sürüm:** PG 8.1 (modern hali PG 9.2+)
- **Granularite:** cluster (per-backend process)
- **Snapshot vs Delta:** snapshot (anlık durum)
- **Etkinleştirme:** track_activities=on (varsayılan)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| datid | oid | 8.1 | Bağlı database OID |
| datname | name | 8.1 | Database adı |
| pid | integer | 8.1 | Backend process ID |
| leader_pid | integer | 13 | Parallel group leader PID |
| usesysid | oid | 8.1 | Kullanıcı OID |
| usename | name | 8.1 | Kullanıcı adı |
| application_name | text | 9.0 | Uygulama adı |
| client_addr | inet | 8.1 | Client IP adresi |
| client_hostname | text | 9.1 | Client hostname (log_hostname=on) |
| client_port | integer | 9.1 | Client TCP port |
| backend_start | timestamptz | 8.1 | Backend başlangıç zamanı |
| xact_start | timestamptz | 8.3 | Aktif transaction başlangıcı |
| query_start | timestamptz | 8.1 | Aktif/son sorgu başlangıcı |
| state_change | timestamptz | 9.2 | Son state değişikliği |
| wait_event_type | text | 9.6 | Bekleme olayı tipi |
| wait_event | text | 9.6 | Bekleme olayı adı |
| state | text | 9.2 | Backend durumu (active/idle/...) |
| backend_xid | xid | 9.4 | Backend'in aktif transaction ID |
| backend_xmin | xid | 9.4 | Backend'in xmin horizon |
| query_id | bigint | 14 | Sorgu hash identifier |
| query | text | 8.1 | Aktif/son sorgu metni |
| backend_type | text | 10 | Backend tipi (client/autovacuum/...) |

**Versiyon Değişiklikleri:**
- PG9.2: state, state_change eklendi
- PG9.6: wait_event_type, wait_event eklendi (eski waiting boolean kaldırıldı)
- PG10: backend_type eklendi
- PG13: leader_pid eklendi
- PG14: query_id eklendi (compute_query_id=on gerekir)

---

## pg_stat_replication

- **İlk sürüm:** PG 9.1
- **Granularite:** cluster (per WAL sender)
- **Snapshot vs Delta:** snapshot
- **Etkinleştirme:** varsayılan (primary'de WAL sender varsa dolar)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| pid | integer | 9.1 | WAL sender process ID |
| usesysid | oid | 9.1 | Kullanıcı OID |
| usename | name | 9.1 | Kullanıcı adı |
| application_name | text | 9.1 | Uygulama adı |
| client_addr | inet | 9.1 | Client IP |
| client_hostname | text | 9.1 | Client hostname |
| client_port | integer | 9.1 | Client TCP port |
| backend_start | timestamptz | 9.1 | WAL sender başlangıcı |
| backend_xmin | xid | 9.4 | Standby xmin horizon |
| state | text | 9.1 | WAL sender durumu (streaming/catchup/...) |
| sent_lsn | pg_lsn | 10 | Son gönderilen LSN |
| write_lsn | pg_lsn | 10 | Standby'da yazılan LSN |
| flush_lsn | pg_lsn | 10 | Standby'da flush edilen LSN |
| replay_lsn | pg_lsn | 10 | Standby'da replay edilen LSN |
| write_lag | interval | 10 | Yazma gecikmesi |
| flush_lag | interval | 10 | Flush gecikmesi |
| replay_lag | interval | 10 | Replay gecikmesi |
| sync_priority | integer | 9.1 | Synchronous replication önceliği |
| sync_state | text | 9.1 | Sync durumu (async/sync/quorum/potential) |
| reply_time | timestamptz | 12 | Son reply mesajı zamanı |

**Versiyon Değişiklikleri:**
- PG10: sent_lsn/write_lsn/flush_lsn/replay_lsn eklendi (eski sent_location vb. kaldırıldı); write_lag/flush_lag/replay_lag eklendi
- PG12: reply_time eklendi

---

## pg_stat_replication_slots

- **İlk sürüm:** PG 14
- **Granularite:** cluster (per logical replication slot)
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** varsayılan (logical slot varsa dolar)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| slot_name | text | 14 | Slot adı |
| spill_txns | bigint | 14 | Diske taşan transaction sayısı |
| spill_count | bigint | 14 | Diske taşma sayısı |
| spill_bytes | bigint | 14 | Diske taşan byte |
| stream_txns | bigint | 14 | Stream edilen transaction sayısı |
| stream_count | bigint | 14 | Stream sayısı |
| stream_bytes | bigint | 14 | Stream edilen byte |
| total_txns | bigint | 14 | Toplam decode edilen transaction |
| total_bytes | bigint | 14 | Toplam decode edilen byte |
| stats_reset | timestamptz | 14 | Son stats reset zamanı |

**Versiyon Değişiklikleri:**
- PG14: View oluşturuldu, tüm kolonlar bu sürümde.

---

## pg_stat_subscription

- **İlk sürüm:** PG 10
- **Granularite:** cluster (per subscription worker)
- **Snapshot vs Delta:** snapshot
- **Etkinleştirme:** varsayılan (logical subscription varsa dolar)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| subid | oid | 10 | Subscription OID |
| subname | name | 10 | Subscription adı |
| worker_type | text | 18 | Worker tipi (apply / parallel apply / table synchronization) |
| pid | integer | 10 | Worker process ID |
| leader_pid | integer | 17 | Parallel apply worker leader PID |
| relid | oid | 10 | Sync edilen relation OID (NULL=apply worker) |
| received_lsn | pg_lsn | 10 | Son alınan LSN |
| last_msg_send_time | timestamptz | 10 | Son mesaj gönderim zamanı |
| last_msg_receipt_time | timestamptz | 10 | Son mesaj alım zamanı |
| latest_end_lsn | pg_lsn | 10 | Son raporlanan LSN |
| latest_end_time | timestamptz | 10 | Son raporlama zamanı |

**Versiyon Değişiklikleri:**
- PG17: leader_pid eklendi (parallel apply workers)
- PG18: worker_type eklendi (worker tipi ayrımı: apply / parallel apply / table synchronization)

---

## pg_stat_subscription_stats

- **İlk sürüm:** PG 15
- **Granularite:** cluster (per subscription)
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** varsayılan

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| subid | oid | 15 | Subscription OID |
| subname | name | 15 | Subscription adı |
| apply_error_count | bigint | 15 | Apply hata sayısı |
| sync_error_count | bigint | 15 | Sync hata sayısı |
| confl_insert_exists | bigint | 18 | NOT DEFERRABLE unique ihlali (insert) |
| confl_update_origin_differs | bigint | 18 | Başka kaynak tarafından değiştirilmiş satır update |
| confl_update_exists | bigint | 18 | NOT DEFERRABLE unique ihlali (update) |
| confl_update_missing | bigint | 18 | Update edilecek satır bulunamadı |
| confl_delete_origin_differs | bigint | 18 | Başka kaynak tarafından değiştirilmiş satır delete |
| confl_delete_missing | bigint | 18 | Delete edilecek satır bulunamadı |
| confl_multiple_unique_conflicts | bigint | 18 | Birden fazla unique constraint ihlali |
| stats_reset | timestamptz | 15 | Son stats reset zamanı |

**Versiyon Değişiklikleri:**
- PG15: View oluşturuldu
- PG18: 7 detaylı conflict kolonu eklendi (confl_insert_exists, confl_update_origin_differs, confl_update_exists, confl_update_missing, confl_delete_origin_differs, confl_delete_missing, confl_multiple_unique_conflicts)

---

## pg_stat_wal_receiver

- **İlk sürüm:** PG 9.6
- **Granularite:** cluster (tek satır, standby'da)
- **Snapshot vs Delta:** snapshot
- **Etkinleştirme:** varsayılan (standby'da WAL receiver varsa dolar)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| pid | integer | 9.6 | WAL receiver process ID |
| status | text | 9.6 | Aktivite durumu |
| receive_start_lsn | pg_lsn | 9.6 | Başlangıç LSN |
| receive_start_tli | integer | 9.6 | Başlangıç timeline |
| written_lsn | pg_lsn | 13 | Yazılan ama flush edilmemiş LSN |
| flushed_lsn | pg_lsn | 9.6 | Flush edilen LSN |
| received_tli | integer | 9.6 | Alınan timeline |
| last_msg_send_time | timestamptz | 9.6 | Son mesaj gönderim zamanı |
| last_msg_receipt_time | timestamptz | 9.6 | Son mesaj alım zamanı |
| latest_end_lsn | pg_lsn | 9.6 | Son raporlanan LSN |
| latest_end_time | timestamptz | 9.6 | Son raporlama zamanı |
| slot_name | text | 9.6 | Kullanılan slot adı |
| sender_host | text | 12 | Sender host |
| sender_port | integer | 12 | Sender port |
| conninfo | text | 9.6 | Connection string (güvenlik: şifre maskelenir) |

**Versiyon Değişiklikleri:**
- PG12: sender_host, sender_port eklendi
- PG13: written_lsn eklendi

---

## pg_stat_recovery_prefetch

- **İlk sürüm:** PG 15
- **Granularite:** cluster (tek satır, standby'da)
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** recovery_prefetch=on (varsayılan: try)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| stats_reset | timestamptz | 15 | Son stats reset |
| prefetch | bigint | 15 | Prefetch edilen blok sayısı |
| hit | bigint | 15 | Buffer cache'te bulunan blok |
| skip_init | bigint | 15 | Init sayfası olduğu için atlanan |
| skip_new | bigint | 15 | Yeni blok olduğu için atlanan |
| skip_fpw | bigint | 15 | Full page write olduğu için atlanan |
| skip_rep | bigint | 15 | Tekrar olduğu için atlanan |
| wal_distance | integer | 15 | WAL mesafesi (blok) |
| block_distance | integer | 15 | Blok mesafesi |
| io_depth | integer | 15 | Aktif I/O derinliği |

---

## pg_stat_archiver

- **İlk sürüm:** PG 9.4
- **Granularite:** cluster (tek satır)
- **Snapshot vs Delta:** delta (archived_count, failed_count monotonik)
- **Etkinleştirme:** archive_mode=on

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| archived_count | bigint | 9.4 | Başarılı arşivleme sayısı |
| last_archived_wal | text | 9.4 | Son arşivlenen WAL dosyası |
| last_archived_time | timestamptz | 9.4 | Son başarılı arşivleme zamanı |
| failed_count | bigint | 9.4 | Başarısız arşivleme sayısı |
| last_failed_wal | text | 9.4 | Son başarısız WAL dosyası |
| last_failed_time | timestamptz | 9.4 | Son başarısız arşivleme zamanı |
| stats_reset | timestamptz | 9.4 | Son stats reset |

---

## pg_stat_bgwriter

- **İlk sürüm:** PG 8.3
- **Granularite:** cluster (tek satır)
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** varsayılan

**Kolonlar (PG16 ve öncesi — checkpoint dahil):**

| Kolon | Tip | PG'de Eklendi | PG17'de Kaldırıldı | Anlam |
|---|---|---|---|---|
| checkpoints_timed | bigint | 8.3 | ✓ (→ checkpointer) | Zamanlı checkpoint sayısı |
| checkpoints_req | bigint | 8.3 | ✓ (→ checkpointer) | İstenen checkpoint sayısı |
| checkpoint_write_time | float8 | 9.2 | ✓ (→ checkpointer) | Checkpoint yazma süresi ms |
| checkpoint_sync_time | float8 | 9.2 | ✓ (→ checkpointer) | Checkpoint sync süresi ms |
| buffers_checkpoint | bigint | 8.3 | ✓ (→ checkpointer) | Checkpoint sırasında yazılan buffer |
| buffers_clean | bigint | 8.3 | — | Bgwriter tarafından yazılan buffer |
| maxwritten_clean | bigint | 8.3 | — | Bgwriter'ın çok yazma nedeniyle durma sayısı |
| buffers_backend | bigint | 8.3 | ✓ (PG17'de kaldırıldı) | Backend tarafından yazılan buffer |
| buffers_backend_fsync | bigint | 8.3 | ✓ (PG17'de kaldırıldı) | Backend fsync sayısı |
| buffers_alloc | bigint | 8.3 | — | Ayrılan buffer sayısı |
| stats_reset | timestamptz | 9.1 | — | Son stats reset |

**PG17+ kolonları (checkpoint ayrıldıktan sonra):**

| Kolon | Tip | Anlam |
|---|---|---|
| buffers_clean | bigint | Bgwriter tarafından yazılan buffer |
| maxwritten_clean | bigint | Çok yazma nedeniyle durma sayısı |
| buffers_alloc | bigint | Ayrılan buffer sayısı |
| stats_reset | timestamptz | Son stats reset |

**Versiyon Değişiklikleri:**
- PG17: checkpoints_timed, checkpoints_req, checkpoint_write_time, checkpoint_sync_time, buffers_checkpoint → pg_stat_checkpointer'a taşındı; buffers_backend, buffers_backend_fsync kaldırıldı

---

## pg_stat_wal

- **İlk sürüm:** PG 14
- **Granularite:** cluster (tek satır)
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** varsayılan; wal_write_time/wal_sync_time için track_wal_io_timing=on

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | PG18'de Kaldırıldı | Anlam |
|---|---|---|---|---|
| wal_records | bigint | 14 | — | Üretilen WAL record sayısı |
| wal_fpi | bigint | 14 | — | Full page image sayısı |
| wal_bytes | numeric | 14 | — | Üretilen WAL byte |
| wal_buffers_full | bigint | 14 | — | WAL buffer dolma sayısı |
| wal_write | bigint | 14 | ✓ (→ pg_stat_io) | WAL yazma çağrısı sayısı |
| wal_sync | bigint | 14 | ✓ (→ pg_stat_io) | WAL sync çağrısı sayısı |
| wal_write_time | float8 | 14 | ✓ (→ pg_stat_io) | WAL yazma süresi ms |
| wal_sync_time | float8 | 14 | ✓ (→ pg_stat_io) | WAL sync süresi ms |
| stats_reset | timestamptz | 14 | — | Son stats reset |

**Versiyon Değişiklikleri:**
- PG14: View oluşturuldu
- PG18: wal_write, wal_sync, wal_write_time, wal_sync_time kaldırıldı (pg_stat_io'ya taşındı, object='wal')

**Notlar:** PG13'te pg_stat_wal yoktur; wal_records/wal_fpi/wal_bytes PG13'te pg_stat_statements üzerinden izlenebilir.

---

## pg_stat_io

- **İlk sürüm:** PG 16
- **Granularite:** cluster (per backend_type × object × context)
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** varsayılan; *_time kolonları için track_io_timing=on

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | PG'de Kaldırıldı | Anlam |
|---|---|---|---|---|
| backend_type | text | 16 | — | Backend tipi |
| object | text | 16 | — | I/O hedefi (relation, temp relation; PG18+ wal da dahil) |
| context | text | 16 | — | I/O bağlamı (normal, vacuum, bulkread, bulkwrite; PG18+ init) |
| reads | bigint | 16 | — | Okuma işlemi sayısı |
| read_time | float8 | 16 | — | Okuma süresi ms |
| writes | bigint | 16 | — | Yazma işlemi sayısı |
| write_time | float8 | 16 | — | Yazma süresi ms |
| writebacks | bigint | 16 | — | Writeback sayısı |
| writeback_time | float8 | 16 | — | Writeback süresi ms |
| extends | bigint | 16 | — | Extend işlemi sayısı |
| extend_time | float8 | 16 | — | Extend süresi ms |
| op_bytes | bigint | 16 | 18 | I/O birim boyutu (genelde 8192) |
| read_bytes | numeric | 18 | — | Toplam okunan byte |
| write_bytes | numeric | 18 | — | Toplam yazılan byte |
| extend_bytes | numeric | 18 | — | Toplam extend byte |
| hits | bigint | 16 | — | Buffer cache hit sayısı |
| evictions | bigint | 16 | — | Buffer eviction sayısı |
| reuses | bigint | 16 | — | Ring buffer reuse sayısı |
| fsyncs | bigint | 16 | — | Fsync çağrısı sayısı |
| fsync_time | float8 | 16 | — | Fsync süresi ms |
| stats_reset | timestamptz | 16 | — | Son stats reset |

**Versiyon Değişiklikleri:**
- PG16: View oluşturuldu
- PG18: op_bytes kaldırıldı; read_bytes, write_bytes, extend_bytes eklendi; object artık 'wal' değerini de içeriyor (WAL I/O tracking); context artık 'init' değerini de içeriyor

---

## pg_stat_checkpointer

- **İlk sürüm:** PG 17
- **Granularite:** cluster (tek satır)
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** varsayılan

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| num_timed | bigint | 17 | Zamanlı checkpoint sayısı (skipped dahil) |
| num_requested | bigint | 17 | İstenen checkpoint sayısı (skipped dahil) |
| num_done | bigint | 18 | Tamamlanan checkpoint sayısı |
| restartpoints_timed | bigint | 17 | Zamanlı restartpoint sayısı |
| restartpoints_req | bigint | 17 | İstenen restartpoint sayısı |
| restartpoints_done | bigint | 17 | Tamamlanan restartpoint sayısı |
| write_time | float8 | 17 | Yazma süresi ms |
| sync_time | float8 | 17 | Sync süresi ms |
| buffers_written | bigint | 17 | Yazılan shared buffer sayısı |
| slru_written | bigint | 18 | Yazılan SLRU buffer sayısı |
| stats_reset | timestamptz | 17 | Son stats reset |

**Versiyon Değişiklikleri:**
- PG17: View oluşturuldu (pg_stat_bgwriter'dan ayrıldı)
- PG18: num_done, slru_written eklendi

---

## pg_stat_slru

- **İlk sürüm:** PG 13
- **Granularite:** cluster (per SLRU cache)
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** varsayılan

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| name | text | 13 | SLRU cache adı |
| blks_zeroed | bigint | 13 | Sıfırlanan blok sayısı |
| blks_hit | bigint | 13 | Cache hit sayısı |
| blks_read | bigint | 13 | Diskten okunan blok |
| blks_written | bigint | 13 | Diske yazılan blok |
| blks_exists | bigint | 13 | Varlık kontrolü yapılan blok |
| flushes | bigint | 13 | Flush sayısı |
| truncates | bigint | 13 | Truncate sayısı |
| stats_reset | timestamptz | 13 | Son stats reset |

---

## pg_stat_database

- **İlk sürüm:** PG 7.4
- **Granularite:** cluster (per database)
- **Snapshot vs Delta:** delta (monotonik counter'lar) + gauge (numbackends)
- **Etkinleştirme:** varsayılan; blk_*_time için track_io_timing=on

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| datid | oid | 7.4 | Database OID |
| datname | name | 7.4 | Database adı |
| numbackends | integer | 7.4 | Aktif bağlantı sayısı (gauge) |
| xact_commit | bigint | 7.4 | Commit edilen transaction |
| xact_rollback | bigint | 7.4 | Rollback edilen transaction |
| blks_read | bigint | 7.4 | Okunan disk blok sayısı |
| blks_hit | bigint | 7.4 | Buffer cache hit sayısı |
| tup_returned | bigint | 8.3 | Döndürülen satır (seq scan + idx entries) |
| tup_fetched | bigint | 8.3 | Fetch edilen satır (idx scan) |
| tup_inserted | bigint | 8.3 | Insert edilen satır |
| tup_updated | bigint | 8.3 | Update edilen satır |
| tup_deleted | bigint | 8.3 | Delete edilen satır |
| conflicts | bigint | 9.1 | Recovery conflict nedeniyle iptal edilen sorgu |
| temp_files | bigint | 9.2 | Oluşturulan temp dosya sayısı |
| temp_bytes | bigint | 9.2 | Temp dosyalara yazılan byte |
| deadlocks | bigint | 9.2 | Deadlock sayısı |
| checksum_failures | bigint | 12 | Checksum hatası sayısı |
| checksum_last_failure | timestamptz | 12 | Son checksum hatası zamanı |
| blk_read_time | float8 | 9.2 | Blok okuma süresi ms |
| blk_write_time | float8 | 9.2 | Blok yazma süresi ms |
| session_time | float8 | 14 | Toplam oturum süresi ms |
| active_time | float8 | 14 | Aktif sorgu süresi ms |
| idle_in_transaction_time | float8 | 14 | Idle-in-tx süresi ms |
| sessions | bigint | 14 | Toplam oturum sayısı |
| sessions_abandoned | bigint | 14 | Bağlantı kopan oturum |
| sessions_fatal | bigint | 14 | Fatal hata ile biten oturum |
| sessions_killed | bigint | 14 | Operator tarafından sonlandırılan |
| parallel_workers_to_launch | bigint | 18 | Planlanan parallel worker |
| parallel_workers_launched | bigint | 18 | Başlatılan parallel worker |
| stats_reset | timestamptz | 9.1 | Son stats reset |

**Versiyon Değişiklikleri:**
- PG12: checksum_failures, checksum_last_failure eklendi
- PG14: session_time, active_time, idle_in_transaction_time, sessions, sessions_abandoned, sessions_fatal, sessions_killed eklendi
- PG18: parallel_workers_to_launch, parallel_workers_launched eklendi

---

## pg_stat_database_conflicts

- **İlk sürüm:** PG 9.1
- **Granularite:** cluster (per database, sadece standby'da anlamlı)
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** varsayılan

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| datid | oid | 9.1 | Database OID |
| datname | name | 9.1 | Database adı |
| confl_tablespace | bigint | 9.1 | Tablespace drop nedeniyle iptal |
| confl_lock | bigint | 9.1 | Lock timeout nedeniyle iptal |
| confl_snapshot | bigint | 9.1 | Eski snapshot nedeniyle iptal |
| confl_bufferpin | bigint | 9.1 | Buffer pin nedeniyle iptal |
| confl_deadlock | bigint | 9.1 | Deadlock nedeniyle iptal |
| confl_active_logicalslot | bigint | 16 | Logical slot conflict nedeniyle iptal |

**Versiyon Değişiklikleri:**
- PG16: confl_active_logicalslot eklendi

**Notlar:** confl_active_logicalslot PG16'da eklendi (PG17 değil — doğrulandı).

---

## pg_stat_user_tables (pg_stat_all_tables)

- **İlk sürüm:** PG 7.4
- **Granularite:** per-database, per-table
- **Snapshot vs Delta:** delta (counter'lar) + gauge (n_live_tup, n_dead_tup) + snapshot (last_* timestamps)
- **Etkinleştirme:** track_counts=on (varsayılan)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| relid | oid | 7.4 | Tablo OID |
| schemaname | name | 7.4 | Schema adı |
| relname | name | 7.4 | Tablo adı |
| seq_scan | bigint | 7.4 | Sequential scan sayısı |
| last_seq_scan | timestamptz | 16 | Son seq scan zamanı |
| seq_tup_read | bigint | 7.4 | Seq scan ile okunan satır |
| idx_scan | bigint | 7.4 | Index scan sayısı |
| last_idx_scan | timestamptz | 16 | Son index scan zamanı |
| idx_tup_fetch | bigint | 7.4 | Index scan ile fetch edilen satır |
| n_tup_ins | bigint | 7.4 | Insert edilen satır |
| n_tup_upd | bigint | 7.4 | Update edilen satır |
| n_tup_del | bigint | 7.4 | Delete edilen satır |
| n_tup_hot_upd | bigint | 8.3 | HOT update sayısı |
| n_tup_newpage_upd | bigint | 16 | Yeni sayfaya taşınan update |
| n_live_tup | bigint | 8.3 | Tahmini canlı satır (gauge) |
| n_dead_tup | bigint | 8.3 | Tahmini ölü satır (gauge) |
| n_mod_since_analyze | bigint | 9.4 | Son analyze'den beri değişen satır |
| n_ins_since_vacuum | bigint | 13 | Son vacuum'dan beri insert edilen |
| last_vacuum | timestamptz | 8.2 | Son manuel vacuum zamanı |
| last_autovacuum | timestamptz | 8.2 | Son autovacuum zamanı |
| last_analyze | timestamptz | 8.2 | Son manuel analyze zamanı |
| last_autoanalyze | timestamptz | 8.2 | Son autoanalyze zamanı |
| vacuum_count | bigint | 9.1 | Manuel vacuum sayısı |
| autovacuum_count | bigint | 9.1 | Autovacuum sayısı |
| analyze_count | bigint | 9.1 | Manuel analyze sayısı |
| autoanalyze_count | bigint | 9.1 | Autoanalyze sayısı |
| total_vacuum_time | float8 | 18 | Manuel vacuum toplam süresi ms (cost delay dahil) |
| total_autovacuum_time | float8 | 18 | Autovacuum toplam süresi ms (cost delay dahil) |
| total_analyze_time | float8 | 18 | Manuel analyze toplam süresi ms (cost delay dahil) |
| total_autoanalyze_time | float8 | 18 | Autoanalyze toplam süresi ms (cost delay dahil) |

**Versiyon Değişiklikleri:**
- PG13: n_ins_since_vacuum eklendi
- PG16: last_seq_scan, last_idx_scan, n_tup_newpage_upd eklendi
- PG18: total_vacuum_time, total_autovacuum_time, total_analyze_time, total_autoanalyze_time eklendi (autovacuum süre tracking)

---

## pg_statio_user_tables (pg_statio_all_tables)

- **İlk sürüm:** PG 7.4
- **Granularite:** per-database, per-table
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** track_counts=on (varsayılan)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| relid | oid | 7.4 | Tablo OID |
| schemaname | name | 7.4 | Schema adı |
| relname | name | 7.4 | Tablo adı |
| heap_blks_read | bigint | 7.4 | Heap diskten okunan blok |
| heap_blks_hit | bigint | 7.4 | Heap buffer hit |
| idx_blks_read | bigint | 7.4 | Index diskten okunan blok |
| idx_blks_hit | bigint | 7.4 | Index buffer hit |
| toast_blks_read | bigint | 7.4 | TOAST diskten okunan blok |
| toast_blks_hit | bigint | 7.4 | TOAST buffer hit |
| tidx_blks_read | bigint | 7.4 | TOAST index diskten okunan blok |
| tidx_blks_hit | bigint | 7.4 | TOAST index buffer hit |

**Versiyon Değişiklikleri:** Yok — PG11-18 arasında değişiklik yok.

---

## pg_stat_user_indexes (pg_stat_all_indexes)

- **İlk sürüm:** PG 7.4
- **Granularite:** per-database, per-index
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** track_counts=on (varsayılan)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| relid | oid | 7.4 | Tablo OID |
| indexrelid | oid | 7.4 | Index OID |
| schemaname | name | 7.4 | Schema adı |
| relname | name | 7.4 | Tablo adı |
| indexrelname | name | 7.4 | Index adı |
| idx_scan | bigint | 7.4 | Index scan sayısı |
| last_idx_scan | timestamptz | 16 | Son index scan zamanı |
| idx_tup_read | bigint | 7.4 | Index'ten okunan entry |
| idx_tup_fetch | bigint | 7.4 | Tablodan fetch edilen satır |

**Versiyon Değişiklikleri:**
- PG16: last_idx_scan eklendi

---

## pg_statio_user_indexes (pg_statio_all_indexes)

- **İlk sürüm:** PG 7.4
- **Granularite:** per-database, per-index
- **Snapshot vs Delta:** delta
- **Etkinleştirme:** track_counts=on (varsayılan)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| relid | oid | 7.4 | Tablo OID |
| indexrelid | oid | 7.4 | Index OID |
| schemaname | name | 7.4 | Schema adı |
| relname | name | 7.4 | Tablo adı |
| indexrelname | name | 7.4 | Index adı |
| idx_blks_read | bigint | 7.4 | Diskten okunan blok |
| idx_blks_hit | bigint | 7.4 | Buffer hit |

**Versiyon Değişiklikleri:** Yok.

---

## pg_stat_user_functions

- **İlk sürüm:** PG 8.4
- **Granularite:** per-database, per-function
- **Snapshot vs Delta:** delta (monotonik counter'lar)
- **Etkinleştirme:** track_functions = 'pl' veya 'all' (varsayılan: none)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| funcid | oid | 8.4 | Function OID |
| schemaname | name | 8.4 | Schema adı |
| funcname | name | 8.4 | Function adı |
| calls | bigint | 8.4 | Çağrı sayısı |
| total_time | float8 | 8.4 | Toplam süre ms (alt çağrılar dahil) |
| self_time | float8 | 8.4 | Kendi süresi ms (alt çağrılar hariç) |

**Versiyon Değişiklikleri:** Yok — PG11-18 arasında değişiklik yok.

---

## pg_statio_all_sequences

- **İlk sürüm:** PG 8.3
- **Granularite:** per-database, per-sequence
- **Snapshot vs Delta:** delta
- **Etkinleştirme:** track_counts=on (varsayılan)

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| relid | oid | 8.3 | Sequence OID |
| schemaname | name | 8.3 | Schema adı |
| relname | name | 8.3 | Sequence adı |
| blks_read | bigint | 8.3 | Diskten okunan blok |
| blks_hit | bigint | 8.3 | Buffer hit |

**Versiyon Değişiklikleri:** Yok.

**Notlar:** pg_stat_user_sequences (scan istatistikleri) PG16'da eklenmedi — sadece pg_statio_all_sequences (I/O) mevcuttur.

---

## pg_stat_xact_user_tables / pg_stat_xact_user_functions

- **İlk sürüm:** PG 8.3 / 8.4
- **Granularite:** per-database, per-table/function
- **Snapshot vs Delta:** anlık (transaction-scoped, commit'te sıfırlanır)
- **Etkinleştirme:** varsayılan

**Notlar:** Bu view'lar sadece aktif transaction içindeki değişiklikleri gösterir. Collector için genellikle anlamsız — pg_stat_user_tables zaten kümülatif değerleri verir. Sadece uzun transaction analizi için kullanılabilir.

---

## pg_replication_slots (catalog view)

- **İlk sürüm:** PG 9.4
- **Granularite:** cluster (per slot)
- **Snapshot vs Delta:** snapshot (konfigürasyon + durum)
- **Etkinleştirme:** varsayılan

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | Anlam |
|---|---|---|---|
| slot_name | name | 9.4 | Slot adı |
| plugin | name | 9.4 | Logical decoding plugin |
| slot_type | text | 9.4 | physical / logical |
| datoid | oid | 9.4 | Database OID (logical slot) |
| database | name | 9.4 | Database adı |
| temporary | boolean | 10 | Geçici slot mu |
| active | boolean | 9.4 | Aktif mi |
| active_pid | integer | 9.6 | Kullanan process PID |
| xmin | xid | 9.4 | Slot xmin |
| catalog_xmin | xid | 9.4 | Catalog xmin |
| restart_lsn | pg_lsn | 9.4 | Restart LSN |
| confirmed_flush_lsn | pg_lsn | 9.4 | Onaylanan flush LSN |
| wal_status | text | 13 | WAL durumu (reserved/extended/unreserved/lost) |
| safe_wal_size | bigint | 13 | Güvenli WAL boyutu |
| two_phase | boolean | 15 | 2PC desteği |
| conflicting | boolean | 17 | Conflict durumunda mı |
| invalidation_reason | text | 17 | Geçersizleşme nedeni |
| failover | boolean | 17 | Failover slot mu |
| synced | boolean | 17 | Senkronize edilmiş mi |

**Versiyon Değişiklikleri:**
- PG13: wal_status, safe_wal_size eklendi
- PG15: two_phase eklendi
- PG17: conflicting, invalidation_reason, failover, synced eklendi

---

## pg_stat_progress_vacuum

- **İlk sürüm:** PG 9.6
- **Granularite:** cluster (per aktif vacuum backend)
- **Snapshot vs Delta:** snapshot (anlık ilerleme)
- **Etkinleştirme:** varsayılan

**Kolonlar:**

| Kolon | Tip | PG'de Eklendi | PG'de Kaldırıldı | Anlam |
|---|---|---|---|---|
| pid | integer | 9.6 | — | Backend process ID |
| datid | oid | 9.6 | — | Database OID |
| datname | name | 9.6 | — | Database adı |
| relid | oid | 9.6 | — | Vacuum edilen tablo OID |
| phase | text | 9.6 | — | Aktif faz |
| heap_blks_total | bigint | 9.6 | — | Toplam heap blok sayısı |
| heap_blks_scanned | bigint | 9.6 | — | Taranan heap blok sayısı |
| heap_blks_vacuumed | bigint | 9.6 | — | Vacuum edilen heap blok sayısı |
| index_vacuum_count | bigint | 9.6 | — | Tamamlanan index vacuum döngüsü |
| max_dead_tuples | bigint | 9.6 | 17 (→ max_dead_tuple_bytes) | Max dead tuple kapasitesi |
| num_dead_tuples | bigint | 9.6 | 14 (→ num_dead_item_ids) | Toplanan dead tuple sayısı |
| num_dead_item_ids | bigint | 14 | — | Toplanan dead item ID sayısı |
| max_dead_tuple_bytes | bigint | 17 | — | Max dead tuple byte kapasitesi (TID store) |
| dead_tuple_bytes | bigint | 17 | — | Toplanan dead tuple byte |
| indexes_total | bigint | 17 | — | Vacuum/cleanup edilecek toplam index |
| indexes_processed | bigint | 17 | — | İşlenen index sayısı |

**Versiyon Değişiklikleri:**
- PG14: num_dead_tuples → num_dead_item_ids olarak yeniden adlandırıldı; max_dead_tuples korundu
- PG17: max_dead_tuples kaldırıldı → max_dead_tuple_bytes eklendi; dead_tuple_bytes eklendi (TID store yeniden tasarımı); indexes_total, indexes_processed eklendi; num_dead_item_ids korundu

---

## pg_stat_progress_analyze

- **İlk sürüm:** PG 13
- **Granularite:** cluster (per aktif analyze backend)
- **Snapshot vs Delta:** snapshot (anlık ilerleme)

**Kolonlar:** pid, datid, datname, relid, phase, sample_blks_total, sample_blks_scanned, ext_stats_total, ext_stats_computed, child_tables_total, child_tables_done, current_child_table_relid

---

## pg_stat_progress_create_index

- **İlk sürüm:** PG 12
- **Granularite:** cluster (per aktif CREATE INDEX/REINDEX backend)
- **Snapshot vs Delta:** snapshot (anlık ilerleme)

**Kolonlar:** pid, datid, datname, relid, index_relid, command, phase, lockers_total, lockers_done, current_locker_pid, blocks_total, blocks_done, tuples_total, tuples_done, partitions_total, partitions_done

---

## pg_stat_progress_basebackup

- **İlk sürüm:** PG 13
- **Granularite:** cluster (per WAL sender streaming backup)
- **Snapshot vs Delta:** snapshot

**Kolonlar:** pid, phase, backup_total, backup_streamed, tablespaces_total, tablespaces_streamed

---

## pg_stat_progress_copy

- **İlk sürüm:** PG 14
- **Granularite:** cluster (per COPY backend)
- **Snapshot vs Delta:** snapshot

**Kolonlar:** pid, datid, datname, relid, command, type, bytes_processed, bytes_total, tuples_processed, tuples_excluded, tuples_skipped

---

## pg_stat_progress_cluster

- **İlk sürüm:** PG 12
- **Granularite:** cluster (per CLUSTER/VACUUM FULL backend)
- **Snapshot vs Delta:** snapshot

**Kolonlar:** pid, datid, datname, relid, command, phase, cluster_index_relid, heap_tuples_scanned, heap_tuples_written, heap_blks_total, heap_blks_scanned, index_rebuild_count

---

## Özet Matris

| View | PG11 | PG12 | PG13 | PG14 | PG15 | PG16 | PG17 | PG18 |
|---|---|---|---|---|---|---|---|---|
| pg_stat_activity | ✓ | ✓ | ✓ (+leader_pid) | ✓ (+query_id) | ✓ | ✓ | ✓ | ✓ |
| pg_stat_replication | ✓ | ✓ (+reply_time) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_replication_slots | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_subscription | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (+leader_pid) | ✓ (+worker_type) |
| pg_stat_subscription_stats | — | — | — | — | ✓ | ✓ | ✓ | ✓ (+7 conflict cols) |
| pg_stat_wal_receiver | ✓ | ✓ (+sender_*) | ✓ (+written_lsn) | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_recovery_prefetch | — | — | — | — | ✓ | ✓ | ✓ | ✓ |
| pg_stat_archiver | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_bgwriter | ✓ (full) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (slim) | ✓ (slim) |
| pg_stat_wal | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ (slim) |
| pg_stat_io | — | — | — | — | — | ✓ | ✓ | ✓ (+bytes,+wal) |
| pg_stat_checkpointer | — | — | — | — | — | — | ✓ | ✓ (+num_done,+slru) |
| pg_stat_slru | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_database | ✓ | ✓ (+checksum) | ✓ | ✓ (+sessions) | ✓ | ✓ | ✓ | ✓ (+parallel) |
| pg_stat_database_conflicts | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (+logicalslot) | ✓ | ✓ |
| pg_stat_user_tables | ✓ | ✓ | ✓ (+n_ins_since) | ✓ | ✓ | ✓ (+last_*,+newpage) | ✓ | ✓ (+vacuum_time*) |
| pg_statio_user_tables | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_user_indexes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (+last_idx_scan) | ✓ | ✓ |
| pg_statio_user_indexes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_user_functions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_statio_all_sequences | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_replication_slots | ✓ | ✓ | ✓ (+wal_status) | ✓ | ✓ (+two_phase) | ✓ | ✓ (+conflicting) | ✓ |
| pg_stat_progress_vacuum | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_progress_analyze | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_progress_create_index | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_progress_basebackup | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_progress_copy | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| pg_stat_progress_cluster | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## Tavsiye

### Must-Have (her instance'ta toplanmalı)

| View | Neden |
|---|---|
| pg_stat_database | Temel workload metrikleri, alert'ler |
| pg_stat_database_conflicts | Standby conflict monitoring |
| pg_stat_bgwriter / pg_stat_checkpointer | Checkpoint ve buffer write performansı |
| pg_stat_wal | WAL üretim hızı |
| pg_stat_activity | Aktif bağlantı ve sorgu monitoring |
| pg_stat_replication | Replication lag |
| pg_stat_user_tables + pg_statio_user_tables | Tablo erişim ve I/O pattern'leri |
| pg_stat_user_indexes + pg_statio_user_indexes | Index kullanım analizi |
| pg_stat_archiver | WAL arşivleme sağlığı |
| pg_replication_slots | Slot lag ve WAL retention |
| pg_stat_io (PG16+) | Detaylı I/O breakdown |

### Opsiyonel (büyük ortamlarda yük getirebilir)

| View | Not |
|---|---|
| pg_stat_user_functions | track_functions='all' gerekir, çok fonksiyon varsa satır sayısı yüksek |
| pg_statio_all_sequences | Genelde az sequence olur, düşük yük |
| pg_stat_slru | Düşük yük, nadir kullanılır ama checkpoint tuning için faydalı |
| pg_stat_subscription / _stats | Sadece logical replication varsa anlamlı; PG18+ conflict kolonları detaylı conflict root-cause analizi sağlar |
| pg_stat_recovery_prefetch | Sadece standby'da, prefetch tuning için |
| pg_stat_wal_receiver | Sadece standby'da |

### Anlık (delta yok, sadece çağrı anında okunur)

| View | Not |
|---|---|
| pg_stat_activity | Her snapshot bağımsız, öncekiyle karşılaştırma yok |
| pg_stat_replication | Anlık durum |
| pg_stat_progress_* | Geçici — sadece operasyon süresince satır var |
| pg_stat_xact_user_tables | Transaction-scoped, collector için genelde gereksiz |

### Etkinleştirme Gerektiren

| Parametre | Etkilenen View/Kolon |
|---|---|
| track_io_timing=on | pg_stat_database.blk_*_time, pg_stat_io.*_time |
| track_wal_io_timing=on | pg_stat_wal.wal_write_time/wal_sync_time |
| track_functions='all'/'pl' | pg_stat_user_functions |
| track_counts=on (varsayılan) | Tüm tablo/index stat view'ları |
| track_activities=on (varsayılan) | pg_stat_activity |
| compute_query_id=on/auto | pg_stat_activity.query_id |
| archive_mode=on | pg_stat_archiver |
| recovery_prefetch=on/try | pg_stat_recovery_prefetch |
