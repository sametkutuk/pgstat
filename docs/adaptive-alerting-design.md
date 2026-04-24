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
| Normal | = 0 (veya baseline max'ı kadar) |
| Warning | > 0 (ilk deadlock bile uyarı — çoğu sistemde anormal) |
| Critical | > 5 / 15dk (tekrarlayan deadlock — ciddi contention) |

**Özel durum:** Eğer baseline'da deadlock normalse (max_seen > 0), o zaman warning eşiği max_seen × 2

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
| Warning | > max_seen × 2 VEYA > 5% (mutlak) |
| Critical | > 20% (mutlak — ciddi uygulama hatası) |

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
  add column if not exists absolute_critical numeric;
  -- absolute_*: baseline ne derse desin bu sınırlar her zaman geçerli
  -- Örn: cache_hit_ratio absolute_critical = 90
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

## Alert Değerlendirme Akışı (Güncellenmiş)

```
1. Aktif kuralları oku
2. Her kural için:
   a. use_adaptive = true ise:
      - metric_baseline'dan bu instance + metrik + saat için profil oku
      - Profil varsa: sensitivity'ye göre eşik hesapla
        warning = max(max_seen × sensitivity_multiplier, absolute_warning)
        critical = max(max_seen × critical_multiplier, absolute_critical)
      - Profil yoksa (yeni instance): sadece absolute_* sınırları kullan
   b. use_adaptive = false ise:
      - Eski davranış: sabit warning_threshold / critical_threshold
   c. Metriği sorgula
   d. Hesaplanan eşikle karşılaştır
   e. Alert oluştur/resolve et
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

## Implementasyon Sırası

1. `control.metric_baseline` + `control.instance_settings` tabloları (migration)
2. `control.alert_rule`'a sensitivity, use_adaptive, absolute_* kolonları (migration)
3. Collector: `BaselineCalculator` servisi — günlük baseline hesaplama
4. Collector: `InstanceSettingsCollector` — discovery sırasında pg_settings okuma
5. Collector: `AlertRuleEvaluator` güncelleme — adaptif eşik hesaplama
6. API: baseline endpoint'leri (profil okuma, grafik verisi)
7. UI: kural formunda adaptif mod, baseline görselleştirme
