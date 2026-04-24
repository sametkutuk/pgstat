# Cursor Handoff - Adaptive Alerting Projesi

## 🎯 Proje Özeti
PostgreSQL monitoring sistemi (pgstat) için adaptive alerting özelliği ekliyoruz. Sistem, 28 günlük geçmiş veriden otomatik baseline profilleri oluşturup anomali tespiti yapacak.

---

## ✅ TAMAMLANAN İŞLER (Phase 1)

### 1. Tasarım Dokümantasyonu ✅
- **Dosya**: `docs/adaptive-alerting-design.md` (150+ sayfa, Türkçe)
- **İçerik**:
  - 31 alert metriği tanımlandı (cluster, activity, replication, database, statement, table, query-based)
  - Baseline profilleme sistemi (28 günlük geçmiş, saatlik örüntüler)
  - Scope yönetimi (single_instance, all_instances, instance_group)
  - Alert snooze/mute sistemi
  - Maintenance window sistemi
  - Notification channels (Email, Slack, PagerDuty, Teams, Webhook)
  - Baseline versiyonlama ve invalidation
  - Query-based monitoring (10 metrik, queryid/statement_series üzerinden)

### 2. Database Migration ✅
- **Dosya**: `db/migrations/V018__adaptive_alerting.sql`
- **Tablolar**:
  - `control.metric_baseline` - Genel metrik baseline'ları
  - `control.metric_baseline_query` - Query bazlı baseline'lar
  - `control.instance_settings` - Instance kapasite bilgileri
  - `control.baseline_version` - Baseline versiyonlama
  - `control.instance_group` - Instance grupları
  - `control.instance_group_member` - Grup üyelikleri
  - `control.alert_snooze` - Geçici alert susturma
  - `control.maintenance_window` - Bakım pencereleri
  - `control.notification_channel` - Bildirim kanalları
- **Fonksiyonlar**:
  - `invalidate_baseline()` - Baseline'ı sıfırla (major upgrade sonrası)
  - `is_alert_snoozed()` - Alert snooze kontrolü
  - `is_in_maintenance()` - Bakım penceresi kontrolü
- **Alert Rule Güncellemeleri**:
  - `sensitivity` kolonu (low/medium/high)
  - `use_adaptive` kolonu (baseline kullan/kullanma)
  - `scope` kolonu (single_instance/all_instances/instance_group)
  - `instance_group_id` kolonu
  - `instance_pk` artık nullable (all_instances için)

### 3. API Endpoints ✅
- **Dosya**: `api/src/routes/adaptiveAlerting.ts`
- **17 Endpoint**:
  - **Alert Snooze**: POST/GET/DELETE `/api/adaptive-alerting/snooze`
  - **Maintenance Windows**: POST/GET/DELETE `/api/adaptive-alerting/maintenance`
  - **Notification Channels**: POST/GET/DELETE/test `/api/adaptive-alerting/channels`
  - **Baseline Management**: GET/POST/invalidate `/api/adaptive-alerting/baselines`
  - **Instance Groups**: POST/GET/add-member/remove-member `/api/adaptive-alerting/groups`
- **Auth**: Tüm endpoint'ler JWT korumalı
- **Route**: `api/src/index.ts` içinde `/api/adaptive-alerting` altında kayıtlı

### 4. UI Sayfası ✅
- **Dosya**: `ui/src/pages/AdaptiveAlerting.tsx`
- **5 Tab**:
  1. **📊 Genel Bakış** - Sistem özeti, aktif baseline/snooze sayıları
  2. **📈 Baseline Profiller** - Instance bazlı baseline görüntüleme (henüz veri yok)
  3. **🔕 Snooze Yönetimi** - Alert'leri geçici susturma
  4. **🔧 Bakım Pencereleri** - Planlı bakım için otomatik susturma
  5. **📢 Bildirim Kanalları** - Email, Slack, PagerDuty entegrasyonları
- **Menü**: Sol sidebar'da "⚡ Adaptive Alerting" linki eklendi
- **Route**: `/settings/adaptive-alerting`

### 5. Dokümantasyon ✅
- `docs/adaptive-alerting-implementation-status.md` - Roadmap ve durum
- `docs/adaptive-alerting-quickstart.md` - Curl örnekleri ile hızlı başlangıç
- `ADAPTIVE_ALERTING_SUMMARY.md` - Proje özeti

---

## 🚧 YAPILMASI GEREKENLER

### Phase 2: Collector Entegrasyonu (ÖNCELİKLİ)
**Durum**: Başlanmadı  
**Tahmini Süre**: 4-6 saat

#### 2.1 Baseline Hesaplama Job'ı
**Dosya**: `collector/src/main/java/com/pgstat/collector/jobs/BaselineCalculationJob.java` (yeni)

**Görevler**:
1. Her gece 02:00'da çalışacak scheduled job
2. Her instance için son 28 günlük veriyi çek:
   - `agg.cluster_metric_hourly` - Cluster metrikleri
   - `agg.activity_metric_hourly` - Bağlantı/aktivite
   - `agg.replication_metric_hourly` - Replikasyon
   - `agg.database_metric_hourly` - Database metrikleri
   - `agg.statement_metric_hourly` - Statement metrikleri
   - `agg.table_metric_hourly` - Tablo metrikleri
3. Her metrik için hesapla:
   - Genel baseline (hour_of_day = -1): avg, stddev, min, max, p50, p95, p99
   - Saatlik baseline (hour_of_day = 0-23): Her saat için ayrı profil
4. `control.metric_baseline` tablosuna yaz
5. `control.instance_settings` tablosunu güncelle (max_connections, shared_buffers vb.)

**SQL Örneği**:
```sql
-- Genel baseline (tüm saatler)
insert into control.metric_baseline (instance_pk, metric_key, hour_of_day, avg_value, stddev_value, ...)
select 
  instance_pk,
  'cache_hit_ratio' as metric_key,
  -1 as hour_of_day,
  avg(cache_hit_ratio) as avg_value,
  stddev(cache_hit_ratio) as stddev_value,
  percentile_cont(0.50) within group (order by cache_hit_ratio) as p50_value,
  percentile_cont(0.95) within group (order by cache_hit_ratio) as p95_value,
  percentile_cont(0.99) within group (order by cache_hit_ratio) as p99_value,
  count(*) as sample_count
from agg.cluster_metric_hourly
where instance_pk = ? 
  and snapshot_time >= now() - interval '28 days'
group by instance_pk;

-- Saatlik baseline (0-23 arası her saat için)
insert into control.metric_baseline (instance_pk, metric_key, hour_of_day, avg_value, ...)
select 
  instance_pk,
  'cache_hit_ratio' as metric_key,
  extract(hour from snapshot_time) as hour_of_day,
  avg(cache_hit_ratio) as avg_value,
  ...
from agg.cluster_metric_hourly
where instance_pk = ? 
  and snapshot_time >= now() - interval '28 days'
group by instance_pk, extract(hour from snapshot_time);
```

#### 2.2 Query Baseline Hesaplama
**Dosya**: Aynı job içinde

**Görevler**:
1. `dim.statement_series` tablosundan top 100 query'yi al (en çok çalışan)
2. Her query için son 28 günlük metrikleri hesapla:
   - avg_exec_time_ms, stddev_exec_time_ms, p95_exec_time_ms
   - avg_calls_per_hour, max_calls
   - avg_temp_blks_per_call, max_temp_blks_per_call
3. `control.metric_baseline_query` tablosuna yaz

#### 2.3 Alert Evaluation Engine Güncellemesi
**Dosya**: `collector/src/main/java/com/pgstat/collector/jobs/AlertEvaluationJob.java` (mevcut)

**Görevler**:
1. `use_adaptive = true` olan kurallar için baseline'dan eşik çek
2. Sensitivity'ye göre eşik hesapla:
   - `low`: avg + 3*stddev
   - `medium`: avg + 2*stddev
   - `high`: avg + 1.5*stddev
3. Saatlik baseline varsa, o saatin profilini kullan
4. Snooze kontrolü: `is_alert_snoozed()` fonksiyonunu çağır
5. Maintenance kontrolü: `is_in_maintenance()` fonksiyonunu çağır
6. Eğer snooze/maintenance aktifse alert oluşturma

**Pseudo-kod**:
```java
for (AlertRule rule : adaptiveRules) {
    if (isAlertSnoozed(rule.getRuleId(), instancePk, metricKey)) {
        continue; // Skip
    }
    if (isInMaintenance(instancePk)) {
        continue; // Skip
    }
    
    Baseline baseline = getBaseline(instancePk, metricKey, currentHour);
    double threshold = calculateThreshold(baseline, rule.getSensitivity());
    
    if (currentValue > threshold) {
        createAlert(rule, currentValue, threshold);
    }
}
```

---

### Phase 3: UI Geliştirmeleri (ORTA ÖNCELİK)
**Durum**: Skeleton hazır, form/modal'lar eksik  
**Tahmini Süre**: 3-4 saat

#### 3.1 Snooze Yönetimi
**Dosya**: `ui/src/pages/AdaptiveAlerting.tsx` (SnoozePanel)

**Görevler**:
1. "Snooze Ekle" modal'ı:
   - Rule seçici (dropdown)
   - Instance seçici (opsiyonel)
   - Süre (dakika/saat/gün)
   - Sebep (textarea)
2. Aktif snooze listesi:
   - Kalan süre göster (countdown)
   - Erken kaldır butonu
3. API entegrasyonu:
   - `POST /api/adaptive-alerting/snooze`
   - `GET /api/adaptive-alerting/snooze`
   - `DELETE /api/adaptive-alerting/snooze/:id`

#### 3.2 Bakım Pencereleri
**Dosya**: `ui/src/pages/AdaptiveAlerting.tsx` (MaintenancePanel)

**Görevler**:
1. "Bakım Penceresi Ekle" modal'ı:
   - Pencere adı
   - Instance seçici (multi-select)
   - Gün seçici (Pazartesi-Pazar, multi-select)
   - Başlangıç/bitiş saati (time picker)
   - Timezone seçici
   - Tüm alert'leri sustur / sadece belirli severity'leri sustur
2. Bakım penceresi listesi:
   - Aktif/pasif toggle
   - Düzenle/sil butonları
   - Bir sonraki bakım zamanı göster
3. API entegrasyonu:
   - `POST /api/adaptive-alerting/maintenance`
   - `GET /api/adaptive-alerting/maintenance`
   - `DELETE /api/adaptive-alerting/maintenance/:id`

#### 3.3 Bildirim Kanalları
**Dosya**: `ui/src/pages/AdaptiveAlerting.tsx` (ChannelsPanel)

**Görevler**:
1. "Kanal Ekle" modal'ı:
   - Kanal tipi seçici (Email/Slack/PagerDuty/Teams/Webhook)
   - Tip'e göre dinamik form:
     - **Email**: recipients (multi-input), smtp_host, smtp_port, from_address
     - **Slack**: webhook_url, channel, username
     - **PagerDuty**: integration_key, severity_mapping
     - **Teams**: webhook_url
     - **Webhook**: url, method, headers (key-value pairs), body_template
   - Min severity (warning/critical/emergency)
   - Instance filtresi (opsiyonel)
   - Metrik kategori filtresi (opsiyonel)
2. Kanal listesi:
   - Aktif/pasif toggle
   - Test butonu (test notification gönder)
   - Düzenle/sil butonları
3. API entegrasyonu:
   - `POST /api/adaptive-alerting/channels`
   - `GET /api/adaptive-alerting/channels`
   - `POST /api/adaptive-alerting/channels/:id/test`
   - `DELETE /api/adaptive-alerting/channels/:id`

#### 3.4 Baseline Görselleştirme
**Dosya**: `ui/src/pages/AdaptiveAlerting.tsx` (BaselinesPanel)

**Görevler**:
1. Instance seçildikten sonra:
   - Metrik listesi (31 metrik)
   - Her metrik için kart:
     - Genel baseline (avg ± stddev)
     - Saatlik grafik (24 saat, her saatin avg değeri)
     - Son güncelleme zamanı
     - "Baseline'ı Sıfırla" butonu
2. Baseline invalidation:
   - Sebep girişi (major upgrade, config change vb.)
   - Onay modal'ı
   - API: `POST /api/adaptive-alerting/baselines/:instance_pk/invalidate`

---

### Phase 4: Notification Sender (DÜŞÜK ÖNCELİK)
**Durum**: Başlanmadı  
**Tahmini Süre**: 4-5 saat

#### 4.1 Notification Service
**Dosya**: `collector/src/main/java/com/pgstat/collector/services/NotificationService.java` (yeni)

**Görevler**:
1. Alert oluşturulduğunda tetiklenecek
2. `control.notification_channel` tablosundan aktif kanalları çek
3. Filtreleme:
   - Min severity kontrolü
   - Instance filtresi kontrolü
   - Metrik kategori filtresi kontrolü
4. Her kanal için notification gönder:
   - **Email**: JavaMail API kullan
   - **Slack**: Webhook POST request
   - **PagerDuty**: Events API v2
   - **Teams**: Webhook POST request
   - **Webhook**: Custom HTTP request
5. Hata yönetimi:
   - Retry mekanizması (3 deneme)
   - Başarısız notification'ları logla
   - Rate limiting (kanal başına max 10 notification/dakika)

#### 4.2 Alert Notification Tablosu
**Dosya**: `db/migrations/V019__alert_notifications.sql` (yeni)

**Görevler**:
1. Tablo oluştur:
```sql
create table control.alert_notification (
  notification_id bigserial primary key,
  alert_id bigint references control.alert(alert_id) on delete cascade,
  channel_id integer references control.notification_channel(channel_id),
  
  sent_at timestamptz default now(),
  status text check (status in ('sent', 'failed', 'retrying')),
  error_message text,
  retry_count integer default 0,
  
  response_code integer,
  response_body text
);
```
2. Alert detay sayfasında notification geçmişini göster

---

### Phase 5: İyileştirmeler (GELECEK)
**Durum**: Planlama aşamasında

#### 5.1 Machine Learning Baseline
- Seasonal decomposition (trend + seasonality + residual)
- Prophet/ARIMA modelleri
- Anomaly detection (Isolation Forest, LSTM)

#### 5.2 Alert Grouping
- Aynı instance'ta 5 dakika içinde 10+ alert → tek grup alert
- Root cause analysis (hangi metrik diğerlerini tetikledi?)

#### 5.3 Alert Correlation
- Replikasyon gecikmesi + yüksek WAL → master'da sorun var
- Tüm instance'larda aynı anda yüksek CPU → network/storage sorunu

#### 5.4 Baseline Drift Detection
- Baseline'ın zamanla kayması (yavaş yavaş artan load)
- Otomatik baseline refresh (her 7 günde bir)

---

## 📁 ÖNEMLİ DOSYALAR

### Backend (Java Collector)
- `collector/src/main/java/com/pgstat/collector/jobs/` - Job'lar buraya
- `collector/src/main/java/com/pgstat/collector/services/` - Servisler buraya
- `collector/pom.xml` - Dependency'ler (JavaMail, HTTP client vb.)

### Backend (Node.js API)
- `api/src/routes/adaptiveAlerting.ts` - Adaptive alerting endpoint'leri
- `api/src/index.ts` - Route kayıtları
- `api/src/config/database.ts` - Database pool

### Frontend (React)
- `ui/src/pages/AdaptiveAlerting.tsx` - Ana sayfa
- `ui/src/components/layout/Sidebar.tsx` - Menü
- `ui/src/App.tsx` - Route tanımları
- `ui/src/api/client.ts` - API client

### Database
- `db/migrations/V018__adaptive_alerting.sql` - Mevcut migration
- `db/migrations/V019__alert_notifications.sql` - Gelecek migration (notification tracking)

### Dokümantasyon
- `docs/adaptive-alerting-design.md` - Tam tasarım dokümanı (150+ sayfa)
- `docs/adaptive-alerting-implementation-status.md` - Roadmap
- `docs/adaptive-alerting-quickstart.md` - API kullanım örnekleri

---

## 🔧 TEKNIK DETAYLAR

### Database Schema
```
control.metric_baseline
├── instance_pk (FK → instance_inventory)
├── metric_key (text) - Örn: 'cache_hit_ratio', 'active_count'
├── hour_of_day (integer) - -1=genel, 0-23=saatlik
├── avg_value, stddev_value, min_value, max_value
├── p50_value, p95_value, p99_value
├── sample_count
├── capacity_value (opsiyonel, max_connections gibi)
└── updated_at

control.metric_baseline_query
├── instance_pk, queryid (PK)
├── statement_series_pk (opsiyonel)
├── avg_exec_time_ms, stddev_exec_time_ms, p95_exec_time_ms
├── avg_calls_per_hour, max_calls
├── avg_temp_blks_per_call, max_temp_blks_per_call
└── updated_at

control.alert_snooze
├── snooze_id (PK)
├── rule_id, instance_pk, metric_key, queryid (opsiyonel)
├── snooze_until (timestamptz)
├── snooze_reason, created_by
└── created_at

control.maintenance_window
├── window_id (PK)
├── window_name, description
├── instance_pks (bigint[])
├── day_of_week (integer[]) - 0=Pazar, 6=Cumartesi
├── start_time, end_time (time)
├── timezone
├── suppress_all_alerts (boolean)
├── suppress_severity (text[])
└── is_enabled

control.notification_channel
├── channel_id (PK)
├── channel_name, channel_type (email/slack/pagerduty/teams/webhook)
├── config (jsonb) - Kanal tipine göre farklı
├── min_severity (warning/critical/emergency)
├── instance_pks (bigint[]) - Filtre
├── metric_categories (text[]) - Filtre
└── is_enabled
```

### API Endpoint'leri
```
POST   /api/adaptive-alerting/snooze              - Snooze ekle
GET    /api/adaptive-alerting/snooze              - Aktif snooze'ları listele
DELETE /api/adaptive-alerting/snooze/:id          - Snooze kaldır

POST   /api/adaptive-alerting/maintenance         - Bakım penceresi ekle
GET    /api/adaptive-alerting/maintenance         - Bakım pencerelerini listele
DELETE /api/adaptive-alerting/maintenance/:id     - Bakım penceresi sil

POST   /api/adaptive-alerting/channels            - Bildirim kanalı ekle
GET    /api/adaptive-alerting/channels            - Kanalları listele
POST   /api/adaptive-alerting/channels/:id/test   - Test notification gönder
DELETE /api/adaptive-alerting/channels/:id        - Kanal sil

GET    /api/adaptive-alerting/baselines/:instance_pk           - Baseline'ları getir
POST   /api/adaptive-alerting/baselines/:instance_pk/invalidate - Baseline'ı sıfırla

POST   /api/adaptive-alerting/groups              - Instance grubu oluştur
GET    /api/adaptive-alerting/groups              - Grupları listele
POST   /api/adaptive-alerting/groups/:id/members  - Gruba instance ekle
DELETE /api/adaptive-alerting/groups/:id/members/:instance_pk - Gruptan çıkar
```

### Baseline Hesaplama Mantığı
```
1. Her gece 02:00'da çalış
2. Her instance için:
   a. Son 28 günlük veriyi çek (agg.* tablolarından)
   b. Her metrik için:
      - Genel baseline hesapla (tüm saatler)
      - Saatlik baseline hesapla (0-23 arası her saat)
   c. control.metric_baseline tablosuna yaz
   d. control.instance_settings'i güncelle
3. Top 100 query için:
   a. Son 28 günlük statement metriklerini çek
   b. control.metric_baseline_query'ye yaz
```

### Alert Evaluation Mantığı
```
1. Her 1 dakikada çalış
2. Her alert rule için:
   a. Snooze kontrolü → varsa skip
   b. Maintenance kontrolü → varsa skip
   c. use_adaptive = true ise:
      - Baseline'dan eşik çek
      - Sensitivity'ye göre hesapla:
        * low: avg + 3*stddev
        * medium: avg + 2*stddev
        * high: avg + 1.5*stddev
      - Saatlik baseline varsa kullan
   d. use_adaptive = false ise:
      - absolute_warning/absolute_critical kullan
   e. Eşik aşıldıysa alert oluştur
   f. Notification kanallarına gönder
```

---

## 🚀 HIZLI BAŞLANGIÇ (Cursor'da)

### 1. Projeyi Aç
```bash
cd /root/pgstat  # veya Windows'ta C:\Users\...\pgstat
cursor .
```

### 2. Phase 2'ye Başla (Collector Entegrasyonu)
```bash
# Yeni Java dosyası oluştur
touch collector/src/main/java/com/pgstat/collector/jobs/BaselineCalculationJob.java

# Mevcut AlertEvaluationJob'ı aç ve güncelle
cursor collector/src/main/java/com/pgstat/collector/jobs/AlertEvaluationJob.java
```

### 3. Test Et
```bash
# Migration'ı kontrol et
psql -h $PGSTAT_DB_HOST -p $PGSTAT_DB_PORT -U $PGSTAT_DB_USER -d $PGSTAT_DB_NAME \
  -c "SELECT * FROM control.metric_baseline LIMIT 5;"

# API'yi test et
curl -X GET http://localhost:3001/api/adaptive-alerting/snooze \
  -H "Authorization: Bearer $TOKEN"

# UI'yi aç
http://localhost:3000/settings/adaptive-alerting
```

---

## 📊 İLERLEME DURUMU

| Phase | Görev | Durum | Tamamlanma |
|-------|-------|-------|------------|
| 1 | Tasarım Dokümantasyonu | ✅ Tamamlandı | 100% |
| 1 | Database Migration | ✅ Tamamlandı | 100% |
| 1 | API Endpoints | ✅ Tamamlandı | 100% |
| 1 | UI Skeleton | ✅ Tamamlandı | 100% |
| 2 | Baseline Hesaplama Job | ⏳ Başlanmadı | 0% |
| 2 | Alert Evaluation Güncelleme | ⏳ Başlanmadı | 0% |
| 3 | Snooze UI | ⏳ Başlanmadı | 0% |
| 3 | Maintenance UI | ⏳ Başlanmadı | 0% |
| 3 | Notification Channels UI | ⏳ Başlanmadı | 0% |
| 3 | Baseline Görselleştirme | ⏳ Başlanmadı | 0% |
| 4 | Notification Service | ⏳ Başlanmadı | 0% |
| 5 | ML Baseline | 📋 Planlama | 0% |

**Toplam İlerleme**: ~35% (Phase 1 tamamlandı)

---

## 💡 ÖNERİLER

1. **Phase 2'ye öncelik ver** - Baseline hesaplama olmadan sistem çalışmaz
2. **Test verisi oluştur** - 28 günlük geçmiş veri yoksa mock data ekle
3. **Loglama ekle** - Baseline hesaplama ve alert evaluation'da detaylı log
4. **Performance test** - 50+ instance için baseline hesaplama süresi
5. **UI/UX iyileştir** - Form validasyonları, loading state'leri, error handling

---

## 🐛 BİLİNEN SORUNLAR

1. **Baseline verisi yok** - Collector entegrasyonu yapılmadığı için baseline tabloları boş
2. **UI form'ları eksik** - Snooze/maintenance/channel ekleme modal'ları yapılmadı
3. **Notification gönderimi yok** - Alert oluştuğunda bildirim gitmiyor
4. **Test coverage düşük** - Unit test'ler yazılmadı

---

## 📞 İLETİŞİM

Sorular için:
- Tasarım: `docs/adaptive-alerting-design.md` dosyasına bak
- API: `docs/adaptive-alerting-quickstart.md` dosyasına bak
- Durum: `docs/adaptive-alerting-implementation-status.md` dosyasına bak

---

**Son Güncelleme**: 2026-04-24  
**Hazırlayan**: Kiro AI  
**Proje**: pgstat Adaptive Alerting  
**Versiyon**: Phase 1 Complete
