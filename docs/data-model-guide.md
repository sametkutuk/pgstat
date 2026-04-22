# pgstat Veri Modeli Rehberi

Merkezi PostgreSQL'de 5 schema, 28 tablo ve 220+ partition bulunur.

---

## Schema Yapısı

| Schema | Amaç | Kim Yazar | Kim Okur |
|---|---|---|---|
| `control` | Envanter, zamanlama, runtime state | API + Collector | API + Collector |
| `dim` | Tekrar etmeyen tanımlayıcı veriler | Collector | API |
| `fact` | Zaman serisi metrik verileri (günlük partition) | Collector | API |
| `agg` | Rollup tabloları (saatlik/günlük özet) | Collector | API |
| `ops` | Job çalıştırma logları ve alertler | Collector | API |

---

## control — Envanter ve Konfigürasyon

### control.schedule_profile
Toplama frekansları ve timeout değerleri.

| Kolon | Açıklama |
|---|---|
| `profile_code` | Profil adı (unique): `default`, `high-frequency` |
| `cluster_interval_seconds` | Cluster metrikleri toplama aralığı |
| `statements_interval_seconds` | pg_stat_statements toplama aralığı |
| `db_objects_interval_seconds` | Tablo/index istatistikleri toplama aralığı |
| `statement_timeout_ms` | Kaynak PG'de sorgu zaman aşımı |
| `max_host_concurrency` | Paralel host sayısı |
| `max_databases_per_run` | Run başına max DB sayısı |

### control.retention_policy
Veri saklama süreleri.

| Kolon | Açıklama |
|---|---|
| `policy_code` | Politika adı: `standard`, `extended`, `minimal` |
| `raw_retention_months` | Ham fact verisi saklama süresi |
| `hourly_retention_months` | Saatlik rollup saklama süresi |
| `daily_retention_months` | Günlük rollup saklama süresi |
| `purge_enabled` | Otomatik temizlik aktif mi |

### control.instance_inventory
İzlenen her PostgreSQL instance'ın ana kaydı.

| Kolon | Açıklama |
|---|---|
| `instance_pk` | Surrogate PK (bigint identity) |
| `instance_id` | Kullanıcı tanımlı unique kimlik |
| `display_name` | UI'da görünen ad |
| `host`, `port` | Bağlantı bilgileri |
| `admin_dbname` | Collector'ın bağlandığı DB (genellikle `postgres`) |
| `collector_username` | Kaynak PG kullanıcı adı |
| `secret_ref` | Şifre referansı (`file:`, `env:`, `vault:`) |
| `schedule_profile_id` | Hangi toplama profili |
| `retention_policy_id` | Hangi saklama politikası |
| `bootstrap_state` | Keşif durumu: pending → discovering → ready |
| `is_active` | Aktif/pasif |
| `environment` | prod, staging, dev |
| `service_group` | Mantıksal gruplama |

### control.instance_capability
Collector keşfi sonrası doldurulan yetenek bilgileri.

| Kolon | Kaynak | Açıklama |
|---|---|---|
| `pg_major` | `server_version_num / 10000` | PostgreSQL major versiyon |
| `system_identifier` | `pg_control_system()` | Fiziksel cluster kimliği |
| `is_primary` | `pg_is_in_recovery()` | Primary mı, replica mı |
| `has_pg_stat_statements` | Extension kontrolü | pgss var mı |
| `has_pg_stat_io` | PG16+ | pg_stat_io var mı |
| `has_pg_stat_checkpointer` | PG17+ | Ayrı checkpointer view var mı |
| `collector_sql_family` | Versiyon bazlı | `pg11_12`, `pg13`, `pg14_16`, `pg17_18` |

### control.instance_state
Runtime toplama durumu.

| Kolon | Açıklama |
|---|---|
| `last_cluster_collect_at` | Son cluster toplama zamanı |
| `next_cluster_collect_at` | Sonraki planlanan toplama |
| `last_statements_collect_at` | Son statements toplama |
| `current_pgss_epoch_key` | Aktif pgss epoch (reset takibi) |
| `consecutive_failures` | Ardışık hata sayısı |
| `backoff_until` | Exponential backoff bitiş zamanı |

### control.database_state
Per-database toplama durumu (db_objects job için).

| Kolon | Açıklama |
|---|---|
| `instance_pk + dbid` | Composite PK |
| `last_db_objects_collect_at` | Son tablo/index toplama |
| `next_db_objects_collect_at` | Sonraki planlanan |
| `consecutive_failures` | Ardışık hata |

---

## dim — Dimension Tabloları

### dim.query_text
SQL text'leri tüm cluster'lar için global olarak tekilleştirir.

| Kolon | Açıklama |
|---|---|
| `query_text_id` | PK |
| `query_hash` | SHA-256(query_text) — tekilleştirme anahtarı |
| `query_text` | Tam SQL metni |
| `first_seen_instance_pk` | İlk gönderen instance |

**Veri kaynağı:** `pg_stat_statements(true)` — SQL text ile birlikte çekilir.

### dim.statement_series
Teknik istatistik serisi — her unique (instance + epoch + dbid + userid + queryid) kombinasyonu.

| Kolon | Açıklama |
|---|---|
| `statement_series_id` | PK |
| `instance_pk` | Hangi instance |
| `system_identifier` | Fiziksel cluster kimliği |
| `pgss_epoch_key` | Reset/upgrade sonrası yeni epoch |
| `dbid`, `userid`, `queryid` | PG tarafındaki kimlikler |
| `query_text_id` | dim.query_text FK (enrichment sonrası bağlanır) |

**Veri kaynağı:** `pg_stat_statements(false)` — her yeni (dbid, userid, queryid) görüldüğünde upsert.

### dim.database_ref
Kaynak database kimliğini insan okunur isimle eşler.

| Kolon | Açıklama |
|---|---|
| `instance_pk + dbid` | Unique |
| `datname` | Database adı |
| `last_seen_at` | Son görülme (drop tespiti için) |

**Veri kaynağı:** `pg_stat_database` — collector keşif sırasında otomatik oluşturur.

### dim.relation_ref
Tablo ve index kimliklerini isimlerle eşler.

| Kolon | Açıklama |
|---|---|
| `instance_pk + dbid + relid` | Unique |
| `schemaname`, `relname` | Schema ve obje adı |
| `relkind` | `r` = tablo, `i` = index |

**Veri kaynağı:** `pg_stat_user_tables`, `pg_stat_user_indexes` — db_objects job sırasında upsert.

### dim.role_ref
Kaynak rol kimliğini isimle eşler.

| Kolon | Açıklama |
|---|---|
| `instance_pk + userid` | Unique |
| `rolname` | Rol adı |

---

## fact — Zaman Serisi Metrik Tabloları

Tüm fact tabloları `PARTITION BY RANGE (sample_ts veya snapshot_ts)` ile günlük partition'lanır.

### fact.pgss_delta
`pg_stat_statements` delta verileri — en kritik tablo.

| Kolon | Kaynak PG View | Açıklama |
|---|---|---|
| `sample_ts` | Toplama zamanı | Partition anahtarı |
| `instance_pk` | — | Hangi instance |
| `statement_series_id` | — | dim.statement_series FK |
| `calls_delta` | `calls` | Çağrı sayısı farkı |
| `total_exec_time_ms_delta` | `total_exec_time` | Toplam çalışma süresi farkı |
| `rows_delta` | `rows` | Dönen satır farkı |
| `shared_blks_hit_delta` | `shared_blks_hit` | Buffer cache hit farkı |
| `shared_blks_read_delta` | `shared_blks_read` | Diskten okunan blok farkı |
| `temp_blks_written_delta` | `temp_blks_written` | Temp dosya yazma farkı |
| `wal_records_delta` | `wal_records` | WAL kayıt farkı (PG13+) |
| `jit_*_delta` | `jit_*` | JIT derleme süreleri (PG13+) |

**Veri kaynağı:** `pg_stat_statements(false)` — önceki sample ile delta hesaplanır.

### fact.pg_database_delta
`pg_stat_database` delta verileri.

| Kolon | Kaynak PG View | Açıklama |
|---|---|---|
| `instance_pk + dbid` | — | Hangi instance, hangi DB |
| `datname` | `pg_stat_database.datname` | DB adı (join kolaylığı) |
| `xact_commit_delta` | `xact_commit` | Commit sayısı farkı |
| `xact_rollback_delta` | `xact_rollback` | Rollback sayısı farkı |
| `blks_read_delta` | `blks_read` | Disk okuma farkı |
| `blks_hit_delta` | `blks_hit` | Cache hit farkı |
| `tup_inserted/updated/deleted_delta` | `tup_*` | DML istatistikleri |
| `deadlocks_delta` | `deadlocks` | Deadlock sayısı farkı |
| `temp_files_delta` | `temp_files` | Temp dosya sayısı farkı |

**Veri kaynağı:** `pg_stat_database` — db_objects job sırasında.

### fact.pg_table_stat_delta
Tablo istatistikleri.

| Kolon | Kaynak PG View | Açıklama |
|---|---|---|
| `instance_pk + dbid + relid` | — | Hangi tablo |
| `schemaname`, `relname` | View'dan | Tablo adı |
| `seq_scan_delta` | `pg_stat_user_tables` | Sequential scan farkı |
| `idx_scan_delta` | `pg_stat_user_tables` | Index scan farkı |
| `n_tup_ins/upd/del_delta` | `pg_stat_user_tables` | DML farkları |
| `heap_blks_read/hit_delta` | `pg_statio_user_tables` | I/O farkları |
| `n_live_tup_estimate` | `pg_stat_user_tables` | Canlı satır tahmini (gauge) |
| `n_dead_tup_estimate` | `pg_stat_user_tables` | Ölü satır tahmini (gauge) |

**Veri kaynağı:** `pg_stat_user_tables` + `pg_statio_user_tables` — db_objects job.

### fact.pg_index_stat_delta
Index istatistikleri.

| Kolon | Kaynak PG View | Açıklama |
|---|---|---|
| `instance_pk + dbid + index_relid` | — | Hangi index |
| `idx_scan_delta` | `pg_stat_user_indexes` | Index scan farkı |
| `idx_tup_read_delta` | `pg_stat_user_indexes` | Okunan tuple farkı |
| `idx_blks_read/hit_delta` | `pg_statio_user_indexes` | I/O farkları |

**Veri kaynağı:** `pg_stat_user_indexes` + `pg_statio_user_indexes` — db_objects job.

### fact.pg_cluster_delta
Cluster geneli metrikler — generic key-value modeli.

| Kolon | Açıklama |
|---|---|
| `metric_family` | `pg_stat_bgwriter`, `pg_stat_wal`, `pg_stat_checkpointer` |
| `metric_name` | Kolon adı (ör: `buffers_checkpoint`, `wal_bytes`) |
| `metric_value_num` | Delta değer |

**Veri kaynağı:**
- `pg_stat_bgwriter` — tüm versiyonlar
- `pg_stat_wal` — PG13+
- `pg_stat_checkpointer` — PG17+

### fact.pg_io_stat_delta
`pg_stat_io` (PG16+) — çok boyutlu I/O istatistikleri.

| Kolon | Açıklama |
|---|---|
| `backend_type` | `client backend`, `autovacuum worker`, `checkpointer` |
| `object` | `relation`, `temp relation` |
| `context` | `normal`, `vacuum`, `bulkread`, `bulkwrite` |
| `reads_delta`, `writes_delta` | I/O operasyon farkları |
| `hits_delta`, `evictions_delta` | Buffer istatistikleri |

**Veri kaynağı:** `pg_stat_io` — yalnızca PG16+ instance'lardan.

### fact.pg_activity_snapshot
Aktif session anlık görüntüsü — delta hesaplanmaz, her cluster job'da tam snapshot.

| Kolon | Kaynak PG View | Açıklama |
|---|---|---|
| `snapshot_ts` | Toplama zamanı | Partition anahtarı |
| `pid` | `pg_stat_activity.pid` | Process ID |
| `datname`, `usename` | `pg_stat_activity` | DB ve kullanıcı |
| `state` | `pg_stat_activity.state` | active, idle, idle in transaction |
| `wait_event_type`, `wait_event` | `pg_stat_activity` | Bekleme bilgisi |
| `query` | `pg_stat_activity.query` | Çalışan sorgu (1000 karakter) |
| `backend_type` | `pg_stat_activity` | client backend, autovacuum, vb. |

**Veri kaynağı:** `pg_stat_activity` — collector'ın kendi session'ı hariç.

### fact.pg_replication_snapshot
Replikasyon durumu — yalnızca primary node'lardan.

| Kolon | Kaynak PG View | Açıklama |
|---|---|---|
| `pid` | `pg_stat_replication.pid` | Replica process |
| `application_name` | `pg_stat_replication` | Replica adı |
| `state` | `pg_stat_replication.state` | streaming, catchup, vb. |
| `replay_lag` | `pg_stat_replication` | Replay gecikmesi (interval) |
| `replay_lag_bytes` | Hesaplanan | sent_lsn - replay_lsn (byte) |
| `sync_state` | `pg_stat_replication` | async, sync, quorum |

**Veri kaynağı:** `pg_stat_replication` — `pg_is_in_recovery() = false` olan node'lardan.

### fact.pg_lock_snapshot
Bekleyen lock'lar — `granted = false`.

| Kolon | Kaynak PG View | Açıklama |
|---|---|---|
| `pid` | `pg_locks.pid` | Bekleyen process |
| `locktype` | `pg_locks.locktype` | relation, transactionid, tuple, advisory |
| `mode` | `pg_locks.mode` | AccessShareLock, RowExclusiveLock, vb. |
| `granted` | `pg_locks.granted` | Lock alındı mı |
| `blocked_by_pids` | `pg_blocking_pids()` | Bloklayan PID listesi |

**Veri kaynağı:** `pg_locks` + `pg_blocking_pids()`.

### fact.pg_progress_snapshot
Devam eden uzun operasyonlar (vacuum, analyze, create index, vb.).

| Kolon | Kaynak PG View | Açıklama |
|---|---|---|
| `command` | — | VACUUM, ANALYZE, CREATE INDEX |
| `phase` | `pg_stat_progress_*` | İşlem aşaması |
| `blocks_total`, `blocks_done` | `pg_stat_progress_*` | İlerleme |
| `progress_pct` | Hesaplanan | Yüzde tamamlanma |

**Veri kaynağı:**
- `pg_stat_progress_vacuum` — tüm versiyonlar
- `pg_stat_progress_analyze` — PG13+
- `pg_stat_progress_create_index` — PG12+

---

## agg — Rollup Tabloları

### agg.pgss_hourly
Saatlik statement özeti — `fact.pgss_delta`'dan üretilir.

| Kolon | Açıklama |
|---|---|
| `bucket_start` | Saat başı (partition anahtarı — aylık) |
| `instance_pk + statement_series_id` | Unique key |
| `calls_sum` | Toplam çağrı |
| `exec_time_ms_sum` | Toplam çalışma süresi |
| `rows_sum` | Toplam satır |
| `shared_blks_read_sum` | Toplam disk okuma |
| `shared_blks_hit_sum` | Toplam cache hit |

**Üretim:** Rollup job, son tamamlanan saat için `INSERT ... ON CONFLICT DO UPDATE` (idempotent).

### agg.pgss_daily
Günlük statement özeti — `agg.pgss_hourly`'den üretilir.

Aynı kolonlar, `bucket_start` günlük. Yıllık partition.

**Üretim:** Rollup job, UTC `daily_rollup_hour_utc` saatinde bir önceki günü toplar.

---

## ops — Operasyon Tabloları

### ops.job_run
Her collector job çalıştırmasının kaydı.

| Kolon | Açıklama |
|---|---|
| `job_run_id` | PK |
| `job_type` | cluster, statements, db_objects, rollup |
| `started_at`, `finished_at` | Başlangıç/bitiş zamanı |
| `status` | success, failed, partial |
| `rows_written` | Yazılan toplam satır |
| `instances_succeeded` | Başarılı instance sayısı |
| `instances_failed` | Başarısız instance sayısı |
| `worker_hostname` | Hangi collector |

### ops.job_run_instance
Instance bazlı job detayı.

| Kolon | Açıklama |
|---|---|
| `job_run_id` | FK → ops.job_run |
| `instance_pk` | Hangi instance |
| `status` | success, failed, partial, skipped |
| `new_series_count` | Yeni statement series sayısı |
| `new_query_text_count` | Yeni SQL text sayısı |
| `error_text` | Hata mesajı |

### ops.alert
Sistem uyarıları — UI'daki alert ekranını besler.

| Kolon | Açıklama |
|---|---|
| `alert_key` | Unique dedupe anahtarı (ör: `connection_failure:instance:42`) |
| `alert_code` | Alert tipi kodu |
| `severity` | critical, error, warning, info |
| `status` | open, acknowledged, resolved |
| `instance_pk` | İlgili instance (null olabilir — job seviyesi) |
| `occurrence_count` | Aynı alert kaç kez tekrarlandı |
| `first_seen_at`, `last_seen_at` | İlk ve son görülme |
| `resolved_at` | Çözülme zamanı |
| `details_json` | Ek detay (JSONB) |

---

## Veri Akış Özeti

```
Kaynak PG'ler
    │
    │  pg_stat_statements(false)  ──→  fact.pgss_delta
    │  pg_stat_statements(true)   ──→  dim.query_text + dim.statement_series
    │  pg_stat_database           ──→  fact.pg_database_delta + dim.database_ref
    │  pg_stat_user_tables        ──→  fact.pg_table_stat_delta + dim.relation_ref
    │  pg_stat_user_indexes       ──→  fact.pg_index_stat_delta + dim.relation_ref
    │  pg_stat_bgwriter/wal/chk   ──→  fact.pg_cluster_delta
    │  pg_stat_io                 ──→  fact.pg_io_stat_delta
    │  pg_stat_activity           ──→  fact.pg_activity_snapshot
    │  pg_stat_replication        ──→  fact.pg_replication_snapshot
    │  pg_locks                   ──→  fact.pg_lock_snapshot
    │  pg_stat_progress_*         ──→  fact.pg_progress_snapshot
    │
    ▼
Collector (delta hesaplama + batch yazma)
    │
    ▼
Merkezi PostgreSQL
    │
    │  fact.pgss_delta  ──rollup──→  agg.pgss_hourly  ──rollup──→  agg.pgss_daily
    │
    ▼
API (okuma) ──→ UI (gösterim)
```

---

## Partition Yapısı

| Tablo | Partition Tipi | Aralık | Örnek |
|---|---|---|---|
| `fact.pgss_delta` | Günlük | `sample_ts` | `fact.pgss_delta_20260420` |
| `fact.pg_database_delta` | Günlük | `sample_ts` | `fact.pg_database_delta_20260420` |
| `fact.pg_table_stat_delta` | Günlük | `sample_ts` | — |
| `fact.pg_index_stat_delta` | Günlük | `sample_ts` | — |
| `fact.pg_cluster_delta` | Günlük | `sample_ts` | — |
| `fact.pg_io_stat_delta` | Günlük | `sample_ts` | — |
| `fact.pg_activity_snapshot` | Günlük | `snapshot_ts` | — |
| `fact.pg_replication_snapshot` | Günlük | `snapshot_ts` | — |
| `fact.pg_lock_snapshot` | Günlük | `snapshot_ts` | — |
| `fact.pg_progress_snapshot` | Günlük | `snapshot_ts` | — |
| `agg.pgss_hourly` | Aylık | `bucket_start` | `agg.pgss_hourly_202604` |
| `agg.pgss_daily` | Yıllık | `bucket_start` | `agg.pgss_daily_2026` |

Partition'lar rollup job tarafından otomatik oluşturulur:
- Fact: gelecek 14 gün
- Hourly: gelecek 2 ay
- Daily: gelecek 1 yıl
