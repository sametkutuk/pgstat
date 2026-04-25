# Grafana Entegrasyonu — Tasarım

> pgstat central database (PG17, port 5417) Grafana'nın PostgreSQL data source'u olarak bağlanır.
> Bu doküman hangi dashboard'ların hangi panel/sorgu/değişkenlerle kurulacağını tanımlar.
> Hedef: pgstat UI'ya alternatif/tamamlayıcı, derin drill-down + uzun zaman serisi analizi.

## İçindekiler

1. [Strateji](#strateji)
2. [Data source kurulumu](#data-source-kurulumu)
3. [Ortak değişkenler (variables)](#ortak-değişkenler)
4. [Dashboard listesi](#dashboard-listesi)
5. [Dashboard detayları](#dashboard-detayları)
6. [Alerting entegrasyonu](#alerting-entegrasyonu)
7. [Performans / cache stratejisi](#performans--cache-stratejisi)
8. [Roadmap & implementation sırası](#roadmap)

---

## Strateji

**pgstat UI vs Grafana iş bölümü:**

| İhtiyaç | Araç |
|---|---|
| Anlık operasyonel görünüm, alert yönetimi, instance CRUD | pgstat UI |
| Uzun zaman serisi trend, ad-hoc sorgu, tek ekranda 50+ instance karşılaştırması | Grafana |
| SLO dashboard, NOC ekranı, TV monitor | Grafana |
| Alert ack/snooze, kural editleme | pgstat UI |
| Multi-team self-service (her takım kendi DB'si için kendi dashboard'ı) | Grafana |

**İlke:** pgstat UI canlı + interaktif, Grafana tarihsel + dağıtım için. Aynı veriyi farklı amaca sunuyorlar; veri çoğaltma yok.

---

## Data source kurulumu

### 1. PostgreSQL data source

```yaml
name: pgstat-central
type: postgres
host: pgstat-host:5417
database: pgstat
user: pgstat_grafana_ro     # read-only kullanıcı (oluşturulacak)
sslMode: prefer
postgresVersion: 1700
timescaledb: false
```

### 2. Read-only kullanıcı (central DB'de)

```sql
create user pgstat_grafana_ro with password 'xxx';
grant connect on database pgstat to pgstat_grafana_ro;
grant usage on schema fact, agg, dim, control, ops to pgstat_grafana_ro;
grant select on all tables in schema fact, agg, dim, control, ops to pgstat_grafana_ro;
alter default privileges in schema fact, agg, dim, control, ops
  grant select on tables to pgstat_grafana_ro;

-- Statement timeout — Grafana'nın yavaş query'lerle DB'yi kilitlememesi için
alter user pgstat_grafana_ro set statement_timeout = '30s';
alter user pgstat_grafana_ro set lock_timeout = '5s';
```

### 3. Provisioning (opsiyonel)

Grafana provisioning klasörüne `datasources/pgstat.yml` ve `dashboards/pgstat-*.json` koyularak Git'ten yönetilebilir. Versiyon kontrolü için tercih edilen yol.

---

## Ortak değişkenler

Tüm dashboard'lar aynı variable seti üzerinde çalışır:

| Variable | Type | Query | Notlar |
|---|---|---|---|
| `$instance` | Query (multi) | `select display_name from control.instance_inventory where is_active order by display_name` | Multi-select, "All" izinli |
| `$instance_pk` | Query (multi, hidden) | `select instance_pk from control.instance_inventory where display_name in ($instance)` | Sorgularda kullanılır |
| `$database` | Query (multi) | `select distinct datname from dim.database_ref where instance_pk in ($instance_pk)` | DB-level paneller için |
| `$service_group` | Query (multi) | `select distinct service_group from control.instance_inventory where service_group is not null` | Takım/ürün filtreleme |
| `$interval` | Interval | `1m,5m,15m,1h,6h,24h` | Time bucket boyutu |

**Time range:** Grafana'nın native `$__timeFrom()` / `$__timeTo()` makroları + `$__timeFilter(column)` kullanılır.

---

## Dashboard listesi

| # | Dashboard | Hedef Kitle | Ana Tablolar |
|---|---|---|---|
| 1 | **Cluster Overview** | DBA, NOC | `pg_cluster_delta`, `pg_activity_snapshot` |
| 2 | **Instance Detail** | DBA (drill-down) | tüm fact.* |
| 3 | **Top Queries** | App dev, DBA | `pgss_delta`, `agg.pgss_hourly`, `agg.pgss_daily` |
| 4 | **Replication & WAL** | DBA, SRE | `pg_replication_snapshot`, `pg_wal_snapshot`, `pg_replication_slot_snapshot`, `pg_archiver_snapshot` |
| 5 | **Locks & Activity** | App dev, DBA | `pg_lock_snapshot`, `pg_activity_snapshot`, `pg_progress_snapshot` |
| 6 | **I/O & Buffers** (PG16+) | DBA | `pg_io_stat_delta`, `pg_cluster_delta` |
| 7 | **Vacuum & Bloat** | DBA | `pg_table_stat_delta`, `pg_progress_snapshot` |
| 8 | **Database & Tables** | App dev | `pg_database_delta`, `pg_table_stat_delta`, `pg_index_stat_delta` |
| 9 | **Alerts & SLO** | NOC, yönetim | `ops.alert`, `ops.notification_log` |
| 10 | **Capacity & Trends** | Kapasite planlama | `agg.pgss_daily`, `pg_database_delta` |

---

## Dashboard detayları

### 1. Cluster Overview

**Amaç:** Tek ekranda tüm instance'ların sağlığı. NOC ekranında 7/24 açık kalır.

| Panel | Tip | Açıklama |
|---|---|---|
| Active Instances | Stat | Toplam aktif instance (current/total) |
| Total TPS | Time series (sum) | Tüm cluster üzerinde xact_commit + xact_rollback delta'sı |
| Cache Hit Ratio | Time series (avg) | Per instance, eşik çizgisi 95% |
| Active Connections | Time series (max) | Per instance, max_connections eşik çizgisi |
| WAL Generated | Time series (sum) | wal_bytes/sec |
| Open Alerts | Stat | Severity bazlı sayım (critical/warning/info) |
| Deadlocks Last 24h | Bar chart | Per instance |
| Slowest Top 10 Queries | Table | Cross-instance |

**Örnek sorgu — Cache Hit Ratio:**
```sql
select
  $__timeGroupAlias(sample_ts, $interval),
  i.display_name as metric,
  avg(d.cache_hit_ratio) as value
from fact.pg_cluster_delta d
join control.instance_inventory i on i.instance_pk = d.instance_pk
where $__timeFilter(sample_ts)
  and i.instance_pk in ($instance_pk)
group by 1, i.display_name
order by 1
```

**Örnek sorgu — Open Alerts (severity bazlı):**
```sql
select severity, count(*)
from ops.alert
where status = 'open'
  and ($__timeFilter(opened_at) or opened_at > now() - interval '24 hours')
group by severity
```

---

### 2. Instance Detail (drill-down)

**Amaç:** Tek instance için 360° görünüm. Cluster Overview'dan tıklanır (`$instance` tek seçim).

Variable: sadece `$instance_pk` (single-select).

**Row 1: Sağlık özeti** — connections, cache hit, TPS, WAL/s (4 stat panel + sparkline)
**Row 2: Aktivite** — active vs idle vs idle_in_tx breakdown (stacked area), wait events (heatmap)
**Row 3: I/O** — read time vs write time, blks_read vs blks_hit, temp files
**Row 4: Replication** — replay_lag bytes/seconds (varsa standby ile)
**Row 5: pg_stat_io tabloları (PG16+)** — backend_type × context heatmap
**Row 6: Bloat & Vacuum** — top 10 dead_tup, son vacuum/analyze zamanları

**Örnek — wait_event heatmap:**
```sql
select
  $__timeGroupAlias(sample_ts, $interval),
  wait_event_type as metric,
  count(*) as value
from fact.pg_activity_snapshot
where $__timeFilter(sample_ts)
  and instance_pk = ($instance_pk)
  and state = 'active'
  and wait_event_type is not null
group by 1, wait_event_type
order by 1
```

---

### 3. Top Queries

**Amaç:** pg_stat_statements üzerinden en pahalı sorguları bulma + trend.

| Panel | Tip | Detay |
|---|---|---|
| Top 20 by total exec time | Table | drill-down: sorguya tıklayınca query_text + per-instance breakdown |
| Total exec time over time | Time series | top 5 queryid stacked |
| Calls vs Mean Time scatter | Scatter | Yavaş+az çağrılan vs hızlı+çok çağrılan |
| WAL bytes per query | Bar | top 10 |
| Temp blocks per query | Bar | top 10 (memory pressure) |
| Cache miss rate per query | Bar | shared_blks_read / (read+hit) |

**Örnek sorgu — Top 20:**
```sql
select
  qt.query_text,
  ss.queryid,
  i.display_name as instance,
  dbr.datname as database,
  sum(d.calls_delta) as calls,
  round(sum(d.total_exec_time_ms_delta)::numeric, 0) as total_ms,
  round(sum(d.total_exec_time_ms_delta)::numeric / nullif(sum(d.calls_delta),0), 2) as mean_ms,
  sum(d.rows_delta) as rows_returned,
  pg_size_pretty(sum(d.shared_blks_read_delta) * 8192) as disk_read,
  pg_size_pretty(sum(d.wal_bytes_delta)) as wal
from fact.pgss_delta d
join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
left join dim.query_text qt on qt.query_text_id = ss.query_text_id
join control.instance_inventory i on i.instance_pk = d.instance_pk
left join dim.database_ref dbr on dbr.instance_pk = ss.instance_pk and dbr.dbid = ss.dbid
where $__timeFilter(d.sample_ts)
  and d.instance_pk in ($instance_pk)
group by 1, 2, 3, 4
order by total_ms desc
limit 20
```

**Uzun zaman aralığı için `agg.pgss_hourly` / `agg.pgss_daily` kullan** (bkz. cache stratejisi).

---

### 4. Replication & WAL

| Panel | Tip | Notlar |
|---|---|---|
| Replication lag (bytes) | Time series | Per primary→standby, eşik 100MB warning / 1GB critical |
| Replication lag (seconds) | Time series | replay_lag_seconds |
| Sync state per standby | Stat | sync vs async vs potential |
| WAL generation rate | Time series | wal_bytes/s |
| Archiver lag | Time series | Last archived vs current LSN |
| Replication slots — wal_status | Table | slot_name, type, active, wal_status, restart_lsn lag |
| Logical decoding spill bytes | Time series | spill_bytes per slot |
| Recovery prefetch hit ratio | Stat | Standby için (PG15+) |

**Örnek — slot lag:**
```sql
select
  i.display_name as instance,
  s.slot_name,
  s.slot_type,
  s.active,
  s.wal_status,
  pg_size_pretty(s.slot_lag_bytes) as lag,
  pg_size_pretty(s.safe_wal_size) as safe_wal
from fact.pg_replication_slot_snapshot s
join control.instance_inventory i on i.instance_pk = s.instance_pk
where s.sample_ts = (
  select max(sample_ts) from fact.pg_replication_slot_snapshot
  where instance_pk = s.instance_pk
)
order by s.slot_lag_bytes desc nulls last
```

---

### 5. Locks & Activity

| Panel | Tip | Detay |
|---|---|---|
| Active sessions over time | Time series | per-instance, breakdown by state |
| Idle in transaction (>5min) | Stat | uyarı için |
| Blocking chains | Table | snapshot — kim kimi bekliyor |
| Lock wait duration histogram | Heatmap | wait süreleri |
| Long running queries | Table | duration > 1min |
| Vacuum/Analyze in progress | Table | pg_stat_progress_* |

**Örnek — blocking chains:**
```sql
select
  i.display_name as instance,
  l.pid as blocked_pid,
  l.locktype,
  l.mode,
  array_to_string(l.blocked_by_pids, ',') as blocked_by,
  extract(epoch from now() - l.waitstart) as wait_seconds
from fact.pg_lock_snapshot l
join control.instance_inventory i on i.instance_pk = l.instance_pk
where l.sample_ts = (
  select max(sample_ts) from fact.pg_lock_snapshot where instance_pk = l.instance_pk
)
  and l.granted = false
  and array_length(l.blocked_by_pids, 1) > 0
order by wait_seconds desc
```

---

### 6. I/O & Buffers (PG16+)

`pg_stat_io` view'ından gelen veri (`fact.pg_io_stat_delta`).

| Panel | Tip |
|---|---|
| Reads per backend_type × context | Heatmap |
| Read time vs Write time | Time series (stacked) |
| Hit ratio per backend_type | Time series |
| Evictions / Reuses | Time series |
| Fsync count + duration | Time series |
| Top backends by extends | Bar |

**Örnek — backend_type heatmap:**
```sql
select
  $__timeGroupAlias(sample_ts, $interval),
  backend_type || ' / ' || context as metric,
  sum(reads_delta) as value
from fact.pg_io_stat_delta
where $__timeFilter(sample_ts)
  and instance_pk in ($instance_pk)
group by 1, backend_type, context
order by 1
```

---

### 7. Vacuum & Bloat

| Panel | Tip | Detay |
|---|---|---|
| Tables with most dead_tup | Table | top 50, click → table detail |
| Dead tuple ratio | Bar | n_dead_tup / n_live_tup |
| Last autovacuum/autoanalyze | Table | timestamp delta |
| Vacuum in progress | Stat | progress % |
| Vacuum frequency per table | Heatmap | day × table |
| Tables never autovacuumed | Table | autovacuum_count = 0 |

**Örnek — bloat candidates:**
```sql
select
  i.display_name as instance,
  rr.schemaname || '.' || rr.relname as relation,
  t.n_live_tup,
  t.n_dead_tup,
  round(100.0 * t.n_dead_tup / nullif(t.n_live_tup + t.n_dead_tup, 0), 1) as dead_pct,
  t.last_autovacuum,
  t.autovacuum_count
from fact.pg_table_stat_delta t
join dim.relation_ref rr on rr.relation_id = t.relation_id
join control.instance_inventory i on i.instance_pk = t.instance_pk
where t.sample_ts = (select max(sample_ts) from fact.pg_table_stat_delta where instance_pk = t.instance_pk)
  and t.n_dead_tup > 10000
  and (t.n_live_tup + t.n_dead_tup) > 0
order by dead_pct desc
limit 50
```

---

### 8. Database & Tables

| Panel | Tip |
|---|---|
| Database sizes | Bar | per-DB current size |
| Per-DB transaction rate | Time series | xact_commit + xact_rollback / s |
| Tup_returned vs tup_fetched | Time series | seq scan verimliliği |
| Index usage ratio | Stat | idx_scan / (idx_scan + seq_scan) |
| Top growing tables | Table | son 7 günün diff'i |
| Conflict count (standby) | Time series | per database |

---

### 9. Alerts & SLO

| Panel | Tip | Detay |
|---|---|---|
| Current open alerts | Table | with severity color, ack button (link) |
| Alert rate over time | Time series | per severity |
| MTTA (mean time to ack) | Stat | rolling 7-day |
| MTTR (mean time to resolve) | Stat | rolling 7-day |
| Top noisy alert codes | Bar | en çok tetiklenen 10 |
| Notification success rate | Stat | from `ops.notification_log` |
| Per-channel delivery breakdown | Pie | email/teams/telegram/webhook |

**Örnek — MTTA:**
```sql
select
  avg(extract(epoch from acknowledged_at - opened_at) / 60)::numeric(10,1) as mtta_minutes
from ops.alert
where acknowledged_at is not null
  and $__timeFilter(opened_at)
```

**Örnek — alert rate:**
```sql
select
  $__timeGroupAlias(opened_at, $interval),
  severity as metric,
  count(*) as value
from ops.alert
where $__timeFilter(opened_at)
group by 1, severity
order by 1
```

---

### 10. Capacity & Trends

**Amaç:** Kapasite planlaması — "3 ay sonra ne olacak?"

| Panel | Tip | Detay |
|---|---|---|
| Daily query volume trend | Time series (90d) | `agg.pgss_daily` |
| WAL daily growth | Time series (90d) | linear regression line |
| Connection count trend (P95) | Time series (90d) | percentile |
| Database growth rate | Time series (90d) | per DB GB/day |
| Slow query count trend | Time series | mean_ms > 1000 sayısı |
| Forecast: connections in 30 days | Stat | linear extrapolation |

**Örnek — daily query volume:**
```sql
select
  bucket_date as time,
  i.display_name as metric,
  sum(calls_total) as value
from agg.pgss_daily a
join control.instance_inventory i on i.instance_pk = a.instance_pk
where bucket_date >= now() - interval '90 days'
  and i.instance_pk in ($instance_pk)
group by 1, i.display_name
order by 1
```

---

## Alerting entegrasyonu

İki seçenek var, hibrit önerilir.

### Seçenek A — pgstat alert'lerini Grafana'da göster
- Grafana → Data source query: `select * from ops.alert where status = 'open'`
- Grafana panel → table view, severity renklendirme
- Avantaj: tek pane'de hem metrik hem alert
- Dezavantaj: alerts state management hâlâ pgstat'ta

### Seçenek B — Grafana Unified Alerting kuralları
- Grafana kendi alert kurallarını PG sorgusu üzerinden tanımlar
- Ayrı bir alert sistemi kurulur
- **Önerilmez** — pgstat zaten alert sistemine sahip, çift yönetim yaratır

### Seçenek C (önerilen) — Hibrit
- pgstat ana alert kaynağı (kural değerlendirme + bildirim)
- Grafana **gösterim katmanı** olarak alert tablosunu okur
- Grafana'da alert'e tıklayınca pgstat UI'ya derin link (`/alerts/:id`)

```
Cluster Overview Dashboard
   ↓ click "Open Alerts: 3 critical"
   → pgstat UI /alerts?status=open&severity=critical
```

Implementation: panel → "Data links" → `${__data.fields.alert_id}` ile pgstat URL'sine redirect.

---

## Performans / cache stratejisi

### Tablo seçimi by time range

| Time range | Sorgu için kullanılacak tablo |
|---|---|
| Son 6 saat | `fact.*_delta` / `*_snapshot` (raw) |
| Son 7 gün | `fact.*` halen OK (1m–5m granularity) |
| 7g–3 ay | `agg.pgss_hourly` (statement metrikleri için) |
| 3 ay+ | `agg.pgss_daily` |

Diğer fact tablolar için henüz hourly/daily aggregate yok — bunlar için Grafana sorgusu `time_bucket` veya `date_trunc` ile aggregate eder; long range yavaşlar. **Sonraki migration aday: V031 — `agg.cluster_hourly`, `agg.activity_hourly`** (Grafana ihtiyacı doğrultusunda).

### Query optimization checklist

- [ ] Tüm time-series sorgularında `$__timeFilter(sample_ts)` zorunlu (partition pruning için)
- [ ] `instance_pk in (...)` her zaman ilk filter — partition + index avantajı
- [ ] `$__timeGroupAlias()` kullan; manuel `date_trunc` Grafana'nın interval optimizasyonunu kırar
- [ ] Top-N panellerde `limit` mutlaka var (50'den fazla seri renderlamaz)
- [ ] Variable refresh: "On Time Range Change" yerine "On Dashboard Load" (gereksiz polling önler)

### Materialized view önerisi (PG17 + REFRESH MATERIALIZED VIEW CONCURRENTLY)

Sık sorgulanan top-N için:

```sql
create materialized view if not exists agg.mv_top_queries_24h as
select
  d.instance_pk, ss.queryid,
  sum(d.calls_delta) as calls,
  sum(d.total_exec_time_ms_delta) as total_ms,
  sum(d.rows_delta) as rows
from fact.pgss_delta d
join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
where d.sample_ts > now() - interval '24 hours'
group by d.instance_pk, ss.queryid;

create unique index on agg.mv_top_queries_24h (instance_pk, queryid);

-- Cron veya pg_cron ile 5 dakikada bir refresh:
refresh materialized view concurrently agg.mv_top_queries_24h;
```

---

## Roadmap

### Phase G1 — Temel altyapı (1 gün)
- [ ] `pgstat_grafana_ro` kullanıcısı + grant'ler (V031 migration)
- [ ] Grafana data source provisioning YAML
- [ ] Test query'leri ile bağlantı doğrulama

### Phase G2 — Operational dashboardlar (2-3 gün)
- [ ] Cluster Overview
- [ ] Instance Detail
- [ ] Alerts & SLO

### Phase G3 — DBA dashboardlar (2-3 gün)
- [ ] Top Queries
- [ ] Locks & Activity
- [ ] Replication & WAL

### Phase G4 — İleri analitik (2 gün)
- [ ] I/O & Buffers
- [ ] Vacuum & Bloat
- [ ] Database & Tables

### Phase G5 — Capacity (1 gün)
- [ ] Capacity & Trends dashboard
- [ ] V031: agg.cluster_hourly, agg.activity_hourly migration (long-range query hızlandırma)

### Phase G6 — Polish
- [ ] Dashboard JSON'larını repo'ya `grafana/dashboards/` altında commit
- [ ] Provisioning ile docker-compose'a dahil
- [ ] README — Grafana kurulum talimatları
- [ ] pgstat UI'da bazı panellere "Grafana'da aç" linki

---

## Açık sorular / kararlar

1. **Grafana versiyon:** En az 10.x (Postgres data source unified alerting + dashboard variables güçlü)
2. **Kimlik:** SSO/LDAP entegrasyonu yapılacak mı? İlk fazda admin/viewer yeter
3. **Public/Anonymous mode:** İç ağda viewer için anonymous read OK mi?
4. **Annotations:** Maintenance window'ları (`control.maintenance_window`) Grafana annotation olarak göster — bakım sırasında metrik dalgalanmaları context'lensin
5. **Multi-tenancy:** Service group bazlı dashboard izolasyonu gerekiyor mu? (her takım sadece kendi DB'sini görsün)

---

## Referanslar

- pgstat data model: [docs/adaptive-alerting-design.md](adaptive-alerting-design.md)
- Migration listesi: [db/migrations/](../db/migrations/)
- Grafana PostgreSQL data source: https://grafana.com/docs/grafana/latest/datasources/postgres/
