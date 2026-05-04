# Tasarım: Instance/Database Raporlama Sistemi

## Özet

3 tip rapor:
1. **On-demand Health Report** — UI'dan tetikle, anında sonuç
2. **Günlük Özet Rapor** — her sabah otomatik (email/telegram)
3. **Haftalık Kapasite Rapor** — Pazartesi sabahı otomatik

---

## 1. On-demand Health Report

### Tetikleme
- UI: Instance Detail sayfasında "Sağlık Raporu" butonu
- API: `GET /api/instances/:id/health-report`

### İçerik (checklist formatı)

```
📋 Instance Sağlık Raporu: test-etsrooms-166-52
📅 Tarih: 2026-04-28 14:30 UTC

━━━ GENEL DURUM ━━━
✅ Bağlantı: OK (bootstrap_state = ready)
✅ Cache Hit Ratio: 99.2% (eşik: > 95%)
⚠️ Bağlantı Kullanımı: 156/200 (%78) (eşik: < 80%)
✅ Replikasyon: lag yok

━━━ PERFORMANS ━━━
✅ Ortalama TPS: 4.2
⚠️ Temp Files (son 24h): 45 dosya, 128 MB
✅ Deadlock (son 24h): 0
✅ Uzun sorgu (> 5dk): yok

━━━ DEPOLAMA ━━━
✅ WAL Üretimi (son 24h): 340 MB
⚠️ Top Bloat: public.reservations %18 dead tuple
✅ Toplam DB Boyutu: 2.1 GB

━━━ INDEX SAĞLIĞI ━━━
⚠️ 2 tablo index gerektirebilir (seq_scan/idx_scan > 100)
⚠️ 1 kullanılmayan index (> 100MB, 30g scan=0)

━━━ YAPILANDIRMA ━━━
✅ work_mem: 64MB
✅ shared_buffers: 2GB
✅ max_connections: 200
✅ autovacuum: aktif

━━━ AÇIK ALERT'LER ━━━
🟡 1 warning: Call Sayısı Ani Artışı
```

### API Response

```json
{
  "instance_pk": 3,
  "display_name": "test-etsrooms-166-52",
  "generated_at": "2026-04-28T14:30:00Z",
  "overall_status": "warning",  // healthy, warning, critical
  "sections": [
    {
      "title": "Genel Durum",
      "checks": [
        {"name": "Bağlantı", "status": "ok", "value": "ready", "threshold": null},
        {"name": "Cache Hit Ratio", "status": "ok", "value": "99.2%", "threshold": "> 95%"},
        {"name": "Bağlantı Kullanımı", "status": "warning", "value": "156/200 (78%)", "threshold": "< 80%"}
      ]
    },
    ...
  ],
  "open_alerts": [...],
  "recommendations": [
    "2 tablo için index oluşturmayı değerlendirin",
    "1 kullanılmayan index drop edilebilir (128 MB tasarruf)"
  ]
}
```

### Kod Değişiklikleri
- `api/src/routes/instances.ts`: `GET /:id/health-report` endpoint
- `ui/src/pages/InstanceDetail.tsx`: "Sağlık Raporu" butonu + modal/panel

---

## 2. Günlük Özet Rapor

### Tetikleme
- Collector: UTC 06:00 (TR 09:00) — iş günü başında
- Bildirim kanallarına gönderilir (email/telegram/teams)

### İçerik (per-instance özet)

```
📊 pgstat Günlük Özet — 2026-04-28

━━━ FLEET DURUMU ━━━
• 4 instance aktif, 0 degraded
• 2 açık alert (1 warning, 1 info)
• Toplam TPS: 12.5 (dün: 11.8, +6%)

━━━ PER-INSTANCE ━━━

🟢 test-etsrooms-166-52
  TPS: 4.2 | Bağlantı: 156/200 | WAL: 340 MB
  Cache: 99.2% | Temp: 45 dosya | Deadlock: 0

🟢 prod-pg15-140-52
  TPS: 8.3 | Bağlantı: 89/200 | WAL: 1.2 GB
  Cache: 99.8% | Temp: 0 | Deadlock: 0

━━━ DİKKAT GEREKTİREN ━━━
⚠️ test-etsrooms: 2 missing index suspect
⚠️ test-etsrooms: temp_files 45/gün (work_mem: 4MB)
```

### Kod Değişiklikleri
- `collector/.../service/DailyReportGenerator.java`: Rapor üretici
- JobOrchestrator: UTC 06:00'da tetikle
- NotificationService: rapor formatını bildirim kanallarına gönder

---

## 3. Haftalık Kapasite Rapor

### Tetikleme
- Collector: Pazartesi UTC 06:00 (TR 09:00)
- Bildirim kanallarına gönderilir

### İçerik

```
📈 pgstat Haftalık Kapasite Raporu — Hafta 17 (2026-04-21 → 2026-04-27)

━━━ TREND ━━━
• TPS: bu hafta avg 12.5, geçen hafta 11.2 (+12%)
• Bağlantı P95: bu hafta 165, geçen hafta 148 (+11%)
• WAL/gün: bu hafta 2.1 GB, geçen hafta 1.8 GB (+17%)
• DB Boyut: +450 MB büyüme

━━━ KAPASİTE TAHMİNİ ━━━
• Bağlantı: mevcut trend ile 45 gün sonra max_connections'a ulaşılır
• Disk: mevcut büyüme ile 180 gün yeterli

━━━ AKSİYON ÖNERİLERİ ━━━
1. 3 unused index drop edilebilir (toplam 450 MB tasarruf)
2. work_mem artırılmalı (haftada 312 temp file)
3. autovacuum_vacuum_scale_factor düşürülmeli (2 tablo > %15 bloat)
```

### Kod Değişiklikleri
- `collector/.../service/WeeklyReportGenerator.java`: Rapor üretici
- JobOrchestrator: Pazartesi UTC 06:00'da tetikle
- NotificationService: rapor gönder

---

## Uygulama Sırası

1. **On-demand Health Report** (API + UI) — en hızlı, bağımsız
2. **Günlük Özet** (collector + notification) — daily report generator
3. **Haftalık Kapasite** (collector + notification) — weekly report generator

---

## Doğrulama

- [ ] `GET /api/instances/:id/health-report` → JSON response
- [ ] UI'da "Sağlık Raporu" butonu çalışıyor
- [ ] Günlük rapor UTC 06:00'da tetikleniyor (log)
- [ ] Haftalık rapor Pazartesi UTC 06:00'da tetikleniyor
- [ ] Telegram/email'e rapor gönderiliyor
