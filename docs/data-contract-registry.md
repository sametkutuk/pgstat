# Data Contract Registry

Date: 2026-07-13
Status: draft
Scope: pgstat collected data, APIs, UI, alerts, reports, and pgdbaagent evidence

## 1. Purpose

This registry tracks collected data fields and their downstream consumers.

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
| collector | yes | Collector or SQL family |
| storage_table | yes | pgstat table |
| storage_column | yes | pgstat column |
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
2. Confirm required privilege.
3. Decide snapshot vs delta semantics.
4. Add migration if storage changes.
5. Add collector SQL with null-safe behavior.
6. Add API whitelist/ColumnRegistry if exposed.
7. Decide whether field is default UI column or optional.
8. Add report/alert/recommendation usage if needed.
9. Add evidence package usage if pgdbaagent needs it.
10. Add tests.
11. Update this registry.

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
    privilege: pg_read_all_stats
  collector:
    component: collector
    sql_family: ...
    reset_behavior: ...
  storage:
    table: fact....
    column: ...
    type: ...
    aggregation: snapshot|delta|sum|max|derived
    unit: ...
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

## 8. Initial High-Value Contracts

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

## 9. Required Automation

The registry should eventually be checked automatically.

Target checks:

- migration adds a column but registry is not updated
- collector SQL adds/removes a field but registry is not updated
- API ColumnRegistry changes but registry is not updated
- UI insight references an unregistered field
- pgdbaagent evidence package references an unregistered field

Early implementation can be a documentation steward checklist. Later it should
be a CI check.
