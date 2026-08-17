# Domain 1: Veri Modeli & Storage Lifecycle

Durum: taslak — kullanıcı incelemesi bekliyor
Program: [PGSTAT-P1-008](../project-board.json) — bkz. [docs/spec/README.md](README.md)

## 1. Kapsam

**Dahil olan dosyalar:**
- `db/migrations/V001__create_schemas.sql`
- `db/migrations/V002__control_tables.sql`
- `db/migrations/V003__dim_tables.sql`
- `db/migrations/V004__fact_tables.sql`
- `db/migrations/V005__agg_tables.sql`
- `db/migrations/V006__ops_tables.sql`
- `db/migrations/V007__initial_partitions.sql`
- `db/migrations/V008__seed_data.sql`
- `db/migrations/V022__retention_days.sql` (retention'ı ay-bazlıdan gün-bazlıya çeviren migration)
- `collector/src/main/java/com/pgstat/collector/service/PartitionManager.java` (tam)
- `collector/src/main/java/com/pgstat/collector/service/PurgeEvaluator.java` (tam)
- `collector/src/main/java/com/pgstat/collector/repository/AggRepository.java` (tam)
- `api/src/routes/retentionPolicies.ts`, `api/src/routes/scheduleProfiles.ts`
- `ui/src/pages/Settings.tsx` — sadece `RetentionTab` ve `ScheduleTab` bölümleri

**Ayrıca referans alınan** (retention_policy/schedule_profile şemasını sonradan genişleten, bu iki tabloyu değiştirdiği için bu domain'in parçası sayılan) migration'lar: `V037` (job_run_retention_days), `V054__snapshot_retention_increase.sql` (snapshot_retention_hours default artışı), `V061__wal_daily_rollup.sql` (daily_snapshot_retention_days), `V068__pg_table_stat_hourly_agg.sql` (agg.pg_table_stat_hourly tablosu — MONTHLY_AGG_TABLES listesinde), `V078__table_freeze_snapshot.sql` (table_freeze_retention_days, table_freeze_interval_seconds), `V080__rollup_interval_default.sql` (hourly_rollup_interval_seconds default değişimi), `V083__nightly_snapshot_retention.sql` (nightly_snapshot_retention_days), `V085__pgss_hourly_wal_and_latency.sql` (agg.pgss_hourly ek kolonlar), `V086__audit_alert_retention.sql` (audit_log_retention_days, alert_retention_days), `V087__monthly_agg_partition_gap_repair.sql` (partition gap düzeltmesi).

**Açıkça hariç tutulan** (başka domain'lere ait, sadece varlığına referans verilir, detaya girilmez):
- Alert altyapısı: `ops.alert` tablosunun **kullanım mantığı** (V011-V020, V025, V030, V032-V036, V040, V042, V044, V046, V056-V060, V062-V065, V073 vb.) — sadece `ops.alert` şeması V006 kapsamında bahsedilir.
- Adaptive alerting: V018-V021.
- Snapshot'a özel domain tabloları (WAL, archiver, replication slot, SLRU, subscription, activity/lock/progress detay iş mantığı, nightly snapshot'ların kendi collector mantığı) — bunlar `PartitionManager`/`PurgeEvaluator` listelerinde adı geçtiği için (partition/purge mekanizması bu domain'e ait) isim olarak yer alıyor, ama tablo şemaları/collector detayları başka domain dokümanına bırakılıyor.
- `report_config`, `report_history`, `notification_log`, `telegram_message_map`, `audit_log` — `PurgeEvaluator` içinde purge metodu bu domain'e ait olduğu için (`purgeReportsAndNotifications`, `purgeAuditLog`, `purgeAlerts`, `purgeJobRunHistory`) mekanizma anlatılıyor, ama tablo şemaları hariç.

## 2. Veri Kaynakları

### control.schedule_profile — V002 (satır 9-38), sonraki değişiklikler: V078, V080

| Kolon | Tip | Default/Kısıt |
|---|---|---|
| schedule_profile_id | bigint identity | PK |
| profile_code | text | not null, unique |
| cluster_interval_seconds | integer | not null, default 60, >0 |
| statements_interval_seconds | integer | not null, default 300, >0 |
| db_objects_interval_seconds | integer | not null, default 1800, >0 |
| hourly_rollup_interval_seconds | integer | not null, default **300** (V080'de 3600→300; V002'de orijinal default 3600) |
| daily_rollup_hour_utc | integer | not null, default 1, 0-23 arası |
| bootstrap_sql_text_batch | integer | not null, default 100, >0 |
| max_databases_per_run | integer | not null, default 5, >0 |
| statement_timeout_ms | integer | not null, default 5000, >0 |
| lock_timeout_ms | integer | not null, default 250, >=0 |
| connect_timeout_seconds | integer | not null, default 5, >0 |
| max_host_concurrency | integer | not null, default 1, >0 |
| is_active | boolean | not null, default true |
| created_at / updated_at | timestamptz | not null, default now(); `trg_schedule_profile_updated_at` trigger `control.set_updated_at()` ile update'te otomatik güncellenir |
| table_freeze_interval_seconds | integer | **V078** ile eklendi, not null, default 21600, check >= 3600 |

Bu tabloyu okuyan Java sınıfı bu domain'in dosyaları arasında yok (JobOrchestrator/scheduler başka domain'e ait); `PartitionManager`/`PurgeEvaluator` bu tabloyu **okumaz**, sadece `control.retention_policy`'yi okur. `schedule_profile`'ı API tarafında `api/src/routes/scheduleProfiles.ts` okur/yazar.

### control.retention_policy — V002 (satır 41-55), yeniden şekillendirme: V022, sonrasında V037, V054, V061, V078, V083, V086

V002 orijinal (ay bazlı):

| Kolon | Tip | Not |
|---|---|---|
| retention_policy_id | bigint identity | PK |
| policy_code | text | not null, unique |
| raw_retention_months | integer | not null, >0 |
| hourly_retention_months | integer | not null, >0 |
| daily_retention_months | integer | not null, >0 |
| is_active | boolean | not null, default true |
| purge_enabled | boolean | not null, default true |
| created_at/updated_at | timestamptz | not null default now(), trigger ile güncellenir |

V022 ile eklenen gün-bazlı kolonlar (satır 9-51): `raw_retention_days`, `hourly_retention_days`, `daily_retention_days` (integer, not null sonradan set edilir, defaultlar 14/30/365), `snapshot_retention_hours` (integer, not null, default 48 → **V054 ile default 720'ye çıktı**, ayrıca seed'e göre policy bazlı farklı). Eski `_months` kolonları **silinmedi**, uyumluluk için kaldı (bkz. bölüm 9).

Sonraki migration'larla eklenen kolonlar:
- `job_run_retention_days` integer not null default 30 (**V037**)
- `daily_snapshot_retention_days` smallint not null default 365 (**V061**)
- `hourly_snapshot_retention_days` smallint not null default 90 (**V055__snapshot_hourly_rollup.sql** — üç ayrı dosya olarak var: bkz. bölüm 9)
- `table_freeze_retention_days` integer not null default 90 (**V078**)
- `nightly_snapshot_retention_days` integer not null default 180, check >0 (**V083**)
- `audit_log_retention_days` integer default 90 → not null (**V086**)
- `alert_retention_days` integer default 90 → not null (**V086**)

**Java erişimi:** `PurgeEvaluator` sınıfının tüm metotları bu tabloyu okur (write etmez — sadece SELECT). `PartitionManager` bu tabloyu **hiç okumaz** (partition oluşturma retention'dan bağımsız, sadece "gelecek" partition yaratır).

### dim.query_text — V003 (satır 8-19)

| Kolon | Tip | Not |
|---|---|---|
| query_text_id | bigint identity | PK |
| query_hash | bytea | not null, unique, check `octet_length = 32` (SHA-256 hash) |
| query_text | text | not null |
| query_text_len | integer | generated always as `length(query_text)` stored |
| first_seen_at / last_seen_at | timestamptz | not null default now() |
| first_seen_instance_pk | bigint | FK → `control.instance_inventory(instance_pk)` on delete set null |
| source_pg_major | integer | null |

Bu tabloya yazan sınıf `DimensionRepository` / `TextEnricher` (StatementsCollector zinciri, başka domain — burada sadece isim referansı).

### dim.database_ref, dim.relation_ref, dim.role_ref — V003

Instance bazında OID→ad eşleştirmesi tutan referans tabloları. `database_ref`: `(database_ref_id PK, instance_pk FK, dbid oid, datname text, is_template bool null, first_seen_at, last_seen_at)`, unique `(instance_pk, dbid)`. `relation_ref`: `(relation_ref_id PK, instance_pk FK, dbid oid, relid oid, schemaname, relname, relkind, parent_relid oid null, first_seen_at, last_seen_at)`, unique `(instance_pk, dbid, relid)`. `role_ref`: `(role_ref_id PK, instance_pk FK, userid oid, rolname, first_seen_at, last_seen_at)`, unique `(instance_pk, userid)`. Yazan sınıf `DimensionRepository` (başka domain).

### dim.statement_series — V003 (satır 60-87)

`(statement_series_id PK identity, instance_pk, pg_major, collector_sql_family, system_identifier, pgss_epoch_key, dbid, userid, toplevel boolean null, queryid bigint not null, query_text_id FK null, first_seen_at, last_seen_at)`. Doğal unique index (`uq_statement_series_natural`, satır 77-87) `coalesce(toplevel::text,'unknown')` kullanarak NULL toplevel'i destekler — yani `toplevel` NULL olan satırlar da tekilleştirilir. `fact.pgss_delta.statement_series_id` bu tabloya FK'dır.

### fact.pgss_delta — V004 (satır 11-46), partition key: `sample_ts` (range)

PK: `(sample_ts, instance_pk, statement_series_id)`. `statement_series_id` FK → `dim.statement_series`. Tüm delta kolonları (`calls_delta` not null, `plans_delta` null, `total_exec_time_ms_delta` not null, diğerleri null) — check constraint'ler negatif olmayı engeller (calls_delta >= 0, total_exec_time_ms_delta >= 0, vb.) Yazan: `StatementsCollector` → `FactRepository` (başka domain, sadece referans). Okuyan/rollup eden: `AggRepository.rollupHourly()`, `rollupWalHourly()`.

### fact.pg_database_delta — V004 (satır 49-80), partition key `sample_ts`

PK `(sample_ts, instance_pk, dbid)`. Zorunlu kolonlar `xact_commit_delta`, `xact_rollback_delta`, `blks_read_delta`, `blks_hit_delta`, `tup_returned/fetched/inserted/updated/deleted_delta` (hepsi not null, >=0 check). Diğer sayaçlar (`conflicts_delta`, `temp_files_delta`, vb.) null olabilir. Yazan: `ClusterCollector`/`FactRepository`.

### fact.pg_table_stat_delta — V004 (satır 83-121), partition key `sample_ts`

PK `(sample_ts, instance_pk, dbid, relid)`. `pg_stat_user_tables` + `pg_statio_user_tables` birleşik delta + `n_live_tup_estimate`/`n_dead_tup_estimate`/`n_mod_since_analyze` (snapshot değerler, delta değil). Rollup edilen tablo: `AggRepository.rollupTableStatHourly()` → `agg.pg_table_stat_hourly`.

### fact.pg_index_stat_delta — V004 (satır 124-144), partition key `sample_ts`

PK `(sample_ts, instance_pk, dbid, index_relid)`. `table_relid` ayrı kolon (index'in ait olduğu tablo).

### fact.pg_cluster_delta — V004 (satır 147-156), partition key `sample_ts`

Key-value model: `(sample_ts, instance_pk, metric_family, metric_name, metric_value_num numeric)`, PK bu 4 kolon. bgwriter/wal/checkpointer gibi cluster-level metrikler burada satır bazlı tutulur (pivot tablo değil).

### fact.pg_io_stat_delta — V004 (satır 159-177), partition key `sample_ts`

PG16+ `pg_stat_io` için. PK `(sample_ts, instance_pk, backend_type, object, context)`.

### fact.pg_activity_snapshot, fact.pg_lock_snapshot, fact.pg_progress_snapshot, fact.pg_replication_snapshot — V004 (satır 180-250)

Snapshot tipi tablolar, partition key `snapshot_ts`. `pg_lock_snapshot`'ın PK'sı **yok** (sadece index) — diğer üçünde PK `(snapshot_ts, instance_pk, pid)` var. `pg_lock_snapshot` üzerinde `granted = false` partial index (`ix_pg_lock_snapshot_instance_waiting`) bekleyen lock'ları hızlı sorgulamak için.

### agg.pgss_hourly — V005 (satır 8-19), partition key `bucket_start` (aylık), sonradan V085 ile genişletildi

PK `(bucket_start, instance_pk, statement_series_id)`. Orijinal kolonlar: `calls_sum`, `exec_time_ms_sum` (not null), `rows_sum`, `shared_blks_read_sum`, `shared_blks_hit_sum`, `temp_blks_written_sum`. **V085** ile eklenen: `wal_bytes_sum`, `wal_records_sum`, `wal_fpi_sum`, `min_exec_time_ms`, `avg_exec_time_ms`, `max_exec_time_ms` (hepsi nullable). Yazan: `AggRepository.rollupHourly()`.

### agg.pgss_daily — V005 (satır 22-33), partition key `bucket_start` — **tip: `date`**

PK `(bucket_start, instance_pk, statement_series_id)`. `bucket_start` tipi **`date not null`** (V005 satır 23) — hiçbir migration bunu değiştirmiyor (bkz. bölüm 9, `AggRepository.rollupDaily()` ile tutarsızlık). Yazan: `AggRepository.rollupDaily()`.

### agg.pg_table_stat_hourly — V068 (tüm dosya)

Bu domain'e ait çünkü `PartitionManager.MONTHLY_AGG_TABLES` ve `PurgeEvaluator.HOURLY_AGG_TABLES` listelerinde. PK `(bucket_start, instance_pk, dbid, relid)`, partition key `bucket_start` (range, aylık). Delta-sum kolonları + son-değer (snapshot) kolonları ayrı ayrı tutulur (`n_live_tup_last` vb.). Yazan: `AggRepository.rollupTableStatHourly()`.

### ops.job_run, ops.job_run_instance, ops.alert — V006

`job_run`: her scheduler döngüsü için 1 satır, `status` check `('running','success','failed','partial')`. `job_run_instance`: instance bazlı sonuç, FK → `job_run` on delete cascade, `status` check `('running','success','failed','partial','skipped')`. `ops.alert` şeması burada tanımlı ama **iş mantığı başka domain'e ait** — sadece varlığına referans (`alert_key` unique, `severity`/`status` check constraint'leri var).

## 3. İş/Hesaplama Kuralları

### PartitionManager

**Strateji tablosu:**

| Tablo grubu | Partition tipi | Lookbehind | Lookahead | İsimlendirme |
|---|---|---|---|---|
| `DAILY_FACT_TABLES` (30 tablo, satır 34-70) | günlük | 1 gün | 14 gün | `<schema>_<table>_YYYYMMDD` |
| `MONTHLY_AGG_TABLES` (`agg.pgss_hourly`, `agg.pg_table_stat_hourly`) | aylık | yok | 2 ay | `<schema>_<table>_YYYYMM` |
| `agg.pgss_daily` | yıllık | yok | 1 yıl | `agg_pgss_daily_<YYYY>` |

**Tetiklenme:** `@PostConstruct initOnStartup()` (satır 92-101) — collector başlarken bir kez çalışır, hata olursa loglanır ama başlatmayı bloklamaz (`try/catch` ile yutulur, satır 98-100). Ayrıca `ensureFuturePartitions()` public metodu (satır 108) rollup job tarafından periyodik çağrılır (JobOrchestrator, başka domain).

**Sınır (bounds) hesaplama — timezone mantığı (kritik, geçmiş bug alanı):**

`queryBounds()` (satır 286-309) sınırları **Java tarafında değil, DB session timezone'unda** hesaplar: `date_trunc('day/month/year', now() + offset * interval)` SQL'i doğrudan Postgres'e gönderilir ve `now()` DB session'ının timezone'una göre yorumlanır (örn. `Europe/Istanbul` ise gece yarısı 00:00+03 = 21:00 UTC). Kod içi yorum (satır 287-290) açıkça UTC hardcode edilirse "eski local midnight partition'larla 3 saatlik gap" oluşacağını belirtiyor — bu, V087 migration'ının çözdüğü **gerçek geçmiş bug**'a işaret ediyor (karışık UTC/local-midnight partition sınırları nedeniyle aylık agg partition'larında boşluk oluşmuştu).

**Eksik segment tespiti (satır 317-395):** `findMissingPartitionSegments()` — istenen `[lower, upper)` aralığını mevcut partition'ların `pg_get_expr(relpartbound)` regex parse'ı ile karşılaştırır, `greatest`/`least` ile kesişimleri bulur, `lead() over (order by point)` ile sıralı noktalar arasında **henüz kapsanmayan** segmentleri döner. Bu sayede kısmi overlap durumunda (örn. eski UTC-bound partition yeni ay'ın bir kısmını kapsıyorsa) sadece boş kalan parça için yeni partition açılır — tüm ay skip edilmez. Sorgu hata verirse (`catch`, satır 390-394) fallback olarak **tüm istenen bounds** tek segment olarak döner (yani hatasız pre-check varsayımıyla create denemesi yapılır).

**Çakışma kontrolü (satır 419-445):** `hasOverlappingPartition()` — CREATE denemeden önce aynı parent altında range çakışan partition var mı kontrol eder; sadece log spam'i engeller, gerçek CREATE hâlâ denenir (segment bazlı, `findMissingPartitionSegments` zaten filtrelemiş olmalı).

**Partition adı çakışma çözümü (satır 397-412):** `partitionRelName()` — eğer segment, istenen orijinal bounds'tan farklıysa (kısmi segment), isim `<base>_seg_<lowerToken>_<upperToken>` formatına döner; 63 karakter Postgres identifier limiti için base kısmı kırpılır (`maxBaseLen = 63 - "_seg_".length() - suffix.length()`).

**Test edilebilir önermeler:**
- EĞER bir DAILY_FACT_TABLES tablosu partitioned değilse (`isPartitionedTable` false) İSE o tablo için hiçbir partition oluşturma denemesi yapılmaz, sessizce debug loglanır (satır 125-128).
- EĞER `today.plusDays(d)` için `d` -1..14 aralığındaysa İSE o gün için partition denenir (satır 133).
- EĞER DB session timezone UTC değilse İSE partition sınırları o timezone'un gece yarısına göre hesaplanır, Java'nın kendi timezone'u hesaba katılmaz.
- EĞER istenen range'in bir kısmı zaten var olan bir partition tarafından kapsanıyorsa İSE sadece kapsanmayan kısım için ayrı bir "_seg_" partition'ı oluşturulur.
- EĞER CREATE TABLE hata verirse (örn. concurrent create) İSE hata sadece WARN loglanır, exception fırlatılmaz — döngü diğer tablolara devam eder (satır 254-265).

### PurgeEvaluator

**Ana `evaluate()` akışı (satır 87-94):** sırayla `purgeRawDeltaFacts()` → `purgeSnapshotFacts()` → `purgeTableFreezeFacts()` → `purgeNightlySnapshotFacts()` → `purgeHourlyAgg()` → `purgeDailyAgg()`. Sıra, drop/delete önceliği açısından önemli değil — her metot bağımsız çalışır ve kendi hata yönetimine sahip (bazıları try/catch ile sarılı — `purgeTableFreezeFacts`, `purgeNightlySnapshotFacts` — bazıları sarılı değil: `purgeRawDeltaFacts`, `purgeSnapshotFacts`, `purgeHourlyAgg`, `purgeDailyAgg`; bu asimetri bölüm 9'da işaretlenmiştir).

**Tablo grubu → kural eşlemesi:**

| Grup | Tablolar | Kolon | Eşik kaynağı | Mekanizma |
|---|---|---|---|---|
| RAW delta | `DELTA_FACT_TABLES` (6 tablo) | `sample_ts` | `coalesce(raw_retention_days, raw_retention_months*30)` | Hard drop (en uzun retention sınırından önceki partition'lar DROP) + instance-bazlı batched DELETE ara aralıkta |
| SNAPSHOT | `SNAPSHOT_FACT_TABLES` (20 tablo) | `snapshot_ts` (activity/replication/lock/progress) veya `sample_ts` (diğerleri) | `coalesce(snapshot_retention_hours, 48)` (saat) | Partition drop (gün bazlı, `ceil(hours/24)+1` gün önce) + saat-hassasiyetli batched DELETE |
| Table freeze | `fact.pg_table_freeze_snapshot` | `snapshot_ts` | `coalesce(table_freeze_retention_days, 90)` | Partition drop + batched DELETE |
| Nightly snapshot | `NIGHTLY_SNAPSHOT_TABLES` (4 tablo) | `snapshot_ts` | `coalesce(nightly_snapshot_retention_days, 180)` | Partition drop + batched DELETE |
| Hourly agg | `HOURLY_AGG_TABLES` (2 tablo) | partition bound | `coalesce(hourly_retention_days, hourly_retention_months*30)` | **Sadece** partition drop (batched delete YOK) |
| Daily agg | `agg.pgss_daily` | partition bound | `coalesce(daily_retention_days, daily_retention_months*30)` | **Sadece** partition drop |

**Hard drop + batched delete ikili mekanizması (RAW ve SNAPSHOT gruplarında ortak desen):**
1. Tüm aktif+purge_enabled policy'ler arasından **en uzun** retention süresi bulunur → bu, global "hard drop" sınırıdır (satır 114-120). Bu sınırdan önceki **tüm** partition'lar (hangi instance'a ait olursa olsun) DROP edilir — instance ayrımı yapılmaz.
2. Her instance'ın **kendi** (daha kısa olabilecek) retention cutoff'u ile hard-drop sınırı arasında kalan "ara bölge" için `batchedDeleteForInstance`/`batchedDeleteByTimestamp` ile instance bazlı DELETE yapılır (satır 130-142, 180-195). EĞER `instanceKeepFrom.isAfter(hardDropBefore)` DEĞİLSE (yani instance'ın kendi cutoff'u hard-drop sınırından daha eski veya eşitse) İSE o instance için hiç batched delete çalıştırılmaz (satır 136, 230, 277) — çünkü partition drop zaten o veriyi silmiştir.

**Batch delete mekaniği (satır 379-429):** `ctid in (select ctid ... limit 10000)` deseniyle döngüsel silme; `DELETE_BATCH_SIZE = 10_000`; `deleted >= DELETE_BATCH_SIZE` oldukça döngü sürer (tam olarak batch boyutu kadar silindiyse daha fazla satır olabileceği varsayımıyla devam eder — teorik olarak tam `10_000` satır kalıp döngünün "fazladan" bir kez daha (0 satır silen) çalışması mümkündür, sorun değil).

**Partition drop mekaniği (satır 328-363):** `pg_get_expr(relpartbound)` ile partition sınırları okunur, `extractStartDate()` (satır 365-377) regex/substring ile ilk 10 karakteri (`YYYY-MM-DD`) tarih olarak parse eder. EĞER partition'ın başlangıç tarihi `beforeDate`'ten önceyse İSE `DETACH PARTITION` + `DROP TABLE` ardışık çalıştırılır (satır 353-361); hata olursa WARN loglanır, döngü devam eder.

**AggRepository ile bağlantılı özel purge/rollup akışları (aynı sınıfta, satır 637-888):** WAL/Archiver/Activity/Lock/Replication/SLRU için saatlik rollup + `not exists` idempotency deseni; WAL için ayrıca günlük rollup (`agg.pg_wal_daily`) ve retention (`daily_snapshot_retention_days`); tüm hourly rollup tabloları için ortak `hourly_snapshot_retention_days` ile retention.

**Test edilebilir önermeler:**
- EĞER bir instance'ın `retention_policy_id`'sine bağlı policy `is_active = false` veya `purge_enabled = false` İSE o instance hiçbir purge sorgusunun `instanceCutoffs` listesine girmez (satır 108, 159 — WHERE koşulu).
- EĞER `hardDropBefore` NULL dönerse (örn. hiç aktif+purge_enabled policy yoksa) İSE `purgeRawDeltaFacts` / `purgeHourlyAgg` / `purgeDailyAgg` erken `return` ile çıkar, hiçbir işlem yapılmaz.
- EĞER bir partition'ın bound string'i regex ile parse edilemezse (`extractStartDate` null döner) İSE o partition drop listesinden atlanır, sonsuza kadar kalır (potansiyel disk sızıntısı — bölüm 9).
- EĞER `snapshot_retention_hours` NULL ise (policy'de eksikse) İSE `coalesce(..., 48)` ile 48 saat varsayılır.
- EĞER tablo adı `_activity_snapshot`, `_replication_snapshot`, `_lock_snapshot`, `_progress_snapshot` ile bitmiyorsa İSE `tsCol = "sample_ts"` kullanılır, aksi halde `"snapshot_ts"` (satır 187-192) — bu, tablo adı string-suffix eşleşmesine dayanan kırılgan bir mantıktır.

### AggRepository

**`rollupHourly()` (satır 26-79):** `fact.pgss_delta` → `agg.pgss_hourly`, `date_trunc('hour', sample_ts)` ile gruplama, pencere **kesinlikle** `[date_trunc('hour', now()-1h), date_trunc('hour', now()))` — yani sadece **son tamamlanmış saat**. `sum(coalesce(...,0))` deltalar için, `min/avg/max` latency kolonları için (V085 sonrası `mean_exec_time_ms`, `min_exec_time_ms`, `max_exec_time_ms` — bunlar `fact.pgss_delta` tablosunda V004'te tanımlı **değil**, ayrı bir migration'da eklenmiş olmalı, bkz. bölüm 9). **İdempotency:** `on conflict (bucket_start, instance_pk, statement_series_id) do update set ...` — aynı saat için tekrar çalıştırılırsa mevcut satır **üzerine yazılır** (upsert), duplicate insert olmaz.

**`rollupTableStatHourly()` (satır 87-161):** `fact.pg_table_stat_delta` → `agg.pg_table_stat_hourly`, aynı 1-saatlik pencere deseni. Delta kolonlar `sum(coalesce(...))`; "last" kolonlar (`n_live_tup_last` vb.) `(array_agg(... order by sample_ts desc))[1]` ile **saat içindeki en son örneklenen değer** alınır (ortalama değil — bir "gauge" snapshot semantiği). `last_vacuum`/`last_autovacuum` vb. `max()` ile alınır (bunlar zaten monoton artan timestamp'ler, max = en güncel). İdempotency: `on conflict (bucket_start, instance_pk, dbid, relid) do update`.

**`rollupWalHourly()` (satır 170-201):** `fact.pgss_delta`'daki WAL kolonlarını (`wal_bytes_delta` vb.) `agg.pg_wal_hourly` tablosuna (bu domain dışı bir tablo ama burada rollup edilir) yazar — **INSERT** kısmı `wal_bytes_total` gibi eski V055 kolonlarını da doldurur ama `on conflict do update` sadece pgss-kaynaklı yeni kolonları (`wal_bytes_sum`, `wal_records_sum`, `wal_fpi_sum`, `calls_sum`) güncelliyor — `wal_bytes_total` conflict'te güncellenmiyor (yani `PurgeEvaluator.rollupSnapshotsHourly()`'nin WAL-snapshot kaynaklı doldurduğu `wal_bytes_total` sütunu bu metodun update kolları arasında yok; iki farklı kaynak aynı satırı farklı kolonlarla besliyor — bkz. bölüm 9).

**`rollupDaily()` (satır 209-244):** `agg.pgss_hourly` → `agg.pgss_daily`, pencere **her zaman "dün"**: `[((now() at time zone 'UTC')::date - 1), (now() at time zone 'UTC')::date)`. Yani bugünün verisi asla günlük rollup'a girmez, sadece tamamlanmış önceki gün. **Kritik uyumsuzluk:** `bucket_start` V005'te `date` tipinde tanımlı ama INSERT değeri `((now() at time zone 'UTC')::date - 1)::timestamptz` — bir `timestamptz` ifadesi `date` kolonuna cast edilerek yazılıyor (implicit cast; PostgreSQL bunu kabul eder ama saat/timezone bilgisini kaybeder — gün UTC'de hesaplanıp date'e indirgenir). İdempotency: `on conflict (bucket_start, instance_pk, statement_series_id) do update`.

**Test edilebilir önermeler:**
- EĞER `rollupHourly()` aynı saat penceresi için iki kez art arda çalıştırılırsa İSE `agg.pgss_hourly`'de duplicate satır oluşmaz, ikinci çalıştırma birinci ile aynı sonucu üretiyorsa değerler değişmez (upsert idempotent).
- EĞER bir `statement_series_id` için o saatte hiç `fact.pgss_delta` satırı yoksa İSE o series için `agg.pgss_hourly`'ye hiç satır yazılmaz (INSERT...SELECT, GROUP BY olduğu için satır yoksa hiçbir şey yazılmaz — "sıfır" satırı üretilmez, NULL/0 farkı yoktur, satır tamamen eksik olur).
- EĞER `rollupDaily()` gün ortasında (örn. 14:00) tetiklenirse İSE sadece **dünkü** tam gün rollup edilir, bugünün kısmi verisi asla dahil edilmez.

## 4. Saklama & Yaşam Döngüsü

**control.retention_policy** — tam güncel şema (tüm migration'lar sonrası, sütun ekleme sırasına göre): `retention_policy_id` (PK), `policy_code` (unique), `raw_retention_months`, `hourly_retention_months`, `daily_retention_months` (V002, eski/uyumluluk), `raw_retention_days`, `hourly_retention_days`, `daily_retention_days`, `snapshot_retention_hours` (V022), `job_run_retention_days` (V037), `daily_snapshot_retention_days` (V061), `hourly_snapshot_retention_days` (V055), `table_freeze_retention_days`, `table_freeze_interval_seconds`* (*bu son kolon aslında `schedule_profile`'da, karıştırılmasın) (V078), `nightly_snapshot_retention_days` (V083), `audit_log_retention_days`, `alert_retention_days` (V086), `is_active`, `purge_enabled`, `created_at`, `updated_at`.

**control.instance_inventory** her instance için tam olarak **bir** `retention_policy_id` (not null FK) ve **bir** `schedule_profile_id` (not null FK) taşır — 1 instance = 1 policy + 1 profile, many-to-one; birden fazla instance aynı policy/profile'ı paylaşabilir (V002 satır 70-71).

**V008 seed data (varsayılan profiller/politikalar):**

Schedule profile'lar:
- `default`: cluster=60s, statements=300s, db_objects=1800s, hourly_rollup=3600s (**not**: V080 sonrası mevcut satır 3600'den 300'e güncellendi ama bu bir `UPDATE ... WHERE hourly_rollup_interval_seconds = 3600` olduğundan sadece hâlâ eski değerdeyse günceller), daily_rollup_hour_utc=1, bootstrap_batch=100, max_db_per_run=5, stmt_timeout=5000ms, lock_timeout=250ms, connect_timeout=5s, max_host_concurrency=1.
- `high-frequency`: cluster=30s, statements=120s, db_objects=900s, hourly_rollup=3600s, diğerleri aynı; max_db_per_run=10, bootstrap_batch=200, max_host_concurrency=2.

Retention policy'ler (V008 seed → V022/V054 ile üzerine yazıldı):
- `r3-short`: (V008) raw=3ay, hourly=3ay, daily=12ay → (V022) raw_days=7, hourly_days=30, daily_days=365, snapshot_hours=24 → (V054) snapshot_hours=168.
- `r6-default`: (V008) raw=6ay, hourly=6ay, daily=24ay → (V022) raw_days=14, hourly_days=60, daily_days=730, snapshot_hours=48 → (V054) snapshot_hours=720.
- `r12-long`: (V008) raw=12ay, hourly=12ay, daily=36ay → (V022) raw_days=30, hourly_days=180, daily_days=1095, snapshot_hours=72 → (V054) snapshot_hours=2160.

Diğer eklenen kolonlar için (`job_run_retention_days`, `nightly_snapshot_retention_days` vb.) V008'de satır zaten var olduğundan, ilgili migration'ların kendi `ALTER ... ADD COLUMN ... DEFAULT` + `UPDATE` mantığı ile (bkz. bölüm 2) doldurulmuş; her policy için ayrı değer atanmıştır (kısa/orta/uzun sıralaması korunmuştur, örn. nightly: r3=90, r6=180, r12=365 gün).

## 5. API Sözleşmesi

**`api/src/routes/retentionPolicies.ts`** — mount: `/api/retention-policies`, `requireAuth` middleware ile korunuyor (`api/src/index.ts:179`).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/` | — | policy listesi + her satıra `bound_instances` (subselect count) |
| POST | `/` | `policy_code`, `raw_retention_days`/`raw_retention_months`, `hourly_retention_days`/`_months`, `daily_retention_days`/`_months`, `snapshot_retention_hours`, `audit_log_retention_days`, `alert_retention_days` (months veya days kabul edilir, months varsa ×30 çevrilir) | 201, oluşan satır |
| PUT | `/:id` | days veya months alanları (aynı fallback), `table_freeze_retention_days`, `nightly_snapshot_retention_days` (opsiyonel, coalesce ile güncellenmezse eski değer kalır) | 200 güncel satır / 404 yoksa / 400 raw-hourly-daily zorunlu değilse |
| DELETE | `/:id` | — | 204 / **409** eğer `bound_instances > 0` |

`parseRetentionDays`/`parseOptionalRetentionDays` (satır 8-19) `1-9999` aralığı validasyonu yapar, dışındaysa `RetentionValidationError` → 400.

**`api/src/routes/scheduleProfiles.ts`** — mount: `/api/schedule-profiles`, `requireAuth`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/` | — | profil listesi + `bound_instances` |
| POST | `/` | `profile_code`, `cluster_interval_seconds`, `statements_interval_seconds`, `db_objects_interval_seconds`, `hourly_rollup_interval_seconds`, `daily_rollup_hour_utc`, `bootstrap_sql_text_batch`, `max_databases_per_run`, `statement_timeout_ms`, `lock_timeout_ms`, `connect_timeout_seconds`, `max_host_concurrency` | 201 |
| PUT | `/:id` | `cluster_interval_seconds`, `statements_interval_seconds`, `db_objects_interval_seconds`, `statement_timeout_ms`, `lock_timeout_ms`, `connect_timeout_seconds`, `max_host_concurrency`, `table_freeze_interval_seconds` (opsiyonel) — **not**: `hourly_rollup_interval_seconds` ve `daily_rollup_hour_utc` PUT body'de kabul edilmiyor/güncellenmiyor (bkz. bölüm 9) | 200 / 404. Yan etki: bu profile bağlı tüm aktif instance'ların `instance_state.next_cluster_collect_at`/`next_statements_collect_at` ve `database_state.next_db_objects_collect_at` **hemen `now()`'a** çekilir (satır 89-107) — yani interval değişikliği en fazla ~5 saniye içinde etkili olur |
| DELETE | `/:id` | — | 204 / **409** eğer bağlı instance varsa |

## 6. UI Davranışı

`ui/src/pages/Settings.tsx` içinde `Settings` bileşeni sekmeli (`tab` state, varsayılan `'retention'`) yapı: `retention`, `schedule`, `reports`, `audit`, `dashboard`, `channels`, `telegram`. Bu domain ile ilgili iki sekme:

**RetentionTab** (satır ~227-444): `useQuery(['retention-policies'])` ile `GET /retention-policies` çeker; tablo kolonları: Kod, Raw(gün), Hourly(gün), Daily(gün), Snapshot(saat), Table Freeze(gün), Nightly(gün), Audit(gün), Alert(gün), Sil butonu (0 bağlı instance ise aktif, aksi halde disabled tooltip ile "N instance bağlı"). Formda `numField` yardımcı fonksiyonu ile 8 sayısal alan düzenlenebilir (`emptyRetention` default değerleri: raw=14, hourly=60, daily=730, snapshot=48, table_freeze=90, nightly=180, audit=90, alert=90). Satır 362-371 civarında kullanıcıya açıklayıcı metin: raw retention süresinden sonra hourly'ye, sonra daily'ye "iner" ifadesi var — **ancak koddaki gerçek mekanizma böyle bir "sıkıştırma/downsample" zinciri değildir**, raw/hourly/daily birbirinden bağımsız 3 ayrı purge kuralıdır (bkz. bölüm 9, UI metni ile gerçek davranış arasında fark).

**ScheduleTab** (satır ~450-620+): `useQuery(['schedule-profiles'])`. Tablo kolonları: Kod, Cluster(s), Stmts(s), DbObj(s), Table Freeze(s), Paralel, Bağlı, Durum, aksiyonlar. Form alanları: Kod (edit modunda disabled), Cluster/Statements/DbObjects/Table Freeze interval'ları, timeout'lar, **Max Paralel Host** (uyarı ikonu ile — bu alan collector restart gerektirir), SQL Text Batch, Max DB/Run, Hourly Rollup(s), Daily Rollup Saat(UTC), Aktif checkbox. `editMut.onSuccess` içinde `max_host_concurrency` değiştiyse `restartNotice` banner'ı gösterilir (satır 483-489, 542-561) — kullanıcıya `./pgstat restart collector` komutu önerilir. Diğer tüm alan değişiklikleri "5 saniye içinde devrede" mesajıyla bildirilir (bu, API'nin `next_*_collect_at = now()` reset mekanizmasına dayanır).

## 7. Domain-arası Arayüzler

Bu domain'in tablolarını (fact/dim/agg/control) yazan/okuyan **diğer** collector sınıfları (detaya girilmeyecek, kendi domain dokümanlarında spesifiye edilecek):

- `ClusterCollector`
- `DbObjectsCollector`
- `StatementsCollector`
- `TextEnricher`
- `DimensionRepository`
- `FactRepository`
- `AlertRuleEvaluator`
- `BaselineCalculator`
- `LongRunningQueryEvaluator`
- `ReportGenerator`
- `SystemHealthEvaluator`
- `WorkloadClassifier`

## 8. Kabul Kriterleri

1. EĞER `instance.retention_policy_id = X` VE `X.raw_retention_days = 30` İSE `fact.pgss_delta`/`pg_database_delta`/`pg_table_stat_delta`/`pg_index_stat_delta`/`pg_cluster_delta`/`pg_io_stat_delta` partition'larından, başlangıç tarihi `current_date - GLOBAL_MAX(raw_retention_days)`'ten önce olanlar DROP edilir (instance'a özel değil, global sınır); GLOBAL_MAX ile instance'ın kendi 30 günü arasında kalan satırlar ise instance bazlı DELETE ile silinir.
2. EĞER bir retention_policy `is_active = false` İSE o policy'ye bağlı instance'lar hiçbir purge cutoff hesaplamasına dahil edilmez (ne hard-drop max'ına, ne instance-bazlı cutoff listesine).
3. EĞER bir retention_policy `purge_enabled = false` İSE aynı şekilde tüm purge sorgularından hariç tutulur, ama partition oluşturma (`PartitionManager`) bundan etkilenmez — partition oluşturma retention_policy'yi hiç okumaz.
4. EĞER `snapshot_retention_hours = 24` İSE `fact.pg_activity_snapshot` (ve diğer 19 snapshot tablosu) için partition drop sınırı `current_date - ceil(24/24.0) - 1 = current_date - 2` gün olur; kalan 24 saatlik pencere saat-hassasiyetli DELETE ile temizlenir.
5. EĞER `hourly_retention_days` değeri güncellenirse İSE `agg.pgss_hourly` ve `agg.pg_table_stat_hourly` için **sadece** ilgili ay partition'ları DROP edilir — hiçbir satır bazlı DELETE çalışmaz (bu iki tablo için batched delete mekanizması yok).
6. EĞER `PartitionManager.ensureFuturePartitions()` collector startup'ında çalışırsa İSE `DAILY_FACT_TABLES` listesindeki 30 tablo için bugünden 1 gün öncesine ve 14 gün sonrasına kadar (toplam 16 gün) partition varlığı garanti edilir; `MONTHLY_AGG_TABLES` için mevcut ay + 2 ay; `agg.pgss_daily` için mevcut yıl + 1 yıl.
7. EĞER `AggRepository.rollupHourly()` aynı `(bucket_start, instance_pk, statement_series_id)` için ikinci kez çalıştırılırsa İSE `agg.pgss_hourly` satırı hata vermeden güncellenir (upsert), duplicate key hatası oluşmaz.
8. EĞER bir `instance_pk` için `raw_retention_days` policy cutoff'u global hard-drop sınırından **daha eski veya eşitse** İSE o instance için `batchedDeleteForInstance` hiç çağrılmaz (partition drop yeterli kabul edilir).
9. EĞER `PartitionManager.createPartition()` çağrısı sırasında CREATE TABLE hata verirse (örn. eşzamanlı iki collector instance'ı aynı partition'ı yaratmaya çalışırsa) İSE hata sadece WARN loglanır, işlem exception fırlatmadan diğer tablolara devam eder.
10. EĞER `ops.job_run_retention_days` kolonu henüz mevcut değilse (migration V037 uygulanmamış) İSE `PurgeEvaluator.purgeJobRunHistory()` varsayılan olarak 30 gün kullanır (`catch` bloğu ile sessizce yutulur, satır 449-451).

## 9. Açık Sorular / Dokümante Edilmemiş Davranış

1. **Migration numarası çift kullanımı — V021, V054, V055, V056, V060:** `V021__allow_adaptive_eval_type.sql` ve `V021__pgss_reset_tracker.sql` aynı numarayı paylaşıyor; benzer şekilde `V054__snapshot_retention_increase.sql` / `V054__user_preferences.sql`, `V055__pgss_min_max_stddev.sql` / `V055__safe_temp_work_mem_alert.sql` / `V055__snapshot_hourly_rollup.sql` (bu domain'e ait `hourly_snapshot_retention_days` kolonu **bu üçüncü V055 dosyasında** — hangi sıra ile uygulandığı flyway/migration runner'ın dosya adı sıralamasına bağlı, aynı numaralı 3 migration'ın çalışma sırası dosya sistemi sıralamasına göre belirsiz olabilir), `V056__concise_alert_templates.sql` / `V056__snapshot_hourly_rollup_remaining.sql`, `V060__manual_report_trigger.sql` / `V060__temp_files_alert_simplify.sql`. Bu domain'i etkileyen asıl risk: `V055__snapshot_hourly_rollup.sql`'in gerçek migration aracı tarafında hangi checksum/sıra ile diğer V055'lerle birlikte çalıştığı doğrulanmalı.
2. **`agg.pgss_daily.bucket_start` tip uyumsuzluğu:** V005'te `date not null` olarak tanımlı, ama `AggRepository.rollupDaily()` (satır 223) `((now() at time zone 'UTC')::date - 1)::timestamptz` ifadesini bu kolona yazıyor. PostgreSQL bunu implicit cast ile kabul eder (timestamptz → date, saat/tz bilgisi atılır) ama niyet net değil — kolonun aslında `timestamptz` olması mı gerekiyordu, yoksa kod fazladan/gereksiz bir cast mi yapıyor? Hiçbir migration `bucket_start` tipini değiştirmemiş.
3. **`fact.pgss_delta` üzerinde `min_exec_time_ms`/`max_exec_time_ms`/`mean_exec_time_ms` kolonları:** `AggRepository.rollupHourly()` (satır 58-59) bu kolonları `fact.pgss_delta`'dan okuyor, ama V004 migration'ında bu kolonlar **tanımlı değil**. Bu domain kapsamının (V001-V008) dışında bir migration'da (muhtemelen `V055__pgss_min_max_stddev.sql`) eklenmiş olmalı — kapsam dışı ama Domain 1'in temel tablosunu genişlettiği için burada işaretleniyor; bu kolonların gerçek şema tanımı bu dokümanda doğrulanmadı.
4. **`rollupWalHourly()` ile snapshot-kaynaklı WAL rollup arasında kolon çakışması riski:** `AggRepository.rollupWalHourly()` `agg.pg_wal_hourly.wal_bytes_total`'ı INSERT listesinde dolduruyor ama `ON CONFLICT DO UPDATE` bunu güncellemiyor; `PurgeEvaluator.rollupSnapshotsHourly()` (satır 644-668) ise aynı tabloyu farklı bir INSERT ile (WAL snapshot kaynağından) besliyor ve o da kendi `wal_bytes_total`'ını yazıyor. İki farklı rollup kaynağı aynı satırı farklı zamanlarda/farklı veri kümesinden dolduruyorsa hangisi "kazanır" belirsiz — `insert ... on conflict do nothing` (satır 663) kullanıyor `rollupSnapshotsHourly`, yani ilk INSERT eden kazanır, sonraki güncellenmez. Bu iki mekanizmanın çalışma sırası/aralığı netleştirilmeli.
5. **`ScheduleTab` PUT body'sinde `hourly_rollup_interval_seconds` ve `daily_rollup_hour_utc` eksik:** UI formunda bu iki alan var (satır 611-612, kullanıcı değiştirebiliyor) ama `scheduleProfiles.ts` PUT route'u (satır 56-80) bu iki alanı body'den okumuyor/UPDATE'e dahil etmiyor — yani kullanıcı arayüzden bu değerleri değiştirse de **sunucu tarafında sessizce yok sayılıyor**. Bu bir bug gibi görünüyor; frontend UI ile backend sözleşmesi arasında sessiz bir tutarsızlık var.
6. **`PurgeEvaluator.evaluate()` içindeki try/catch asimetrisi:** `purgeTableFreezeFacts()` ve `purgeNightlySnapshotFacts()` kendi içlerinde try/catch ile korunuyor (bir hata `evaluate()`'in diğer adımlarını durdurmaz), ama `purgeRawDeltaFacts()`, `purgeSnapshotFacts()`, `purgeHourlyAgg()`, `purgeDailyAgg()` korunmuyor — bunlardan biri exception fırlatırsa `evaluate()`'in kalan adımları (örn. daily agg purge) hiç çalışmaz. Bu tutarsız hata izolasyonu niyetli mi yoksa eksik mi belirsiz.
7. **`extractStartDate()` regex parse hatası durumunda partition sonsuza kadar kalabilir:** `dropPartitionsBefore()` (satır 350-351) `partStart == null` ise `continue` ile o partition'ı tamamen atlıyor — hiçbir uyarı loglanmıyor. Beklenmeyen bir bound formatı (örn. V087'nin oluşturduğu `_gap_` veya `_seg_` isimli partition'lar farklı bir bound string formatına sahipse) bu partition'ların asla drop edilmemesine yol açabilir; sessiz disk sızıntısı riski.
8. **`table_freeze_interval_seconds` kolonunun retention_policy ile karışma riski:** Bu kolon `control.schedule_profile` tablosunda (V078), ama `control.retention_policy`'de de aynı migration'da `table_freeze_retention_days` ekleniyor — isim benzerliği (`interval_seconds` vs `retention_days`, ikisi de "table_freeze" prefix'i) kolayca karıştırılabilir; kod tarafında doğru tabloya yazıldığı doğrulandı ama dokümantasyon/isimlendirme riski not edilmelidir.
9. **UI'daki "raw → hourly → daily iner" açıklaması gerçek mekanizmayı yanlış tanımlıyor olabilir:** `RetentionTab` (satır 362-371) kullanıcıya raw/hourly/daily retention'ın birbirini takip eden bir "downsample zinciri" gibi anlatıyor, ama kod düzeyinde bu üç retention tamamen bağımsız purge kuralı (raw fact'ler kendi süresinde silinir, hourly agg kendi süresinde, daily agg kendi süresinde — biri bittiğinde diğerine "geçiş" yapan bir mekanizma yok, zaten `AggRepository.rollupHourly/rollupDaily` sürekli paralel çalışıyor). UI metni kullanıcıyı yanıltabilir; gerçek davranışla doküman arasında fark var.
10. **`hasOverlappingPartition()` ve `findMissingPartitionSegments()`'ın try/catch fallback'i:** İkisi de SQL hatası durumunda (satır 390-394, 440-444) ya `List.of(bounds)` (tüm range'i "eksik" kabul et) ya da `false` (çakışma yok kabul et) döndürüyor — bu "optimistic" fallback'ler normal koşullarda güvenli ama production'da `pg_get_expr`/`regexp_match` regex'i beklenmeyen bir partition bound formatıyla (örn. sub-partitioning veya farklı bir literal quoting) karşılaşırsa sessizce yanlış davranabilir; hiçbir metrik/alert bu düşüşü yakalamıyor.
