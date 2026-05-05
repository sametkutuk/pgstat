# Otomatik Rapor Sistemi

pgstat günlük ve haftalık özet raporlarını yapılandırılmış bildirim kanallarına otomatik gönderir. Bu doküman:
- Mimariyi
- Yapılandırmayı (UI ve DB)
- Saklama (retention) mantığını
- Sorun giderme adımlarını

açıklar.

---

## Mimari

```
┌──────────────────────────────────────────────────────────────────┐
│ JobOrchestrator (her 5 saniyede çalışır)                          │
│   if (currentUtcHour == config.daily_hour_utc                     │
│       && !todayUtc.equals(lastDailyReportDate))                   │
│       → ReportGenerator.generateAndSendDailyReport()              │
│   if (Pazartesi && currentUtcHour == config.weekly_hour_utc       │
│       && !todayUtc.equals(lastWeeklyReportDate))                  │
│       → ReportGenerator.generateAndSendWeeklyReport()             │
│                                                                   │
│   if (currentUtcHour == 2 && !todayUtc.equals(lastJobPurgeDate))  │
│       → PurgeEvaluator.purgeReportsAndNotifications()             │
└──────────────────────────────────────────────────────────────────┘
                  │                                    │
                  │                                    │
         ┌────────▼─────────┐                ┌────────▼──────────┐
         │ ReportGenerator  │                │ PurgeEvaluator    │
         │  - config check  │                │  - retention check │
         │  - body üret     │                │  - delete rapor    │
         │  - kanal gönder  │                │  - delete notif    │
         │  - DB kayıt      │                └────────────────────┘
         └────────┬─────────┘
                  │
         ┌────────▼─────────┐
         │ ops.report_      │
         │   history        │
         └──────────────────┘
```

### İdempotency

Saat-bazlı tetikler 1 saat sürer (örn. UTC 06:00–06:59) ve rollup loop'u her 5 saniyede çalışır → 720 cycle. İdempotency için **`lastDailyReportDate` / `lastWeeklyReportDate` / `lastJobPurgeDate`** in-memory `LocalDate` field'ları kullanılır:

- Aynı UTC günü içinde aynı job sadece bir kez tetiklenir
- Hata olursa flag `null`'a alınır, sonraki cycle yeniden dener
- Collector restart'ında flag sıfırlanır → o saatte restart varsa **en kötü 1 dup** oluşabilir (kabul edilebilir)

---

## Yapılandırma

### UI (Ayarlar > Raporlar sekmesi)

| Alan | Açıklama | Default |
|---|---|---|
| Günlük Etkin | Günlük raporu kapat/aç | `true` |
| Günlük Saat (UTC) | Hangi UTC saatte gönderilecek (TR saati de gösterilir) | `6` (TR 09:00) |
| Günlük Saklama (gün) | Tarihçede kaç gün tutulacak | `30` |
| Haftalık Etkin | Pazartesi haftalık raporu kapat/aç | `true` |
| Haftalık Saat (UTC) | Pazartesi günü hangi saat | `6` |
| Haftalık Saklama (gün) | Tarihçede kaç gün tutulacak | `90` |
| Bildirim Logu Saklama (gün) | `ops.notification_log` retention | `14` |

### DB Tablosu

```sql
control.report_config (singleton, config_id = 1)
  daily_enabled                    boolean
  daily_hour_utc                   smallint  CHECK (0..23)
  daily_retention_days             smallint  CHECK (1..3650)
  weekly_enabled                   boolean
  weekly_hour_utc                  smallint  CHECK (0..23)
  weekly_retention_days            smallint  CHECK (1..3650)
  notification_log_retention_days  smallint  CHECK (1..3650)
  updated_at                       timestamptz
```

`set_updated_at` trigger'ı `updated_at`'i otomatik günceller.

---

## Rapor Tarihçesi

Gönderilen her rapor `ops.report_history` tablosuna kaydedilir:

```sql
ops.report_history
  report_id        bigserial PK
  report_type      'daily' | 'weekly'
  generated_at     timestamptz
  title            text
  body             text          -- markdown
  recipients_json  jsonb         -- [{channel_id, channel_type, status}, ...]
  sent_status      'sent' | 'failed' | 'partial'
  channels_count   smallint      -- başarılı gönderim sayısı
  error_message    text          -- ilk hata mesajı (varsa)
```

UI'da `Sidebar > Raporlar` linkinden listelenir. Her satır:
- Tip rozeti (Günlük / Haftalık)
- Başlık + zaman
- Durum (sent / partial / failed)
- Kanal sayısı
- "Aç" → modal'da tam body + kanal sonuçları
- "Sil" → manuel silme (DELETE /api/reports/history/:id)

---

## Saklama (Retention)

Her UTC 02:00'da `PurgeEvaluator.purgeReportsAndNotifications()` çalışır:

1. **Daily report cleanup**: `report_type='daily' AND generated_at < now() - daily_retention_days`
2. **Weekly report cleanup**: `report_type='weekly' AND generated_at < now() - weekly_retention_days`
3. **Notification log cleanup**: `sent_at < now() - notification_log_retention_days`

Tablolar küçük olduğundan tek `DELETE` ile temizlenir (job_run history'deki gibi batch'lere ihtiyaç yok).

---

## API Uçları

| Method | Path | Açıklama |
|---|---|---|
| GET    | `/api/reports/config` | Mevcut config |
| PATCH  | `/api/reports/config` | Config güncelle (kısmi update — sadece gönderilen alanlar değişir) |
| GET    | `/api/reports/history` | Liste (filter: `?type=daily|weekly`, `?limit=N`) |
| GET    | `/api/reports/history/:id` | Tek rapor (body dahil) |
| DELETE | `/api/reports/history/:id` | Manuel sil |

Tüm uçlar `requireAuth` ile korunur.

---

## Migration

`db/migrations/V045__report_config_and_history.sql`:
- `control.report_config` tablo + initial seed
- `control.set_updated_at` trigger
- `ops.report_history` tablo + index'ler

`./pgstat upgrade` otomatik uygular.

---

## Sorun Giderme

### "Yüzlerce duplicate rapor geldi"

Önceki commit'lerde (öncesinde `b08fec1`) saat-bazlı kontrolde idempotency yoktu. Düzeltildi. Yarınki rapor 1 tane gelecek.

### "Rapor hiç gelmiyor"

Kontrol listesi:

1. **UI Ayarlar > Raporlar > Etkin** açık mı?
2. `select * from control.notification_channel where is_enabled` — en az 1 aktif kanal var mı?
3. Collector log'unda `Gunluk rapor uretiliyor...` görünüyor mu?
4. Saat doğru mu? UTC saat config'de.
5. `select * from ops.report_history order by generated_at desc limit 5` — son raporlar ne durumda?

### "Rapor gönderildi ama mail ulaşmadı"

`ops.report_history.recipients_json` alanına bak — hangi kanal `failed` durumuna düşmüş? `error_message` alanında ilk hata var. SMTP/Telegram/Webhook config'i kontrol et.

### Rapor saatini değiştirdim ama çalışmıyor

JobOrchestrator config'i her cycle (her 5 saniyede) okur — restart gerektirmez. Ama gün bazlı idempotency guard restart'ta sıfırlanır; saat değişikliği aynı gün içinde **bugün için zaten gönderilmişse** etkilemez (yarın etkili olur).

### Tek seferlik manuel rapor göndermek istiyorum

Şu an UI'da manuel tetik yok. DB'de:
```sql
-- Idempotency flag'i resetlemek collector restart gerektirir.
-- Pratik: collector container restart (./pgstat restart collector)
-- saatin doğru olduğu pencerede başlatılırsa rapor üretilir.
```
İleriye dönük: `POST /api/reports/trigger?type=daily` endpoint eklenebilir.

---

## İlgili Dosyalar

**Backend (Java)**
- `collector/.../scheduler/JobOrchestrator.java` — saat tetiği + idempotency
- `collector/.../service/ReportGenerator.java` — rapor üretimi + DB kayıt
- `collector/.../service/PurgeEvaluator.java` — retention cleanup
- `collector/.../repository/ReportConfigRepository.java` — config okuma
- `collector/.../repository/ReportHistoryRepository.java` — history yazma + purge
- `collector/.../service/NotificationService.java` — `sendReport()` (mevcut)

**API (Node)**
- `api/src/routes/reports.ts` — REST uçları
- `api/src/index.ts` — route mount

**UI (React)**
- `ui/src/pages/Settings.tsx` — `ReportsTab` (config formu)
- `ui/src/pages/ReportHistory.tsx` — tarihçe + detay modal
- `ui/src/components/layout/Sidebar.tsx` — Raporlar linki
- `ui/src/App.tsx` — `/reports/history` route

**DB**
- `db/migrations/V045__report_config_and_history.sql`
