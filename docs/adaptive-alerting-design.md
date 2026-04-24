# pgstat Adaptif Alert Sistemi — Tasarım Dokümanı

## Problem

Mevcut smart alert kuralları sabit yüzdesel eşikler kullanıyor (%100, %200 gibi). Ama her sistemin "normali" farklı. Bir sistemde 50 aktif bağlantı normalken, başka birinde 5 normal. Sabit %100 eşiği birinde çok geç, diğerinde çok erken tetiklenir.

Kullanıcı eşik girmek zorunda kalmamalı — sistem kendi normalini öğrenmeli ve anomaliyi otomatik tespit etmeli.

## Hedef

Her metrik için sistem otomatik olarak:
1. Tarihsel profil çıkarsın (ortalama, min, max, percentile, stddev)
2. Kapasite sınırlarını bilsin (max_connections, disk boyutu, vb.)
3. Normal aralığı hesaplasın
4. Normal aralık dışına çıkınca alert üretsin
5. Kullanıcı sadece "hassasiyet" seçsin (düşük/orta/yüksek)

---

## Baseline Profil Yapısı

Her metrik + instance kombinasyonu için periyodik olarak hesaplanan profil:

```sql
control.metric_baseline (
  instance_pk bigint,
  metric_key text,           -- "activity.active_count", "cluster.wal_bytes", vb.
  
  -- Tarihsel istatistikler (son 4 hafta)
  avg_value numeric,          -- ortalama
  stddev_value numeric,       -- standart sapma
  min_value numeric,          -- görülen minimum
  max_value numeric,          -- görülen maksimum
  p50_value numeric,          -- medyan
  p95_value numeric,          -- %95 percentile (normal üst sınır)
  p99_value numeric,          -- %99 percentile
  sample_count integer,       -- kaç sample'dan hesaplandı
  
  -- Saatlik profil (günün saatine göre)
  hour_of_day integer,        -- 0-23 (null = tüm saatler)
  day_of_week integer,        -- 0-6 (null = tüm günler, 0=Pzt)
  
  -- Kapasite bilgisi (varsa)
  capacity_value numeric,     -- max_connections, tablespace size, vb.
  capacity_source text,       -- "pg_settings.max_connections", "disk_total", vb.
  
  -- Meta
  baseline_period_start timestamptz,
  baseline_period_end timestamptz,
  updated_at timestamptz default now(),
  
  primary key (instance_pk, metric_key, coalesce(hour_of_day, -1))
)
```

---

## Metrik Bazlı Adaptif Kurallar

### 1. Aktif Bağlantı Sayısı (activity.active_count)

**Baseline kaynağı:** `fact.pg_activity_snapshot` — son 4 hafta, saatlik grupla

**Profil:**
```
avg=50, stddev=8, min=12, max=72, p95=68, p99=71
capacity=200 (max_connections'dan)
```

**Alert seviyeleri:**

| Seviye | Koşul | Örnek |
|---|---|---|
| Normal | değer ≤ max(p95, max_seen) | ≤ 72 |
| Warning | değer > max_seen × 1.1 VEYA değer > capacity × 0.70 | > 79 veya > 140 |
| Critical | değer > capacity × 0.85 | > 170 |
| Emergency | değer > capacity × 0.95 | > 190 |

**Kapasite entegrasyonu:**
- `max_connections` değeri `pg_settings`'ten okunur (collector discovery sırasında)
- `superuser_reserved_connections` düşülür
- Efektif kapasite = max_connections - superuser_reserved - 5 (güvenlik payı)

**Neden sadece ortalama yetmez:**
- Ortalama 50, ama iş saatlerinde 70'e çıkıyor → 70 normal
- p95=68 ama max=72 → 72'ye kadar görülmüş, normal
- Alert 73+'da başlamalı, 50+%100=100'de değil

---

### 2. Idle in Transaction Bağlantı (activity.idle_in_transaction_count)

**Baseline kaynağı:** `fact.pg_activity_snapshot`

**Profil:**
```
avg=2, stddev=1.5, min=0, max=8, p95=5
capacity=max_connections × 0.10 (max_connections'ın %10'u makul üst sınır)
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 1.5 VEYA > capacity × 0.10 |
| Critical | > capacity × 0.20 VEYA süre > 5dk olan var |

**Ek kural:** Tek bir session 5 dakikadan uzun idle in transaction ise → warning (süre bazlı)

---

### 3. Lock Bekleme (activity.waiting_count)

**Baseline kaynağı:** `fact.pg_lock_snapshot`

**Profil:**
```
avg=0.5, stddev=1, min=0, max=3, p95=2
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 2 VEYA herhangi bir lock > 30s bekliyor |
| Critical | > max_seen × 5 VEYA herhangi bir lock > 5dk bekliyor |

**Ek kural:** Lock bekleme süresi bazlı — kaç tane olduğundan bağımsız, tek bir 5dk+ lock critical

---

### 4. Cache Hit Ratio (database.cache_hit_ratio)

**Baseline kaynağı:** `fact.pg_database_delta` — `blks_hit / (blks_hit + blks_read)`

**Profil:**
```
avg=99.2, stddev=0.3, min=97.5, max=99.8, p05=98.1
```

**Not:** Bu metrik ters — düşük değer kötü. p05 (alt %5) kullanılır.

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≥ min(p05, min_seen) |
| Warning | < min_seen × 0.98 VEYA < 95 (mutlak alt sınır) |
| Critical | < 90 (mutlak alt sınır) |

**Neden mutlak sınır da lazım:**
- Yeni kurulmuş bir sistemde baseline henüz yok
- Cache hit %85 olsa bile baseline olmadan "normal" sayılmamalı
- %95 ve %90 mutlak sınırlar her zaman geçerli

---

### 5. Replication Lag — Byte (replication.replay_lag_bytes)

**Baseline kaynağı:** `fact.pg_replication_snapshot`

**Profil:**
```
avg=1MB, stddev=2MB, min=0, max=15MB, p95=8MB
capacity=WAL üretim hızı × 5dk (kabul edilebilir gecikme)
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 2 VEYA > 50MB (mutlak) |
| Critical | > max_seen × 5 VEYA > 500MB (mutlak) |
| Emergency | > 1GB (mutlak — veri kaybı riski) |

**Trend ek kuralı:** Son 15dk'da lag sürekli artıyorsa (monoton artış) → warning (henüz eşik aşılmasa bile)

---

### 6. Replication Lag — Süre (replication.replay_lag_seconds)

**Profil:**
```
avg=0.5s, stddev=1s, min=0, max=3s, p95=2s
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > 30s (mutlak) VEYA > max_seen × 3 |
| Critical | > 5dk (mutlak) |

---

### 7. WAL Üretimi (cluster.wal_bytes)

**Baseline kaynağı:** `fact.pg_cluster_delta` — metric_family='pg_stat_wal', metric_name='wal_bytes'

**Profil (dakikalık):**
```
avg=5MB/dk, stddev=3MB, min=0.1MB, max=25MB, p95=15MB
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 2 (ani bulk write) |
| Critical | > max_seen × 5 (olağandışı WAL patlaması) |

**Trend:** Saatlik WAL üretimi son 7 günde sürekli artıyorsa → kapasite uyarısı

---

### 8. Deadlock Sayısı (database.deadlocks)

**Baseline kaynağı:** `fact.pg_database_delta`

**Profil:**
```
avg=0, stddev=0, min=0, max=0, p95=0
(çoğu sistemde deadlock hiç olmaz)
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 2 (baseline varsa) VEYA > 3 / 15dk (baseline yoksa) |
| Critical | > max_seen × 5 VEYA > 10 / 15dk (tekrarlayan deadlock — ciddi contention) |

**Revize:** İlk deadlock'ta uyarı çok agresif. Yoğun OLTP sistemlerinde nadir deadlock normal olabilir. Baseline'a güvenilmeli — eğer sistem normalde 0-2 deadlock görüyorsa, 5+ anormal demektir.

---

### 9. Temp Dosya Kullanımı (database.temp_files / temp_bytes)

**Baseline kaynağı:** `fact.pg_database_delta`

**Profil:**
```
avg=10 dosya/saat, stddev=5, min=0, max=30, p95=25
avg_bytes=500MB/saat
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 2 VEYA temp_bytes > 5GB/saat |
| Critical | > max_seen × 5 VEYA temp_bytes > 20GB/saat |

**Disk bazlı:** Eğer temp tablespace boyutu biliniyorsa, %80 doluluk → critical

---

### 10. Transaction Throughput (database.xact_commit + xact_rollback)

**Baseline kaynağı:** `fact.pg_database_delta`

**Profil (saatlik):**
```
avg=50000 TPS, stddev=10000, min=5000, max=80000, p95=72000
```

**Alert seviyeleri — çift yönlü:**

| Seviye | Koşul |
|---|---|
| Normal | min_seen × 0.5 ≤ değer ≤ max_seen × 1.2 |
| Warning (yüksek) | > max_seen × 1.5 (trafik patlaması) |
| Warning (düşük) | < min_seen × 0.3 (servis durmuş olabilir) |
| Critical (düşük) | < min_seen × 0.1 (kesinlikle sorun var) |

**Neden düşük de önemli:** TPS aniden 0'a düşerse uygulama çökmüş demektir

---

### 11. Rollback Oranı (database.rollback_ratio)

**Hesaplama:** `xact_rollback / (xact_commit + xact_rollback) × 100`

**Profil:**
```
avg=0.5%, stddev=0.3%, min=0.1%, max=2%, p95=1.5%
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 2 VEYA > 10% (mutlak) |
| Critical | > 30% (mutlak — ciddi uygulama hatası) |

**Revize:** Sabit %5 warning çok düşük. Batch job'lar bilinçli rollback yapabilir (örn: ETL hata kontrolü). Baseline'a güvenilmeli — eğer sistem normalde %8 rollback görüyorsa, bu normal demektir. Mutlak sınır %10'a çıkarıldı.

---

### 12. Sequential Scan Yoğunluğu (table.seq_scan)

**Baseline kaynağı:** `fact.pg_table_stat_delta` — tablo bazlı

**Profil (tablo başına):**
```
tablo: orders — avg=100/saat, max=500, p95=400
tablo: users — avg=5000/saat, max=8000, p95=7500 (küçük tablo, seq scan normal)
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 2 VE tablo > 10000 satır (küçük tablolarda seq scan normal) |
| Critical | > max_seen × 5 VE tablo > 100000 satır |

**Akıllı filtre:** `n_live_tup < 10000` olan tablolarda seq scan alert'i üretilmez — küçük tabloda seq scan index'ten hızlı

---

### 13. Dead Tuple Oranı (table.dead_tuple_ratio)

**Hesaplama:** `n_dead_tup / (n_live_tup + n_dead_tup) × 100`

**Baseline kaynağı:** `fact.pg_table_stat_delta` — tablo bazlı

**Profil:**
```
avg=2%, stddev=3%, min=0%, max=15%, p95=10%
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen, 10%) |
| Warning | > 20% VEYA > max_seen × 1.5 (autovacuum yetişemiyor) |
| Critical | > 50% (tablo ciddi şekilde şişmiş) |

**Mutlak sınırlar:** Dead tuple oranı %20 üzeri her zaman warning — baseline ne derse desin

---

### 14. Sorgu Performansı (statement.avg_exec_time_ms)

**Baseline kaynağı:** `fact.pgss_delta` veya `agg.pgss_hourly` — statement_series bazlı

**Profil (statement başına):**
```
statement #42: avg=5ms, stddev=2ms, min=1ms, max=15ms, p95=12ms
statement #99: avg=500ms, stddev=100ms, min=200ms, max=900ms, p95=800ms
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 2 (sorgu regresyonu) |
| Critical | > max_seen × 5 VEYA > 30s (mutlak — çok yavaş) |

**Özel:** Yeni görülen statement (baseline yok) → ilk 24 saat sadece mutlak sınırlar (>30s) uygulanır

---

### 14a. Slow Query Spike (statement.slow_query_spike)

**Baseline kaynağı:** `fact.pgss_delta` — statement_series bazlı, queryid ile izleme

**Profil (query başına):**
```
queryid: 1234567890
  avg_exec_time: 50ms
  p95_exec_time: 120ms
  max_exec_time: 200ms
  calls_per_hour: 1000
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | avg_exec_time ≤ max(p95, max_seen) |
| Warning | avg_exec_time > max_seen × 2 (ani yavaşlama) |
| Critical | avg_exec_time > max_seen × 5 VEYA > 10s (mutlak) |

**Özel Durum — Spike Tespiti:**
- Son 15 dakikada avg_exec_time sürekli artıyorsa (monoton artış) → warning
- Tek bir çalıştırma > max_seen × 10 → critical (outlier)

**Akıllı Filtre:**
- `calls < 10 / saat` olan query'ler hariç (nadir çalışan query'ler için baseline güvenilmez)
- `total_exec_time < 1s / saat` olan query'ler hariç (toplam etkisi düşük)

---

### 14b. Query Call Frequency Anomaly (statement.call_frequency_anomaly)

**Baseline kaynağı:** `fact.pgss_delta` — statement_series bazlı, çağrı sayısı

**Profil (query başına):**
```
queryid: 1234567890
  avg_calls_per_hour: 1000
  stddev: 200
  min: 500
  max: 1500
  p95: 1400
```

**Alert seviyeleri — çift yönlü:**

| Seviye | Koşul |
|---|---|
| Normal | min_seen × 0.5 ≤ calls ≤ max_seen × 1.5 |
| Warning (yüksek) | calls > max_seen × 2 (ani trafik artışı) |
| Warning (düşük) | calls < min_seen × 0.3 (query çalışmıyor — uygulama sorunu?) |
| Critical (yüksek) | calls > max_seen × 5 (trafik patlaması — N+1 query?) |

**Önem:** Query çağrı sayısı aniden artarsa N+1 query problemi veya uygulama hatası olabilir.

---

### 14c. Query Error Rate (statement.error_rate)

**Baseline kaynağı:** `fact.pgss_delta` — `calls` vs `rows` karşılaştırması (dolaylı)

**Not:** pg_stat_statements error sayısını direkt vermez. Alternatif yaklaşımlar:
1. `rows = 0` olan query'ler (SELECT için anormal)
2. `mean_exec_time` çok düşük ama `calls` yüksek (hata ile erken sonlanan query'ler)
3. Log parsing ile error tespiti (gelecek implementasyon)

**Profil (query başına):**
```
queryid: 1234567890
  avg_rows_per_call: 10
  zero_row_ratio: 5% (SELECT için normal olabilir)
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | zero_row_ratio ≤ max(p95, max_seen, 10%) |
| Warning | zero_row_ratio > 30% (çok fazla boş sonuç) |
| Critical | zero_row_ratio > 70% (query neredeyse hiç sonuç döndürmüyor) |

**Sınırlama:** Bu tam error rate değil, proxy metrik. Gerçek error rate için log parsing gerekir.

---

### 14d. Query Plan Change Detection (statement.plan_change)

**Baseline kaynağı:** `fact.pgss_delta` — `planid` değişimi (PG13+)

**Profil (query başına):**
```
queryid: 1234567890
  current_planid: 9876543210
  avg_exec_time_with_this_plan: 50ms
  previous_planid: 1111111111
  avg_exec_time_with_previous_plan: 45ms
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | planid değişmedi VEYA yeni plan daha hızlı |
| Warning | planid değişti VE yeni plan > eski plan × 1.5 (plan regresyonu) |
| Critical | planid değişti VE yeni plan > eski plan × 3 (ciddi regresyon) |

**Önem:** Plan değişimi genellikle istatistik güncellemesi, index değişikliği veya veri dağılımı değişikliği nedeniyle olur. Yavaşlama varsa sorun işareti.

**Sınırlama:** PG13+ gerekli (planid kolonu). Önceki versiyonlarda plan değişimi tespit edilemez.

---

### 14e. Top N Slow Queries (statement.top_slow_queries)

**Baseline kaynağı:** `agg.pgss_hourly` — toplam çalışma süresi bazlı

**Profil (instance başına):**
```
Top 10 query by total_exec_time (son 1 saat):
1. queryid: 1234567890 — total: 300s, calls: 10000, avg: 30ms
2. queryid: 9876543210 — total: 250s, calls: 50, avg: 5s
...
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | Top 10 query'lerin total_exec_time toplamı < %50 (dengeli dağılım) |
| Warning | Tek bir query total_exec_time'ın > %30'unu tüketiyor (hotspot) |
| Critical | Tek bir query total_exec_time'ın > %50'sini tüketiyor (ciddi hotspot) |

**Önem:** Tek bir query'nin sistem kaynaklarını domine etmesi performans sorunu işareti.

---

### 14f. Query Temp Usage Spike (statement.temp_usage_spike)

**Baseline kaynağı:** `fact.pgss_delta` — `temp_blks_written` metriği

**Profil (query başına):**
```
queryid: 1234567890
  avg_temp_blks_per_call: 100
  max_temp_blks_per_call: 500
  p95: 400
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | temp_blks ≤ max(p95, max_seen) |
| Warning | temp_blks > max_seen × 2 (work_mem yetersiz) |
| Critical | temp_blks > max_seen × 5 VEYA > 100000 blks (800MB) |

**Önem:** Temp blok kullanımı artışı work_mem yetersizliği veya query plan değişikliği işareti.

---

### 14g. Query Max Execution Time Change (statement.max_exec_time_change)

**Baseline kaynağı:** `fact.pgss_delta` — `max_exec_time` metriği

**Profil (query başına):**
```
queryid: 1234567890
  historical_max_exec_time: 500ms (son 28 gün)
  avg_exec_time: 50ms
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | current_max ≤ historical_max × 1.5 |
| Warning | current_max > historical_max × 2 (outlier tespit edildi) |
| Critical | current_max > historical_max × 5 VEYA > 60s (mutlak) |

**Önem:** Max execution time artışı:
- Lock contention (query bekletildi)
- Plan değişikliği (kötü plan seçildi)
- Veri büyümesi (tablo çok büyüdü)
- Outlier query (anormal parametre değeri)

**Örnek Alert:**
```
⚠️ Query Max Execution Time Spike

Query ID: 1234567890
Query: SELECT * FROM orders WHERE user_id = $1

Önceki Max: 500ms (son 28 gün)
Yeni Max: 5000ms (10× artış!)

Son çalıştırma: 2026-04-24 14:23:15
Süre: 5000ms

Olası nedenler:
• Lock bekleme (pg_locks kontrol edin)
• Plan değişikliği (EXPLAIN kontrol edin)
• Anormal parametre değeri (user_id çok fazla satır döndürdü)
```

---

### 14h. Query Index Usage (statement.index_usage)

**Baseline kaynağı:** `fact.pgss_delta` — `shared_blks_hit + shared_blks_read` vs `local_blks_hit + local_blks_read`

**Not:** pg_stat_statements direkt "index kullanıldı mı" bilgisi vermez. Dolaylı tespit:
1. `shared_blks_read` yüksek → disk okuma (index yoksa seq scan)
2. `rows` / `calls` oranı yüksek → çok satır döndürüyor (index seçici değil)
3. EXPLAIN plan parsing (gelecek implementasyon)

**Profil (query başına):**
```
queryid: 1234567890
  avg_shared_blks_per_call: 10 (index kullanıyor)
  avg_rows_per_call: 5

queryid: 9876543210
  avg_shared_blks_per_call: 10000 (seq scan?)
  avg_rows_per_call: 50000
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | shared_blks_per_call < 1000 (index kullanıyor) |
| Warning | shared_blks_per_call > 1000 VE rows_per_call > 1000 (seq scan şüphesi) |
| Critical | shared_blks_per_call > 10000 VE rows_per_call > 10000 (kesin seq scan) |

**Ek Kontrol — Baseline Karşılaştırması:**
```
Eğer shared_blks_per_call > baseline_max × 2 ise:
  → Plan değişti, artık index kullanmıyor olabilir
```

**Sınırlama:** Bu tam index kullanımı tespiti değil, proxy metrik. Kesin tespit için EXPLAIN plan parsing gerekir.

**Gelecek İyileştirme:** 
- EXPLAIN plan otomatik çalıştırma (opsiyonel)
- "Seq Scan on large_table" pattern tespiti
- Index recommendation

---

### 14i. Query Disk Write (statement.disk_write)

**Baseline kaynağı:** `fact.pgss_delta` — `temp_blks_written + local_blks_written`

**Profil (query başına):**
```
queryid: 1234567890
  avg_disk_write_blks_per_call: 0 (sadece memory)
  max_disk_write_blks_per_call: 0

queryid: 9876543210
  avg_disk_write_blks_per_call: 5000 (disk'e yazıyor)
  max_disk_write_blks_per_call: 50000
  total_disk_write_mb_per_hour: 400MB
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | disk_write_blks = 0 VEYA < baseline_max |
| Warning | disk_write_blks > baseline_max × 2 VEYA total > 1GB/saat |
| Critical | disk_write_blks > baseline_max × 5 VEYA total > 10GB/saat |

**Disk Write Türleri:**

1. **temp_blks_written:** Temp dosya (work_mem yetersiz)
   - Sort, Hash, Materialize operasyonları
   - work_mem artırılmalı

2. **local_blks_written:** Temp tablo yazma
   - CREATE TEMP TABLE
   - Genellikle normal (batch job'lar)

**Örnek Alert:**
```
⚠️ Query Disk Write Spike

Query ID: 9876543210
Query: SELECT * FROM orders o JOIN users u ON o.user_id = u.id ORDER BY o.created_at

Disk Yazma:
• Önceki ortalama: 100MB/saat
• Mevcut: 5GB/saat (50× artış!)

Breakdown:
• temp_blks_written: 4.8GB (work_mem yetersiz)
• local_blks_written: 200MB (temp tablo)

Öneriler:
• work_mem artırın (mevcut: 4MB → önerilen: 64MB)
• Query'yi optimize edin (ORDER BY + JOIN maliyetli)
• Index ekleyin (created_at için)
```

---

### 14j. Query Rows Returned Anomaly (statement.rows_anomaly)

**Baseline kaynağı:** `fact.pgss_delta` — `rows` metriği

**Profil (query başına):**
```
queryid: 1234567890
  avg_rows_per_call: 10
  stddev: 5
  min: 1
  max: 50
  p95: 30
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | rows ≤ max(p95, max_seen) |
| Warning | rows > max_seen × 5 (anormal fazla satır) |
| Critical | rows > max_seen × 10 VEYA > 100000 (tek çağrıda çok fazla satır) |

**Önem:** Rows anomalisi:
- Parametre değeri anormal (örn: user_id = admin, binlerce satır döndürüyor)
- Index seçiciliği düştü (veri dağılımı değişti)
- WHERE clause eksik (tüm tablo döndürülüyor)
- Pagination eksik (LIMIT yok)

**Örnek Alert:**
```
⚠️ Query Rows Returned Anomaly

Query ID: 1234567890
Query: SELECT * FROM orders WHERE user_id = $1

Normal Durum:
• Ortalama: 10 satır/çağrı
• Maksimum: 50 satır

Mevcut Durum:
• Son çağrı: 50000 satır! (1000× fazla)
• Parametre: user_id = 12345

Olası nedenler:
• Bu user çok fazla order'a sahip (VIP müşteri?)
• Pagination eksik (LIMIT ekleyin)
• Index seçici değil (user_id için çok fazla satır)

Öneriler:
• LIMIT ekleyin (pagination)
• Composite index: (user_id, created_at)
• Query'yi filtreleyin (son 30 gün gibi)
```

---

### 15. Checkpoint Süresi (cluster.checkpoint_write_time)

**Baseline kaynağı:** `fact.pg_cluster_delta`

**Profil:**
```
avg=5s, stddev=3s, min=1s, max=15s, p95=12s
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen) |
| Warning | > max_seen × 2 VEYA > checkpoint_timeout × 0.5 |
| Critical | > checkpoint_timeout × 0.9 (checkpoint bitmeden yenisi başlıyor) |

**Kapasite:** `checkpoint_timeout` değeri `pg_settings`'ten okunur

---

### 16. Autovacuum Durumu (database.autovacuum_count)

**Baseline kaynağı:** `fact.pg_database_delta`

**Profil:**
```
avg=20/saat, stddev=5, min=5, max=40
```

**Alert seviyeleri — flatline tespiti:**

| Seviye | Koşul |
|---|---|
| Normal | > 0 (autovacuum çalışıyor) |
| Warning | Son 2 saatte 0 autovacuum (flatline) |
| Critical | Son 6 saatte 0 autovacuum |

**Ters alert:** Autovacuum sayısı max_seen × 3'ü geçerse → warning (çok fazla vacuum — tablo çok hızlı kirletiliyor)

---

### 17. Kullanılmayan Index (index.unused_index)

**Baseline kaynağı:** `fact.pg_index_stat_delta` — `idx_scan = 0` olan index'ler

**Profil:**
```
index: idx_users_email — idx_scan=0, son 30 gün boyunca hiç kullanılmamış
index: idx_orders_status — idx_scan=15000, aktif kullanımda
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | idx_scan > 0 (son 30 günde en az 1 kez kullanılmış) |
| Warning | idx_scan = 0 VE index boyutu > 100MB VE index yaşı > 30 gün |
| Critical | idx_scan = 0 VE index boyutu > 1GB VE index yaşı > 90 gün |

**Akıllı filtre:**

- Unique constraint index'ler hariç (veri bütünlüğü için gerekli)
- Primary key index'ler hariç
- Foreign key index'ler hariç (JOIN performansı için gerekli olabilir)
- Son 7 günde oluşturulmuş index'ler hariç (henüz kullanılmamış olabilir)

**Önem:** Kullanılmayan index'ler disk israfı + write overhead. Tespit edilmeli ve silinmeli.

---

### 18. Bloat Tespiti (table.bloat_ratio / index.bloat_ratio)

**Not:** Fiziksel bloat tespiti `pg_total_relation_size()` gibi fonksiyonlar gerektirir. Mevcut mimari bu fonksiyonları çağırmıyor (bilinçli sınırlama — kaynak PG'ye yük bindirmemek için).

**Alternatif yaklaşım — dead tuple bazlı tahmin:**

```
estimated_bloat_ratio = n_dead_tup / (n_live_tup + n_dead_tup) × 100
```

**Profil:**
```
avg=5%, stddev=3%, min=0%, max=20%, p95=15%
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | ≤ max(p95, max_seen, 15%) |
| Warning | > 25% VEYA (> 15% VE last_autovacuum > 24 saat) |
| Critical | > 50% VEYA (> 30% VE last_autovacuum > 7 gün) |

**Sınırlama:** Bu tam bloat değil, dead tuple oranı. Gerçek bloat tespiti için `pgstattuple` extension veya `pg_total_relation_size` karşılaştırması gerekir. Şu an için dead tuple oranı proxy metrik olarak kullanılıyor.

**Gelecek iyileştirme:** Opsiyonel olarak haftalık 1 kez `pgstattuple.pgstattuple()` çağrısı yapılabilir (düşük öncelikli background job).

---

### 19. Long Running Query (activity.long_running_query)

**Baseline kaynağı:** `fact.pg_activity_snapshot` — `now() - query_start` hesaplaması

**Profil (statement bazlı):**
```
statement #42: avg_duration=5s, max_duration=30s, p95=20s
statement #99: avg_duration=500s, max_duration=1800s, p95=1200s (batch job)
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | duration ≤ max(p95, max_seen) |
| Warning | duration > max_seen × 2 VEYA > 5dk (mutlak) |
| Critical | duration > max_seen × 5 VEYA > 30dk (mutlak) |
| Emergency | duration > 2 saat (mutlak — muhtemelen takılmış) |

**Özel durum:**

- `state = 'idle in transaction'` olan sorgular ayrı değerlendirilir (daha düşük eşik)
- `application_name` bazlı whitelist (örn: `pg_dump`, `pg_basebackup` hariç)
- Batch job pattern tespiti: eğer aynı query her gece 2 saat sürüyorsa, bu normal

**Hesaplama:** Activity snapshot'tan `extract(epoch from (snapshot_time - query_start))` ile süre hesaplanır.

---

### 20. Connection Kullanım Trendi (cluster.connection_trend)

**Baseline kaynağı:** `fact.pg_activity_snapshot` — günlük max bağlantı sayısı

**Profil (haftalık trend):**
```
7 gün önce: max=120
6 gün önce: max=125
5 gün önce: max=130
...
bugün: max=180
```

**Alert seviyeleri:**

| Seviye | Koşul |
|---|---|
| Normal | Haftalık artış < %10 |
| Warning | Haftalık artış > %20 VEYA 4 haftalık artış > %50 |
| Critical | Haftalık artış > %50 VEYA max_connections'a 2 hafta içinde ulaşılacak (lineer projeksiyon) |

**Hesaplama:**

```sql
-- Son 7 günün günlük max bağlantı sayısı
select date_trunc('day', snapshot_time) as day,
       max(active_count + idle_count) as max_connections
from fact.pg_activity_snapshot
where instance_pk = ?
  and snapshot_time > now() - interval '7 days'
group by 1
order by 1;

-- Lineer regresyon ile trend hesaplama
-- Eğer trend pozitif ve hızlı artıyorsa → kapasite uyarısı
```

**Önem:** Kapasite planlama için kritik. "Bağlantı sayısı her hafta %15 artıyor, 3 hafta sonra max_connections'a ulaşacağız" uyarısı.

---

### 21. pg_stat_io Metrikleri (PG16+)

**Not:** PostgreSQL 16+ için `pg_stat_io` view'i I/O istatistikleri sağlar. Henüz collector'da toplanmıyor.

**Gelecek metrikler:**

| Metrik | Açıklama | Alert Koşulu |
|---|---|---|
| `io.read_throughput_mb` | Disk okuma hızı (MB/s) | > max_seen × 2 (ani I/O patlaması) |
| `io.write_throughput_mb` | Disk yazma hızı (MB/s) | > max_seen × 2 |
| `io.eviction_rate` | Shared buffer eviction oranı | > max_seen × 3 (bellek yetersiz) |
| `io.fsync_time_ms` | fsync ortalama süresi | > max_seen × 2 (disk yavaşlaması) |

**Implementasyon:** Collector'a `PgStatIoCollector` eklenmeli (PG16+ için).

**Baseline:** Saatlik profil + günün saatine göre (gece backup vs gündüz OLTP farklı)

---

## Hassasiyet Seviyeleri

Kullanıcı eşik girmek yerine hassasiyet seçer:

| Hassasiyet | Warning Tetikleme | Critical Tetikleme | Açıklama |
|---|---|---|---|
| Düşük | > max_seen × 2.0 | > max_seen × 5.0 | Az alert, sadece ciddi anomaliler |
| Orta (varsayılan) | > max_seen × 1.3 | > max_seen × 3.0 | Dengeli |
| Yüksek | > max_seen × 1.1 | > max_seen × 1.5 | Çok alert, erken uyarı |

Mutlak sınırlar (max_connections %85, cache hit %90, vb.) hassasiyetten bağımsız — her zaman geçerli.

---

## Baseline Hesaplama

### Ne Zaman Hesaplanır

- Rollup job içinde, günde 1 kez (daily rollup saatinde)
- Son 4 haftalık veri kullanılır
- Saatlik profil: her saat dilimi için ayrı baseline (iş saatleri vs gece)
- Haftalık profil: hafta içi vs hafta sonu ayrı (opsiyonel)

### Minimum Veri Gereksinimi

| Durum | Davranış |
|---|---|
| < 24 saat veri | Sadece mutlak sınırlar uygulanır |
| 1-7 gün veri | Genel baseline (saatlik profil yok) |
| > 7 gün veri | Saatlik profil aktif |
| > 28 gün veri | Tam profil (haftalık pattern dahil) |

### Yeni Instance

İlk 24 saat: sadece mutlak sınırlar (max_connections %85, cache hit %90, vb.)
İlk 7 gün: genel baseline + mutlak sınırlar
7 gün sonra: tam adaptif mod

### Performans Tahmini

**Baseline satır sayısı:**

```
50 instance × 21 metrik × 24 saat = 25.200 baseline satırı (saatlik profil)
50 instance × 21 metrik × 1 genel = 1.050 baseline satırı (genel profil)
Toplam: ~26.000 satır
```

**Günlük hesaplama maliyeti:**

- Her metrik için son 28 günlük veri üzerinde `percentile_cont`, `avg`, `stddev` hesaplaması
- Örnek: `fact.pg_activity_snapshot` — 50 instance × 28 gün × 1440 dakika = 2M satır
- Saatlik gruplama: 50 instance × 28 gün × 24 saat = 33.600 satır
- Percentile hesaplama: `percentile_cont(0.95) within group (order by value)` — O(n log n)

**Optimizasyon:**

- Baseline hesaplama incremental yapılabilir (sadece son 1 günü ekle, 29 gün öncesini çıkar)
- Saatlik profil opsiyonel (hassasiyet düşük olan kurallar için genel baseline yeterli)
- Metrik bazlı paralel hesaplama (her metrik bağımsız)

**Tahmini süre:** 50 instance için günlük baseline hesaplama ~5-10 dakika (paralel işlemle)

---

## Kapasite Bilgileri

Collector discovery sırasında kaynak PG'den okunan değerler:

| Parametre | Kaynak | Kullanım |
|---|---|---|
| `max_connections` | `pg_settings` | Bağlantı alert'leri |
| `superuser_reserved_connections` | `pg_settings` | Efektif kapasite hesabı |
| `shared_buffers` | `pg_settings` | Cache hit beklentisi |
| `checkpoint_timeout` | `pg_settings` | Checkpoint süre alert'i |
| `autovacuum_max_workers` | `pg_settings` | Autovacuum kapasite |
| `work_mem` | `pg_settings` | Temp dosya beklentisi |

Bu değerler `control.instance_capability` tablosuna veya yeni bir `control.instance_settings` tablosuna kaydedilir.

---

## Veri Modeli Değişiklikleri

### control.alert_rule_template (yeni tablo)

Smart alert otomatik kurulum için şablon kurallar:

```sql
create table control.alert_rule_template (
  template_id serial primary key,
  template_name text not null,
  category text not null,  -- 'connection', 'performance', 'replication', 'maintenance', 'system'
  metric_key text not null,
  description text,
  
  -- Varsayılan ayarlar
  default_sensitivity text default 'medium',
  use_adaptive boolean default true,
  
  -- Mutlak sınırlar (opsiyonel)
  absolute_warning numeric,
  absolute_critical numeric,
  
  -- Metrik bazlı özel ayarlar (JSON)
  custom_config jsonb,
  
  -- Gereksinimler
  min_pg_version integer,  -- Örn: 16 (pg_stat_io için)
  required_extension text, -- Örn: 'pgstattuple' (bloat için)
  
  is_enabled boolean default true,
  display_order integer,
  
  created_at timestamptz default now()
);

-- Örnek template'ler (31 kural)
-- ... (önceki insert'ler)
```

---

### control.alert_snooze (yeni tablo)

Alert'leri geçici susturma:

```sql
create table control.alert_snooze (
  snooze_id serial primary key,
  
  -- Kapsam
  rule_id integer references control.alert_rule(rule_id),  -- null = tüm alert'ler
  instance_pk bigint references control.instance_inventory(instance_pk),  -- null = tüm instance'lar
  metric_key text,  -- null = tüm metrikler
  queryid bigint,  -- null = tüm query'ler (query bazlı alert'ler için)
  
  -- Süre
  snooze_until timestamptz not null,
  snooze_reason text,
  
  -- Meta
  created_by text not null,
  created_at timestamptz default now(),
  
  -- Constraint: en az biri belirtilmeli
  constraint check_snooze_scope check (
    rule_id is not null or 
    instance_pk is not null or 
    metric_key is not null or
    queryid is not null
  )
);

-- Index
create index idx_alert_snooze_active 
  on control.alert_snooze (snooze_until) 
  where snooze_until > now();

-- Örnek kullanım:
-- Tüm alert'leri 1 saat sustur (planlı bakım)
insert into control.alert_snooze (snooze_until, snooze_reason, created_by)
values (now() + interval '1 hour', 'Planned maintenance', 'admin');

-- Belirli bir instance'ı sustur
insert into control.alert_snooze (instance_pk, snooze_until, snooze_reason, created_by)
values (42, now() + interval '2 hours', 'Migration in progress', 'admin');

-- Belirli bir query'yi sustur (bilinen yavaş batch job)
insert into control.alert_snooze (queryid, snooze_until, snooze_reason, created_by)
values (1234567890, now() + interval '1 week', 'Known slow batch job', 'admin');
```

---

### control.maintenance_window (yeni tablo)

Tekrarlayan bakım pencereleri:

```sql
create table control.maintenance_window (
  window_id serial primary key,
  window_name text not null,
  description text,
  
  -- Kapsam
  instance_pks bigint[],  -- null = tüm instance'lar
  
  -- Zamanlama (cron-like)
  day_of_week integer[],  -- 0-6 (0=Pzt), null = her gün
  start_time time not null,  -- 02:00
  end_time time not null,    -- 04:00
  timezone text default 'UTC',
  
  -- Alert davranışı
  suppress_all_alerts boolean default true,
  suppress_severity text[],  -- ['warning', 'critical'] (null = hepsi)
  
  is_enabled boolean default true,
  created_at timestamptz default now()
);

-- Örnek: Her Pazar 02:00-04:00 tüm alert'leri sustur
insert into control.maintenance_window (window_name, day_of_week, start_time, end_time)
values ('Weekly Backup', array[0], '02:00', '04:00');

-- Örnek: Her gece 01:00-03:00 sadece warning alert'leri sustur
insert into control.maintenance_window (window_name, start_time, end_time, suppress_severity)
values ('Nightly Jobs', '01:00', '03:00', array['warning']);
```

---

### control.notification_channel (yeni tablo)

Alert bildirim kanalları:

```sql
create table control.notification_channel (
  channel_id serial primary key,
  channel_name text not null unique,
  channel_type text not null check (channel_type in ('email', 'slack', 'pagerduty', 'teams', 'webhook')),
  
  -- Konfigürasyon (JSON)
  config jsonb not null,
  -- email: {"recipients": ["admin@example.com", "team@example.com"]}
  -- slack: {"webhook_url": "https://hooks.slack.com/...", "channel": "#alerts"}
  -- pagerduty: {"integration_key": "xxx", "severity_mapping": {...}}
  -- webhook: {"url": "https://api.example.com/alerts", "headers": {...}}
  
  -- Filtreleme
  min_severity text,  -- 'warning', 'critical', 'emergency' (null = hepsi)
  instance_pks bigint[],  -- null = tüm instance'lar
  metric_categories text[],  -- ['connection', 'performance'] (null = hepsi)
  
  is_enabled boolean default true,
  created_at timestamptz default now()
);

-- Örnek: Slack entegrasyonu (sadece critical alert'ler)
insert into control.notification_channel (channel_name, channel_type, config, min_severity)
values (
  'Slack - Critical Alerts',
  'slack',
  '{"webhook_url": "https://hooks.slack.com/services/xxx", "channel": "#db-alerts"}',
  'critical'
);

-- Örnek: PagerDuty entegrasyonu (sadece emergency)
insert into control.notification_channel (channel_name, channel_type, config, min_severity)
values (
  'PagerDuty - On-Call',
  'pagerduty',
  '{"integration_key": "xxx", "severity_mapping": {"emergency": "critical", "critical": "error"}}',
  'emergency'
);

-- Örnek: Email (tüm alert'ler, sadece production instance'ları)
insert into control.notification_channel (channel_name, channel_type, config, instance_pks)
values (
  'Email - Production Team',
  'email',
  '{"recipients": ["prod-team@example.com"]}',
  array[42, 43]  -- prod-db-01, prod-db-02
);
```

---

### control.baseline_version (yeni tablo)

Baseline versiyonlama ve invalidation:

```sql
create table control.baseline_version (
  version_id serial primary key,
  instance_pk bigint not null references control.instance_inventory(instance_pk),
  
  -- Versiyon bilgisi
  version_number integer not null default 1,
  pg_version text,  -- '16.2' (major upgrade tespiti için)
  
  -- Invalidation nedeni
  invalidation_reason text,  -- 'major_upgrade', 'manual_reset', 'schema_change'
  invalidated_at timestamptz,
  invalidated_by text,
  
  -- Baseline periyodu
  baseline_start timestamptz not null,
  baseline_end timestamptz,
  
  is_active boolean default true,
  created_at timestamptz default now(),
  
  unique (instance_pk, version_number)
);

-- Mevcut baseline'ı invalidate et ve yeni versiyon başlat
create or replace function invalidate_baseline(
  p_instance_pk bigint,
  p_reason text,
  p_invalidated_by text
) returns void as $$
begin
  -- Mevcut versiyonu kapat
  update control.baseline_version
  set is_active = false,
      baseline_end = now(),
      invalidation_reason = p_reason,
      invalidated_at = now(),
      invalidated_by = p_invalidated_by
  where instance_pk = p_instance_pk
    and is_active = true;
  
  -- Yeni versiyon başlat
  insert into control.baseline_version (instance_pk, version_number, baseline_start)
  select p_instance_pk, 
         coalesce(max(version_number), 0) + 1,
         now()
  from control.baseline_version
  where instance_pk = p_instance_pk;
  
  -- Eski baseline verilerini sil (opsiyonel)
  delete from control.metric_baseline
  where instance_pk = p_instance_pk;
  
  delete from control.metric_baseline_query
  where instance_pk = p_instance_pk;
end;
$$ language plpgsql;

-- Kullanım:
select invalidate_baseline(42, 'major_upgrade', 'admin');
```

-- Örnek template'ler
insert into control.alert_rule_template 
  (template_name, category, metric_key, description, display_order)
values
  ('Aktif Bağlantı Sayısı', 'connection', 'activity.active_count', 
   'Aktif bağlantı sayısı normalin üzerinde', 1),
  
  ('Idle in Transaction', 'connection', 'activity.idle_in_transaction_count',
   'Uzun süre idle in transaction durumunda kalan bağlantılar', 2),
  
  ('Lock Bekleme', 'connection', 'activity.waiting_count',
   'Lock bekleyen sorgu sayısı', 3),
  
  ('Long Running Query', 'connection', 'activity.long_running_query',
   'Normalden uzun süren sorgular', 4),
  
  ('Connection Trend', 'connection', 'cluster.connection_trend',
   'Bağlantı sayısı sürekli artıyor (kapasite uyarısı)', 5),
  
  ('Cache Hit Ratio', 'performance', 'database.cache_hit_ratio',
   'Cache hit oranı düşük', 6),
  
  ('Sequential Scan', 'performance', 'table.seq_scan',
   'Büyük tablolarda sequential scan artışı', 7),
  
  ('Sorgu Performansı', 'performance', 'statement.avg_exec_time_ms',
   'Sorgu çalışma süresi normalden yüksek', 8),
  
  ('Slow Query Spike', 'performance', 'statement.slow_query_spike',
   'Belirli bir query aniden yavaşladı (queryid bazlı)', 9),
  
  ('Query Call Frequency', 'performance', 'statement.call_frequency_anomaly',
   'Query çağrı sayısı anormal (N+1 query tespiti)', 10),
  
  ('Query Error Rate', 'performance', 'statement.error_rate',
   'Query error oranı yüksek (dolaylı tespit)', 11),
  
  ('Query Plan Change', 'performance', 'statement.plan_change',
   'Query plan değişti ve yavaşladı (PG13+)', 12),
  
  ('Top Slow Queries', 'performance', 'statement.top_slow_queries',
   'Tek bir query sistem kaynaklarını domine ediyor', 13),
  
  ('Query Temp Usage', 'performance', 'statement.temp_usage_spike',
   'Query temp blok kullanımı arttı (work_mem yetersiz)', 14),
  
  ('Query Max Exec Time Change', 'performance', 'statement.max_exec_time_change',
   'Query max çalışma süresi değişti (outlier tespit)', 15),
  
  ('Query Index Usage', 'performance', 'statement.index_usage',
   'Query index kullanmıyor (seq scan şüphesi)', 16),
  
  ('Query Disk Write', 'performance', 'statement.disk_write',
   'Query diske yazıyor (temp + local blks)', 17),
  
  ('Query Rows Anomaly', 'performance', 'statement.rows_anomaly',
   'Query anormal fazla satır döndürüyor', 18),
  
  ('Temp Dosya Kullanımı', 'performance', 'database.temp_files',
   'Temp dosya kullanımı yüksek (work_mem yetersiz)', 19),
  
  ('Checkpoint Süresi', 'performance', 'cluster.checkpoint_write_time',
   'Checkpoint süresi uzun', 20),
  
  ('Transaction Throughput', 'performance', 'database.xact_throughput',
   'TPS aniden düştü veya arttı', 21),
  
  ('Replication Lag (Byte)', 'replication', 'replication.replay_lag_bytes',
   'Replikasyon gecikmesi (byte)', 22),
  
  ('Replication Lag (Süre)', 'replication', 'replication.replay_lag_seconds',
   'Replikasyon gecikmesi (süre)', 23),
  
  ('Dead Tuple Oranı', 'maintenance', 'table.dead_tuple_ratio',
   'Dead tuple oranı yüksek (autovacuum yetişemiyor)', 24),
  
  ('Autovacuum Durumu', 'maintenance', 'database.autovacuum_count',
   'Autovacuum çalışmıyor (flatline)', 25),
  
  ('Bloat Tespiti', 'maintenance', 'table.bloat_ratio',
   'Tablo/index şişmesi (bloat)', 26),
  
  ('Kullanılmayan Index', 'maintenance', 'index.unused_index',
   'Hiç kullanılmayan index (disk israfı)', 27),
  
  ('WAL Üretimi', 'system', 'cluster.wal_bytes',
   'WAL üretimi aniden arttı', 28),
  
  ('Deadlock Sayısı', 'system', 'database.deadlocks',
   'Deadlock sayısı normalden yüksek', 29),
  
  ('Rollback Oranı', 'system', 'database.rollback_ratio',
   'Rollback oranı yüksek (uygulama hatası)', 30),
  
  ('pg_stat_io Metrikleri', 'system', 'io.read_throughput_mb',
   'I/O throughput aniden arttı (PG16+)', 31);
```

---

### control.metric_baseline (yeni tablo)

```sql
create table control.metric_baseline (
  instance_pk bigint not null references control.instance_inventory(instance_pk),
  metric_key text not null,
  hour_of_day integer,          -- null = genel, 0-23 = saatlik
  
  avg_value numeric,
  stddev_value numeric,
  min_value numeric,
  max_value numeric,
  p50_value numeric,
  p95_value numeric,
  p99_value numeric,
  sample_count integer,
  
  capacity_value numeric,
  capacity_source text,
  
  baseline_start timestamptz,
  baseline_end timestamptz,
  updated_at timestamptz default now(),
  
  primary key (instance_pk, metric_key, coalesce(hour_of_day, -1))
);
```

### control.alert_rule değişiklikleri

```sql
alter table control.alert_rule
  add column if not exists sensitivity text default 'medium'
    check (sensitivity in ('low', 'medium', 'high')),
  add column if not exists use_adaptive boolean default true,
  add column if not exists absolute_warning numeric,
  add column if not exists absolute_critical numeric,
  add column if not exists template_id integer references control.alert_rule_template(template_id),
  -- template_id: hangi template'ten oluşturuldu (opsiyonel, tracking için)
  
  add column if not exists scope text default 'single_instance'
    check (scope in ('single_instance', 'all_instances', 'instance_group')),
  add column if not exists instance_group_id integer references control.instance_group(group_id);
  -- scope:
  --   'single_instance': sadece instance_pk'daki instance (mevcut davranış)
  --   'all_instances': tüm instance'lar (mevcut + gelecekte eklenecekler)
  --   'instance_group': belirli bir grup (örn: "production", "staging")
```

**Scope Mantığı:**

1. **single_instance (varsayılan):**
   - Kural sadece `instance_pk` kolonundaki instance için geçerli
   - Yeni instance eklenince bu kurala dahil olmaz
   - Mevcut davranış (geriye uyumlu)

2. **all_instances:**
   - Kural tüm instance'lar için geçerli
   - Yeni instance eklenince otomatik bu kurala dahil olur
   - `instance_pk` kolonu NULL olur (tüm instance'ları kapsadığı için)

3. **instance_group:**
   - Kural belirli bir grup için geçerli (örn: "production" grubu)
   - Yeni instance bu gruba eklenirse kurala dahil olur
   - `instance_group_id` kolonu grup ID'sini tutar

---

### control.instance_group (yeni tablo)

Instance'ları gruplamak için:

```sql
create table control.instance_group (
  group_id serial primary key,
  group_name text not null unique,
  description text,
  created_at timestamptz default now()
);

create table control.instance_group_member (
  group_id integer not null references control.instance_group(group_id) on delete cascade,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  added_at timestamptz default now(),
  primary key (group_id, instance_pk)
);

-- Örnek gruplar
insert into control.instance_group (group_name, description)
values
  ('production', 'Production veritabanları'),
  ('staging', 'Staging ortamı'),
  ('development', 'Development ortamı');
```

### control.instance_settings (yeni tablo)

```sql
create table control.instance_settings (
  instance_pk bigint primary key references control.instance_inventory(instance_pk),
  max_connections integer,
  superuser_reserved integer,
  shared_buffers_bytes bigint,
  checkpoint_timeout_seconds integer,
  autovacuum_max_workers integer,
  work_mem_bytes bigint,
  updated_at timestamptz default now()
);
```

---

### control.smart_alert_config (yeni tablo)

Kullanıcının "tüm instance'lar için otomatik kural oluştur" tercihini saklar:

```sql
create table control.smart_alert_config (
  config_id serial primary key,
  
  -- Kapsam
  apply_to_all_instances boolean default false,
  instance_pks bigint[],  -- null ise apply_to_all_instances=true
  
  -- Kategori seçimi
  enabled_categories text[],  -- ['connection', 'performance', 'replication', 'maintenance', 'system']
  
  -- Ayarlar
  default_sensitivity text default 'medium',
  
  -- Otomatik kural oluşturma
  auto_create_for_new_instances boolean default false,
  
  created_by text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

---

## Alert Değerlendirme Akışı (Güncellenmiş)

```
1. Aktif kuralları oku
2. Her kural için:
   a. Snooze kontrolü:
      - alert_snooze tablosunda bu kural/instance/metrik/queryid için aktif snooze var mı?
      - maintenance_window içinde miyiz? (gün + saat kontrolü)
      - Varsa → alert değerlendirmesini atla
   
   b. Scope'a göre instance listesi belirle:
      - single_instance: sadece instance_pk
      - all_instances: tüm aktif instance'lar
      - instance_group: instance_group_member'dan grup üyeleri
   
   c. Her instance için:
      i. Baseline version kontrolü:
         - baseline_version tablosundan aktif versiyon al
         - Eğer invalidate edilmişse → sadece mutlak sınırlar kullan
      
      ii. use_adaptive = true ise:
         - metric_baseline'dan bu instance + metrik + saat için profil oku
         - Profil varsa: sensitivity'ye göre eşik hesapla
           warning = max(max_seen × sensitivity_multiplier, absolute_warning)
           critical = max(max_seen × critical_multiplier, absolute_critical)
         - Profil yoksa (yeni instance): sadece absolute_* sınırları kullan
      
      iii. use_adaptive = false ise:
         - Eski davranış: sabit warning_threshold / critical_threshold
      
      iv. Metriği sorgula
      v. Hesaplanan eşikle karşılaştır
      vi. Alert oluştur/resolve et
      
      vii. Notification gönder:
         - notification_channel tablosundan aktif kanalları al
         - Severity, instance, category filtrelerine göre uygun kanalları seç
         - Her kanal için bildirim gönder (email, slack, pagerduty, vb.)
```

**Örnek SQL (snooze kontrolü):**

```sql
-- Alert snoozed mı kontrol et
with active_snoozes as (
  select *
  from control.alert_snooze
  where snooze_until > now()
    and (
      rule_id = ? or rule_id is null
    )
    and (
      instance_pk = ? or instance_pk is null
    )
    and (
      metric_key = ? or metric_key is null
    )
    and (
      queryid = ? or queryid is null
    )
),
active_maintenance as (
  select *
  from control.maintenance_window
  where is_enabled = true
    and (
      instance_pks is null or ? = any(instance_pks)
    )
    and (
      day_of_week is null or extract(dow from now()) = any(day_of_week)
    )
    and current_time between start_time and end_time
)
select 
  case 
    when exists (select 1 from active_snoozes) then 'snoozed'
    when exists (select 1 from active_maintenance) then 'maintenance'
    else 'active'
  end as alert_status;
```

---

## UI Değişiklikleri

### Kural Oluşturma Formu (Güncellenmiş)

**Mod seçimi:**
- ○ Adaptif (önerilen) — sistem normali öğrenir, anomali tespit eder
- ○ Sabit eşik — manuel warning/critical değeri gir

**Adaptif modda:**
- Hassasiyet: [Düşük] [Orta ●] [Yüksek]
- Mutlak alt/üst sınır (opsiyonel): "Her durumda bu sınırı aşarsa alert"
- Baseline durumu göstergesi: "Bu instance için 14 günlük veri var, saatlik profil aktif"

**Kural detay sayfasında:**
- Mevcut baseline profili görselleştirmesi (avg, min, max, p95 çizgi grafik)
- Son 24 saatteki gerçek değerler vs baseline karşılaştırması
- "Bu kural şu an tetiklenir miydi?" simülasyonu

---

## Sınırlamalar ve Gelecek İyileştirmeler

### Mevcut Sınırlamalar

1. **Fiziksel bloat tespiti yok:** `pg_total_relation_size()` çağrılmıyor (kaynak PG'ye yük bindirmemek için). Dead tuple oranı proxy metrik olarak kullanılıyor.

2. **pg_stat_io metrikleri yok:** PG16+ için I/O istatistikleri henüz toplanmıyor. Disk throughput, eviction rate gibi metrikler eksik.

3. **Statement-level long running query:** Activity snapshot'ta query_start var ama statement_series ile eşleştirilmiyor. Hangi sorgunun uzun sürdüğü tam tespit edilemiyor.

4. **Trend analizi sınırlı:** Sadece connection trend var. WAL üretimi, TPS, cache hit gibi metriklerde trend analizi yok.

5. **Seasonal pattern yok:** Aylık pattern (ay sonu batch job'lar) veya yıllık pattern (yıl sonu raporlama) desteklenmiyor.

6. **Query index usage dolaylı:** EXPLAIN plan parsing yok, sadece shared_blks bazlı tahmin.

7. **Alert notification channels sınırlı:** Sadece email/webhook var, Slack/PagerDuty entegrasyonu yok.

8. **Alert snooze/mute yok:** Planlı bakım sırasında alert'leri geçici susturma özelliği yok.

9. **Alert grouping yok:** Aynı anda çok alert tetiklenirse her biri ayrı bildirim gönderilir.

10. **Baseline invalidation manuel:** Major upgrade sonrası baseline otomatik sıfırlanmıyor.

---

### Gelecek İyileştirmeler

#### Faz 2: Temel Özellikler (2-3 ay)

1. **Alert Snooze/Mute:**
   - Belirli süre için alert'i sustur (1 saat, 1 gün, 1 hafta)
   - Belirli query için mute (bilinen yavaş batch job)
   - Maintenance window tanımlama (her Pazar 02:00-04:00 alert yok)
   - UI: "Snooze for 1 hour" butonu

2. **Alert Notification Channels:**
   - Slack entegrasyonu (webhook + rich formatting)
   - PagerDuty entegrasyonu (incident creation)
   - Microsoft Teams entegrasyonu
   - Generic webhook (custom integration)
   - Severity bazlı routing (Warning → Slack, Critical → PagerDuty)
   - On-call schedule entegrasyonu (PagerDuty/Opsgenie)

3. **Baseline Invalidation:**
   - Major version upgrade sonrası otomatik baseline reset
   - Schema değişikliği sonrası query baseline reset (DDL tracking)
   - Manuel baseline reset (UI'dan "Reset Baseline" butonu)
   - Baseline versioning (eski baseline'ları sakla, karşılaştır)

4. **Alert History & Trend:**
   - Alert geçmişi sayfası (son 30 gün)
   - Trend analizi: "Bu alert her gün 14:00'te tetikleniyor" (batch job tespiti)
   - MTTR (Mean Time To Resolution): Ortalama çözüm süresi
   - Alert frequency chart (günlük/haftalık)
   - Top 10 most frequent alerts

---

#### Faz 3: İleri Seviye Özellikler (3-6 ay)

5. **Alert Escalation:**
   - Warning 15 dakika devam ederse → Critical'e yükselt
   - Critical 1 saat devam ederse → Emergency + farklı notification channel
   - Escalation policy tanımlama (UI'dan)
   - Auto-resolve: Alert 5 dakika normal kalırsa otomatik resolve

6. **Alert Grouping/Deduplication:**
   - Aynı anda 10 query yavaşlarsa → "5 query aniden yavaşladı" gruplanmış alert
   - Root cause analysis: Ortak neden tespit et (disk yavaş, lock contention, vb.)
   - Alert correlation: İlişkili alert'leri grupla
   - Smart grouping: ML ile benzer alert'leri grupla

7. **Alert Dependency/Correlation:**
   - "Disk dolu" → "Temp file kullanımı yüksek" (bağımlı alert'leri gizle)
   - "Replication lag yüksek" → "WAL üretimi yüksek" (ilişkili alert'leri grupla)
   - Dependency graph: Alert'ler arası ilişki haritası
   - Root cause alert: Asıl sorunu vurgula, yan etkileri gizle

8. **EXPLAIN Plan Parsing:**
   - Query için otomatik EXPLAIN plan çalıştır (opsiyonel, düşük öncelikli)
   - "Seq Scan on large_table" pattern tespiti
   - Index recommendation: "Bu query için şu index'i ekleyin"
   - Plan regression detection: Yeni plan eski plandan kötü mü?

---

#### Faz 4: Otomasyon ve ML (6-12 ay)

9. **Automatic Remediation Actions:**
   - "Idle in transaction > 5dk" → Otomatik `pg_terminate_backend()` (kullanıcı onayı ile)
   - "Unused index" → Otomatik DROP önerisi (dry-run mode)
   - "work_mem yetersiz" → Otomatik work_mem artırma önerisi
   - "Lock contention" → Otomatik deadlock_timeout artırma
   - Remediation history: Hangi aksiyonlar alındı, sonuçları ne oldu?

10. **Anomaly Detection ML:**
    - Basit eşik yerine LSTM/Prophet ile zaman serisi anomali tespiti
    - Seasonal pattern öğrenme (aylık, yıllık)
    - Multi-metric correlation: "Cache hit düşüyor + seq scan artıyor + temp file artıyor" → missing index alert
    - Predictive alerting: "2 saat sonra disk dolacak" (trend bazlı)

11. **Custom Metrics:**
    - Kullanıcı kendi metriğini tanımlayabilir (SQL query ile)
    - Örnek: "pending_orders_count" → `SELECT COUNT(*) FROM orders WHERE status = 'pending'`
    - Custom metrik için de adaptif baseline
    - Custom metrik için alert kuralı oluşturma
    - Metrik library: Hazır custom metrik şablonları

12. **Query Fingerprint Normalization:**
    - Aynı query farklı parametrelerle → aynı queryid (PostgreSQL zaten yapıyor)
    - Farklı queryid'ler aynı query pattern'i → normalization (whitespace, comment farkı)
    - Query grouping: Benzer query'leri grupla (örn: "SELECT * FROM users WHERE id = ?" ailesi)
    - Cross-instance query comparison: Aynı query farklı instance'larda nasıl performans gösteriyor?

13. **Advanced Trend Analysis:**
    - WAL üretimi trend: "Son 7 günde %20 artıyor, 3 hafta sonra disk dolacak"
    - TPS trend: "Her hafta %10 artıyor, 2 ay sonra max_connections'a ulaşacağız"
    - Cache hit trend: "Son 1 ayda %2 düşüyor, shared_buffers yetersiz olabilir"
    - Capacity planning dashboard: Tüm trendleri tek sayfada göster

14. **Alert Simulation & Testing:**
    - "Bu kuralı geçmişe uygulasaydım kaç alert tetiklenirdi?" (backtesting)
    - Alert rule testing: Yeni kural oluşturmadan önce simüle et
    - False positive rate: Bu kural ne kadar gürültü üretiyor?
    - Alert tuning: Hassasiyeti otomatik ayarla (ML ile)

---

#### Faz 5: Enterprise Özellikler (12+ ay)

15. **Multi-Tenant Alert Management:**
    - Farklı takımlar için ayrı alert kuralları
    - Role-based access control (RBAC)
    - Alert ownership: Her alert'in sahibi var
    - Team-specific notification channels

16. **Alert SLA & Reporting:**
    - SLA tanımlama: "Critical alert 5 dakikada çözülmeli"
    - SLA compliance reporting: "Bu ay %95 SLA compliance"
    - Executive dashboard: Üst yönetim için özet rapor
    - Alert cost analysis: Her alert'in maliyeti (engineer time)

17. **Integration Ecosystem:**
    - Grafana dashboard entegrasyonu
    - Datadog/New Relic entegrasyonu
    - ServiceNow incident creation
    - Jira ticket creation
    - ChatOps: Slack'ten alert yönetimi (/pgstat mute alert-123)

18. **AI-Powered Root Cause Analysis:**
    - "Bu alert neden tetiklendi?" sorusuna otomatik cevap
    - Benzer geçmiş alert'leri bul ve çözümlerini öner
    - Knowledge base: Geçmiş alert'lerden öğren
    - Chatbot: "Neden bu query yavaşladı?" sorusuna cevap ver

---

## Implementasyon Sırası

### Faz 1: Temel Altyapı + Kritik Özellikler (3-4 hafta)

1. **Veri modeli:**
   - `control.alert_rule_template` tablosu + 31 template kaydı
   - `control.metric_baseline` tablosu
   - `control.metric_baseline_query` tablosu (query bazlı)
   - `control.instance_settings` tablosu
   - `control.smart_alert_config` tablosu
   - `control.instance_group` + `control.instance_group_member` tabloları
   - `control.alert_snooze` tablosu ✨ YENİ
   - `control.maintenance_window` tablosu ✨ YENİ
   - `control.notification_channel` tablosu ✨ YENİ
   - `control.baseline_version` tablosu ✨ YENİ
   - `control.alert_rule` güncellemeleri (sensitivity, use_adaptive, template_id, scope)

2. **Collector servisleri:**
   - `InstanceSettingsCollector` — discovery sırasında pg_settings okuma
   - `BaselineCalculator` — günlük baseline hesaplama (daily rollup içinde)
   - `BaselineVersionManager` — PG version değişikliği tespiti ✨ YENİ

3. **Alert değerlendirme:**
   - `AlertRuleEvaluator` güncelleme — adaptif eşik hesaplama
   - Baseline lookup + sensitivity multiplier
   - Kapasite entegrasyonu
   - Snooze/maintenance window kontrolü ✨ YENİ
   - Notification channel routing ✨ YENİ

4. **Notification servisleri:** ✨ YENİ
   - `EmailNotifier` — email gönderimi
   - `SlackNotifier` — Slack webhook entegrasyonu
   - `PagerDutyNotifier` — PagerDuty incident creation
   - `WebhookNotifier` — generic webhook
   - `NotificationRouter` — severity/instance/category bazlı routing

### Faz 2: API ve UI (3-4 hafta)

5. **API endpoint'leri:**
   - `POST /api/alerts/smart-setup` — otomatik kural oluşturma
   - `GET /api/alerts/templates` — template listesi
   - `GET /api/alerts/{alert_id}/calculation` — hesaplama detayı
   - `GET /api/instances/{instance_pk}/baseline/{metric_key}` — baseline profil
   - `POST /api/alerts/simulate-threshold` — eşik simülasyonu
   - `POST /api/alerts/snooze` — alert susturma ✨ YENİ
   - `POST /api/maintenance-windows` — maintenance window oluşturma ✨ YENİ
   - `POST /api/notification-channels` — notification channel oluşturma ✨ YENİ
   - `POST /api/instances/{instance_pk}/baseline/invalidate` — baseline sıfırlama ✨ YENİ

6. **UI geliştirme:**
   - Smart alert kurulum wizard'ı
   - Alert listesinde (ⓘ) butonu + popover
   - Alert detay sayfasında hesaplama açıklaması
   - Baseline görselleştirme (grafik)
   - Interaktif eşik simülasyonu
   - Manuel kural oluşturma formu (adaptif mod)
   - Alert snooze butonu + modal ✨ YENİ
   - Maintenance window yönetim sayfası ✨ YENİ
   - Notification channel yönetim sayfası ✨ YENİ
   - Baseline version geçmişi sayfası ✨ YENİ

### Faz 3: Eksik Metrikler (2 hafta)

7. **Yeni metrik collector'ları:**
   - Unused index tespiti (idx_scan = 0)
   - Long running query (activity snapshot'tan süre hesaplama)
   - Connection trend (günlük max bağlantı, lineer regresyon)
   - Query bazlı metrikler (10 yeni metrik)

8. **Baseline hesaplama genişletme:**
   - Tablo bazlı metrikler (seq_scan, dead_tuple_ratio)
   - Statement bazlı metrikler (avg_exec_time_ms, call_frequency, vb.)
   - Query bazlı baseline (queryid)

### Faz 4: İleri Seviye (gelecek)

9. **PG16+ pg_stat_io:**
   - `PgStatIoCollector` eklenmeli
   - I/O throughput, eviction rate metrikleri

10. **Opsiyonel bloat tespiti:**
    - Haftalık `pgstattuple.pgstattuple()` çağrısı
    - Düşük öncelikli background job

11. **Alert Escalation:**
    - Warning 15 dakika devam ederse → Critical'e yükselt
    - Escalation policy tanımlama

12. **Alert Grouping:**
    - Aynı anda çok alert tetiklenirse grupla
    - Root cause analysis

13. **ML anomaly detection:**
    - LSTM/Prophet ile zaman serisi anomali tespiti
    - Multi-metric correlation

14. **Automatic remediation:**
    - "Idle in transaction > 5dk" → otomatik `pg_terminate_backend()` önerisi
    - Kullanıcı onayı ile otomatik aksiyon

---

## Kullanıcı Akışı Örnekleri

### Senaryo 1: İlk Kurulum

1. Kullanıcı "Smart Alerts" sayfasına gider
2. "Smart Alerts Aktifleştir" butonuna tıklar
3. Wizard açılır:
   - Instance seçimi: "Tüm instance'lar" veya "Seçili instance'lar"
   - Kategori seçimi: Bağlantı, Performans, Replikasyon, Bakım, Sistem (hepsi seçili)
   - Hassasiyet: Orta (varsayılan)
4. "Kuralları Oluştur" butonuna tıklar
5. Sistem 42 kural oluşturur (2 instance × 21 metrik)
6. Başarı mesajı: "İlk 7 gün baseline oluşturulacak"

### Senaryo 2: Yeni Instance Ekleme

1. Kullanıcı yeni bir instance ekler: "prod-db-03"
2. Eğer "auto_create_for_new_instances" aktifse:
   - Sistem otomatik 21 kural oluşturur
   - Bildirim: "prod-db-03 için smart alerts otomatik oluşturuldu"
3. Değilse:
   - Bildirim: "prod-db-03 için smart alerts oluşturmak ister misiniz?"
   - Kullanıcı "Evet" derse wizard açılır (sadece bu instance için)

### Senaryo 3: Alert Tetiklendi

1. Sistem alert tespit eder: "prod-db-01 aktif bağlantı sayısı yüksek"
2. Alert listesinde görünür: ⚠️ Warning
3. Kullanıcı (ⓘ) butonuna tıklar
4. Popover açılır:
   - Mevcut değer: 185 bağlantı
   - Baseline: avg=50, max=72
   - Eşik: 133 (max × 1.3)
   - Neden tetiklendi: 185 > 133
   - Öneriler: Connection pooling kontrol et
5. Kullanıcı "Detaylar" linkine tıklar
6. Alert detay sayfası açılır:
   - Son 7 günlük grafik (baseline bantları ile)
   - Hesaplama açıklaması (adım adım)
   - Interaktif simülasyon (hassasiyet değiştir)

### Senaryo 4: Hassasiyet Ayarlama

1. Kullanıcı çok fazla alert alıyor
2. Alert kuralı detay sayfasına gider
3. Hassasiyet: Orta → Düşük değiştirir
4. Sistem eşikleri yeniden hesaplar:
   - Warning: 133 → 144 (max × 2.0)
   - Critical: 216 → 360 (max × 5.0)
5. Simülasyon gösterir: "Mevcut değer (185) artık warning tetiklemez"
6. Kullanıcı kaydeder
7. Mevcut alert otomatik resolve olur (eşik aşılmıyor artık)


---

## API Endpoint'leri

### 0. Smart Alert Otomatik Kurulum

```
POST /api/alerts/smart-setup
```

**Request:**

```json
{
  "apply_to_all_instances": false,
  "instance_pks": [42, 43],
  "enabled_categories": ["connection", "performance", "replication", "maintenance", "system"],
  "sensitivity": "medium",
  "auto_create_for_new_instances": false
}
```

**Response:**

```json
{
  "success": true,
  "created_rules_count": 42,
  "rules_by_instance": {
    "42": {
      "instance_name": "prod-db-01",
      "rules_created": 21,
      "rules": [
        {
          "rule_id": 1001,
          "template_name": "Aktif Bağlantı Sayısı",
          "metric_key": "activity.active_count",
          "category": "connection"
        }
        // ... 20 more
      ]
    },
    "43": {
      "instance_name": "prod-db-02",
      "rules_created": 21,
      "rules": [...]
    }
  },
  "baseline_status": {
    "message": "Baseline oluşturma süreci başladı",
    "estimated_days_until_full_profile": 7
  }
}
```

---

### 0.1. Smart Alert Template Listesi

```
GET /api/alerts/templates
```

**Query Parameters:**
- `category` (optional): Kategori filtresi

**Response:**

```json
{
  "templates": [
    {
      "template_id": 1,
      "template_name": "Aktif Bağlantı Sayısı",
      "category": "connection",
      "metric_key": "activity.active_count",
      "description": "Aktif bağlantı sayısı normalin üzerinde",
      "default_sensitivity": "medium",
      "min_pg_version": null,
      "required_extension": null
    }
    // ... 20 more
  ],
  "categories": [
    {
      "category": "connection",
      "display_name": "Bağlantı Yönetimi",
      "template_count": 5
    },
    {
      "category": "performance",
      "display_name": "Performans",
      "template_count": 6
    },
    {
      "category": "replication",
      "display_name": "Replikasyon",
      "template_count": 2
    },
    {
      "category": "maintenance",
      "display_name": "Bakım",
      "template_count": 4
    },
    {
      "category": "system",
      "display_name": "Sistem",
      "template_count": 4
    }
  ]
}
```

---

### 1. Alert Hesaplama Detayı

```
GET /api/alerts/{alert_id}/calculation
```

**Response:**

```json
{
  "alert_id": 12345,
  "instance_pk": 42,
  "instance_name": "prod-db-01",
  "metric_key": "activity.active_count",
  "metric_display_name": "Active Connections",
  "current_value": 185,
  "severity": "warning",
  "triggered_at": "2026-04-24T14:23:15Z",
  
  "calculation": {
    "baseline": {
      "avg": 50,
      "stddev": 8,
      "min": 12,
      "max": 72,
      "p50": 48,
      "p95": 68,
      "p99": 71,
      "sample_count": 672,
      "baseline_period_start": "2026-03-27T00:00:00Z",
      "baseline_period_end": "2026-04-24T00:00:00Z",
      "hour_of_day": 14,
      "day_of_week": null
    },
    
    "capacity": {
      "max_connections": 200,
      "superuser_reserved_connections": 5,
      "safety_margin": 5,
      "effective_capacity": 190,
      "capacity_source": "pg_settings.max_connections"
    },
    
    "thresholds": {
      "sensitivity": "medium",
      "sensitivity_multipliers": {
        "warning": 1.3,
        "critical": 3.0
      },
      
      "warning": {
        "formula": "max(max_seen × sensitivity, capacity × 0.70)",
        "baseline_threshold": 93.6,
        "capacity_threshold": 133,
        "final_threshold": 133,
        "absolute_minimum": null
      },
      
      "critical": {
        "formula": "max(max_seen × sensitivity, capacity × 0.85)",
        "baseline_threshold": 216,
        "capacity_threshold": 161.5,
        "final_threshold": 216,
        "absolute_minimum": null
      }
    },
    
    "trigger_analysis": {
      "reasons": [
        {
          "type": "threshold_exceeded",
          "message": "current_value (185) > warning_threshold (133)",
          "severity": "warning"
        },
        {
          "type": "capacity_usage",
          "message": "capacity_usage: 97% (185 / 190)",
          "severity": "warning"
        }
      ],
      "deviation_from_baseline": {
        "percent": 157,
        "message": "+157% above max_seen (72)"
      }
    }
  },
  
  "recommendations": [
    {
      "priority": "high",
      "category": "configuration",
      "message": "Connection pooling ayarlarını kontrol edin",
      "action": "check_connection_pooling"
    },
    {
      "priority": "medium",
      "category": "capacity",
      "message": "max_connections artırılabilir (mevcut: 200)",
      "action": "increase_max_connections"
    },
    {
      "priority": "medium",
      "category": "cleanup",
      "message": "Idle bağlantıları kapatın",
      "action": "terminate_idle_connections"
    }
  ]
}
```

---

### 2. Baseline Profil Görselleştirme

```
GET /api/instances/{instance_pk}/baseline/{metric_key}
```

**Query Parameters:**
- `hour_of_day` (optional): Saatlik profil için (0-23)
- `include_history` (optional): Son 7 günlük gerçek değerleri de döndür

**Response:**

```json
{
  "instance_pk": 42,
  "metric_key": "activity.active_count",
  "baseline": {
    "avg": 50,
    "stddev": 8,
    "min": 12,
    "max": 72,
    "p50": 48,
    "p95": 68,
    "p99": 71,
    "sample_count": 672,
    "baseline_period_start": "2026-03-27T00:00:00Z",
    "baseline_period_end": "2026-04-24T00:00:00Z",
    "hour_of_day": null
  },
  
  "hourly_profiles": [
    {
      "hour_of_day": 0,
      "avg": 25,
      "max": 35,
      "p95": 32
    },
    {
      "hour_of_day": 1,
      "avg": 22,
      "max": 30,
      "p95": 28
    },
    {
      "hour_of_day": 14,
      "avg": 50,
      "max": 72,
      "p95": 68
    }
  ],
  
  "recent_history": [
    {
      "timestamp": "2026-04-24T14:00:00Z",
      "value": 185,
      "severity": "warning"
    },
    {
      "timestamp": "2026-04-24T13:00:00Z",
      "value": 68,
      "severity": "normal"
    }
  ],
  
  "capacity": {
    "max_connections": 200,
    "effective_capacity": 190
  }
}
```

---

### 3. Eşik Simülasyonu

```
POST /api/alerts/simulate-threshold
```

**Request:**

```json
{
  "instance_pk": 42,
  "metric_key": "activity.active_count",
  "sensitivity": "high",
  "current_value": 185
}
```

**Response:**

```json
{
  "sensitivity": "high",
  "thresholds": {
    "warning": 79,
    "critical": 108
  },
  "would_trigger": {
    "severity": "critical",
    "message": "Current value (185) would trigger CRITICAL alert"
  },
  "comparison": {
    "low": {
      "warning": 144,
      "critical": 360,
      "would_trigger": "warning"
    },
    "medium": {
      "warning": 133,
      "critical": 216,
      "would_trigger": "warning"
    },
    "high": {
      "warning": 79,
      "critical": 108,
      "would_trigger": "critical"
    }
  }
}
```

---

### 4. Alert Snooze

```
POST /api/alerts/snooze
```

**Request:**

```json
{
  "rule_id": 1001,
  "instance_pk": 42,
  "duration_minutes": 60,
  "reason": "Planned maintenance"
}
```

**Response:**

```json
{
  "snooze_id": 123,
  "snoozed_until": "2026-04-24T15:23:15Z",
  "message": "Alert snoozed for 1 hour"
}
```

**Snooze Varyasyonları:**

```
POST /api/alerts/snooze-all
```
Tüm alert'leri sustur (planlı bakım)

```
POST /api/alerts/snooze-instance
```
Belirli instance'ın tüm alert'lerini sustur

```
POST /api/alerts/snooze-query
```
Belirli query'nin alert'lerini sustur (bilinen yavaş batch job)

---

### 5. Maintenance Window

```
POST /api/maintenance-windows
```

**Request:**

```json
{
  "window_name": "Weekly Backup",
  "day_of_week": [0],
  "start_time": "02:00",
  "end_time": "04:00",
  "timezone": "UTC",
  "instance_pks": null,
  "suppress_all_alerts": true
}
```

**Response:**

```json
{
  "window_id": 1,
  "message": "Maintenance window created",
  "next_occurrence": "2026-04-28T02:00:00Z"
}
```

```
GET /api/maintenance-windows
```
Tüm maintenance window'ları listele

```
DELETE /api/maintenance-windows/{window_id}
```
Maintenance window'u sil

---

### 6. Notification Channels

```
POST /api/notification-channels
```

**Request (Slack):**

```json
{
  "channel_name": "Slack - Critical Alerts",
  "channel_type": "slack",
  "config": {
    "webhook_url": "https://hooks.slack.com/services/xxx",
    "channel": "#db-alerts",
    "username": "pgstat-bot",
    "icon_emoji": ":warning:"
  },
  "min_severity": "critical"
}
```

**Request (PagerDuty):**

```json
{
  "channel_name": "PagerDuty - On-Call",
  "channel_type": "pagerduty",
  "config": {
    "integration_key": "xxx",
    "severity_mapping": {
      "emergency": "critical",
      "critical": "error",
      "warning": "warning"
    }
  },
  "min_severity": "emergency"
}
```

**Request (Email):**

```json
{
  "channel_name": "Email - Production Team",
  "channel_type": "email",
  "config": {
    "recipients": ["prod-team@example.com", "dba@example.com"],
    "subject_prefix": "[pgstat]"
  },
  "instance_pks": [42, 43]
}
```

**Response:**

```json
{
  "channel_id": 1,
  "message": "Notification channel created"
}
```

```
GET /api/notification-channels
```
Tüm notification channel'ları listele

```
POST /api/notification-channels/{channel_id}/test
```
Test bildirimi gönder

---

### 7. Baseline Invalidation

```
POST /api/instances/{instance_pk}/baseline/invalidate
```

**Request:**

```json
{
  "reason": "major_upgrade",
  "invalidated_by": "admin"
}
```

**Response:**

```json
{
  "success": true,
  "old_version": 1,
  "new_version": 2,
  "message": "Baseline invalidated. New baseline will be calculated over next 7 days.",
  "baseline_records_deleted": 672
}
```

```
GET /api/instances/{instance_pk}/baseline/versions
```
Baseline version geçmişini listele

```
POST /api/instances/{instance_pk}/baseline/rollback
```
Önceki baseline versiyonuna geri dön (opsiyonel)


---

## Alert Listesi ve Detay Sayfası — UI Mockup

### Alert Listesinde (ⓘ) Butonu

Her alert satırında bilgi ikonu — tıklanınca popover açılır:

```
┌─────────────────────────────────────────────────────┐
│ Alert Hesaplama Detayı                              │
├─────────────────────────────────────────────────────┤
│ Metrik: activity.active_count                       │
│ Mevcut Değer: 185 bağlantı                          │
│ Seviye: ⚠️ Warning                                   │
│                                                     │
│ Nasıl Hesaplandı:                                   │
│ ─────────────────                                   │
│ Baseline Profil (son 28 gün):                      │
│   • Ortalama: 50 bağlantı                           │
│   • Maksimum: 72 bağlantı                           │
│   • P95: 68 bağlantı                                │
│   • Standart Sapma: 8                               │
│                                                     │
│ Kapasite:                                           │
│   • max_connections: 200                            │
│   • Efektif kapasite: 190 (reserved düşüldü)       │
│                                                     │
│ Eşikler (Hassasiyet: Orta):                         │
│   • Warning: max(72 × 1.3, 190 × 0.70) = 133       │
│   • Critical: max(72 × 3.0, 190 × 0.85) = 216      │
│                                                     │
│ Tetikleme Nedeni:                                   │
│   ✓ Mevcut değer (185) > Warning eşiği (133)       │
│   ✓ Kapasite kullanımı: %97 (190'ın 185'i)         │
│                                                     │
│ Öneriler:                                           │
│   • Connection pooling ayarlarını kontrol edin      │
│   • max_connections artırılabilir (mevcut: 200)    │
│   • Idle bağlantıları kapatın                       │
└─────────────────────────────────────────────────────┘
```

---

### Alert Detay Sayfası

**Hesaplama Açıklaması Bölümü:**

```
┌─────────────────────────────────────────────────────────────┐
│ 📊 Alert Hesaplama Detayı                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ [Grafik: Son 7 günlük metrik değeri + baseline bantları]   │
│                                                             │
│ ─── Baseline Profil ───────────────────────────────────────│
│                                                             │
│ Son 28 günlük veriden hesaplandı (672 sample)              │
│ Saatlik profil: 14:00-15:00 (şu anki saat dilimi)          │
│                                                             │
│ Ortalama:        50 bağlantı                                │
│ Standart Sapma:   8 bağlantı                                │
│ Minimum:         12 bağlantı                                │
│ Maksimum:        72 bağlantı                                │
│ P95:             68 bağlantı                                │
│                                                             │
│ ─── Eşik Hesaplama ────────────────────────────────────────│
│                                                             │
│ Hassasiyet: Orta (1.3× warning, 3.0× critical)             │
│                                                             │
│ Warning Eşiği:                                              │
│   = max(max_seen × 1.3, capacity × 0.70)                   │
│   = max(72 × 1.3, 190 × 0.70)                              │
│   = max(93.6, 133)                                          │
│   = 133 bağlantı                                            │
│                                                             │
│ Critical Eşiği:                                             │
│   = max(max_seen × 3.0, capacity × 0.85)                   │
│   = max(72 × 3.0, 190 × 0.85)                              │
│   = max(216, 161.5)                                         │
│   = 216 bağlantı                                            │
│                                                             │
│ ─── Tetikleme Analizi ─────────────────────────────────────│
│                                                             │
│ Mevcut Değer: 185 bağlantı                                  │
│                                                             │
│ ✓ 185 > 133 (warning eşiği)                                │
│ ✗ 185 < 216 (critical eşiği)                               │
│                                                             │
│ Sonuç: ⚠️ WARNING seviyesi alert                            │
│                                                             │
│ Kapasite Kullanımı: 97% (185 / 190)                        │
│ Normal Aralık Dışında: +157% (185 vs 72 max_seen)          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

### Interaktif Simülasyon

```
┌─────────────────────────────────────────────────────────────┐
│ 🧪 Eşik Simülasyonu                                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Hassasiyet değiştirirseniz ne olur?                        │
│                                                             │
│ [Düşük] [Orta ●] [Yüksek]                                   │
│                                                             │
│ Düşük (2.0×):    Warning: 144, Critical: 360               │
│ Orta (1.3×):     Warning: 133, Critical: 216  ← mevcut     │
│ Yüksek (1.1×):   Warning: 79,  Critical: 108               │
│                                                             │
│ Mevcut değer (185) ile:                                     │
│   Düşük:   ⚠️ Warning tetikler                              │
│   Orta:    ⚠️ Warning tetikler                              │
│   Yüksek:  🔴 Critical tetikler                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

### Alert Bildirim Mesajı (Email/Slack)

Email/Slack bildirimlerinde de hesaplama detayı eklenebilir:

```
🚨 PostgreSQL Alert: High Active Connections

Instance: prod-db-01
Metrik: activity.active_count
Seviye: WARNING
Mevcut Değer: 185 bağlantı

─── Neden Tetiklendi? ───
• Mevcut değer (185) normal maksimumun (72) %157 üzerinde
• Kapasite kullanımı %97 (190'ın 185'i)
• Warning eşiği: 133 bağlantı (baseline × 1.3)

─── Baseline Profil ───
Son 28 gün ortalaması: 50 bağlantı
Normal maksimum: 72 bağlantı
Saatlik profil: 14:00-15:00

─── Öneriler ───
• Connection pooling ayarlarını kontrol edin
• max_connections artırılabilir (mevcut: 200)
• Idle bağlantıları kapatın

Detaylar: https://pgstat.example.com/alerts/12345
```

---

## Test Senaryoları

### 1. Yeni Instance (Baseline Yok)

**Durum:** Instance ilk kez eklendi, henüz 24 saat veri yok

**Beklenen Davranış:**
- Sadece mutlak sınırlar uygulanır
- `max_connections` %85 → critical
- `cache_hit_ratio` < %90 → critical
- Baseline profili yok mesajı gösterilir

**Test:**
```sql
-- Yeni instance ekle
insert into control.instance_inventory (instance_name, host, port)
values ('test-new-db', 'localhost', 5432);

-- Alert kuralı oluştur (adaptif mod)
insert into control.alert_rule (instance_pk, metric_key, use_adaptive, sensitivity)
values (999, 'activity.active_count', true, 'medium');

-- Alert değerlendirme çalıştır
-- Beklenen: sadece absolute_critical (max_connections × 0.85) kontrol edilir
```

---

### 2. Baseline Var, Normal Değer

**Durum:** 28 günlük veri var, mevcut değer baseline içinde

**Beklenen Davranış:**
- Alert tetiklenmez
- UI'da "Normal" gösterilir
- Baseline profili görselleştirilir

**Test:**
```sql
-- Baseline ekle
insert into control.metric_baseline (instance_pk, metric_key, avg_value, max_value, p95_value)
values (42, 'activity.active_count', 50, 72, 68);

-- Mevcut değer: 65 (max=72'nin altında)
-- Beklenen: alert yok
```

---

### 3. Baseline Var, Anomali Tespit

**Durum:** Mevcut değer baseline'ın çok üzerinde

**Beklenen Davranış:**
- Warning alert tetiklenir
- Hesaplama detayı gösterilir
- Öneriler sunulur

**Test:**
```sql
-- Baseline: max=72
-- Mevcut değer: 185
-- Hassasiyet: medium (1.3×)
-- Warning eşiği: max(72 × 1.3, 190 × 0.70) = 133
-- Beklenen: warning alert
```

---

### 4. Saatlik Profil

**Durum:** Gece 02:00'da 10 bağlantı normal, gündüz 14:00'te 70 normal

**Beklenen Davranış:**
- Saat 02:00'da 30 bağlantı → warning (gece için yüksek)
- Saat 14:00'te 70 bağlantı → normal (gündüz için normal)

**Test:**
```sql
-- Gece profili
insert into control.metric_baseline (instance_pk, metric_key, hour_of_day, max_value)
values (42, 'activity.active_count', 2, 15);

-- Gündüz profili
insert into control.metric_baseline (instance_pk, metric_key, hour_of_day, max_value)
values (42, 'activity.active_count', 14, 72);

-- Saat 02:00'da 30 bağlantı → warning
-- Saat 14:00'te 70 bağlantı → normal
```

---

### 5. Hassasiyet Değişikliği

**Durum:** Aynı metrik, farklı hassasiyetler

**Beklenen Davranış:**
- Düşük: az alert
- Orta: dengeli
- Yüksek: çok alert

**Test:**
```sql
-- Baseline: max=72
-- Mevcut değer: 85

-- Düşük (2.0×): warning=144 → alert yok
-- Orta (1.3×): warning=93.6 → warning alert
-- Yüksek (1.1×): warning=79.2 → warning alert
```

---

### 6. Kapasite Sınırı

**Durum:** Baseline düşük ama kapasite dolmak üzere

**Beklenen Davranış:**
- Baseline eşiği aşılmasa bile kapasite eşiği tetiklenir

**Test:**
```sql
-- Baseline: max=50
-- max_connections: 100, efektif: 95
-- Mevcut değer: 80

-- Baseline eşiği: 50 × 1.3 = 65
-- Kapasite eşiği: 95 × 0.70 = 66.5
-- Final warning: max(65, 66.5) = 66.5
-- 80 > 66.5 → warning alert
```

---

## Güvenlik ve Performans Notları

### Güvenlik

1. **Baseline verisi hassas değil:** Metrik istatistikleri (avg, max, p95) hassas veri içermez. Public schema'da tutulabilir.

2. **Alert hesaplama izni:** Sadece alert evaluator servisi baseline okuyabilir. UI kullanıcıları sadece kendi instance'larının baseline'ını görebilir.

3. **SQL injection:** Metrik key'ler enum olmalı, dinamik SQL'de kullanılmamalı.

### Performans

1. **Baseline hesaplama:** Günde 1 kez, off-peak saatlerde (gece 03:00). Paralel işlem ile 5-10 dakika.

2. **Alert değerlendirme:** Her 1 dakikada 1 kez. Baseline join'i index'li (instance_pk, metric_key, hour_of_day).

3. **API cache:** Baseline profil verisi 1 saat cache'lenir (günde 1 kez değişiyor).

4. **Index'ler:**
```sql
create index idx_metric_baseline_lookup 
  on control.metric_baseline (instance_pk, metric_key, hour_of_day);

create index idx_metric_baseline_updated 
  on control.metric_baseline (updated_at);
```

---

## Özet

Bu tasarım ile:

✅ Kullanıcı eşik girmez, sadece hassasiyet seçer
✅ Sistem kendi normalini öğrenir (28 günlük baseline)
✅ Saatlik profil ile gece/gündüz farklılıkları desteklenir
✅ Kapasite sınırları otomatik entegre edilir
✅ Her alert için "nasıl hesaplandı" şeffaf gösterilir
✅ Yeni instance'lar için mutlak sınırlar devreye girer
✅ 31 farklı metrik için adaptif kurallar tanımlanmıştır
✅ UI'da interaktif simülasyon ve görselleştirme vardır
✅ Email/Slack bildirimlerinde hesaplama detayı paylaşılır

**Yeni: Scope Yönetimi**

✅ **all_instances:** Tüm instance'lar için tek kural (yeni instance otomatik dahil)
✅ **single_instance:** Belirli bir instance için özel kural
✅ **instance_group:** Grup bazlı kural (gruba yeni üye eklenince otomatik dahil)
✅ Kullanıcı scope'u istediği zaman değiştirebilir
✅ Karma kullanım: Genel kurallar + kritik instance'lar için özel kurallar

**Yeni: Query Bazlı İzleme (statement_series/queryid) — 10 Metrik**

✅ **Slow Query Spike:** Belirli bir query aniden yavaşladı (avg_exec_time)
✅ **Query Call Frequency:** N+1 query tespiti (çağrı sayısı anomalisi)
✅ **Query Error Rate:** Query error oranı (dolaylı tespit)
✅ **Query Plan Change:** Plan değişti ve yavaşladı (PG13+)
✅ **Top Slow Queries:** Hotspot tespiti (tek query sistem kaynaklarını domine ediyor)
✅ **Query Temp Usage:** work_mem yetersizliği (temp_blks_written)
✅ **Query Max Exec Time Change:** Max çalışma süresi değişti (outlier tespit)
✅ **Query Index Usage:** Index kullanmıyor (seq scan şüphesi)
✅ **Query Disk Write:** Diske yazıyor (temp + local blks)
✅ **Query Rows Anomaly:** Anormal fazla satır döndürüyor

**Metrik Kategorileri:**

- **Bağlantı Yönetimi:** 5 kural
- **Performans:** 16 kural (10 query bazlı dahil)
- **Replikasyon:** 2 kural
- **Bakım:** 4 kural
- **Sistem:** 4 kural
- **Toplam:** 31 kural

**Kullanım Senaryoları:**

1. **İlk Kurulum:** "Tüm instance'lar" seçeneği ile 31 kural oluştur → yeni instance otomatik dahil
2. **Yeni Instance:** Otomatik kurallara dahil olur (all_instances scope'u varsa)
3. **Kritik Instance:** Özel kural oluştur (single_instance, high sensitivity)
4. **Ortam Bazlı:** Production grubu için ayrı kurallar (instance_group scope'u)
5. **Query İzleme:** Belirli bir query'nin performansını queryid bazlı izle
6. **Query Optimizasyon:** Hangi query index kullanmıyor, diske yazıyor, çok satır döndürüyor?

Eksik kalan noktalar gelecek fazlarda implementasyon edilecektir (bloat, pg_stat_io, ML anomaly detection).


---

## Scope Örnekleri ve Kullanım Senaryoları

### Senaryo 1: Tüm Instance'lar İçin Alert (all_instances)

**Kullanım:**
- Kullanıcı "Tüm instance'lar" seçeneğini işaretler
- 21 kural oluşturulur (scope=all_instances)
- Her kural tüm instance'ları kapsar

**Veri:**
```sql
insert into control.alert_rule (rule_name, metric_key, scope, sensitivity, use_adaptive)
values ('Aktif Bağlantı - Tüm Sistemler', 'activity.active_count', 'all_instances', 'medium', true);
-- instance_pk = NULL (tüm instance'ları kapsadığı için)
```

**Yeni Instance Eklenince:**
```sql
-- Yeni instance eklendi: prod-db-05
insert into control.instance_inventory (instance_name, host, port)
values ('prod-db-05', 'db05.example.com', 5432);

-- Alert evaluator çalıştığında:
-- scope=all_instances olan tüm kurallar otomatik prod-db-05'i de kontrol eder
-- Hiçbir manuel işlem gerekmez
```

---

### Senaryo 2: Seçili Instance'lar İçin Alert (single_instance)

**Kullanım:**
- Kullanıcı "Seçili instance'lar" seçeneğini işaretler
- prod-db-01 ve prod-db-02'yi seçer
- 42 kural oluşturulur (2 instance × 21 metrik)

**Veri:**
```sql
-- prod-db-01 için
insert into control.alert_rule (rule_name, metric_key, instance_pk, scope, sensitivity, use_adaptive)
values ('Aktif Bağlantı - prod-db-01', 'activity.active_count', 42, 'single_instance', 'medium', true);

-- prod-db-02 için
insert into control.alert_rule (rule_name, metric_key, instance_pk, scope, sensitivity, use_adaptive)
values ('Aktif Bağlantı - prod-db-02', 'activity.active_count', 43, 'single_instance', 'medium', true);
```

**Yeni Instance Eklenince:**
```sql
-- Yeni instance eklendi: prod-db-05
-- Mevcut kurallara dahil OLMAZ
-- Kullanıcı manuel olarak prod-db-05 için kural oluşturmalı
```

---

### Senaryo 3: Instance Grubu İçin Alert (instance_group)

**Kullanım:**
- Kullanıcı "Instance grubu" seçeneğini işaretler
- "Production" grubunu seçer
- 21 kural oluşturulur (scope=instance_group)

**Veri:**
```sql
-- Production grubu
insert into control.instance_group (group_name, description)
values ('production', 'Production veritabanları');

-- Grup üyeleri
insert into control.instance_group_member (group_id, instance_pk)
values 
  (1, 42),  -- prod-db-01
  (1, 43);  -- prod-db-02

-- Alert kuralı
insert into control.alert_rule (rule_name, metric_key, scope, instance_group_id, sensitivity, use_adaptive)
values ('Aktif Bağlantı - Production', 'activity.active_count', 'instance_group', 1, 'medium', true);
-- instance_pk = NULL (grup üzerinden çözümlenir)
```

**Yeni Instance Gruba Eklenince:**
```sql
-- Yeni instance eklendi ve production grubuna dahil edildi
insert into control.instance_inventory (instance_name, host, port)
values ('prod-db-05', 'db05.example.com', 5432);

insert into control.instance_group_member (group_id, instance_pk)
values (1, 99);  -- prod-db-05'in pk'si

-- Alert evaluator çalıştığında:
-- scope=instance_group ve instance_group_id=1 olan tüm kurallar
-- otomatik prod-db-05'i de kontrol eder
```

---

### Senaryo 4: Karma Kullanım

**Kullanım:**
- Production instance'ları için "all_instances" scope'lu genel kurallar
- Kritik instance'lar için "single_instance" scope'lu özel kurallar (daha hassas)

**Veri:**
```sql
-- Genel kural (tüm instance'lar, orta hassasiyet)
insert into control.alert_rule (rule_name, metric_key, scope, sensitivity)
values ('Aktif Bağlantı - Genel', 'activity.active_count', 'all_instances', 'medium');

-- Kritik instance için özel kural (yüksek hassasiyet)
insert into control.alert_rule (rule_name, metric_key, instance_pk, scope, sensitivity)
values ('Aktif Bağlantı - prod-db-01 (Kritik)', 'activity.active_count', 42, 'single_instance', 'high');
```

**Sonuç:**
- prod-db-01 için 2 kural çalışır (genel + özel)
- Diğer instance'lar için sadece genel kural çalışır
- prod-db-01'de daha erken uyarı alınır (high sensitivity)

---

## Scope Değiştirme

Kullanıcı mevcut bir kuralın scope'unu değiştirebilir:

### Örnek: single_instance → all_instances

**Önce:**
```sql
-- prod-db-01 için özel kural
select rule_id, rule_name, instance_pk, scope
from control.alert_rule
where rule_id = 1001;

-- Sonuç:
-- rule_id | rule_name                    | instance_pk | scope
-- 1001    | Aktif Bağlantı - prod-db-01  | 42          | single_instance
```

**Değişiklik:**
```sql
update control.alert_rule
set scope = 'all_instances',
    instance_pk = null,
    rule_name = 'Aktif Bağlantı - Tüm Sistemler'
where rule_id = 1001;
```

**Sonra:**
```sql
-- Artık tüm instance'ları kapsıyor
select rule_id, rule_name, instance_pk, scope
from control.alert_rule
where rule_id = 1001;

-- Sonuç:
-- rule_id | rule_name                         | instance_pk | scope
-- 1001    | Aktif Bağlantı - Tüm Sistemler    | null        | all_instances
```

---

## UI'da Scope Gösterimi

### Alert Kuralları Listesi

```
┌─────────────────────────────────────────────────────────────┐
│ Alert Kuralları                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Kural Adı                    | Kapsam        | Hassasiyet  │
│ ─────────────────────────────────────────────────────────  │
│ Aktif Bağlantı - Tüm Sistemler | 🌐 Tüm (4)   | Orta       │
│ Cache Hit - Production Grubu   | 👥 Grup (2)  | Orta       │
│ Deadlock - prod-db-01          | 🎯 Tekil     | Yüksek     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Kapsam İkonları:**
- 🌐 Tüm instance'lar (all_instances) — yanında instance sayısı
- 👥 Instance grubu (instance_group) — yanında grup üye sayısı
- 🎯 Tekil instance (single_instance) — yanında instance adı

### Kural Detay Sayfası

```
┌─────────────────────────────────────────────────────────────┐
│ Aktif Bağlantı - Tüm Sistemler                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Kapsam: 🌐 Tüm instance'lar                                 │
│                                                             │
│ Bu kural şu instance'larda aktif:                           │
│ • prod-db-01                                                │
│ • prod-db-02                                                │
│ • staging-db-01                                             │
│ • dev-db-01                                                 │
│                                                             │
│ ℹ️ Yeni instance eklendiğinde otomatik bu kurala dahil olur │
│                                                             │
│ [Kapsamı Değiştir]                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```


---

## Query Bazlı İzleme — Detaylı Açıklama

### Neden Query Bazlı İzleme Önemli?

Genel metrikler (TPS, cache hit, vb.) sistem genelinde sorun olduğunu gösterir ama **hangi query'nin** soruna neden olduğunu göstermez. Query bazlı izleme ile:

1. **Hotspot Tespiti:** Hangi query sistem kaynaklarını domine ediyor?
2. **Regresyon Tespiti:** Hangi query aniden yavaşladı?
3. **N+1 Query Tespiti:** Hangi query çağrı sayısı anormal arttı?
4. **Plan Değişikliği:** Hangi query'nin planı değişti ve yavaşladı?

### statement_series vs queryid

**statement_series:**
- pgstat'ın kendi internal ID'si
- Aynı query farklı instance'larda farklı statement_series'e sahip
- Zaman içinde değişebilir (pg_stat_statements reset)

**queryid:**
- PostgreSQL'in query fingerprint'i (pg_stat_statements)
- Aynı query her yerde aynı queryid'ye sahip
- Parametreler farklı olsa bile aynı query pattern'i aynı queryid

**Baseline için hangisi kullanılır?**
- **statement_series:** Instance bazlı izleme için (her instance'ın kendi baseline'ı)
- **queryid:** Cross-instance karşılaştırma için (aynı query farklı instance'larda nasıl performans gösteriyor?)

### Query Bazlı Alert Örnekleri

#### Örnek 1: Slow Query Spike

```sql
-- Baseline
queryid: 1234567890
  avg_exec_time: 50ms (son 28 gün)
  max_exec_time: 200ms
  p95: 120ms

-- Mevcut durum (son 15 dakika)
avg_exec_time: 500ms

-- Alert tetiklenir:
-- 500ms > 200ms × 2 (max_seen × sensitivity)
-- Mesaj: "Query 1234567890 aniden yavaşladı (50ms → 500ms)"
```

**Olası nedenler:**
- Plan değişikliği
- Index kullanılmıyor
- Lock contention
- Veri dağılımı değişti

---

#### Örnek 2: N+1 Query Tespiti

```sql
-- Baseline
queryid: 9876543210
  avg_calls_per_hour: 100 (son 28 gün)
  max_calls_per_hour: 150

-- Mevcut durum (son 1 saat)
calls: 5000

-- Alert tetiklenir:
-- 5000 > 150 × 2 (max_seen × sensitivity)
-- Mesaj: "Query 9876543210 çağrı sayısı anormal arttı (100 → 5000)"
```

**Olası nedenler:**
- N+1 query problemi (ORM lazy loading)
- Loop içinde query çağrılıyor
- Uygulama hatası (cache bypass)

---

#### Örnek 3: Query Plan Change

```sql
-- Önceki durum
queryid: 1111111111
  planid: 2222222222
  avg_exec_time: 50ms

-- Yeni durum
queryid: 1111111111
  planid: 3333333333  -- plan değişti!
  avg_exec_time: 500ms

-- Alert tetiklenir:
-- planid değişti VE 500ms > 50ms × 3
-- Mesaj: "Query 1111111111 plan değişti ve 10× yavaşladı"
```

**Olası nedenler:**
- ANALYZE çalıştı, istatistikler güncellendi
- Index eklendi/silindi
- Veri dağılımı değişti (skew)
- Planner parametreleri değişti

---

#### Örnek 4: Top Slow Queries Hotspot

```sql
-- Son 1 saatteki toplam query süresi: 1000s

-- Top 5 query:
1. queryid: 1234567890 — 600s (60% — HOTSPOT!)
2. queryid: 9876543210 — 150s (15%)
3. queryid: 1111111111 — 100s (10%)
4. queryid: 2222222222 — 80s (8%)
5. queryid: 3333333333 — 70s (7%)

-- Alert tetiklenir:
-- Tek bir query toplam sürenin %60'ını tüketiyor
-- Mesaj: "Query 1234567890 sistem kaynaklarını domine ediyor (%60)"
```

**Aksiyon:**
- Bu query'yi optimize et (en yüksek ROI)
- Index ekle
- Query'yi yeniden yaz
- Cache ekle

---

### Query Bazlı Alert'lerin Veri Modeli

```sql
-- Baseline query bazlı
create table control.metric_baseline_query (
  instance_pk bigint not null,
  queryid bigint not null,  -- pg_stat_statements.queryid
  statement_series_pk bigint,  -- opsiyonel, statement_series ile ilişki
  
  -- Performans metrikleri
  avg_exec_time_ms numeric,
  stddev_exec_time_ms numeric,
  min_exec_time_ms numeric,
  max_exec_time_ms numeric,
  p95_exec_time_ms numeric,
  
  -- Çağrı metrikleri
  avg_calls_per_hour numeric,
  stddev_calls numeric,
  min_calls numeric,
  max_calls numeric,
  
  -- Temp kullanımı
  avg_temp_blks_per_call numeric,
  max_temp_blks_per_call numeric,
  
  -- Plan bilgisi (PG13+)
  current_planid bigint,
  
  -- Meta
  sample_count integer,
  baseline_start timestamptz,
  baseline_end timestamptz,
  updated_at timestamptz default now(),
  
  primary key (instance_pk, queryid)
);

-- Index
create index idx_baseline_query_lookup 
  on control.metric_baseline_query (instance_pk, queryid);
```

---

### Query Bazlı Alert UI

**Alert Detay Sayfası:**

```
┌─────────────────────────────────────────────────────────────┐
│ 🐌 Slow Query Spike Alert                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Query ID: 1234567890                                        │
│ Instance: prod-db-01                                        │
│                                                             │
│ Query Text:                                                 │
│ SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at│
│                                                             │
│ ─── Performans Karşılaştırması ────────────────────────────│
│                                                             │
│ Baseline (son 28 gün):                                     │
│   • Ortalama: 50ms                                          │
│   • P95: 120ms                                              │
│   • Maksimum: 200ms                                         │
│                                                             │
│ Mevcut Durum (son 15 dakika):                              │
│   • Ortalama: 500ms  ⚠️ 10× yavaş!                          │
│   • Çağrı sayısı: 150                                       │
│                                                             │
│ ─── Plan Değişikliği ───────────────────────────────────────│
│                                                             │
│ Önceki Plan ID: 2222222222                                  │
│ Yeni Plan ID: 3333333333  ⚠️ Plan değişti!                  │
│                                                             │
│ [EXPLAIN Planını Göster]                                    │
│                                                             │
│ ─── Öneriler ───────────────────────────────────────────────│
│                                                             │
│ • Index kullanımını kontrol edin                            │
│ • ANALYZE çalıştırın (istatistikler güncel mi?)             │
│ • Query planını inceleyin (Seq Scan var mı?)                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

### Implementasyon Notları

1. **Baseline hesaplama:** Query bazlı baseline günlük hesaplanır (statement_series bazlı mevcut baseline ile birlikte)

2. **Performans:** 
   - Top 100 query için baseline hesaplanır (total_exec_time bazlı)
   - Nadir çalışan query'ler (<10 call/hour) hariç tutulur

3. **Veri boyutu:**
   - 50 instance × 100 query = 5000 baseline satırı
   - Kabul edilebilir boyut

4. **PG13+ özellikler:**
   - planid kolonu PG13+ için
   - Önceki versiyonlarda plan değişikliği tespit edilemez

5. **Query text:**
   - statement_series tablosunda query_text var
   - Alert'te gösterilir (ilk 200 karakter)


---

## Yeni Özellikler — UI Mockup'ları

### Alert Snooze UI

**Alert Listesinde Snooze Butonu:**

```
┌─────────────────────────────────────────────────────────────┐
│ Alert Listesi                                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ⚠️ High Active Connections - prod-db-01                     │
│ Mevcut: 185 bağlantı | Eşik: 133                            │
│ [Detaylar] [🔕 Snooze] [✓ Resolve]                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Snooze Modal:**

```
┌─────────────────────────────────────────────────────────────┐
│ Alert'i Sustur                                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Bu alert'i ne kadar süreyle susturmak istersiniz?          │
│                                                             │
│ ○ 15 dakika                                                 │
│ ○ 1 saat                                                    │
│ ● 4 saat                                                    │
│ ○ 1 gün                                                     │
│ ○ 1 hafta                                                   │
│ ○ Özel: [____] saat                                         │
│                                                             │
│ Neden: (opsiyonel)                                          │
│ [Planned maintenance - migration in progress_____________]  │
│                                                             │
│ Kapsam:                                                     │
│ ● Sadece bu alert (rule + instance)                        │
│ ○ Bu instance'ın tüm alert'leri                             │
│ ○ Bu metriğin tüm alert'leri                                │
│                                                             │
│ [İptal]  [Sustur]                                           │
└─────────────────────────────────────────────────────────────┘
```

**Snoozed Alert Gösterimi:**

```
┌─────────────────────────────────────────────────────────────┐
│ 🔕 High Active Connections - prod-db-01 (Snoozed)           │
│ Susturuldu: 4 saat (3 saat 45 dk kaldı)                    │
│ Neden: Planned maintenance - migration in progress          │
│ [Snooze'u Kaldır]                                           │
└─────────────────────────────────────────────────────────────┘
```

---

### Maintenance Window UI

**Maintenance Window Yönetim Sayfası:**

```
┌─────────────────────────────────────────────────────────────┐
│ Maintenance Windows                                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ [+ Yeni Maintenance Window]                                 │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 📅 Weekly Backup                                        │ │
│ │ Her Pazar 02:00-04:00 (UTC)                             │ │
│ │ Kapsam: Tüm instance'lar                                │ │
│ │ Durum: ✅ Aktif                                          │ │
│ │ Sonraki: 2026-04-28 02:00                               │ │
│ │ [Düzenle] [Sil]                                         │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 🌙 Nightly Jobs                                         │ │
│ │ Her gün 01:00-03:00 (UTC)                               │ │
│ │ Kapsam: Production grubu                                │ │
│ │ Sadece Warning alert'leri susturulur                    │ │
│ │ Durum: ✅ Aktif                                          │ │
│ │ [Düzenle] [Sil]                                         │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Yeni Maintenance Window Formu:**

```
┌─────────────────────────────────────────────────────────────┐
│ Yeni Maintenance Window                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ İsim:                                                       │
│ [Weekly Backup_________________________________________]    │
│                                                             │
│ Zamanlama:                                                  │
│ Günler: [✓] Pzt [✓] Sal [✓] Çar [✓] Per [✓] Cum [ ] Cmt [ ] Paz │
│ Başlangıç: [02:00] Bitiş: [04:00]                           │
│ Timezone: [UTC ▼]                                           │
│                                                             │
│ Kapsam:                                                     │
│ ● Tüm instance'lar                                          │
│ ○ Seçili instance'lar: [Seç...]                             │
│ ○ Instance grubu: [Production ▼]                            │
│                                                             │
│ Alert Davranışı:                                            │
│ ● Tüm alert'leri sustur                                     │
│ ○ Sadece şu severity'leri sustur: [✓] Warning [ ] Critical │
│                                                             │
│ [İptal]  [Oluştur]                                          │
└─────────────────────────────────────────────────────────────┘
```

---

### Notification Channel UI

**Notification Channel Yönetim Sayfası:**

```
┌─────────────────────────────────────────────────────────────┐
│ Notification Channels                                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ [+ Yeni Channel]                                            │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 💬 Slack - Critical Alerts                              │ │
│ │ Tip: Slack                                              │ │
│ │ Channel: #db-alerts                                     │ │
│ │ Filtre: Sadece Critical ve üzeri                        │ │
│ │ Durum: ✅ Aktif                                          │ │
│ │ [Test Gönder] [Düzenle] [Sil]                           │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 📟 PagerDuty - On-Call                                  │ │
│ │ Tip: PagerDuty                                          │ │
│ │ Integration Key: r3d***************                     │ │
│ │ Filtre: Sadece Emergency                                │ │
│ │ Durum: ✅ Aktif                                          │ │
│ │ [Test Gönder] [Düzenle] [Sil]                           │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 📧 Email - Production Team                              │ │
│ │ Tip: Email                                              │ │
│ │ Recipients: prod-team@example.com, dba@example.com      │ │
│ │ Filtre: Tüm alert'ler, sadece prod-db-01, prod-db-02    │ │
│ │ Durum: ✅ Aktif                                          │ │
│ │ [Test Gönder] [Düzenle] [Sil]                           │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Yeni Notification Channel Formu (Slack):**

```
┌─────────────────────────────────────────────────────────────┐
│ Yeni Notification Channel - Slack                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Channel İsmi:                                               │
│ [Slack - Critical Alerts_______________________________]    │
│                                                             │
│ Slack Webhook URL:                                          │
│ [https://hooks.slack.com/services/xxx__________________]    │
│                                                             │
│ Slack Channel:                                              │
│ [#db-alerts_____________________________________________]   │
│                                                             │
│ Bot Username: (opsiyonel)                                   │
│ [pgstat-bot_____________________________________________]   │
│                                                             │
│ Icon Emoji: (opsiyonel)                                     │
│ [:warning:______________________________________________]   │
│                                                             │
│ ─── Filtreler ──────────────────────────────────────────── │
│                                                             │
│ Minimum Severity:                                           │
│ [Critical ▼]  (Warning, Critical, Emergency)                │
│                                                             │
│ Instance'lar:                                               │
│ ● Tüm instance'lar                                          │
│ ○ Seçili instance'lar: [Seç...]                             │
│                                                             │
│ Kategoriler:                                                │
│ [✓] Bağlantı [✓] Performans [✓] Replikasyon [✓] Bakım [✓] Sistem │
│                                                             │
│ [İptal]  [Test Gönder]  [Oluştur]                           │
└─────────────────────────────────────────────────────────────┘
```

---

### Baseline Invalidation UI

**Instance Detay Sayfasında:**

```
┌─────────────────────────────────────────────────────────────┐
│ prod-db-01 - Baseline Durumu                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Mevcut Baseline Version: 2                                  │
│ Oluşturulma: 2026-03-15 (40 gün önce)                      │
│ PostgreSQL Version: 16.2                                    │
│ Baseline Kayıt Sayısı: 672                                  │
│                                                             │
│ Durum: ✅ Aktif ve Sağlıklı                                 │
│                                                             │
│ [Baseline Geçmişi] [Baseline'ı Sıfırla]                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Baseline Sıfırlama Modal:**

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️ Baseline'ı Sıfırla                                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Bu işlem mevcut baseline verilerini silecek ve yeni        │
│ baseline oluşturma sürecini başlatacak.                     │
│                                                             │
│ Neden sıfırlamak istiyorsunuz?                              │
│ ● Major version upgrade (PG 15 → 16)                        │
│ ○ Schema değişikliği (büyük refactoring)                    │
│ ○ Donanım değişikliği (yeni sunucu)                         │
│ ○ Diğer: [_______________________________________]          │
│                                                             │
│ ⚠️ Uyarı:                                                    │
│ • 672 baseline kaydı silinecek                              │
│ • İlk 7 gün sadece mutlak sınırlar kullanılacak            │
│ • Yeni baseline 7-28 gün içinde oluşacak                    │
│ • Eski baseline version 1 arşivlenecek                      │
│                                                             │
│ [İptal]  [Evet, Sıfırla]                                    │
└─────────────────────────────────────────────────────────────┘
```

**Baseline Version Geçmişi:**

```
┌─────────────────────────────────────────────────────────────┐
│ prod-db-01 - Baseline Version Geçmişi                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Version 2 (Aktif)                                       │ │
│ │ Başlangıç: 2026-03-15                                   │ │
│ │ PostgreSQL: 16.2                                        │ │
│ │ Kayıt Sayısı: 672                                       │ │
│ │ Durum: ✅ Aktif                                          │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Version 1 (Arşiv)                                       │ │
│ │ Başlangıç: 2025-12-01                                   │ │
│ │ Bitiş: 2026-03-15                                       │ │
│ │ PostgreSQL: 15.5                                        │ │
│ │ Invalidation: major_upgrade (admin tarafından)          │ │
│ │ Durum: 🗄️ Arşivlendi                                    │ │
│ │ [Detayları Göster]                                      │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```
