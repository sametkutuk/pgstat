# Tasarım: Sistem Alert'leri Yönetim Sayfası (v2 — düzeltmeli)

## Problem

Sistem alert'leri (connection_failure, high_temp_files, index_unused vb.) şu an:
- Hardcoded çalışıyor, kapatılamıyor
- Eşikleri değiştirilemiyor (örn. temp_files > 100 sabit)
- Instance bazlı override yok (test instance'ında gereksiz alert spam)
- Kullanıcı hangi sistem alert'lerinin aktif olduğunu göremez

## Çözüm

### A. Veri Modeli — V042

```sql
create table if not exists control.system_alert_config (
  config_id       serial primary key,
  alert_code      text not null,
  instance_pk     bigint null,             -- null = global default, değer = instance override
  is_enabled      boolean not null default true,
  threshold_value numeric null,            -- alert tipine özel eşik (null = eşik yok)
  cooldown_minutes integer not null default 60, -- bildirim tekrar süresi (alert tetikleme değil)
  updated_at      timestamptz not null default now(),
  updated_by      text null
);

-- NULL-safe unique: global (instance_pk IS NULL) ve instance bazlı ayrı
create unique index if not exists uq_system_alert_config_global
  on control.system_alert_config (alert_code) where instance_pk is null;
create unique index if not exists uq_system_alert_config_instance
  on control.system_alert_config (alert_code, instance_pk) where instance_pk is not null;
```

**Neden `UNIQUE (alert_code, instance_pk)` değil:**
PostgreSQL'de NULL değerler unique constraint'te eşleşmez — aynı alert_code için birden fazla `instance_pk = NULL` satır eklenebilir. Partial unique index bu sorunu çözer.

### B. Cooldown Mantığı (Düzeltme #1)

Cooldown = **bildirim gönderim aralığı**, alert tetikleme değil.

```
Alert tetiklenir → alertRepo.upsert() → occurrence_count++, last_seen_at güncellenir (HER ZAMAN)
  └── NotificationService.notifyIfNeeded()
        └── Son bildirim ne zaman gönderildi? (ops.notification_log)
              └── cooldown_minutes geçmediyse → bildirim GÖNDERME
              └── geçtiyse → bildirim gönder
```

Mevcut NotificationService spam koruması: "sadece yeni alert veya severity yükseldiğinde bildirim gönder". Buna ek olarak `cooldown_minutes` config'den okunur — kullanıcı "bu alert beni 4 saatte bir rahatsız etsin" diyebilir.

### C. Eşik Metadata (Düzeltme #2)

Her alert kodunun eşik bilgisi hardcoded metadata olarak tanımlanır. Eşiği olmayan alert'ler için UI'da eşik alanı gizlenir.

```java
// SystemAlertMetadata.java — statik bilgi, DB'de değil
public static final Map<String, AlertMeta> METADATA = Map.ofEntries(
  // Eşiği olmayan alert'ler (ya tetiklenir ya tetiklenmez)
  entry("connection_failure",      new AlertMeta("Bağlantı Hatası", "connectivity", null, null)),
  entry("authentication_failure",  new AlertMeta("Auth Hatası", "connectivity", null, null)),
  entry("permission_denied",       new AlertMeta("Yetki Hatası", "connectivity", null, null)),
  entry("extension_missing",       new AlertMeta("Extension Eksik", "connectivity", null, null)),
  entry("secret_ref_error",        new AlertMeta("Secret Hatası", "connectivity", null, null)),
  entry("bootstrap_failed",        new AlertMeta("Bootstrap Hatası", "connectivity", null, null)),
  entry("stale_data",              new AlertMeta("Veri Toplama Durdu", "collection", null, null)),
  entry("stats_reset_detected",    new AlertMeta("Stats Reset", "collection", null, null)),

  // Eşikli alert'ler
  entry("high_connection_usage",   new AlertMeta("Bağlantı Doluyor", "performance", "percent", "Bağlantı kullanım oranı (%)")),
  entry("long_running_query",      new AlertMeta("Uzun Sorgu", "performance", "seconds", "Sorgu süresi (saniye)")),
  entry("lock_contention",         new AlertMeta("Kilit Bekleme", "performance", null, null)),
  entry("high_temp_files",         new AlertMeta("Temp File Yüksek", "performance", "count", "Temp file sayısı/saat")),
  entry("idle_in_tx_time_high",    new AlertMeta("Idle in Tx Yüksek", "performance", "percent", "Idle in tx oranı (%)")),
  entry("high_bloat_ratio",        new AlertMeta("Bloat Yüksek", "index_table", "percent", "Dead tuple oranı (%)")),
  entry("index_suspect_missing",   new AlertMeta("Index Gerekiyor", "index_table", "ratio", "Seq/Idx scan oranı (×)")),
  entry("index_unused",            new AlertMeta("Kullanılmayan Index", "index_table", null, null)),
  entry("index_invalid",           new AlertMeta("Invalid Index", "index_table", null, null)),
  entry("high_temp_files_daily",   new AlertMeta("Günlük Temp File", "performance", "count", "Temp file sayısı/24s")),
  entry("high_temp_sqls_daily",    new AlertMeta("Temp-heavy SQL", "performance", "count", "100MB+ temp yazan SQL sayısı/24s")),
  entry("replication_lag",         new AlertMeta("Replikasyon Gecikmesi", "replication", "MB", "Max lag (MB)")),
  entry("replication_slot_inactive", new AlertMeta("Inactive Slot", "replication", "MB", "Min slot lag (MB)")),

  // Job alert'leri — instance bazlı DEĞİL (Düzeltme #4)
  entry("job_partial_failure",     new AlertMeta("Job Kısmen Başarısız", "job", null, null)),
  entry("job_failed",              new AlertMeta("Job Başarısız", "job", null, null)),
  entry("advisory_lock_skip",      new AlertMeta("Lock Skip", "job", null, null))
);
```

### D. Job Alert'leri Instance Bazlı Değil (Düzeltme #4)

Job alert'leri (job_failed, job_partial_failure, advisory_lock_skip) instance seviyesinde değil, job seviyesinde tetiklenir. Bu alert'ler için:
- Instance override butonu UI'da **gösterilmez**
- Config'de sadece global toggle ve cooldown ayarlanabilir
- `category = "job"` olanlar ayrı grupta gösterilir

### E. Config Okuma — SystemAlertConfigCache

```java
@Service
public class SystemAlertConfigCache {
    // 60 saniyede bir DB'den yenilenen in-memory cache
    private volatile Map<String, ConfigEntry> globalConfigs = Map.of();
    private volatile Map<String, Map<Long, ConfigEntry>> instanceOverrides = Map.of();

    @Scheduled(fixedDelay = 60_000)
    public void reload() { ... }

    /** Alert aktif mi? Öncelik: instance override > global > default (true) */
    public boolean isEnabled(String alertCode, Long instancePk) {
        // 1. Instance override var mı?
        if (instancePk != null) {
            var overrides = instanceOverrides.get(alertCode);
            if (overrides != null && overrides.containsKey(instancePk)) {
                return overrides.get(instancePk).isEnabled();
            }
        }
        // 2. Global config
        var global = globalConfigs.get(alertCode);
        if (global != null) return global.isEnabled();
        // 3. Default: aktif (geriye uyumlu — config tablosu boşsa bile çalışır)
        return true;
    }

    /** Eşik değeri. Öncelik: instance override > global > hardcoded default */
    public BigDecimal getThreshold(String alertCode, Long instancePk, BigDecimal hardcodedDefault) {
        if (instancePk != null) {
            var overrides = instanceOverrides.get(alertCode);
            if (overrides != null && overrides.containsKey(instancePk)) {
                var val = overrides.get(instancePk).thresholdValue();
                if (val != null) return val;
            }
        }
        var global = globalConfigs.get(alertCode);
        if (global != null && global.thresholdValue() != null) return global.thresholdValue();
        return hardcodedDefault;
    }

    /** Cooldown (bildirim tekrar süresi). Aynı öncelik sırası. */
    public int getCooldownMinutes(String alertCode, Long instancePk) { ... }
}
```

### F. Tüm Alert Üreticilere Config Check (Düzeltme #5)

Her alert üreten yer, alert oluşturmadan önce `configCache.isEnabled()` kontrol eder:

| Dosya | Alert Kodları | Değişiklik |
|-------|--------------|-----------|
| `ClusterCollector.java` | connection_failure, stale_data | `if (!configCache.isEnabled(code, instancePk)) return;` |
| `StatementsCollector.java` | stats_reset_detected | Aynı check |
| `BootstrapHandler.java` | bootstrap_failed, extension_missing, permission_denied, authentication_failure | Aynı check |
| `DbObjectsCollector.java` | secret_ref_error | Aynı check |
| `AlertRuleEvaluator.java` | lock_contention, high_connection_usage, long_running_query, replication_lag, high_bloat_ratio | Eşik de config'den okunur |
| `ActionableAlertEvaluator.java` | index_suspect_missing, index_unused, index_invalid, high_temp_files, high_temp_files_daily, high_temp_sqls_daily, idle_in_tx_time_high, replication_slot_inactive | Eşik de config'den okunur |
| `JobOrchestrator.java` | job_failed, job_partial_failure, advisory_lock_skip | Global toggle check (instance yok) |

**Pattern:**
```java
// Önce: (hardcoded, kapatılamaz)
alertRepo.upsert(alertKey, AlertCode.CONNECTION_FAILURE, instancePk, ...);

// Sonra: (config check ile)
if (configCache.isEnabled("connection_failure", instancePk)) {
    alertRepo.upsert(alertKey, AlertCode.CONNECTION_FAILURE, instancePk, ...);
}
```

**Eşikli alert'ler için:**
```java
// Önce: (hardcoded eşik)
if (tempFiles > 100) { ... }

// Sonra: (config'den eşik)
BigDecimal threshold = configCache.getThreshold("high_temp_files", instancePk, new BigDecimal("100"));
if (tempFiles > threshold.intValue()) { ... }
```

### G. API Endpoint'leri

```
GET  /api/system-alerts/config
  Response: [
    {
      alert_code: "high_temp_files",
      category: "performance",
      label: "Temp File Yüksek",
      threshold_unit: "count",
      threshold_description: "Temp file sayısı/saat",
      global: { is_enabled: true, threshold_value: 100, cooldown_minutes: 60 },
      overrides: [
        { instance_pk: 3, display_name: "test-instance", is_enabled: false, threshold_value: null, cooldown_minutes: 60 }
      ]
    },
    ...
  ]

PUT  /api/system-alerts/config/:alert_code
  Body: { is_enabled: true, threshold_value: 200, cooldown_minutes: 120 }
  → Global config güncelle

PUT  /api/system-alerts/config/:alert_code/instances/:instance_pk
  Body: { is_enabled: false, threshold_value: null, cooldown_minutes: 60 }
  → Instance override ekle/güncelle

DELETE /api/system-alerts/config/:alert_code/instances/:instance_pk
  → Instance override sil (global default'a dön)
```

### H. UI — Alert Kuralları Sayfasına Yeni Tab

**Tab:** "🛡️ Sistem Alert'leri"

**Kategoriler:**
| Kategori | Alert Kodları |
|----------|--------------|
| 🔌 Bağlantı | connection_failure, authentication_failure, permission_denied, extension_missing, secret_ref_error, bootstrap_failed |
| 📊 Veri Toplama | stale_data, stats_reset_detected |
| ⚡ Performans | high_temp_files, idle_in_tx_time_high, high_connection_usage, long_running_query, lock_contention |
| 🗄️ Index / Tablo | index_suspect_missing, index_unused, index_invalid, high_bloat_ratio |
| 🔄 Replikasyon | replication_lag, replication_slot_inactive |
| 🔧 Job | job_partial_failure, job_failed, advisory_lock_skip |

**Her satır:**
- Toggle (global aktif/devre dışı)
- Alert adı + açıklama
- Severity badge
- Eşik (düzenlenebilir, varsa)
- Cooldown (düzenlenebilir)
- Instance override listesi + "Override Ekle" butonu

**Override Modal:**
- Instance seçici (dropdown — sadece ready instance'lar)
- Toggle: aktif/devre dışı
- Eşik: (opsiyonel, boş = global kullan)
- Cooldown: dakika

**Job kategorisi:** Instance override butonu yok (instance bazlı değil).

### I. Uygulama Sırası

1. V042 migration (tablo + seed + partial unique index)
2. `SystemAlertConfigCache.java` (servis, 60s reload, isEnabled/getThreshold/getCooldown)
3. API endpoint'leri (4 endpoint + metadata response)
4. ActionableAlertEvaluator'a config check ekle (5 alert)
5. ClusterCollector, StatementsCollector, BootstrapHandler, DbObjectsCollector'a config check ekle
6. AlertRuleEvaluator'daki sistem alert'lerine config check ekle (lock_contention vb.)
7. JobOrchestrator'daki job alert'lerine global toggle check ekle
8. UI sayfası (AlertRules'a yeni tab + override modal)
9. NotificationService'e cooldown_minutes config entegrasyonu

### J. Risk

- **Geriye uyumluluk:** Config tablosu boşsa veya satır yoksa → `isEnabled()` true döner (mevcut davranış korunur)
- **Cache staleness:** Max 60 saniye gecikme (UI'dan kapatınca 1 dk sonra etkili)
- **Performans:** In-memory cache, her alert check'te DB sorgusu yok
- **Migration:** Seed data ON CONFLICT DO NOTHING — tekrar uygulanabilir
- **Büyük değişiklik:** 7+ Java dosyasında config check ekleniyor — dikkatli test gerekli

### K. Doğrulama Checklist

- [ ] V042 idempotent (ikinci kez hata vermez)
- [ ] `cd collector && mvn clean compile -DskipTests` → BUILD SUCCESS
- [ ] `cd api && npx tsc --noEmit` → EXIT 0
- [ ] `cd ui && npx tsc --noEmit` → EXIT 0
- [ ] API: GET /api/system-alerts/config → 18 alert kodu listelenir
- [ ] API: PUT disable high_temp_files → collector artık tetiklemiyor (60s sonra)
- [ ] API: PUT instance override → sadece o instance'ta devre dışı
- [ ] API: DELETE override → global default'a döner
- [ ] UI: toggle çalışıyor
- [ ] UI: eşik düzenlenebiliyor
- [ ] UI: override eklenebiliyor/silinebiliyor
- [ ] UI: job kategorisinde override butonu yok
- [ ] Collector: tüm alert üreticiler config check yapıyor
- [ ] Config tablosu boşken mevcut davranış korunuyor
