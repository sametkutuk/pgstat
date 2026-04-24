# Adaptive Alerting - Quick Start Guide

## 🚀 Hızlı Başlangıç (5 Dakika)

### 1. Migration'ı Uygula

```bash
cd db
./apply.sh
```

**Beklenen Çıktı:**
```
Applying V018__adaptive_alerting.sql...
✓ Tables created
✓ Functions created
✓ Seed data inserted
Migration completed successfully!
```

### 2. API'yi Yeniden Başlat

```bash
cd api
npm install  # Sadece ilk kez
npm run build
pm2 restart pgstat-api  # veya: npm run dev
```

### 3. Test Et

```bash
# Health check
curl http://localhost:3001/api/health

# Snooze endpoint test (JWT token gerekli)
curl -X POST http://localhost:3001/api/adaptive-alerting/snooze \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "rule_id": 1,
    "duration_minutes": 60,
    "reason": "Planned maintenance"
  }'
```

---

## 📋 Özellik Kullanım Örnekleri

### Alert Snooze

**1 saat için alert sustur:**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/snooze \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "rule_id": 123,
    "duration_minutes": 60,
    "reason": "Migration in progress"
  }'
```

**Tüm instance'ın alert'lerini sustur:**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/snooze \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "instance_pk": 42,
    "duration_minutes": 120,
    "reason": "Server maintenance"
  }'
```

**Aktif snooze'ları listele:**
```bash
curl http://localhost:3001/api/adaptive-alerting/snooze \
  -H "Authorization: Bearer $TOKEN"
```

---

### Maintenance Window

**Her Pazar 02:00-04:00 bakım penceresi:**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/maintenance-windows \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "window_name": "Weekly Backup",
    "day_of_week": [0],
    "start_time": "02:00",
    "end_time": "04:00",
    "timezone": "UTC",
    "suppress_all_alerts": true
  }'
```

**Her gece 01:00-03:00 sadece warning'leri sustur:**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/maintenance-windows \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "window_name": "Nightly Jobs",
    "start_time": "01:00",
    "end_time": "03:00",
    "suppress_severity": ["warning"]
  }'
```

---

### Notification Channel

**Slack entegrasyonu:**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/notification-channels \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "channel_name": "Slack - Critical Alerts",
    "channel_type": "slack",
    "config": {
      "webhook_url": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
      "channel": "#db-alerts",
      "username": "pgstat-bot",
      "icon_emoji": ":warning:"
    },
    "min_severity": "critical"
  }'
```

**Email entegrasyonu:**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/notification-channels \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "channel_name": "Email - Production Team",
    "channel_type": "email",
    "config": {
      "recipients": ["prod-team@example.com", "dba@example.com"]
    },
    "instance_pks": [42, 43]
  }'
```

**Test bildirimi gönder:**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/notification-channels/1/test \
  -H "Authorization: Bearer $TOKEN"
```

---

### Baseline Management

**Baseline'ı oku:**
```bash
curl http://localhost:3001/api/adaptive-alerting/instances/42/baseline/activity.active_count \
  -H "Authorization: Bearer $TOKEN"
```

**Baseline'ı sıfırla (major upgrade sonrası):**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/instances/42/baseline/invalidate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "reason": "major_upgrade"
  }'
```

**Baseline version geçmişi:**
```bash
curl http://localhost:3001/api/adaptive-alerting/instances/42/baseline/versions \
  -H "Authorization: Bearer $TOKEN"
```

---

### Instance Groups

**Grup oluştur:**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/instance-groups \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "group_name": "production",
    "description": "Production databases"
  }'
```

**Gruba instance ekle:**
```bash
curl -X POST http://localhost:3001/api/adaptive-alerting/instance-groups/1/members \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "instance_pk": 42
  }'
```

**Grupları listele:**
```bash
curl http://localhost:3001/api/adaptive-alerting/instance-groups \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🔍 Troubleshooting

### Migration Hatası

**Hata:** `relation "control.metric_baseline" already exists`

**Çözüm:**
```sql
-- Mevcut tabloları kontrol et
\dt control.metric_baseline

-- Gerekirse manuel sil ve tekrar uygula
drop table if exists control.metric_baseline cascade;
```

### API Hatası

**Hata:** `Cannot find module './routes/adaptiveAlerting'`

**Çözüm:**
```bash
cd api
npm run build  # TypeScript'i compile et
pm2 restart pgstat-api
```

### JWT Token Alma

```bash
# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "your_password"
  }'

# Response'dan access_token'ı al
export TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Artık kullanabilirsin
curl http://localhost:3001/api/adaptive-alerting/snooze \
  -H "Authorization: Bearer $TOKEN"
```

---

## 📊 Veritabanı Kontrolleri

```sql
-- Tabloları kontrol et
\dt control.metric_baseline*
\dt control.alert_snooze
\dt control.maintenance_window
\dt control.notification_channel

-- Fonksiyonları kontrol et
\df control.invalidate_baseline
\df control.is_alert_snoozed
\df control.is_in_maintenance

-- Seed data kontrol et
select * from control.instance_group;
select * from control.notification_channel;

-- Alert rule güncellemelerini kontrol et
\d control.alert_rule
-- sensitivity, use_adaptive, scope kolonları olmalı
```

---

## 🎯 Sonraki Adımlar

1. ✅ Migration uygulandı
2. ✅ API endpoint'leri hazır
3. ⏳ Collector servisleri (BaselineCalculator, AlertRuleEvaluator)
4. ⏳ Notification servisleri (Email, Slack, PagerDuty)
5. ⏳ UI geliştirme (Snooze modal, Maintenance windows)

**Detaylı implementasyon durumu için:**
`docs/adaptive-alerting-implementation-status.md`

**Tam tasarım dokümanı için:**
`docs/adaptive-alerting-design.md`
