# pgstat Kullanıcı Tanımlı Alert Kuralları — Tasarım Dokümanı

## Amaç

Kullanıcının pgstat UI'dan alert kuralları tanımlayabilmesi. Hardcoded eşikler yerine esnek, yönetilebilir bir alert mekanizması.

Mevcut durum: Replication lag > 100MB, lock bekleme > 5dk gibi sabit kurallar kod içinde. Kullanıcı değiştiremiyor, yeni kural ekleyemiyor.

Hedef: UI'dan "Eğer X metriği Y eşiğini aşarsa Z seviyesinde alert oluştur" tanımlanabilsin.

---

## Veri Modeli

### control.alert_rule

```sql
create table if not exists control.alert_rule (
  rule_id bigint generated always as identity primary key,
  rule_name text not null,
  description text null,

  -- Ne ölçülüyor
  metric_type text not null,
  -- cluster_metric   → fact.pg_cluster_delta (bgwriter, wal, checkpointer)
  -- io_metric        → fact.pg_io_stat_delta
  -- database_metric  → fact.pg_database_delta
  -- statement_metric → fact.pgss_delta / agg.pgss_hourly
  -- table_metric     → fact.pg_table_stat_delta
  -- index_metric     → fact.pg_index_stat_delta
  -- activity_metric  → fact.pg_activity_snapshot (count bazlı)
  -- replication_metric → fact.pg_replication_snapshot

  metric_name text not null,
  -- Örnekler:
  --   cluster_metric:  "cache_hit_ratio", "wal_bytes", "checkpoints_timed"
  --   database_metric: "xact_commit", "deadlocks", "temp_files", "blk_read_time"
  --   statement_metric: "total_exec_time_ms", "calls", "rows", "temp_blks_written"
  --   table_metric:    "seq_scan", "n_dead_tup_ratio", "n_tup_ins"
  --   activity_metric: "active_count", "idle_in_transaction_count", "waiting_count"
  --   replication_metric: "replay_lag_bytes", "replay_lag_seconds"

  -- Kapsam
  scope text not null default 'all_instances',
  -- all_instances    → tüm aktif instance'larda değerlendirilir
  -- specific_instance → sadece belirtilen instance'da
  -- service_group    → belirtilen service_group'taki instance'larda

  instance_pk bigint null references control.instance_inventory(instance_pk),
  -- scope = specific_instance ise zorunlu, diğerlerinde null

  service_group text null,
  -- scope = service_group ise zorunlu

  -- Koşul
  condition_operator text not null default '>',
  -- ">", "<", ">=", "<=", "="

  warning_threshold numeric null,
  critical_threshold numeric null,
  -- İkisinden en az biri dolu olmalı
  -- warning_threshold = 90, critical_threshold = 95 gibi

  -- Değerlendirme
  evaluation_window_minutes integer not null default 5,
  -- Son N dakikadaki veri üzerinden değerlendirilir

  aggregation text not null default 'avg',
  -- avg  → penceredeki ortalama
  -- sum  → penceredeki toplam
  -- max  → penceredeki maksimum
  -- min  → penceredeki minimum
  -- last → son değer
  -- count → satır sayısı (activity_metric için)

  -- Davranış
  is_enabled boolean not null default true,
  cooldown_minutes integer not null default 15,
  -- Aynı kural için tekrar alert açmadan önce bekleme süresi
  auto_resolve boolean not null default true,
  -- Eşik altına düşünce otomatik resolve

  -- Meta
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ck_alert_rule_metric_type check (
    metric_type in ('cluster_metric', 'io_metric', 'database_metric',
                    'statement_metric', 'table_metric', 'index_metric',
                    'activity_metric', 'replication_metric')
  ),
  constraint ck_alert_rule_scope check (
    scope in ('all_instances', 'specific_instance', 'service_group')
  ),
  constraint ck_alert_rule_operator check (
    condition_operator in ('>', '<', '>=', '<=', '=')
  ),
  constraint ck_alert_rule_aggregation check (
    aggregation in ('avg', 'sum', 'max', 'min', 'last', 'count')
  ),
  constraint ck_alert_rule_threshold check (
    warning_threshold is not null or critical_threshold is not null
  ),
  constraint ck_alert_rule_window check (evaluation_window_minutes > 0),
  constraint ck_alert_rule_cooldown check (cooldown_minutes >= 0)
);

create index if not exists ix_alert_rule_enabled
  on control.alert_rule (is_enabled, metric_type)
  where is_enabled;
```

### control.alert_rule_last_eval

Kural başına son değerlendirme durumu (cooldown takibi için).

```sql
create table if not exists control.alert_rule_last_eval (
  rule_id bigint not null references control.alert_rule(rule_id) on delete cascade,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  last_evaluated_at timestamptz not null default now(),
  last_alert_at timestamptz null,
  last_value numeric null,
  current_severity text null, -- null = normal, 'warning', 'critical'
  primary key (rule_id, instance_pk)
);
```

---

## Hazır Kural Template'leri

Seed data olarak eklenir. Kullanıcı isterse aktifleştirir, eşikleri değiştirir.

### Cluster Sağlık

| Template | metric_type | metric_name | Operatör | Warning | Critical | Aggregation | Window |
|---|---|---|---|---|---|---|---|
| Cache Hit Ratio Düşük | cluster_metric | cache_hit_ratio | < | 95 | 90 | avg | 5dk |
| WAL Üretimi Yüksek | cluster_metric | wal_bytes | > | 500000000 | 2000000000 | sum | 5dk |
| Checkpoint Süresi Uzun | cluster_metric | checkpoint_write_time | > | 30000 | 60000 | max | 15dk |

### Bağlantı ve Kilitleme

| Template | metric_type | metric_name | Operatör | Warning | Critical | Aggregation | Window |
|---|---|---|---|---|---|---|---|
| Aktif Bağlantı Yüksek | activity_metric | active_count | > | 50 | 100 | last | 1dk |
| Idle in TX Bağlantı | activity_metric | idle_in_transaction_count | > | 5 | 20 | last | 1dk |
| Lock Bekleme | activity_metric | waiting_count | > | 3 | 10 | last | 1dk |

### Replikasyon

| Template | metric_type | metric_name | Operatör | Warning | Critical | Aggregation | Window |
|---|---|---|---|---|---|---|---|
| Replay Lag (byte) | replication_metric | replay_lag_bytes | > | 52428800 | 524288000 | max | 1dk |
| Replay Lag (süre) | replication_metric | replay_lag_seconds | > | 60 | 300 | max | 1dk |

### Database

| Template | metric_type | metric_name | Operatör | Warning | Critical | Aggregation | Window |
|---|---|---|---|---|---|---|---|
| Deadlock Sayısı | database_metric | deadlocks | > | 1 | 10 | sum | 15dk |
| Temp Dosya Kullanımı | database_metric | temp_files | > | 50 | 500 | sum | 15dk |
| Rollback Oranı Yüksek | database_metric | rollback_ratio | > | 5 | 20 | avg | 15dk |

### Statement

| Template | metric_type | metric_name | Operatör | Warning | Critical | Aggregation | Window |
|---|---|---|---|---|---|---|---|
| Yavaş Sorgu (ort) | statement_metric | avg_exec_time_ms | > | 1000 | 5000 | max | 5dk |
| Çok Temp Kullanan Sorgu | statement_metric | temp_blks_written | > | 10000 | 100000 | sum | 15dk |

### Tablo

| Template | metric_type | metric_name | Operatör | Warning | Critical | Aggregation | Window |
|---|---|---|---|---|---|---|---|
| Dead Tuple Oranı | table_metric | dead_tuple_ratio | > | 20 | 50 | last | 30dk |
| Sequential Scan Yoğun | table_metric | seq_scan | > | 10000 | 100000 | sum | 60dk |

---

## Hesaplanan (Derived) Metrikler

Bazı metrikler doğrudan tabloda yok, hesaplanması gerekiyor:

| Metrik Adı | Hesaplama | Kaynak |
|---|---|---|
| `cache_hit_ratio` | `100.0 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0)` | `fact.pg_database_delta` |
| `rollback_ratio` | `100.0 * sum(xact_rollback) / nullif(sum(xact_commit + xact_rollback), 0)` | `fact.pg_database_delta` |
| `dead_tuple_ratio` | `100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0)` | `fact.pg_table_stat_delta` |
| `avg_exec_time_ms` | `total_exec_time_ms / nullif(calls, 0)` | `fact.pgss_delta` |
| `replay_lag_seconds` | `extract(epoch from replay_lag)` | `fact.pg_replication_snapshot` |
| `active_count` | `count(*) where state = 'active'` | `fact.pg_activity_snapshot` |
| `idle_in_transaction_count` | `count(*) where state = 'idle in transaction'` | `fact.pg_activity_snapshot` |
| `waiting_count` | `count(*) where wait_event_type is not null` | `fact.pg_activity_snapshot` |

---

## Collector Tarafı — AlertRuleEvaluator

### Çalışma Zamanı

Rollup job içinde, saatlik rollup'tan sonra çalışır. Veya ayrı bir `alert_eval` job olarak her 60 saniyede.

### Değerlendirme Akışı

```
1. Aktif kuralları oku (is_enabled = true)
2. Her kural için:
   a. Scope'a göre hedef instance listesini belirle
   b. Her instance için:
      - Cooldown kontrolü (last_alert_at + cooldown > now ise atla)
      - evaluation_window içindeki veriyi sorgula
      - aggregation uygula (avg/sum/max/min/last/count)
      - Eşik karşılaştır:
        * critical_threshold aşıldı → severity = critical
        * warning_threshold aşıldı → severity = warning
        * Hiçbiri aşılmadı → normal
      - Durum değişikliği varsa:
        * normal → warning/critical: ops.alert upsert
        * warning → critical: severity güncelle
        * warning/critical → normal: auto_resolve ise resolve et
      - last_eval tablosunu güncelle
```

### Örnek Değerlendirme SQL'leri

**Cache Hit Ratio (son 5dk ortalaması):**
```sql
select
  d.instance_pk,
  100.0 * sum(d.blks_hit_delta)::numeric
    / nullif(sum(d.blks_hit_delta + d.blks_read_delta), 0) as value
from fact.pg_database_delta d
where d.sample_ts >= now() - interval '5 minutes'
group by d.instance_pk;
```

**Replication Lag Bytes (son 1dk max):**
```sql
select
  r.instance_pk,
  max(r.replay_lag_bytes) as value
from fact.pg_replication_snapshot r
where r.snapshot_ts >= now() - interval '1 minute'
group by r.instance_pk;
```

**Active Connection Count (son snapshot):**
```sql
select
  a.instance_pk,
  count(*) as value
from fact.pg_activity_snapshot a
where a.snapshot_ts = (
  select max(snapshot_ts) from fact.pg_activity_snapshot
  where instance_pk = a.instance_pk
)
and a.state = 'active'
group by a.instance_pk;
```

**Dead Tuple Ratio (son 30dk, tablo bazlı):**
```sql
select
  t.instance_pk,
  t.relid,
  100.0 * max(t.n_dead_tup_estimate)::numeric
    / nullif(max(t.n_live_tup_estimate + t.n_dead_tup_estimate), 0) as value
from fact.pg_table_stat_delta t
where t.sample_ts >= now() - interval '30 minutes'
group by t.instance_pk, t.relid;
```

---

## API Endpoint'leri

### Alert Kuralları CRUD

```
GET    /api/alert-rules              — Kural listesi (filtrelenebilir)
GET    /api/alert-rules/templates    — Hazır template'ler
POST   /api/alert-rules              — Yeni kural oluştur
PUT    /api/alert-rules/:id          — Kural güncelle
DELETE /api/alert-rules/:id          — Kural sil
PATCH  /api/alert-rules/:id/toggle   — Aktif/pasif toggle
POST   /api/alert-rules/from-template — Template'den kural oluştur
```

### Kural Oluşturma Request Body

```json
{
  "rule_name": "Production Cache Hit Düşük",
  "description": "Cache hit ratio %95 altına düşerse uyar",
  "metric_type": "cluster_metric",
  "metric_name": "cache_hit_ratio",
  "scope": "service_group",
  "service_group": "production",
  "condition_operator": "<",
  "warning_threshold": 95,
  "critical_threshold": 90,
  "evaluation_window_minutes": 5,
  "aggregation": "avg",
  "cooldown_minutes": 15,
  "auto_resolve": true
}
```

### Template'den Oluşturma

```json
{
  "template_name": "cache_hit_ratio",
  "warning_threshold": 97,
  "critical_threshold": 93,
  "scope": "all_instances"
}
```

---

## UI Ekranı — Alert Kuralları

### Kural Listesi (Ayarlar > Alert Kuralları)

| Kolon | Açıklama |
|---|---|
| Durum | Aktif/Pasif toggle |
| Kural Adı | Tıklanabilir — düzenleme açar |
| Metrik | metric_type + metric_name (okunur format) |
| Kapsam | Tüm / Instance adı / Service group |
| Warning Eşik | Sarı badge |
| Critical Eşik | Kırmızı badge |
| Pencere | "Son 5dk ort." gibi okunur format |
| Son Değerlendirme | last_evaluated_at |
| Aktif Alert | Bu kuraldan kaç açık alert var |

### Kural Ekleme/Düzenleme Formu

**Adım 1 — Metrik Seçimi:**
- Dropdown: Cluster / Database / Statement / Tablo / Index / Bağlantı / Replikasyon
- Seçime göre ikinci dropdown: cache_hit_ratio, wal_bytes, deadlocks, vb.
- Açıklama metni: "Bu metrik şunu ölçer: ..."

**Adım 2 — Kapsam:**
- Radio: Tüm Instance'lar / Belirli Instance / Service Group
- Seçime göre dropdown

**Adım 3 — Koşul:**
- Operatör: > < >= <= =
- Warning eşik (opsiyonel)
- Critical eşik (opsiyonel)
- Değerlendirme penceresi: 1dk, 5dk, 15dk, 30dk, 1saat
- Toplama: Ortalama, Toplam, Maksimum, Minimum, Son Değer

**Adım 4 — Davranış:**
- Cooldown süresi: 5dk, 15dk, 30dk, 1saat
- Otomatik çözüm: Evet/Hayır

### Hazır Template Galerisi

Kartlar halinde:
- "Cache Hit Ratio" — Cluster sağlığı
- "Replication Lag" — Replikasyon takibi
- "Deadlock Tespiti" — Kilitleme sorunları
- "Yavaş Sorgu" — Performans
- "Dead Tuple" — Vacuum ihtiyacı
- "Bağlantı Kullanımı" — Kapasite

Her kart: açıklama + "Aktifleştir" butonu → eşikleri özelleştirme formu açılır.

---

## Alert Oluşturma Akışı

```
Kullanıcı UI'dan kural tanımlar
        │
        ▼
control.alert_rule tablosuna INSERT
        │
        ▼
Collector her 60 saniyede:
  1. SELECT * FROM control.alert_rule WHERE is_enabled
  2. Her kural için hedef instance'ları belirle
  3. Metriği sorgula (evaluation_window içinde)
  4. Aggregation uygula
  5. Eşik karşılaştır
        │
        ├── Eşik aşıldı → ops.alert UPSERT
        │     alert_key = "rule:{rule_id}:instance:{instance_pk}"
        │     alert_code = "user_defined_rule"
        │     severity = warning veya critical
        │     title = rule_name
        │     message = "{metric_name} = {value} (eşik: {threshold})"
        │
        └── Eşik altında + auto_resolve → ops.alert RESOLVE
              Mevcut açık alert varsa kapat
```

---

## Bildirim Kanalları (V2)

İlk fazda sadece UI'da alert listesi. İkinci fazda:

### control.notification_channel

```sql
create table control.notification_channel (
  channel_id bigint generated always as identity primary key,
  channel_type text not null, -- 'email', 'webhook', 'slack'
  channel_name text not null,
  config_json jsonb not null,
  -- email:   {"to": ["dba@company.com"], "smtp_host": "..."}
  -- webhook: {"url": "https://hooks.slack.com/...", "method": "POST"}
  -- slack:   {"webhook_url": "...", "channel": "#alerts"}
  is_enabled boolean not null default true
);
```

### control.alert_rule_notification

```sql
create table control.alert_rule_notification (
  rule_id bigint references control.alert_rule(rule_id),
  channel_id bigint references control.notification_channel(channel_id),
  min_severity text not null default 'warning',
  primary key (rule_id, channel_id)
);
```

Kural tanımlarken: "Bu kural tetiklendiğinde şu kanallara bildir" seçimi.

---

## Implementasyon Sırası

1. **DB Migration:** `control.alert_rule` + `control.alert_rule_last_eval` tabloları
2. **Seed Data:** Hazır template'ler (is_enabled = false olarak)
3. **API:** CRUD endpoint'leri + template endpoint
4. **Collector:** `AlertRuleEvaluator` servisi — kuralları oku, değerlendir, alert yaz
5. **UI:** Alert Kuralları sayfası — liste, form, template galerisi
6. **V2:** Bildirim kanalları (email, webhook, Slack)
