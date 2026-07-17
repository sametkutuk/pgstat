# Data Contract Registry

Date: 2026-07-13
Status: draft
Scope: pgstat collected data, APIs, UI, alerts, reports, and pgdbaagent evidence

Related documents:

- [pgstat Project Master Document](project-master.md)
- [Project Execution Plan](project-execution-plan.md)
- [pgstat Data Source Dictionary](pgstat-data-source-dictionary.md)
- [pgstat Telemetry Completion Roadmap](pgstat-telemetry-completion-roadmap.md)
- [Agentic DBA Platform Architecture](agentic-dba-platform-architecture.md)
- [Platform Governance And SDLC](platform-governance-and-sdlc.md)

## 1. Purpose

This registry tracks collected data fields and their downstream consumers.

The source-level inventory lives in
[pgstat Data Source Dictionary](pgstat-data-source-dictionary.md). This
registry is the field-level contract layer on top of that inventory.
The code-derived table/column/API/UI inventory is generated at
[Generated pgstat Project Inventory](generated/project-inventory.md).
The table-level lifecycle matrix is generated at
[Generated pgstat Data Lifecycle Matrix](generated/data-lifecycle-matrix.md).
The table/data-family operational contract matrix is generated at
[Generated pgstat Data Family Contracts](generated/data-family-contracts.md).
The field-level scaffold is generated at
[Generated pgstat Field Contracts](generated/field-contracts.md), and current
promotion/review gaps are generated at
[Generated pgstat Contract Review Queue](generated/contract-review-queue.md).
pgdbaagent-facing evidence, finding, recommendation, and reasoning contracts
live in [pgdbaagent Contracts](pgdbaagent-contracts.md).

It exists to prevent hidden coupling. When a field is added, changed,
deprecated, or removed, the project must know which collectors, tables, APIs,
UI components, alerts, reports, recommendations, and AI evidence packages are
affected.

Core rule:

```text
No collected field is anonymous.
Every field has an owner, lifecycle state, and consumer map.
```

## 2. Field Lifecycle

```text
proposed
-> collected
-> stored
-> exposed
-> used
-> deprecated
-> removed
```

Lifecycle meanings:

| State | Meaning |
| --- | --- |
| proposed | Field is planned but not collected |
| collected | Collector reads it from source PostgreSQL |
| stored | Field exists in fact/agg/dim/control table |
| exposed | API can return it |
| used | UI/report/alert/recommendation consumes it |
| deprecated | Field still exists but should not be used by new code |
| removed | Field no longer exists or is no longer collected |

## 3. Required Field Metadata

Every field entry must include:

| Metadata | Required | Meaning |
| --- | --- | --- |
| field_id | yes | Stable registry identifier |
| source_view | yes | PostgreSQL source view/function |
| source_column | yes | Source column or expression |
| pg_version | yes | Version availability |
| since_pg | yes | First PostgreSQL major version where the source is available |
| removed_pg | no | PostgreSQL major version where the source was removed or replaced |
| unsupported_behavior | yes | null, skip field, skip collector, or error |
| collector | yes | Collector or SQL family |
| storage_table | yes | pgstat table |
| storage_column | yes | pgstat column |
| retention_class | yes | raw, snapshot, hourly, daily, nightly, audit, alert, or custom |
| retention_policy_field | yes | `control.retention_policy` field that purges the stored data |
| rollup_policy | yes | none, hourly, daily, or custom summary path |
| semantics | yes | Meaning and units |
| aggregation | yes | snapshot, delta, sum, max, avg, derived |
| reset_behavior | yes | cumulative reset handling if applicable |
| api_consumers | yes | API routes/endpoints |
| ui_consumers | yes | UI pages/tabs/components |
| alert_consumers | yes | Alerts using this field |
| report_consumers | yes | Reports using this field |
| pgdbaagent_consumers | yes | Evidence/finding/recommendation usage |
| ai_context | yes | Whether AI evidence package may include it |
| compatibility | yes | Add/remove/backfill notes |
| owner | yes | Code owner or product owner |

## 4. Consumer Categories

Consumer map categories:

- collector SQL
- fact table
- aggregate table
- API endpoint
- UI tab/card/chart
- alert rule
- report
- evidence package
- pgdbaagent signal
- pgdbaagent finding
- recommendation
- AI context
- validation job

## 5. Add Field Checklist

Before adding a new collected field:

1. Confirm PostgreSQL version availability.
2. Check the generated data family contract and generated field contract for
   the parent field.
3. Confirm exact source column availability for every supported PostgreSQL
   version and define `unsupported_behavior`.
4. Confirm required privilege.
5. Decide snapshot vs delta semantics.
6. Add migration if storage changes.
7. Add collector SQL with null-safe and version-safe behavior.
8. Assign retention class, purge path, and rollup/no-rollup behavior.
9. Add API whitelist/ColumnRegistry if exposed.
10. Decide whether field is default UI column or optional.
11. Add report/alert/recommendation usage if needed.
12. Add evidence package usage if pgdbaagent needs it.
13. Regenerate project inventory, lifecycle matrix, data family contracts,
    field contracts, and contract review queue.
14. Add tests.
15. Update this registry.

## 6. Remove Field Checklist

Before removing or stopping collection for a field:

1. Search storage, collector, API, UI, reports, alerts, docs, pgdbaagent.
2. Check evidence package usage.
3. Check AI prompt/context usage.
4. Mark field deprecated first unless urgent.
5. Provide migration/backward compatibility notes.
6. Remove or replace every consumer.
7. Update this registry.
8. Add release note.

## 7. Registry Template

```yaml
field_id:
  lifecycle: collected|stored|exposed|used|deprecated|removed
  source:
    view: pg_stat_...
    column: ...
    pg_version: "PG..."
    since_pg: 10
    removed_pg: null
    privilege: pg_read_all_stats
  collector:
    component: collector
    sql_family: ...
    unsupported_behavior: null|skip_field|skip_collector|error
    reset_behavior: ...
  storage:
    table: fact....
    column: ...
    type: ...
    aggregation: snapshot|delta|sum|max|derived
    unit: ...
    retention_class: raw|snapshot|hourly|daily|nightly|audit|alert|custom
    retention_policy_field: ...
    rollup_policy: none|hourly|daily|custom
  consumers:
    api: []
    ui: []
    alerts: []
    reports: []
    pgdbaagent:
      evidence_packages: []
      signals: []
      findings: []
      recommendations: []
    ai_context: []
    validation: []
  compatibility:
    nullable: true
    default: null
    backfill: none
    deprecation_policy: ...
  owner: ...
  notes: ...
```

## 8. Promoted Core Field Contracts

The first manual promotion pass covers the six highest-value pgdbaagent input
families. Their fields are generated from repository schema plus maintained
contract rules in `scripts/generate-doc-inventory.mjs` and are marked as
`manual core field contract` in
[Generated pgstat Field Contracts](generated/field-contracts.md).

| Table | Fields | Source family | Contract status | Primary evidence use |
| --- | --- | --- | --- | --- |
| `fact.pgss_delta` | 52 | `pg_stat_statements(false)` plus pgss metadata | promoted | query workload, Temp Spill, WAL Spike, Cache Hit, latency |
| `fact.pg_table_stat_delta` | 41 | `pg_stat_user_tables`, `pg_statio_user_tables` | promoted | Vacuum Lag, autovacuum health, table bloat/freeze proxy |
| `fact.pg_database_delta` | 32 | `pg_stat_database` | promoted | database workload, TPS, temp, cache, sessions |
| `fact.pg_index_stat_delta` | 18 | `pg_stat_user_indexes`, `pg_statio_user_indexes`, `pg_index` | promoted | index usage, unused index risk, write overhead |
| `fact.pg_settings_snapshot` | 7 | selected `pg_settings` rows | promoted | parameter context and risk model |
| `fact.pg_lock_snapshot` | 10 | `pg_locks`, `pg_stat_activity`, `pg_blocking_pids()` | promoted | lock wait and blocker evidence |

Promotion means each field has a documented source family, source
column/expression, PostgreSQL version gate, unsupported behavior, collector job,
schedule, retention, purge owner, partition/rollup role, consumer map,
sensitivity classification, and AI-context policy in generated docs.

Exact consumer usage is still route/file-level unless a field is separately
registered below as a durable API/UI/alert/report contract.

## 9. Promoted Data-Family Contracts

Data-family promotion means the table family has reviewed operational
semantics, source family, schedule, retention, purge owner, partition/rollup
role, consumer class, sensitivity, unsupported behavior, and pgdbaagent
relevance. It does not replace field-level contracts.

### P0-001 Aggregate History Batch

The P0-001 aggregate batch promotes long-range query, table, WAL, activity,
lock, replication, SLRU, and archiver history families. These families are
generated from repository schema plus maintained contract rules in
`scripts/generate-doc-inventory.mjs` and are marked as `seeded semantic
contract` in [Generated pgstat Data Family Contracts](generated/data-family-contracts.md).

| Table | Source family | Retention policy | Purge owner | Partition | Primary evidence use |
| --- | --- | --- | --- | --- | --- |
| `agg.pgss_hourly` | `fact.pgss_delta` | `control.retention_policy.hourly_retention_days/hourly_retention_months` | `PurgeEvaluator.purgeHourlyAgg` | monthly by `PartitionManager` | hourly query workload, latency, temp, cache, WAL, and throughput trend |
| `agg.pgss_daily` | `agg.pgss_hourly` | `control.retention_policy.daily_retention_days/daily_retention_months` | `PurgeEvaluator.purgeDailyAgg` | yearly by `PartitionManager` | daily long-range query workload trend |
| `agg.pg_table_stat_hourly` | `fact.pg_table_stat_delta` | `control.retention_policy.hourly_retention_days/hourly_retention_months` | `PurgeEvaluator.purgeHourlyAgg` | monthly by `PartitionManager` | Vacuum Lag, table health, autovacuum/analyze trend |
| `agg.pg_wal_hourly` | `fact.pg_wal_snapshot`, `fact.pgss_delta` | `control.retention_policy.hourly_snapshot_retention_days` | `PurgeEvaluator.rollupSnapshotsHourly` | not partitioned; `PartitionManager` currently lists it but skips it because the table is not schema-partitioned | WAL Spike, write amplification, FPI, replication pressure, WAL capacity |
| `agg.pg_wal_daily` | `agg.pg_wal_hourly` | `control.retention_policy.daily_snapshot_retention_days` | `PurgeEvaluator.rollupSnapshotsHourly` | not partitioned | long-range WAL growth and capacity trend |
| `agg.pg_activity_hourly` | `fact.pg_activity_snapshot` | `control.retention_policy.hourly_snapshot_retention_days` | `PurgeEvaluator.rollupSnapshotsHourly` | not partitioned | session pressure, long-running query, idle-in-transaction history |
| `agg.pg_lock_hourly` | `fact.pg_lock_snapshot` | `control.retention_policy.hourly_snapshot_retention_days` | `PurgeEvaluator.rollupSnapshotsHourly` | not partitioned | historical lock pressure and incident context |
| `agg.pg_replication_hourly` | `fact.pg_replication_snapshot` | `control.retention_policy.hourly_snapshot_retention_days` | `PurgeEvaluator.rollupSnapshotsHourly` | not partitioned | replication lag and standby-count history |
| `agg.pg_slru_hourly` | `fact.pg_slru_snapshot` | `control.retention_policy.hourly_snapshot_retention_days` | `PurgeEvaluator.rollupSnapshotsHourly` | not partitioned | SLRU pressure and cache/read/write/flush trend |
| `agg.pg_archiver_hourly` | `fact.pg_archiver_snapshot` | `control.retention_policy.hourly_snapshot_retention_days` | `PurgeEvaluator.rollupSnapshotsHourly` | not partitioned | archive backlog/failure and WAL retention risk trend |

These promoted families remain generated from code and hints. If rollup SQL,
retention fields, purge ownership, partitioning, or consumers change, update
the generator hints and regenerate the generated contract docs.

Live schema validation on 2026-07-14 confirmed that `agg.pgss_hourly`,
`agg.pgss_daily`, and `agg.pg_table_stat_hourly` are partitioned, while
`agg.pg_wal_hourly` and the snapshot-derived hourly aggregates are not
partitioned. The same validation exposed existing mixed timezone partition
bounds in live `agg.pgss_hourly` and `agg.pg_table_stat_hourly` partitions;
that is an operational remediation item, not a data-family contract closure
condition.

## 10. Initial High-Value Contracts

The full registry must be built incrementally. The first fields to formalize are
the ones required by DBA recommendations.

### Query Workload Contract

Domain: query workload and slow query analysis

Critical fields:

- `calls_delta`
- `total_exec_time_ms_delta`
- `mean_exec_time_ms`
- `min_exec_time_ms`
- `max_exec_time_ms`
- `rows_delta`
- `shared_blks_hit_delta`
- `shared_blks_read_delta`
- `shared_blk_read_time_ms_delta`
- `temp_blks_written_delta`
- `temp_blk_write_time_ms_delta`
- `wal_bytes_delta`
- `wal_records_delta`
- `wal_fpi_delta`
- `parallel_workers_launched_delta`

Primary consumers:

- Insights Top Queries
- Temp Spill
- WAL Spike
- Cache Hit
- pgdbaagent query workload evidence
- future recommendation engine
- future clone validation prioritization

### Settings Contract

Domain: configuration and parameter tuning

Critical fields:

- `work_mem`
- `shared_buffers`
- `effective_cache_size`
- `maintenance_work_mem`
- `max_connections`
- `max_parallel_workers_per_gather`
- `track_io_timing`
- `checkpoint_timeout`
- `checkpoint_completion_target`
- `max_wal_size`
- `min_wal_size`
- `wal_compression`
- `wal_buffers`
- `autovacuum`
- `autovacuum_vacuum_scale_factor`
- `autovacuum_analyze_scale_factor`
- `autovacuum_max_workers`

Primary consumers:

- Settings UI
- settings diff reports
- Temp Spill work_mem guidance
- WAL Spike settings panel
- Cache Hit context
- Vacuum Lag context
- pgdbaagent configuration advisor
- AI action plans

### Table Maintenance Contract

Domain: vacuum, analyze, bloat, freeze, and table maintenance

Critical fields:

- `n_live_tup`
- `n_dead_tup`
- `n_mod_since_analyze`
- `last_vacuum`
- `last_autovacuum`
- `last_analyze`
- `last_autoanalyze`
- `vacuum_count_delta`
- `autovacuum_count_delta`
- `analyze_count_delta`
- `autoanalyze_count_delta`
- `relfrozenxid_age`
- `relminmxid_age`

Primary consumers:

- Tables tab
- Vacuum Lag
- Autovacuum health
- freeze risk alerts
- pgdbaagent vacuum advisor
- future operations planning

### Validation Contract

Domain: user-provided clone/staging validation

Critical fields:

- validation target identity
- validation target freshness
- executed SQL
- explain_before
- explain_after
- runtime delta
- buffer delta
- temp delta
- WAL delta
- error/timeout
- cleanup status

Primary consumers:

- DBA Agent / Action Center
- recommendation lifecycle
- AI action plan
- audit log
- post-apply observation

## 11. Required Automation

The registry should eventually be checked automatically.

Target checks:

- migration adds a column but registry is not updated
- collector SQL adds/removes a field but registry is not updated
- API ColumnRegistry changes but registry is not updated
- UI insight references an unregistered field
- pgdbaagent evidence package references an unregistered field

Early implementation can be a documentation steward checklist. Later it should
be a CI check.
