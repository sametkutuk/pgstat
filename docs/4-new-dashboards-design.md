# 4 Yeni Dashboard Tasarım Dokümanı

## Genel Bakış

Fleet seviyesinde 4 yeni Grafana dashboard ekleniyor. Tüm dashboard'lar `$service_group` değişkeni ile filtrelenir (multi-select, includeAll). Instance bazlı drill-down için tablo panellerinde data link bulunur.

## Ortak Özellikler

| Özellik | Değer |
|---------|-------|
| schemaVersion | 39 |
| version | 1 |
| datasource | `{"type": "postgres", "uid": "pgstat"}` |
| Variable | `$service_group` (multi, includeAll) |
| Time range | now-24h → now |
| Service group filter | `and (i.service_group in ($service_group) or 'All' in ($service_group) or i.service_group is null)` |
| Data link | Instance Detail'a git: `/grafana/d/pgstat-instance-detail?var-instance=${__data.fields.instance_pk}&from=${__from}&to=${__to}` |

## Dashboard 1: Index Health Overview (`pgstat-index-health`)

**Amaç:** Eksik index, kullanılmayan index tespiti — fleet genelinde karşılaştırma.

**Paneller:**
- Stat: Toplam distinct index sayısı (pg_index_stat_delta, son 1 saat)
- Stat: Kullanılmayan index sayısı (30 gün idx_scan=0, boyut > 100MB)
- Stat: Missing index suspect sayısı (seq_scan/idx_scan > 100, seq_tup_read > 100k)
- Table: Top 30 Missing Index Suspect (seq_scans desc)
- Table: Top 30 Unused Index (index_size_bytes desc)

**Kaynak tablolar:** `fact.pg_index_stat_delta`, `fact.pg_table_stat_delta`, `fact.pg_relation_size_snapshot`, `control.instance_inventory`

## Dashboard 2: Memory & Sort Health (`pgstat-memory-sort`)

**Amaç:** Temp file üretimi, work_mem analizi, en çok temp üreten sorgular.

**Paneller:**
- Stat: Toplam temp files (24h)
- Stat: Toplam temp bytes (24h)
- Stat: Ortalama work_mem
- Table: Per-instance temp file pattern
- Table: Top 30 temp producing queries
- Table: work_mem suggestion

**Kaynak tablolar:** `fact.pg_database_delta`, `fact.pgss_delta`, `fact.pg_settings_snapshot`, `control.instance_inventory`

## Dashboard 3: Connection Lifecycle (`pgstat-connection-lifecycle`)

**Amaç:** Aktif/idle/idle_in_tx oranları, bağlantı profili, pool sağlığı.

**Paneller:**
- Stat: Toplam aktif bağlantı (son snapshot)
- Stat: Toplam idle in transaction (son snapshot)
- Stat: Idle in tx oranı (%)
- Table: Per-instance connection profile
- Table: Top idle in tx backends
- Timeseries: Fleet state distribution (stacked area)

**Kaynak tablolar:** `fact.pg_activity_snapshot`, `fact.pg_database_delta`, `control.instance_inventory`

## Dashboard 4: Wraparound & Vacuum Freeze (`pgstat-wraparound`)

**Amaç:** XID yaşı, wraparound riski, autovacuum freeze takibi.

**Paneller:**
- Stat: Max XID age (fleet) — threshold: green < 200M, yellow < 500M, red ≥ 500M
- Stat: DB sayısı (age > 200M)
- Stat: autovacuum_freeze_max_age değeri
- Table: Per-DB wraparound risk
- Table: Autovacuum activity (7d)

**Kaynak tablolar:** `fact.pg_database_freeze_snapshot`, `fact.pg_settings_snapshot`, `fact.pg_table_stat_delta`, `control.instance_inventory`
