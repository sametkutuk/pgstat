# Requirements Document

## Introduction

Per-table XID/MXID freeze izleme. Collector kaynak DB'lerden pg_class relfrozenxid age'i toplar, central DB'de fact.pg_table_freeze_snapshot'ta saklar. Toplama sikligi schedule_profile'dan, saklama suresi retention_policy'den kullanici tarafindan ayarlanir. Insights'a "Freeze" sekmesi eklenir: DB seviyesi liste + per-table drill-down + kopyalanabilir VACUUM komutu.

## Glossary

- **Collector**: Java tabanli veri toplama servisi (collector/)
- **Central_DB**: pgstat'in kendi PostgreSQL veritabani (migration'lar burada)
- **PartitionManager**: Gunluk partition olusturma servisi
- **NightlySnapshotCollector**: Gece + periyodik snapshot toplayan sinif
- **JobOrchestrator**: Zamanlama ve tetikleme servisi
- **PurgeEvaluator**: Retention bazli veri temizleme servisi
- **InstanceInfo**: Instance bilgisi modeli (schedule_profile alanlari dahil)
- **InsightsAPI**: Express.js API endpoint'leri (api/src/routes/insights.ts)
- **InsightsUI**: React Insights sayfasi (ui/src/pages/Insights.tsx)
- **SettingsUI**: React Settings sayfasi (ui/src/pages/Settings.tsx)
- **freeze_max_age**: autovacuum_freeze_max_age GUC degeri (default 200000000)

## Requirements

### Requirement 1: Migration - Fact Tablosu

**User Story:** As a DBA, I want per-table freeze data stored in a partitioned fact table, so that historical XID/MXID age data is available for analysis.

#### Acceptance Criteria

1. THE Central_DB SHALL have a table `fact.pg_table_freeze_snapshot` with columns: snapshot_ts, instance_pk, dbid, schemaname, relname, relkind, relfrozenxid_age, relminmxid_age, relpages, last_autovacuum_at
2. THE table SHALL be partitioned by range on snapshot_ts
3. THE migration SHALL create initial partitions (past 1 + future 14 days) using the V039 do-block pattern
4. THE migration SHALL create an index on (instance_pk, snapshot_ts desc) where relfrozenxid_age is not null
5. THE migration SHALL be idempotent (create if not exists)

### Requirement 2: Migration - Retention ve Schedule Kolonlari

**User Story:** As an admin, I want configurable retention and collection interval for per-table freeze data, so that storage and collection frequency can be tuned per-environment.

#### Acceptance Criteria

1. THE Central_DB SHALL have column `control.retention_policy.table_freeze_retention_days` (integer, not null, default 90)
2. THE Central_DB SHALL have column `control.schedule_profile.table_freeze_interval_seconds` (integer, not null, default 21600)
3. THE schedule_profile column SHALL have a check constraint enforcing minimum 3600 seconds
4. THE migration SHALL use `add column if not exists` for idempotency
5. THE migration SHALL use a guarded do-block for the check constraint (if not exists pattern)

### Requirement 3: PartitionManager Kaydi

**User Story:** As a system operator, I want the PartitionManager to automatically create daily partitions for the new table, so that partition management is automatic.

#### Acceptance Criteria

1. WHEN PartitionManager runs, THE PartitionManager SHALL include `fact.pg_table_freeze_snapshot` in daily partition creation

### Requirement 4: Collector Per-Table Freeze Toplama

**User Story:** As a DBA, I want the collector to periodically gather per-table relfrozenxid age from monitored instances, so that I can track which tables are closest to wraparound.

#### Acceptance Criteria

1. WHEN collectTableFreeze is called for a database, THE Collector SHALL query pg_class joined with pg_namespace for relkind in ('r','m') excluding system schemas
2. THE Collector SHALL insert results into fact.pg_table_freeze_snapshot with on conflict do nothing
3. THE Collector SHALL expose a public collectTableFreezeOnly method that iterates all active databases for an instance
4. WHEN collectAll runs (nightly), THE Collector SHALL also call collectTableFreeze per database

### Requirement 5: JobOrchestrator Schedule Tetigi

**User Story:** As a system operator, I want per-table freeze collection to run at the interval specified in schedule_profile, so that collection frequency is configurable per-instance.

#### Acceptance Criteria

1. WHEN the configured table_freeze_interval_seconds has elapsed since last collection for an instance, THE JobOrchestrator SHALL trigger collectTableFreezeOnly for that instance
2. THE JobOrchestrator SHALL track last collection time per instance (not global)
3. THE InstanceInfo model SHALL include tableFreezeIntervalSeconds field from schedule_profile

### Requirement 6: PurgeEvaluator Temizleme

**User Story:** As a system operator, I want old per-table freeze data purged based on retention_policy, so that storage does not grow unbounded.

#### Acceptance Criteria

1. WHEN PurgeEvaluator runs, THE PurgeEvaluator SHALL drop partitions of fact.pg_table_freeze_snapshot older than the maximum table_freeze_retention_days
2. THE PurgeEvaluator SHALL perform instance-based batched delete for the interval between hard-drop boundary and instance-specific retention

### Requirement 7: API Freeze Endpoint'leri

**User Story:** As a frontend developer, I want API endpoints for freeze data, so that the Insights UI can display DB-level and table-level freeze information.

#### Acceptance Criteria

1. WHEN GET /insights/freeze/databases is called, THE InsightsAPI SHALL return DB-level freeze summary with xid_pct and mxid_pct calculated against autovacuum_freeze_max_age
2. WHEN GET /insights/freeze/tables is called with instancePk and dbid, THE InsightsAPI SHALL return per-table freeze data from the latest snapshot, ordered by relfrozenxid_age desc
3. THE InsightsAPI SHALL use parameterized queries for all user-supplied values
4. THE InsightsAPI SHALL list columns explicitly (no select *)

### Requirement 8: UI Freeze Sekmesi

**User Story:** As a DBA, I want a Freeze tab in Insights showing DB-level and per-table XID/MXID age, so that I can identify tables at risk of wraparound and generate VACUUM commands.

#### Acceptance Criteria

1. WHEN the user navigates to Insights Freeze tab, THE InsightsUI SHALL display a DB-level table with XID Age, XID %, MXID Age, MXID % columns
2. WHEN a DB row is clicked, THE InsightsUI SHALL display a per-table drill-down panel with relfrozenxid_age, xid_pct, size, and a copyable VACUUM command
3. THE InsightsUI SHALL color-code XID% values: >=95 red, >=80 amber, below green
4. THE InsightsUI SHALL provide a copy button for the VACUUM command using the existing clipboard fallback pattern

### Requirement 9: Settings UI Retention ve Schedule Alanlari

**User Story:** As an admin, I want to configure per-table freeze retention and collection interval from the Settings UI, so that I can tune these per-environment.

#### Acceptance Criteria

1. WHEN the RetentionTab is displayed, THE SettingsUI SHALL show a "Table Freeze Saklama (gun)" field with default 90
2. WHEN the ScheduleTab is displayed, THE SettingsUI SHALL show a "Table Freeze Aralik (saniye)" field with default 21600, minimum 3600
3. WHEN the retention form is saved, THE API SHALL persist table_freeze_retention_days to control.retention_policy
4. WHEN the schedule form is saved, THE API SHALL persist table_freeze_interval_seconds to control.schedule_profile
