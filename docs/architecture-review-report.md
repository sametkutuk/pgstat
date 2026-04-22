# Mimari İnceleme Raporu — centralized-pgstats-architecture.md

Tarih: 2026-04-16

---

## 1. Mantıksal Tutarsızlıklar

### 1.1 `dim.query_text` — `system_identifier` bazlı tekilleştirme, disk tasarrufu hedefiyle çelişiyor

Belge hem "SQL text merkezi DB'de fiziksel cluster bazında bir kez saklanır" prensibini açıklıyor hem de `system_identifier`'ın failover, restore veya yeniden kurulum sonrası değişebileceğini söylüyor (satır 655).

**Çelişki:** Aynı fiziksel SQL text, `system_identifier` değiştiğinde yeni bir `(system_identifier, query_hash)` çifti üretir ve tekrar yazılır. Disk tasarrufu prensibi fiilen çalışmıyor; sadece epoch değişmediği sürece etkin.

**Öneri:** Ya tekilleştirme `query_hash` üzerinden yapılmalı (sistem_identifier'dan bağımsız), ya da dokümanda bu sınırlama açıkça kabul edilmeli.

---

### 1.2 `dim.statement_series` unique index — `system_identifier` eksik

Unique index tanımı:

```
(instance_pk, pg_major, pgss_epoch_key, dbid, userid, coalesce(toplevel::text, 'unknown'), queryid)
```

`instance_pk` aynı kalırken `system_identifier` değişebilir (satır 654-655). Bu durumda iki farklı fiziksel cluster aynı `instance_pk` altında çakışan seri kayıtları üretebilir.

**Çelişki:** Belgede "Delta ve statement surekliligi fiziksel olarak `system_identifier` ve epoch ile izlenir" deniyor ama unique index'te `system_identifier` yok.

**Öneri:** Unique index'e `system_identifier` eklenmeli veya epoch key zaten `system_identifier` bilgisini içerdiği net olarak açıklanmalı.

---

### 1.3 `fact.pg_cluster_delta` — `pg_stat_io` için generic model yetersiz

`pg_stat_io` view'ı her satır için `(backend_type, object, context)` üç boyutunu içerir. Generic `(metric_family, metric_name, metric_value_num)` modeli bu çok boyutlu yapıyı doğru temsil edemez.

**Örnek sorun:** "client backend + relation + read için blks_read" ve "client backend + temp relation + read için blks_read" aynı `metric_name = 'blks_read'` altında çakışır. Primary key ihlali olur veya veriler kaybolur.

**Çelişki:** `pg_stat_io` ilk fazda kapsama alındığı söyleniyor ama veri modeli onu barındıramıyor.

**Öneri:** `pg_stat_io` için ayrı fact tablosu tasarlanmalı ya da generic modele `dimension_1`, `dimension_2`, `dimension_3` kolonları eklenmeli.

---

### 1.4 Collector "stateless" — advisory lock çelişkisi

Belge "Collector bir daemon olmak zorunda değildir. Başlangıç için stateless bir CLI uygulaması yeterlidir" diyor; ancak "Aynı job'in çakışan iki kopyası merkezi advisory lock ile engellenir" de belirtiliyor.

**Çelişki:** Stateless bir CLI process, bağlantı koptuğunda advisory lock otomatik serbest bırakır. Bu güvenli bir senaryo olsa da "process crash → lock serbest → iki kopya aynı anda çalışma riski" stateless modelde daha yüksektir. Ayrıca advisory lock'un hangi bağlantı üzerinde tutulacağı belirsizdir.

---

### 1.5 `control.instance_inventory` — `(host, port, admin_dbname)` unique constraint

Aynı sunucu üzerinde farklı PostgreSQL versiyonları veya container'lar (farklı `system_identifier`) çalışabilir. Bu unique constraint aynı host:port'ta birden fazla fiziksel cluster takibini imkânsız kılıyor.

**Çelişki:** Belgede "Hostname veya IP değişebilir; `instance_id` değişmeyebilir" deniyor ama ters yön (aynı host, farklı cluster) ele alınmıyor.

---

### 1.6 Backoff hesabında potansiyel taşma

```sql
power(2, s.consecutive_failures)::integer
```

`consecutive_failures = 31` olduğunda `power(2, 31) = 2.147 milyar`, `::integer` cast'ı 32-bit PostgreSQL integer sınırında overflow üretir. `least(900, ...)` ile üst sınır konulmuş ama `power()` float döndürür ve intermediate değer problem çıkarabilir.

**Öneri:** `least(900, 2^consecutive_failures)` yerine `least(900, 30 * consecutive_failures)` veya benzer bir doğrusal yaklaşım daha güvenli.

---

## 2. Eksik veya Belirsiz Noktalar

### 2.1 `dim.database_ref`, `dim.relation_ref`, `dim.role_ref` — `instance_pk` foreign key DDL'de yok

Belge bu tablolarda `instance_pk`'nın `control.instance_inventory.instance_pk` ile "ilişkili" olduğunu yazıyor. Ancak DDL'de foreign key constraint tanımlanmamış. Referential integrity korunmuyor.

---

### 2.2 `fact.pg_database_delta` — `datname` fact tablosunda tekrarlanıyor

Bu tabloda hem `dbid` hem de `datname` doğrudan yazılıyor. `dim.database_ref` bu eşleşmeyi zaten tutuyor. Database rename edilirse fact'teki eski `datname` değerleri tutarsız kalır.

**Aynı sorun:** `fact.pg_table_stat_delta` ve `fact.pg_index_stat_delta`'da da `schemaname`, `relname`, `table_relname`, `index_relname` gibi text alanlar fact'e yazılıyor. `dim.relation_ref` varken bu hem veri tekrarı hem de isim değişikliğinde inconsistency.

---

### 2.3 Partition yönetimi — kim oluşturuyor?

"En az gelecek 7 günlük partisyon önceden oluşturulur" deniliyor ama bu işlemin hangi bileşen tarafından, hangi zamanlamada yapılacağı belirtilmemiyor.

- Collector uygulaması mı?
- Ayrı bir cron job mu?
- Uygulama başlangıcında mı?

Bu eksiklik production'da "no partition for date" hatasına yol açabilir.

---

### 2.4 `ops.job_run` ve `ops.alert` retention mekanizması eksik

Belge "`ops` tabloları en az 90 gün saklanır" diyor. Ancak bu tabloların nasıl temizleneceği (kim, hangi job, hangi tablo tanımıyla) belirtilmemiyor. `fact` tabloları için purge evaluator anlatılıyor ama `ops` için sessizlik var. Yoğun sistemlerde `ops.job_run` ve `ops.job_run_instance` hızla şişecek.

---

### 2.5 Günlük rollup tablosu yok

`rollup_interval_seconds = 3600` (saatlik) ve `agg.pgss_hourly` var. Aylık/yıllık sorgular için saatlik tablodan okumak pahalı olabilir. Günlük agg tablosu (`agg.pgss_daily`) hiç bahsedilmiyor.

---

### 2.6 `control.instance_state` — `db_objects` için state yok

`control.instance_state`'te `last_db_objects_collect_at` veya `next_db_objects_collect_at` kolonları yok. Bu bilgi `control.database_state`'te database başına tutuluyor. Belge scheduler sorgusunda da sadece cluster ve statements'ı kapsıyor; `db_objects` için ayrı scheduler sorgusu tanımlı ama `instance_state`'e bağlı global "db_objects tümü tamamlandı" takibi yok.

---

### 2.7 OID değişiminin `dim.relation_ref` üzerindeki etkisi ele alınmamış

Tablo drop/recreate edildiğinde `relid` OID değişir. Yeni `relid` için yeni `dim.relation_ref` kaydı açılır; ancak eski `relid`'e bağlı fact satırları orphan kalır. `dim.relation_ref`'e foreign key olmadığı için bunu DB de tutmuyor.

Benzer şekilde `dim.database_ref`'te de database drop/recreate sonrası `dbid` değişebilir.

---

### 2.8 `dim.query_text.first_seen_instance_pk` — foreign key yok

DDL'de bu kolona referans constraint yok. Orphan değer yazılabilir. Doküman "null olabilir" diyor ama silinen bir instance sonrası geçersiz referans da kabul ediliyor demek, bu tutarsız bir tasarım.

---

### 2.9 `secret_ref` formatı ve çözüm mekanizması belirtilmemiyor

`control.instance_inventory.secret_ref` kolonunun ne tür değer alacağı (dosya yolu, Vault path, environment variable adı, AWS Secrets Manager ARN?) hiçbir yerde tanımlanmıyor. Collector bu değeri nasıl çözecek? Bu "operasyonel karar" listesine alınmış ama bağlantı güvenliğinin temel parçası.

---

### 2.10 `pg_stat_statements` reset sonrası ilk sample'ın delta değeri

Reset sonrası yeni epoch açılıyor. Yeni epoch'un ilk sample'ında kümülatif sayaçlar sıfırdan başlar. Bu ilk sample delta olarak `0` mı yazılacak yoksa atlanacak mı? Bu durum belgelenmemiş. Yanlış uygulanırsa ilk örnekte sahte büyük delta değerleri yazılabilir.

---

### 2.11 Replica ve HA topolojisi ele alınmamış

Primary/replica setup'larda collector hangi node'a bağlanır? Belgede "her instance için ayrı `instance_id`" deniyor ama:

- Floating IP / VIP kullanan HA setup'larında aynı endpoint farklı fiziksel node'lara gidebilir.
- Replica'lar ayrı mı izlenecek, primary only mi?
- Streaming replication veya logical replication'a ilişkin hiçbir yönlendirme yok.

---

### 2.12 `pg_stat_bgwriter` / `pg_stat_wal` reset tracking

Cluster delta metrikleri için epoch/reset mekanizması sadece `pgss_epoch_key` üzerinden anlatılıyor. `pg_stat_bgwriter` ve `pg_stat_wal` de kümülatif sayaçlar ve bunların da reset edilebileceği `fact.pg_cluster_delta` generic modelinde handle edilmiyor.

---

## 3. Küçük Notlar

- `control.instance_capability.is_reachable` default `false` ama yeni kayıt collector henüz kesif yapmadan `false` görünür. Bu "ulaşılamıyor" ile "henüz denenmedi" ayrımını kaybediyor. `null` daha doğru olurdu.
- `ops.alert.alert_key` unique ama constraint adı DDL'de `uq_alert_key` olarak var, dokümanda ayrı belirtilmemiş.
- Belge boyunca Türkçe/İngilizce terim karışımı tutarlı, ancak bazı yerlerde `pg_stat_statements(false)` kullanımı açıklanmamış — `false` parametresinin "text alanını getirme" anlamına geldiği bir kez daha not edilmeli.

---

## Özet Tablo

| # | Kategori | Konu | Ciddiyet |
|---|---|---|---|
| 1.1 | Mantıksal tutarsızlık | `system_identifier` değişince SQL text tekrar yazılır | Orta |
| 1.2 | Mantıksal tutarsızlık | `statement_series` unique index'te `system_identifier` eksik | Yüksek |
| 1.3 | Mantıksal tutarsızlık | `pg_stat_io` generic modele sığmıyor | Yüksek |
| 1.4 | Mantıksal tutarsızlık | Stateless collector + advisory lock çelişkisi | Orta |
| 1.5 | Mantıksal tutarsızlık | Aynı host:port farklı cluster senaryosu engelleniyor | Orta |
| 1.6 | Mantıksal tutarsızlık | Backoff integer overflow riski | Düşük |
| 2.1 | Eksik | `dim.*` tablolarında `instance_pk` foreign key yok | Orta |
| 2.2 | Eksik | `datname`/`relname` fact'te tekrar + inconsistency riski | Orta |
| 2.3 | Eksik | Partition yönetimi otomasyonu belirtilmemiş | Yüksek |
| 2.4 | Eksik | `ops` tablo retention/purge mekanizması yok | Orta |
| 2.5 | Eksik | Günlük rollup tablosu yok | Düşük |
| 2.6 | Eksik | `instance_state`'te db_objects global takibi yok | Düşük |
| 2.7 | Eksik | OID değişiminin dim tablolarına etkisi ele alınmamış | Orta |
| 2.8 | Eksik | `first_seen_instance_pk` foreign key yok | Düşük |
| 2.9 | Eksik | `secret_ref` format ve çözüm mekanizması belirsiz | Orta |
| 2.10 | Eksik | Reset sonrası ilk sample'ın delta davranışı belirsiz | Orta |
| 2.11 | Eksik | HA/replica topolojisi ele alınmamış | Orta |
| 2.12 | Eksik | `pg_stat_bgwriter`/`pg_stat_wal` reset tracking yok | Orta |
