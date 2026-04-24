# Adaptive Alerting Implementation Status

## ✅ Tamamlanan (1.5 saat içinde)

### 1. Veri Modeli (Migration)
**Dosya:** `db/migrations/V018__adaptive_alerting.sql`

**Oluşturulan Tablolar:**
- ✅ `control.metric_baseline` — Genel metrik baseline'ları
- ✅ `control.metric_baseline_query` — Query bazlı baseline'lar
- ✅ `control.instance_settings` — Instance kapasite ayarları
- ✅ `control.baseline_version` — Baseline versiyonlama
- ✅ `control.instance_group` + `control.instance_group_member` — Instance grupları
- ✅ `control.alert_snooze` — Alert susturma
- ✅ `control.maintenance_window` — Bakım pencereleri
- ✅ `control.notification_channel` — Bildirim kanalları

**Oluşturulan Fonksiyonlar:**
- ✅ `control.invalidate_baseline()` — Baseline sıfırlama
- ✅ `control.is_alert_snoozed()` — Snooze kontrolü
- ✅ `control.is_in_maintenance()` — Maintenance window kontrolü

**Alert Rule Güncellemeleri:**
- ✅ `sensitivity` kolonu (low/medium/high)
- ✅ `use_adaptive` kolonu (boolean)
- ✅ `absolute_warning` / `absolute_critical` kolonları
- ✅ `scope` kolonu (single_instance/all_instances/instance_group)
- ✅ `instance_group_id` kolonu
- ✅ `instance_pk` artık nullable

### 2. API Endpoint'leri
**Dosya:** `api/src/routes/adaptiveAlerting.ts`

**Alert Snooze:**
- ✅ `POST /api/adaptive-alerting/snooze` — Alert sustur
- ✅ `GET /api/adaptive-alerting/snooze` — Aktif snooze'ları listele
- ✅ `DELETE /api/adaptive-alerting/snooze/:snooze_id` — Snooze kaldır

**Maintenance Windows:**
- ✅ `POST /api/adaptive-alerting/maintenance-windows` — Bakım penceresi oluştur
- ✅ `GET /api/adaptive-alerting/maintenance-windows` — Bakım pencerelerini listele
- ✅ `DELETE /api/adaptive-alerting/maintenance-windows/:window_id` — Bakım penceresi sil

**Notification Channels:**
- ✅ `POST /api/adaptive-alerting/notification-channels` — Bildirim kanalı oluştur
- ✅ `GET /api/adaptive-alerting/notification-channels` — Kanalları listele
- ✅ `POST /api/adaptive-alerting/notification-channels/:channel_id/test` — Test bildirimi
- ✅ `DELETE /api/adaptive-alerting/notification-channels/:channel_id` — Kanal sil

**Baseline Management:**
- ✅ `GET /api/adaptive-alerting/instances/:instance_pk/baseline/:metric_key` — Baseline oku
- ✅ `POST /api/adaptive-alerting/instances/:instance_pk/baseline/invalidate` — Baseline sıfırla
- ✅ `GET /api/adaptive-alerting/instances/:instance_pk/baseline/versions` — Version geçmişi

**Instance Groups:**
- ✅ `POST /api/adaptive-alerting/instance-groups` — Grup oluştur
- ✅ `GET /api/adaptive-alerting/instance-groups` — Grupları listele
- ✅ `POST /api/adaptive-alerting/instance-groups/:group_id/members` — Üye ekle
- ✅ `DELETE /api/adaptive-alerting/instance-groups/:group_id/members/:instance_pk` — Üye çıkar

---

## 🚧 Yapılması Gerekenler (Sonraki Adımlar)

### 3. Collector Servisleri (Java)
**Öncelik: YÜKSEK**

**Dosyalar:**
- `collector/src/main/java/com/pgstat/collector/service/BaselineCalculator.java`
- `collector/src/main/java/com/pgstat/collector/service/InstanceSettingsCollector.java`
- `collector/src/main/java/com/pgstat/collector/service/BaselineVersionManager.java`

**Görevler:**
- [ ] `BaselineCalculator` — Günlük baseline hesaplama (daily rollup içinde)
  - Son 28 günlük veri üzerinde percentile, avg, stddev hesapla
  - Saatlik profil oluştur (hour_of_day bazlı)
  - `control.metric_baseline` tablosuna yaz
  
- [ ] `InstanceSettingsCollector` — Discovery sırasında pg_settings oku
  - `max_connections`, `superuser_reserved_connections`, `shared_buffers`, vb.
  - `control.instance_settings` tablosuna yaz
  - PG version değişikliği tespiti
  
- [ ] `BaselineVersionManager` — PG version değişikliği kontrolü
  - Her discovery'de PG version kontrol et
  - Major version değişirse otomatik `invalidate_baseline()` çağır

### 4. Alert Değerlendirme Güncellemesi (Java)
**Öncelik: YÜKSEK**

**Dosya:**
- `collector/src/main/java/com/pgstat/collector/service/AlertRuleEvaluator.java`

**Görevler:**
- [ ] Snooze/maintenance window kontrolü ekle
  - Alert değerlendirmeden önce `is_alert_snoozed()` ve `is_in_maintenance()` kontrol et
  - Snoozed/maintenance ise alert değerlendirmesini atla
  
- [ ] Scope çözümleme ekle
  - `single_instance`: Sadece instance_pk
  - `all_instances`: Tüm aktif instance'lar
  - `instance_group`: Grup üyelerini çöz
  
- [ ] Adaptif eşik hesaplama ekle
  - `use_adaptive = true` ise baseline'dan eşik hesapla
  - `sensitivity` bazlı multiplier uygula (low: 2.0×, medium: 1.3×, high: 1.1×)
  - `absolute_warning` / `absolute_critical` ile max al
  
- [ ] Notification routing ekle
  - Alert tetiklendiğinde `notification_channel` tablosundan uygun kanalları seç
  - Severity, instance, category filtrelerine göre route et

### 5. Notification Servisleri (Java)
**Öncelik: ORTA**

**Dosyalar:**
- `collector/src/main/java/com/pgstat/collector/notification/NotificationRouter.java`
- `collector/src/main/java/com/pgstat/collector/notification/EmailNotifier.java`
- `collector/src/main/java/com/pgstat/collector/notification/SlackNotifier.java`
- `collector/src/main/java/com/pgstat/collector/notification/PagerDutyNotifier.java`
- `collector/src/main/java/com/pgstat/collector/notification/WebhookNotifier.java`

**Görevler:**
- [ ] `NotificationRouter` — Kanalları seç ve route et
- [ ] `EmailNotifier` — SMTP ile email gönder
- [ ] `SlackNotifier` — Slack webhook ile bildirim gönder
- [ ] `PagerDutyNotifier` — PagerDuty incident oluştur
- [ ] `WebhookNotifier` — Generic webhook POST

### 6. UI Geliştirme (React/TypeScript)
**Öncelik: ORTA**

**Sayfalar:**
- [ ] Alert Snooze Modal (`ui/src/components/AlertSnoozeModal.tsx`)
- [ ] Maintenance Window Yönetimi (`ui/src/pages/MaintenanceWindows.tsx`)
- [ ] Notification Channel Yönetimi (`ui/src/pages/NotificationChannels.tsx`)
- [ ] Baseline Version Geçmişi (`ui/src/components/BaselineVersionHistory.tsx`)
- [ ] Instance Group Yönetimi (`ui/src/pages/InstanceGroups.tsx`)

**Görevler:**
- [ ] Alert listesinde "Snooze" butonu ekle
- [ ] Snooze modal oluştur (süre + kapsam seçimi)
- [ ] Maintenance window CRUD sayfası
- [ ] Notification channel CRUD sayfası
- [ ] Baseline invalidation butonu + modal
- [ ] Instance group yönetim sayfası

### 7. Query Bazlı Metrikler (Java)
**Öncelik: DÜŞÜK**

**Görevler:**
- [ ] Query bazlı baseline hesaplama (`metric_baseline_query` tablosu)
- [ ] 10 yeni query metriği için collector'lar:
  - Slow query spike
  - Query call frequency anomaly
  - Query error rate
  - Query plan change
  - Top slow queries
  - Query temp usage spike
  - Query max exec time change
  - Query index usage
  - Query disk write
  - Query rows anomaly

---

## 📋 Test Checklist

### Migration Test
```bash
# Migration'ı uygula
cd db
./apply.sh

# Tabloları kontrol et
psql -h localhost -U pgstat_user -d pgstat_control -c "\dt control.*"

# Fonksiyonları test et
psql -h localhost -U pgstat_user -d pgstat_control -c "select control.invalidate_baseline(1, 'test', 'admin');"
```

### API Test
```bash
# API'yi başlat
cd api
npm install
npm run dev

# Endpoint'leri test et
curl -X POST http://localhost:3001/api/adaptive-alerting/snooze \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"rule_id": 1, "duration_minutes": 60, "reason": "test"}'

curl http://localhost:3001/api/adaptive-alerting/snooze \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Collector Test
```bash
# Collector'ı başlat
cd collector
mvn clean install
java -jar target/pgstat-collector.jar

# Log'ları kontrol et
tail -f logs/collector.log
```

---

## 📊 Performans Notları

**Baseline Hesaplama:**
- 50 instance × 31 metrik × 24 saat = ~37.000 baseline satırı
- Günlük hesaplama süresi: ~5-10 dakika (paralel işlemle)
- Incremental hesaplama önerilir (sadece son 1 günü ekle, 29 gün öncesini çıkar)

**Alert Değerlendirme:**
- Her 1 dakikada 1 kez çalışır
- Snooze/maintenance kontrolü: ~1ms (index'li)
- Baseline lookup: ~2ms (index'li)
- Toplam overhead: ~10-20ms per alert rule

**Notification:**
- Async olarak gönderilmeli (alert değerlendirmesini bloklamasın)
- Retry mekanizması olmalı (Slack/PagerDuty geçici down olabilir)
- Rate limiting olmalı (aynı alert 1 dakikada 1 kez bildirilsin)

---

## 🎯 Sonraki Sprint Hedefleri

**Sprint 1 (1-2 hafta):**
- ✅ Migration + API (TAMAMLANDI)
- [ ] Collector servisleri (BaselineCalculator, InstanceSettingsCollector)
- [ ] Alert değerlendirme güncellemesi (snooze, scope, adaptive threshold)

**Sprint 2 (1-2 hafta):**
- [ ] Notification servisleri (Email, Slack, PagerDuty)
- [ ] UI geliştirme (Snooze modal, Maintenance windows, Notification channels)

**Sprint 3 (1-2 hafta):**
- [ ] Query bazlı metrikler
- [ ] Baseline görselleştirme
- [ ] Test ve bug fix

---

## 📝 Notlar

- Migration dosyası Flyway naming convention'ına uygun: `V018__adaptive_alerting.sql`
- API endpoint'leri `/api/adaptive-alerting` prefix'i altında
- Tüm endpoint'ler JWT authentication gerektiriyor
- Snooze ve maintenance window kontrolü alert değerlendirmeden önce yapılmalı
- Baseline hesaplama daily rollup job içinde çalışmalı (gece 03:00)
- Notification async olmalı (alert değerlendirmesini bloklamasın)

---

## 🚀 Deployment

```bash
# 1. Migration'ı uygula
cd db && ./apply.sh

# 2. API'yi yeniden başlat
cd api && npm run build && pm2 restart pgstat-api

# 3. Collector'ı yeniden başlat
cd collector && mvn clean install && systemctl restart pgstat-collector

# 4. UI'yi yeniden build et
cd ui && npm run build && nginx -s reload
```
