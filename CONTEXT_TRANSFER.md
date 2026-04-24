# Context Transfer — pgstat Projesi

## PROJE ÖZETİ
PostgreSQL monitoring sistemi. Java Spring Boot collector, Node.js Express API, React UI.
Kullanıcı Türkçe konuşuyor, production sunucusu Linux (root), development Windows.

## SON OTURUM YAPILANLARI (2026-04-25)

### 1. Adaptive Alerting — Migration + API + UI ✅
- `db/migrations/V018__adaptive_alerting.sql` — 8 tablo, 3 fonksiyon
- `api/src/routes/adaptiveAlerting.ts` — 17 endpoint
- `ui/src/pages/AdaptiveAlerting.tsx` — 5 tab skeleton (form/modal'lar EKSİK)
- Sidebar'a menü linki eklendi

### 2. Alert Evaluation Pipeline Düzeltmeleri ✅
- `metric_name` → fact column mapping: `calls` → `calls_delta` (AlertRuleEvaluator.java `toFactColumn()`)
- JDBC null parametre: `updateLastEval` iki branch'e ayrıldı
- Alert detaylarına top 5 query + baseline bilgisi eklendi (Alerts.tsx `AlertDetails` componenti)

### 3. pg_stat_statements Reset Handling ✅
- Epoch change'de current değerler delta olarak yazılır (StatementsCollector.java)
- `ops.alert` oluşturulur (STATS_RESET_DETECTED)
- Reset pattern tespiti: `PgssResetTracker.java` + `V021__pgss_reset_tracker.sql`
- 3+ reset aynı saatte → `pgss_reset_schedule` → reset'ten 30sn önce ekstra snapshot

### 4. Statements Deep Search ✅
- `/api/statements/search` endpoint — `dim.statement_series`'ten arama
- UI'da tek arama kutusu: 3+ karakter → otomatik deep search
- "delta yok" tag'i: collector gördü ama delta yazılmadı

### 5. Yeni Metrik Aileleri (5 tane) ✅
- V026: SLRU, Subscription, Recovery Prefetch, User Functions
- V028: Sequence I/O (pg_statio_all_sequences)
- V027: metric_type constraint güncelleme
- Tüm katmanlar: SourceQueries → ClusterCollector → FactRepository → AlertRuleEvaluator → PartitionManager → PurgeEvaluator → API → UI
- Integer/Long cast fix (`toLongSafe`)
- Pg13Queries SLRU override fix

### 6. Veri Toplama Durumu (19 fact tablosu) ✅
```
activity_snapshot    264K ✅    lock_snapshot         0 (normal)
archiver_snapshot     340 ✅    pgss_delta        113K ✅
cluster_delta       213K ✅    prefetch_snapshot    36 ✅ YENİ
conflict_snapshot   1785 ✅    progress_snapshot     0 (normal)
database_delta      2745 ✅    replication_snapshot  0 (normal)
function_snapshot    354 ✅ YENİ  sequence_io_snapshot 152 ✅ YENİ
index_stat_delta   785K ✅    slot_snapshot          0 (normal)
io_stat_delta         0 (PG16+) slru_snapshot        176 ✅ YENİ
subscription_snapshot 0 (normal) table_stat_delta   393K ✅
wal_snapshot         340 ✅
```

## YAPILMASI GEREKENLER (Yeni Oturumda)

### İŞ 1: Adaptive Alerting UI Form/Modal'ları
**Dosya**: `ui/src/pages/AdaptiveAlerting.tsx`
**Durum**: Skeleton var, butonlar var ama tıklayınca form açılmıyor

#### 1a. Snooze Ekleme Modal'ı
- Rule seçici (dropdown, `/api/alert-rules` GET)
- Instance seçici (opsiyonel, `/api/instances` GET)
- Süre: dakika/saat/gün input
- Sebep: textarea
- API: `POST /api/adaptive-alerting/snooze`
- Liste: `GET /api/adaptive-alerting/snooze` → kalan süre countdown, erken kaldır butonu
- Sil: `DELETE /api/adaptive-alerting/snooze/:id`

#### 1b. Bakım Penceresi Modal'ı
- Pencere adı, açıklama
- Instance seçici (multi-select)
- Gün seçici (Pzt-Paz, multi-checkbox)
- Başlangıç/bitiş saati (time input)
- Timezone seçici
- Tüm alert'leri sustur / sadece belirli severity
- API: `POST/GET/DELETE /api/adaptive-alerting/maintenance`

#### 1c. Bildirim Kanalı Modal'ı
- Kanal tipi: Email/Slack/PagerDuty/Teams/Webhook
- Tipe göre dinamik form:
  - Email: recipients, smtp ayarları
  - Slack: webhook_url, channel
  - PagerDuty: integration_key
  - Teams: webhook_url
  - Webhook: url, method, headers, body_template
- Min severity filtresi
- API: `POST/GET/DELETE /api/adaptive-alerting/channels`, `POST .../channels/:id/test`

### İŞ 4: Dashboard'a Yeni Metrikler
**Dosya**: `ui/src/pages/Dashboard.tsx` + `api/src/routes/dashboard.ts`

Mevcut dashboard'da 4 top-N widget var: QPS, Bağlantı, Replikasyon Lag, Dead Tuple.
Eklenecek widget'lar:
- **WAL Üretimi**: Top 5 instance WAL byte/saat
- **Archiver Durumu**: Failed archive count > 0 olan instance'lar
- **SLRU Cache Miss**: Top 5 SLRU blks_read
- **Açık Alert Özeti**: Severity bazında dağılım (pie/bar değil, sayısal kartlar)

API'de `/api/dashboard/instance-metrics` endpoint'i mevcut. Yeni metrikleri buraya eklemek veya ayrı endpoint yapmak gerekebilir.

Dashboard API dosyası: `api/src/routes/dashboard.ts`

### İŞ 5: Instance Detail Yeni Tab'lar
**Dosya**: `ui/src/pages/InstanceDetail.tsx` + `api/src/routes/instances.ts`

Mevcut tab'lar: Overview, Statements, Databases, Activity, Alerts, Job Runs

Eklenecek tab'lar:
- **Functions**: `fact.pg_user_function_snapshot` — top fonksiyonlar (calls, total_time, self_time)
- **Sequences**: `fact.pg_sequence_io_snapshot` — sequence I/O (blks_read, blks_hit, hit ratio)
- **WAL/Archive**: `fact.pg_wal_snapshot` + `fact.pg_archiver_snapshot` — WAL üretimi, archive durumu
- **SLRU**: `fact.pg_slru_snapshot` — SLRU cache istatistikleri (name bazında)

Her tab için API endpoint gerekli:
- `GET /api/instances/:id/functions?hours=1`
- `GET /api/instances/:id/sequences?hours=1`
- `GET /api/instances/:id/wal?hours=1`
- `GET /api/instances/:id/slru?hours=1`

## ÖNEMLİ TEKNİK NOTLAR

### Dosya Yapısı
```
api/src/routes/          — Express route'ları
api/src/config/auth.ts   — JWT auth, requireAuth middleware
ui/src/pages/            — React sayfaları
ui/src/api/client.ts     — apiGet/apiPost/apiDelete
ui/src/components/common/ — DataTable, Badge, TimeAgo, Toast
collector/src/main/java/com/pgstat/collector/
  collector/   — ClusterCollector, StatementsCollector
  service/     — AlertRuleEvaluator, BaselineCalculator, PgssResetTracker
  repository/  — FactRepository, AlertRepository, DimensionRepository
  sql/         — SourceQueries, Pg11_12/13/14_16/17_18 Queries
  scheduler/   — JobOrchestrator
```

### UI Pattern'leri
- React Query (`useQuery`, `useMutation`) ile data fetching
- `apiGet('/path')` → `api/client.ts` JWT token ekler
- Tailwind CSS inline styles (hex renk kodları)
- DataTable componenti: `columns` array + `data` array
- Toast: `useToast()` → `toast.success()`, `toast.error()`
- Badge: `<Badge value="ready" />` → yeşil, `<Badge value="critical" />` → kırmızı

### DB Bağlantı
- Central DB: `.env` dosyasından (`PGSTAT_DB_HOST`, `PGSTAT_DB_PORT` vb.)
- API pool: `api/src/config/database.ts`
- Instance'lar: PG12 (2 adet), PG15 (2 adet)
- Container'lar UTC timezone'da çalışıyor

### Deploy
```bash
./pgstat upgrade  # git pull + migrate + docker build + up
```

### Bilinen Kısıtlamalar
- `io_stat_delta` boş: PG16+ gerekli, instance'lar PG12/15
- `subscription_snapshot` boş: logical replication yok
- `replication_snapshot` boş: replikasyon kurulu değil
- Container UTC'de, kullanıcı TR timezone'da (UTC+3)
