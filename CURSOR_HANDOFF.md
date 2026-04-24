# Cursor Handoff — Adaptive Alerting

**Son güncelleme:** 2026-04-24 (audit sonrası yeniden yazıldı)
**Durum:** Phase 1 çıktıları var ama eksik/tutarsız. Phase 2'ye başlamadan önce A-D aksiyonları yapılmalı.

---

## 1. Gerçek Durum (kod üzerinden doğrulandı)

### Mevcut olanlar

| Katman   | Dosya                                                                        | Ne var?                                                                                          |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| DB       | `db/migrations/V018__adaptive_alerting.sql`                                  | 9 yeni tablo + 3 fonksiyon (`invalidate_baseline`, `is_alert_snoozed`, `is_in_maintenance`) + `alert_rule`'a 7 yeni kolon. |
| API      | `api/src/routes/adaptiveAlerting.ts`                                         | 18 endpoint. JWT korumalı, `/api/adaptive-alerting` altında mount edilmiş.                       |
| UI       | `ui/src/pages/AdaptiveAlerting.tsx`                                          | 5 tab iskeleti. **Sadece `OverviewPanel` yarım çalışıyor. Diğer 4 panel boş placeholder.**         |
| Router   | `ui/src/App.tsx`, `ui/src/components/layout/Sidebar.tsx`                     | `/settings/adaptive-alerting` route'u + menü linki kayıtlı.                                      |
| Collector| —                                                                            | **Henüz hiçbir şey yok.** `BaselineCalculator` ve adaptive evaluation kodu yazılmadı.            |

### Yok olanlar

- Baseline hesaplayan servis (Java).
- `AlertRuleEvaluator`'a adaptive branch.
- Notification gönderici (Java).
- UI'da: snooze formu, maintenance formu, channel formu, baseline görüntüleme. (Tümü placeholder.)
- `V019__alert_notifications.sql` (Phase 4 için, henüz gerekli değil).

---

## 2. Tespit Edilen Tutarsızlıklar ve Kararlar

Phase 1 kodu tasarım dokümanına tam uymuyor. Phase 2'ye geçmeden önce aşağıdaki **A-D aksiyonları** tamamlanmalı.

### A) `scope` kolonu iki kez, farklı değer kümesiyle tanımlanmış

- **V011 + V016** (mevcut, kullanımda): `alert_rule.scope ∈ {'all_instances', 'specific_instance', 'service_group'}`. UI ve API bu değerleri kullanıyor (`api/src/routes/alertRules.ts`'de `VALID_SCOPES`).
- **V018** (yeni): `scope ∈ {'single_instance', 'all_instances', 'instance_group'}` + `check_scope_consistency` constraint.

**Çakışma:** V018'in `add column if not exists` satırı eski kolon üstüne check constraint eklemeye çalışır ve mevcut `'specific_instance'` ve `'service_group'` değerleri constraint'i fail eder.

**Karar (değiştirilmesi yasak ana kural: mevcut davranışı koru):**
- Kod bazda `specific_instance` ismi kalacak (`single_instance` yerine).
- `service_group` korunacak.
- `instance_group` yeni değer olarak eklenecek (instance_group_id FK ile).

**Aksiyon A1 — V018'i patchle:** `scope` için constraint ve default kısmı değiştirilmeli. Aşağıda düzeltilmiş SQL bloğu — V018'i açıp bulup değiştir:

```sql
-- YANLIŞ (mevcut V018):
alter table control.alert_rule
  add column if not exists scope text default 'single_instance'
    check (scope in ('single_instance', 'all_instances', 'instance_group')),

-- DOĞRU:
alter table control.alert_rule
  add column if not exists instance_group_id integer references control.instance_group(group_id);
-- scope zaten V011'de eklenmiş; sadece 'instance_group' değerini genişletmek gerekiyor

-- scope constraint'ini yeniden kur (eski değerleri koru + yeni ekle):
alter table control.alert_rule drop constraint if exists alert_rule_scope_check;
alter table control.alert_rule drop constraint if exists ck_alert_rule_scope;
alter table control.alert_rule
  add constraint ck_alert_rule_scope
  check (scope in ('all_instances', 'specific_instance', 'service_group', 'instance_group'));

-- check_scope_consistency constraint'ini specific_instance adıyla düzelt:
alter table control.alert_rule drop constraint if exists check_scope_consistency;
alter table control.alert_rule
  add constraint check_scope_consistency check (
    (scope = 'specific_instance' and instance_pk is not null and instance_group_id is null) or
    (scope = 'all_instances'     and instance_pk is null     and instance_group_id is null) or
    (scope = 'service_group'     and service_group is not null) or
    (scope = 'instance_group'    and instance_pk is null     and instance_group_id is not null)
  );
```

### B) `use_adaptive` ile `alert_category` aynı şeyi anlatıyor

- **V016** (mevcut): `alert_rule.alert_category ∈ {'smart', 'threshold'}`. UI'da "Hızlı İzleme" (smart) vs "Özel Kurallar" (threshold) tab ayrımı bunun üstüne kurulu.
- **V018** (yeni): `use_adaptive boolean default true`. Adaptive evaluator bunu okuyacak.

**Karar:** `alert_category` tek kaynak olacak. `use_adaptive`, `alert_category = 'smart'`'in alias'ı olarak türetilecek — ayrı kolon tutmuyoruz.

**Aksiyon B1 — V018'den `use_adaptive` kolonunu sil:**

```sql
-- V018 içinden ŞUNU ÇIKAR:
-- add column if not exists use_adaptive boolean default true,

-- Yerine: collector kodunda "rule.alert_category == 'smart'" olarak kontrol edilecek.
```

`absolute_warning`/`absolute_critical` kolonları da gereksiz — zaten `warning_threshold` ve `critical_threshold` kolonları V011'den beri var, aynı amaca hizmet ediyor.

**Aksiyon B2 — `absolute_warning` ve `absolute_critical` kolonlarını V018'den çıkar.** Mevcut `warning_threshold`/`critical_threshold` kullanılmaya devam edecek.

### C) API route path'leri doküman ile uyuşmuyor

Eski handoff hatalıydı. **Gerçek path'ler:**

```
POST   /api/adaptive-alerting/snooze
GET    /api/adaptive-alerting/snooze
DELETE /api/adaptive-alerting/snooze/:snooze_id

POST   /api/adaptive-alerting/maintenance-windows
GET    /api/adaptive-alerting/maintenance-windows
DELETE /api/adaptive-alerting/maintenance-windows/:window_id

POST   /api/adaptive-alerting/notification-channels
GET    /api/adaptive-alerting/notification-channels
POST   /api/adaptive-alerting/notification-channels/:channel_id/test
DELETE /api/adaptive-alerting/notification-channels/:channel_id

GET    /api/adaptive-alerting/instances/:instance_pk/baseline/:metric_key
POST   /api/adaptive-alerting/instances/:instance_pk/baseline/invalidate
GET    /api/adaptive-alerting/instances/:instance_pk/baseline/versions

POST   /api/adaptive-alerting/instance-groups
GET    /api/adaptive-alerting/instance-groups
POST   /api/adaptive-alerting/instance-groups/:group_id/members
DELETE /api/adaptive-alerting/instance-groups/:group_id/members/:instance_pk
```

**Aksiyon C1 — UI panellerini yazarken sadece bu path'leri kullan.** Modal POST'ları için de aynı path'ler.

### D) Collector'da `jobs/` paketi yok

Eski handoff `collector/.../jobs/BaselineCalculationJob.java` yazıyor. **Paket yok.** Pgstat pattern'i: tüm servisler `com.pgstat.collector.service` altında `@Service`, orchestration `scheduler/JobOrchestrator` üzerinden.

**Aksiyon D1 — Yeni dosya yolu:** `collector/src/main/java/com/pgstat/collector/service/BaselineCalculator.java`. `@Scheduled` değil, `JobOrchestrator` çağıracak (gece 02:00 advisory lock'lı).

**Aksiyon D2 — Evaluation güncellemesi:** Yeni sınıf değil, **mevcut `service/AlertRuleEvaluator.java`'ya** yeni branch. `evaluate()` içinde `evalType` switch'ine `"adaptive"` case'i eklenecek. Baseline'dan (`control.metric_baseline`) eşik çekip sensitivity'ye göre karar verecek.

---

## 3. Phase 2 — Collector Entegrasyonu (öncelikli)

**Ön koşul:** A1, B1, B2 tamamlanmış olmalı (V018 patch'lenmiş).

### 2.1 BaselineCalculator servisi

**Dosya (yeni):** `collector/src/main/java/com/pgstat/collector/service/BaselineCalculator.java`
**Tetikleme:** `JobOrchestrator` içinde yeni bir metot — gece 02:00-02:10 arası advisory lock alıp `calculate()` çağırsın. (`@Scheduled(cron="0 0 2 * * *")` değil — orchestrator pattern'i.)

**Kapsam:**
1. Her aktif instance için son 28 gün verisini `agg.*_hourly` tablolarından çek.
2. Genel baseline (`hour_of_day = -1`) ve saatlik baseline (`hour_of_day = 0..23`).
3. İstatistikler: `avg`, `stddev`, `min`, `max`, `p50`, `p95`, `p99`, `sample_count`.
4. `control.metric_baseline` tablosuna UPSERT (`on conflict (instance_pk, metric_key, hour_of_day) do update`).
5. `control.instance_settings` tablosunu da güncelle (source'tan `max_connections`, `shared_buffers` vb. çek — mevcut `DiscoveryCollector.java` pattern'ine bak).

**İzlenecek metrikler (V018 aligned):**
- Cluster: `cache_hit_ratio`, `wal_bytes`, `buffers_checkpoint`, `checkpoint_write_time`.
- Activity: `active_count`, `idle_in_transaction_count`, `waiting_count`.
- Replication: `replay_lag_bytes`, `replay_lag_seconds`.
- Database: `deadlocks`, `temp_files`, `rollback_ratio`, `db_size_bytes`, `autovacuum_count`.
- Statement: `calls`, `avg_exec_time_ms`, `temp_blks_written`.
- Table: `dead_tuple_ratio`, `seq_scan`.

**SQL iskeleti (örnek, cluster için):**

```sql
insert into control.metric_baseline
  (instance_pk, metric_key, hour_of_day,
   avg_value, stddev_value, min_value, max_value,
   p50_value, p95_value, p99_value, sample_count,
   baseline_start, baseline_end, updated_at)
select
  ?  as instance_pk,
  'cache_hit_ratio' as metric_key,
  -1 as hour_of_day,  -- genel
  avg(cache_hit_ratio),
  stddev_samp(cache_hit_ratio),
  min(cache_hit_ratio),
  max(cache_hit_ratio),
  percentile_cont(0.50) within group (order by cache_hit_ratio),
  percentile_cont(0.95) within group (order by cache_hit_ratio),
  percentile_cont(0.99) within group (order by cache_hit_ratio),
  count(*),
  now() - interval '28 days',
  now(),
  now()
from agg.cluster_metric_hourly
where instance_pk = ?
  and snapshot_time >= now() - interval '28 days'
on conflict (instance_pk, metric_key, hour_of_day) do update set
  avg_value = excluded.avg_value,
  stddev_value = excluded.stddev_value,
  min_value = excluded.min_value,
  max_value = excluded.max_value,
  p50_value = excluded.p50_value,
  p95_value = excluded.p95_value,
  p99_value = excluded.p99_value,
  sample_count = excluded.sample_count,
  baseline_start = excluded.baseline_start,
  baseline_end = excluded.baseline_end,
  updated_at = now();

-- Saatlik versiyon:
-- group by extract(hour from snapshot_time), hour_of_day = extract(hour from snapshot_time)
```

### 2.2 Query baseline (opsiyonel, aynı job içinde)

Top 100 `queryid` için `control.metric_baseline_query`'ye yaz. Kaynak: `fact.pgss_delta` + `dim.statement_series`. Erken sürüm için atlanabilir — cluster/activity/db baseline'ı ilk olarak bitsin.

### 2.3 AlertRuleEvaluator'a adaptive branch

**Dosya (düzenleme):** `collector/src/main/java/com/pgstat/collector/service/AlertRuleEvaluator.java`

**Eklenecek:** `evaluateAdaptive(rule)` metodu. `evaluateRule` switch'ine `case "adaptive" -> evaluateAdaptive(rule);` eklenmeli. Ayrıca `alert_category='smart'` VE `evaluation_type='threshold'` kombinasyonu da adaptive'e yönlendirilmeli (kullanıcı eşik girmediyse).

**Akış:**
```java
private void evaluateAdaptive(Map<String,Object> rule) {
    long ruleId = toLong(rule.get("rule_id"));
    String metricKey = (String) rule.get("metric_name");
    String sensitivity = (String) rule.get("sensitivity"); // low/medium/high
    int hour = LocalDateTime.now().getHour();

    for (target : loadTargetInstances(rule)) {
        // 1) Snooze / maintenance kontrolü
        if (isSnoozed(ruleId, instancePk, metricKey)) continue;
        if (isInMaintenance(instancePk)) continue;

        // 2) Saatlik baseline'ı çek, yoksa genel baseline
        BigDecimal avg, stddev;
        var hourly = jdbc.query("... where hour_of_day = ?", hour);
        var row = hourly.orElseGet(() -> jdbc.query("... where hour_of_day = -1"));
        if (row == null) continue; // baseline yok, atla

        // 3) Eşik hesapla
        BigDecimal multiplier = switch (sensitivity) {
            case "low"    -> new BigDecimal("3.0");
            case "medium" -> new BigDecimal("2.0");
            case "high"   -> new BigDecimal("1.5");
            default       -> new BigDecimal("2.0");
        };
        BigDecimal threshold = avg.add(stddev.multiply(multiplier));

        // 4) Mevcut değeri çek, karşılaştır
        BigDecimal current = queryCurrentValue(metricKey, instancePk);
        if (current.compareTo(threshold) > 0) {
            alertRepo.upsertWithSeverity(..., "warning", ..., ruleId);
        }
    }
}

private boolean isSnoozed(long ruleId, long pk, String metric) {
    return jdbc.queryForObject(
        "select control.is_alert_snoozed(?, ?, ?, null)",
        Boolean.class, ruleId, pk, metric);
}

private boolean isInMaintenance(long pk) {
    return jdbc.queryForObject(
        "select control.is_in_maintenance(?)",
        Boolean.class, pk);
}
```

**Önemli:** `is_alert_snoozed` ve `is_in_maintenance` fonksiyonları V018'de tanımlı — yeniden yazmaya gerek yok, sadece çağır.

---

## 4. Phase 3 — UI Panelleri (orta öncelik)

**Her panel için ortak pattern:**
1. `useQuery` ile `GET` listesi.
2. Liste render, boş state.
3. "+ Ekle" modal'ı (mevcut `RuleFormModal` pattern'ini kopyala — `AlertRules.tsx`).
4. `useMutation` ile `POST`, success'te `invalidateQueries` + toast.
5. Her satırda "Sil" butonu → `DELETE` mutation.

### 3.1 SnoozePanel
- **List:** `GET /api/adaptive-alerting/snooze` → `{snooze_id, rule_id, rule_name, instance_pk, instance_name, metric_key, snooze_until, snooze_reason, created_by}[]`.
- **Countdown:** `snooze_until - now()` dakika cinsinden göster. Bittiyse otomatik kaldır.
- **Form alanları:** rule dropdown (`GET /api/alert-rules`), instance dropdown (`GET /api/instances`), süre (5dk/1sa/4sa/1gün/3gün/1hafta presetleri), `snooze_reason` textarea.
- **POST body:** `{rule_id, instance_pk, metric_key?, snooze_until, snooze_reason}`.

### 3.2 MaintenancePanel
- **List:** `GET /api/adaptive-alerting/maintenance-windows`.
- **Form alanları:** `window_name`, `description`, `instance_pks` (multi-select), `day_of_week` (checkbox 7 gün), `start_time`/`end_time` (time picker), `timezone` (default `Europe/Istanbul`), `suppress_all_alerts` toggle, `suppress_severity` (multi: warning/critical).
- **POST body aynen.**

### 3.3 ChannelsPanel
- **List:** `GET /api/adaptive-alerting/notification-channels`.
- **Form — tip'e göre dinamik:**
  - `email`: `config = {recipients: [], smtp_host, smtp_port, from_address}`.
  - `slack`: `config = {webhook_url, channel, username?}`.
  - `pagerduty`: `config = {integration_key}`.
  - `teams`: `config = {webhook_url}`.
  - `webhook`: `config = {url, method, headers, body_template}`.
- **Test butonu:** `POST /api/adaptive-alerting/notification-channels/:id/test`.

### 3.4 BaselinesPanel
- Instance seçildikten sonra, her metrik için kart:
  - `GET /api/adaptive-alerting/instances/:pk/baseline/:metric_key` → `{hourly: [{hour_of_day, avg_value, p95_value, ...}], general: {...}}` gibi.
  - Kartta: genel `avg ± stddev`, saatlik mini sparkline (24 saat `avg_value`), `updated_at`.
  - "Baseline'ı Sıfırla" butonu → `POST .../invalidate` (sebep prompt'u).

### 3.5 OverviewPanel
- Şu anda hard-coded. Gerçek veri:
  - Aktif baseline sayısı: `GET /api/adaptive-alerting/baseline-count` (YENI ENDPOINT EKLE — basit `select count(distinct instance_pk) from control.metric_baseline`).
  - Aktif snooze sayısı: `GET /api/adaptive-alerting/snooze` → length.
  - Aktif maintenance sayısı: aynı yaklaşım.

---

## 5. Phase 4 — Notification Sender (düşük öncelik)

Ancak Phase 2 + 3 bittikten sonra.

**Dosya (yeni):** `collector/src/main/java/com/pgstat/collector/service/NotificationService.java`.
**Tetikleme:** `AlertService.createAlert` çağrıldıktan sonra event yayınla veya aynı method'un sonunda çağır.

**Adımlar:**
1. `control.notification_channel where is_enabled = true` çek.
2. Filtreler: `min_severity`, `instance_pks`, `metric_categories`.
3. Eşleşenlere gönder:
   - Email: Spring Mail Starter (`pom.xml`'e ekle).
   - Slack/Teams/Webhook: `java.net.http.HttpClient` — minimal, harici dependency yok.
   - PagerDuty: Events API v2 (basit JSON POST).
4. `V019__alert_notifications.sql` migration'ı yaz (handoff'un eski hali referans olarak kullanılabilir — şema doğru). Her gönderim için kayıt.
5. Retry: aynı migration'da `retry_count` kolonu var. Scheduled retry servisi — 5dk arayla `failed` olanları tekrar dene, max 3.

---

## 6. Aksiyon Listesi (bitirme sırası)

- [ ] **A1** V018'de `scope` constraint'ini mevcut değerlerle uyumlu hale getir.
- [ ] **B1** V018'den `use_adaptive` kolonunu kaldır.
- [ ] **B2** V018'den `absolute_warning`/`absolute_critical` kolonlarını kaldır.
- [ ] **C1** UI formları yazılırken yukarıdaki doğru API path'lerini kullan.
- [ ] **D1** `BaselineCalculator.java` → `service/` altına yaz, `JobOrchestrator`'dan çağır.
- [ ] **D2** `AlertRuleEvaluator.evaluateAdaptive()` metodu ekle, switch'e case ekle.
- [ ] **3.1-3.5** UI panellerini gerçek API ile çalışır hale getir (her birinin POST/GET/DELETE'i).
- [ ] **4** Notification service + V019 migration (erteleme kabul).

**Phase 2 bitirme kriteri:** Bir instance'ı 28 gün izledikten sonra UI'da baseline kartı görünür, `alert_category='smart'` kural adaptive olarak tetiklenir, snooze/maintenance doğru şekilde alert oluşmasını engeller.

---

## 7. Önemli Dosyalar (referans)

```
db/migrations/V018__adaptive_alerting.sql      [düzeltilecek: A1, B1, B2]
db/migrations/V019__alert_notifications.sql    [yazılacak: Phase 4]

api/src/routes/adaptiveAlerting.ts             [mevcut, 18 endpoint tamam]
api/src/routes/alertRules.ts                   [smart/threshold pattern referansı]
api/src/index.ts                               [route kayıtları]

ui/src/pages/AdaptiveAlerting.tsx              [düzeltilecek: Phase 3 tüm panel]
ui/src/pages/AlertRules.tsx                    [form pattern referansı — kopyala]

collector/src/main/java/com/pgstat/collector/service/AlertRuleEvaluator.java  [düzeltilecek: D2]
collector/src/main/java/com/pgstat/collector/service/BaselineCalculator.java  [yazılacak: D1]
collector/src/main/java/com/pgstat/collector/scheduler/JobOrchestrator.java   [baseline çağrısı eklenecek]
```

---

## 8. Hızlı Komutlar

```bash
# Migration durumu
PGPASSWORD=$PGSTAT_DB_PASSWORD psql -h $PGSTAT_DB_HOST -p $PGSTAT_DB_PORT -U $PGSTAT_DB_USER -d $PGSTAT_DB_NAME \
  -c "\d control.metric_baseline" -c "\d control.alert_rule"

# V018 çakışma testi (local)
cd db && ./apply.sh

# API sağlık
curl -s localhost:3001/api/adaptive-alerting/snooze -H "Authorization: Bearer $TOKEN" | jq

# UI
http://localhost:3000/settings/adaptive-alerting
```
