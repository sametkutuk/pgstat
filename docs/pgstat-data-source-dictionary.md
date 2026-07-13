# pgstat Data Source Dictionary

Date: 2026-07-13
Status: draft
Scope: source-level inventory for pgstat collector data and known gaps

Related documents:

- [pgstat Project Master Document](project-master.md)
- [Agentic DBA Platform Architecture](agentic-dba-platform-architecture.md)
- [pgstat Telemetry Completion Roadmap](pgstat-telemetry-completion-roadmap.md)
- [Data Contract Registry](data-contract-registry.md)
- [PostgreSQL Stat Views Matrix](pg-stat-views-matrix.md)
- [Data Model Guide](data-model-guide.md)
- [Platform Governance And SDLC](platform-governance-and-sdlc.md)

## 1. Purpose

This document answers two questions:

1. What does pgstat collect today?
2. What is missing for pgstat + pgdbaagent to produce high-quality DBA
   findings and recommendations?

This is a source-level dictionary. It tracks data families, source views,
collector jobs, storage tables, semantics, and known limits. Field-level
ownership and consumer mapping belongs in
[Data Contract Registry](data-contract-registry.md).

The mechanical code-derived inventory lives in
[Generated pgstat Project Inventory](generated/project-inventory.md). It is
regenerated from migrations, collector code, API routes, UI references, purge
ownership, partition ownership, and rollup ownership with:

The table-level lifecycle view lives in
[Generated pgstat Data Lifecycle Matrix](generated/data-lifecycle-matrix.md).
It shows inferred semantics, timestamp columns, retention policy mapping,
purge ownership, partition ownership, and rollup role.

The table/data-family operational contract view lives in
[Generated pgstat Data Family Contracts](generated/data-family-contracts.md).
It shows collector job, PostgreSQL source, version gate, schedule, retention,
purge, partition, rollup, API/UI/alert/report consumers, pgdbaagent relevance,
sensitive-data classification, and unsupported-version behavior.

The generated field-level scaffold lives in
[Generated pgstat Field Contracts](generated/field-contracts.md), with current
review gaps summarized in
[Generated pgstat Contract Review Queue](generated/contract-review-queue.md).

```text
node scripts/generate-doc-inventory.mjs
# or on systems with make: make docs-inventory
```

Use the generated inventory and contract outputs to verify that this
human-readable dictionary stays complete.

Core rule:

```text
Every collected data family must have a source, storage location, semantics,
consumer intent, PostgreSQL version coverage, retention policy, and gap status.
```

## 2. Status Labels

| Status | Meaning |
| --- | --- |
| active | Collector reads this source and stores it in pgstat tables |
| version-gated | Active only on PostgreSQL versions where the source exists |
| partial | Some useful fields are collected, but important context is missing |
| derived | Computed from stored pgstat data, not read directly from source PG |
| gap | Not collected yet |
| verify | Schema or docs mention it, but field-level behavior must be rechecked |

## 3. Data Semantics

| Semantics | Meaning |
| --- | --- |
| dimension | Reference data used to identify stable entities |
| delta | Difference between current cumulative source counters and previous sample |
| snapshot | Point-in-time state; no delta calculation |
| aggregate | Rollup over fact/snapshot data |
| baseline | Historical distribution used for anomaly detection |
| derived finding | Rule output or alert computed from stored telemetry |

## 4. Collection Jobs

| Job | Main source scope | Typical cadence | Notes |
| --- | --- | --- | --- |
| bootstrap / discovery | PostgreSQL identity, extensions, DB list, capabilities | setup / rediscovery | Populates inventory, capability flags, database refs, and initial state |
| statements | `pg_stat_statements(false)` plus enrichment by `pg_stat_statements(true)` | `statements_interval_seconds` | Numeric query counters are collected frequently; SQL text is enriched separately |
| cluster | cluster-wide snapshots and counters | `cluster_interval_seconds` | Activity, replication, locks, WAL, archiver, SLRU, progress, slots, subscriptions |
| db_objects | per-database stats | `db_objects_interval_seconds` per database | Table, index, and database deltas; connects to each due database |
| nightly snapshot | selected settings and catalog size/freeze snapshots | nightly plus selected hot refreshes | Relation size, sequence state, freeze age, settings |
| rollup / retention | stored pgstat fact tables | background | Builds hourly/daily aggregates and purges old data |
| baseline | stored pgstat fact tables | daily / trigger | Builds `control.metric_baseline` for anomaly thresholds |

## 5. Collected Data Inventory

| Domain | Source in PostgreSQL | Collector / code path | Stored in | Semantics | Main pgstat consumers | pgdbaagent relevance | Status / limits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Instance identity | `pg_control_system()`, `version()`, `pg_is_in_recovery()`, `pg_postmaster_start_time()` | discovery / bootstrap | `control.instance_inventory`, `control.instance_capability`, `control.instance_state` | dimension / snapshot | instance list, health, scheduling | target identity, version gates, primary/standby context | active |
| Database catalog | `pg_database` | discovery, bootstrap, nightly | `dim.database_ref`, `control.database_state` | dimension | DB filters, per-DB jobs, reports | database-scoped evidence and recommendations | active |
| Extension capability | `pg_extension`, `pg_stat_statements_info`, `current_setting('compute_query_id')` | bootstrap, statements | `control.instance_capability`, `control.instance_state`, `control.pgss_reset_history` | snapshot / dimension | setup status, pgss reset alerts | determines query evidence quality | active, version-gated |
| Query workload | `pg_stat_statements(false)` | `StatementsCollector` | `fact.pgss_delta`, `dim.statement_series`, `dim.role_ref` | delta | Insights top queries, temp spill, WAL spike, cache hit, alerts, reports | primary query-impact evidence | active; requires `pg_stat_statements` |
| Query text | `pg_stat_statements(true)` | `TextEnricher` | `dim.query_text` | dimension | SQL display, search, copy, evidence packages | human-readable root cause and EXPLAIN target text | active; text enrichment may lag numeric samples |
| Database workload | `pg_stat_database` | `DbObjectsCollector.collectDatabaseStats` | `fact.pg_database_delta` | delta + gauges | Databases tab, TPS/cache/temp/deadlock/session signals | workload mix, DB-level tuning context | active; per-DB job must run |
| Table access and maintenance | `pg_stat_user_tables`, `pg_statio_user_tables` | `DbObjectsCollector.collectTableStats` | `fact.pg_table_stat_delta`, `dim.relation_ref` | delta + gauges | Tables tab, Vacuum Lag, missing-index heuristics, table health | table-level root cause, vacuum/analyze evidence | active; PG version safe lookups for newer fields |
| Index access and health | `pg_stat_user_indexes`, `pg_statio_user_indexes`, `pg_index` | `DbObjectsCollector.collectIndexStats` | `fact.pg_index_stat_delta`, `dim.relation_ref` | delta + gauges | Indexes tab, index health alerts | index usage, unused/invalid index risk | active; index definition/columns are not stored |
| BgWriter counters | `pg_stat_bgwriter` | `ClusterCollector.collectClusterMetrics` | `fact.pg_cluster_delta` | delta | BgWriter tab, alerts, baselines | buffer/checkpoint pressure context | active; PG17+ moved checkpoint fields out |
| Checkpointer counters | `pg_stat_checkpointer` | `ClusterCollector.collectClusterMetrics` | `fact.pg_cluster_delta` | delta | Checkpointer tab, checkpoint analysis | checkpoint tuning evidence | version-gated PG17+ |
| WAL counters | `pg_stat_wal` | `ClusterCollector.collectClusterMetrics` | `fact.pg_cluster_delta` | delta | WAL/stat WAL tabs, WAL Spike, baselines | WAL volume, FPI, write/sync pressure | version-gated; PG18 moved some timing fields to `pg_stat_io` |
| WAL position and directory | `pg_current_wal_lsn()`, `pg_last_wal_replay_lsn()`, `pg_walfile_name()`, `pg_ls_waldir()` | `ClusterCollector.collectWalSnapshot` | `fact.pg_wal_snapshot`, `agg.pg_wal_hourly`, `agg.pg_wal_daily` | snapshot + derived delta | WAL position tab, reports, WAL trend | WAL growth and disk pressure context | active; directory scan cost should stay monitored |
| Detailed I/O | `pg_stat_io` | `ClusterCollector.collectIoStats` | `fact.pg_io_stat_delta` | delta | I/O Stats tab, cache/read/write analysis | backend/object/context I/O evidence | version-gated PG16+ |
| Session activity | `pg_stat_activity` | `ClusterCollector.collectActivity` | `fact.pg_activity_snapshot`, `agg.pg_activity_hourly` | snapshot / aggregate | Activity tab, long-running query alerts, idle-in-tx alerts | live blocker/session context | active; samples only, not full wait-time history |
| Replication sender | `pg_stat_replication` | `ClusterCollector.collectReplication` on primary | `fact.pg_replication_snapshot`, `agg.pg_replication_hourly` | snapshot / aggregate | Replication tab, lag alerts | replication risk and WAL retention context | active; primary only |
| WAL receiver | `pg_stat_wal_receiver` | `ClusterCollector.collectWalReceiverSnapshot` on standby | `fact.pg_wal_receiver_snapshot` | snapshot | WAL Receiver tab | standby receive/apply evidence | active, standby only; field-level coverage should be periodically verified |
| Replication slots | `pg_replication_slots`, `pg_stat_replication_slots` | `ClusterCollector.collectSlotSnapshot` | `fact.pg_replication_slot_snapshot` | snapshot | Replication Slots tab, slot lifecycle alerts, WAL Spike summary | slot lag, lost/unreserved risk, logical spill | active; version-gated columns |
| Standby conflicts | `pg_stat_database_conflicts` | `ClusterCollector.collectConflictSnapshot` | `fact.pg_database_conflict_snapshot` | snapshot/counter state | Conflicts tab, standby alerts | standby read conflict diagnosis | active |
| Logical subscriptions | `pg_stat_subscription`, `pg_stat_subscription_stats` | `ClusterCollector.collectSubscriptionSnapshot` | `fact.pg_subscription_snapshot` | snapshot/counter state | Subscriptions tab, logical replication alerts | subscriber health context | active; PG18 conflict fields should remain under field-level registry |
| Recovery prefetch | `pg_stat_recovery_prefetch` | `ClusterCollector.collectRecoveryPrefetchSnapshot` | `fact.pg_recovery_prefetch_snapshot` | snapshot/counter state | Recovery Prefetch tab | standby replay tuning context | version-gated PG15+, standby-oriented |
| Archiver | `pg_stat_archiver` | `ClusterCollector.collectArchiverSnapshot` | `fact.pg_archiver_snapshot`, `agg.pg_archiver_hourly` | snapshot / aggregate | Archiver tab, WAL summary, reports | archive backlog/failure risk | active |
| SLRU | `pg_stat_slru` | `ClusterCollector.collectSlruSnapshot` | `fact.pg_slru_snapshot`, `agg.pg_slru_hourly` | snapshot/counter state | SLRU tab | checkpoint/autovacuum/transaction pressure context | version-gated PG13+ |
| Locks | `pg_locks` joined to `pg_stat_activity` | `ClusterCollector.collectLocks` | `fact.pg_lock_snapshot`, `agg.pg_lock_hourly` | snapshot | lock alerts, activity context | blocker/wait evidence | partial; stores waiting locks, not full lock graph history |
| Progress overview | `pg_stat_progress_vacuum`, `pg_stat_progress_analyze`, `pg_stat_progress_create_index` | `ClusterCollector.collectProgress` | `fact.pg_progress_snapshot` | snapshot | Progress tab | active maintenance/build context | active, version-gated |
| Progress detail | `pg_stat_progress_vacuum`, `pg_stat_progress_analyze`, `pg_stat_progress_create_index`, `pg_stat_progress_basebackup`, `pg_stat_progress_copy`, `pg_stat_progress_cluster` | dedicated `collectProgress*Full` methods | `fact.pg_progress_*_snapshot` tables | snapshot | Progress subtabs | active operation evidence | active, version-gated; verify UI coverage per subtab |
| User functions | `pg_stat_user_functions` | `ClusterCollector.collectUserFunctionSnapshot` | `fact.pg_user_function_snapshot` | snapshot/counter state | Functions tab | function hotspot context | active; requires `track_functions` |
| Sequence I/O | `pg_statio_all_sequences` | `ClusterCollector.collectSequenceIoSnapshot` | `fact.pg_sequence_io_snapshot` | snapshot/counter state | Sequences tab | sequence cache/I/O clues | active |
| Settings | selected rows from `pg_settings` | `NightlySnapshotCollector.collectSettings`, `collectHotSettings` | `fact.pg_settings_snapshot` | snapshot | settings UI, XID/WAL/cache/temp summaries, alerts | parameter tuning evidence | active; selected allowlist only |
| Relation size | `pg_class`, `pg_namespace`, `pg_relation_size()`, `pg_total_relation_size()` | `NightlySnapshotCollector.collectRelationSizes` | `fact.pg_relation_size_snapshot` | snapshot | Storage tab, index/table health, reports fallback | index cost, table growth, recommendation risk | active; only user schemas, objects over 1MB, first 10 active DBs per nightly run |
| Sequence state | `pg_sequences` | `NightlySnapshotCollector.collectSequenceStates` | `fact.pg_sequence_state_snapshot` | snapshot | sequence health | exhaustion risk context | active; PG10+ |
| Database freeze age | `pg_database`, `age(datfrozenxid)`, `mxid_age(datminmxid)` | `NightlySnapshotCollector.collectFreezeAge` | `fact.pg_database_freeze_snapshot` | snapshot | XID/freeze alerts | vacuum urgency context | active |
| Table freeze age | `pg_class`, `pg_namespace`, `age(relfrozenxid)`, `mxid_age(relminmxid)` | `NightlySnapshotCollector.collectTableFreeze` | `fact.pg_table_freeze_snapshot` | snapshot | XID/freeze details | table-level vacuum risk | active; `last_autovacuum_at` currently stored as null |
| Query rollups | `fact.pgss_delta` | `AggRepository`, `PurgeEvaluator` | `agg.pgss_hourly`, `agg.pgss_daily` | aggregate | long-range Insights trends | long-horizon evidence without raw scan cost | active |
| Table rollups | `fact.pg_table_stat_delta` | `AggRepository` | `agg.pg_table_stat_hourly` | aggregate | Vacuum Lag long-range trends | table health history | active |
| WAL rollups | `fact.pg_wal_snapshot`, `fact.pgss_delta` | `AggRepository`, `PurgeEvaluator` | `agg.pg_wal_hourly`, `agg.pg_wal_daily` | aggregate | WAL trend, reports | WAL baseline and growth history | active |
| Snapshot rollups | activity, locks, replication, SLRU, archiver snapshots | `PurgeEvaluator` | `agg.pg_activity_hourly`, `agg.pg_lock_hourly`, `agg.pg_replication_hourly`, `agg.pg_slru_hourly`, `agg.pg_archiver_hourly` | aggregate | reports and long-range dashboards | long-range operational context | active |
| Metric baselines | stored fact/snapshot tables | `BaselineCalculator` | `control.metric_baseline` | baseline | adaptive alerts | anomaly scoring context | derived |
| Alerts and reports | pgstat fact, snapshot, aggregate, and config tables | evaluator/report services | `control.alert_*`, report history/config tables | derived finding | UI, Telegram, reports | recommendation triggers and user workflow | derived |

## 6. What pgstat Does Not Collect Yet

These are the important gaps for the pgstat + pgdbaagent roadmap.

The pgstat-side implementation order is defined in
[pgstat Telemetry Completion Roadmap](pgstat-telemetry-completion-roadmap.md).

| Gap | Why it matters | Suggested owner | Priority |
| --- | --- | --- | --- |
| EXPLAIN / EXPLAIN ANALYZE plans | Required to validate query/index/parameter recommendations safely | pgdbaagent, using user-provided clone/staging target | critical |
| Before/after validation result model | Needed to compare runtime, buffers, temp, WAL, rows, and plan changes | pgdbaagent contract, pgstat storage/API later | critical |
| Query plan history from production | Helps detect plan regressions without running tests | future pgdbaagent/pgstat contract | high |
| Index definitions and column/predicate metadata | Required for precise index recommendations and write-cost modeling | pgstat collector | high |
| Table statistics histograms | `pg_stats`/extended stats improve selectivity reasoning | pgstat collector | high |
| Host OS metrics | CPU, memory, disk IOPS/latency, filesystem saturation are outside PostgreSQL views | optional node/exporter integration | high |
| Full wait-event time accounting | Activity snapshots show current waits but not cumulative wait duration by query | future wait sampling integration | medium |
| Full lock graph history | Current lock collection focuses on waiting locks; full blocker graph history is partial | pgstat collector | medium |
| Exact bloat measurement | Current table/index health uses proxies; `pgstattuple` or similar is not collected | optional extension-based job | medium |
| Application/deploy context | Deploy IDs, service names, ORM/version context are not collected | external integration | medium |
| Query parameter samples | Useful for skew diagnosis, but sensitive and not available from pgss | external/application integration | low by default, sensitive |
| Workload replay traces | Needed for load-test-grade validation, not required for first product phase | out of early scope | low |
| Automatic clone lifecycle | Current product direction assumes clone/staging connection is user-provided | out of early scope | explicit non-goal |

## 7. Important Coverage Notes

1. pgstat collector is read-only against source PostgreSQL. It reads system
   views/functions and writes only to the central pgstat database.
2. `pg_stat_statements` is required for query workload evidence. Without it,
   query-level recommendations must be disabled or marked unsupported.
3. Some source views are version-gated:
   - `pg_stat_io`: PG16+
   - `pg_stat_checkpointer`: PG17+
   - `pg_stat_wal_receiver`: standby only
   - `pg_stat_recovery_prefetch`: PG15+
   - detailed progress views vary by PG version
4. Nightly relation/sequence/table-freeze collection currently limits work to
   the first 10 active databases returned by `pg_database`. Any recommendation
   using object size/freeze evidence must record this coverage limit.
5. `fact.pg_storage_snapshot` may exist in older or external deployments, but
   current collector source writes relation-level storage to
   `fact.pg_relation_size_snapshot`.
6. Existing audit documents may be stale. This dictionary was checked against
   current collector source paths listed below, but field-level registry work
   remains separate.

## 8. Source Code Map

| Area | Main files |
| --- | --- |
| SQL source families | `collector/src/main/java/com/pgstat/collector/sql/SourceQueries.java`, `Pg11_12Queries.java`, `Pg13Queries.java`, `Pg14_16Queries.java`, `Pg17_18Queries.java` |
| Query workload | `collector/src/main/java/com/pgstat/collector/collector/StatementsCollector.java`, `TextEnricher.java` |
| Cluster/snapshot collection | `collector/src/main/java/com/pgstat/collector/collector/ClusterCollector.java` |
| Per-database object collection | `collector/src/main/java/com/pgstat/collector/collector/DbObjectsCollector.java` |
| Nightly/catalog snapshots | `collector/src/main/java/com/pgstat/collector/collector/NightlySnapshotCollector.java` |
| Fact writes | `collector/src/main/java/com/pgstat/collector/repository/FactRepository.java` |
| Dimension writes | `collector/src/main/java/com/pgstat/collector/repository/DimensionRepository.java` |
| Rollups | `collector/src/main/java/com/pgstat/collector/repository/AggRepository.java`, `collector/src/main/java/com/pgstat/collector/service/PurgeEvaluator.java` |
| Baselines | `collector/src/main/java/com/pgstat/collector/service/BaselineCalculator.java` |
| Schema | `db/migrations/` |

## 9. First Data Contracts To Promote

The next field-level registry pass should promote these first because they are
directly needed by pgdbaagent evidence packages:

1. Query workload contract:
   - `fact.pgss_delta`
   - `dim.statement_series`
   - `dim.query_text`
   - `agg.pgss_hourly`
2. Temp spill contract:
   - temp blocks, temp I/O time, rows, calls, max per-call approximations,
     recommended work_mem lower bound
3. WAL evidence contract:
   - query WAL bytes/records/FPI, WAL trend, replication slot lag, WAL settings
4. Cache evidence contract:
   - shared block hit/read, read time, hit ratio, shared_buffers,
     effective_cache_size
5. Vacuum/table health contract:
   - dead/live tuples, vacuum/analyze counts, vacuum/analyze time,
     freeze ages, autovacuum settings
6. Validation target contract:
   - user-provided clone/staging connection metadata
   - explain before/after
   - runtime/buffer/temp/WAL comparison

## 10. Change Rule

Any change that adds, removes, or changes collection behavior must update this
document in the same PR.

Required updates:

1. Add or modify the relevant inventory row.
2. Update gap status if the change closes or creates a gap.
3. If the data is exposed to UI, alerts, reports, APIs, or pgdbaagent, update
   [Data Contract Registry](data-contract-registry.md).
4. If PostgreSQL version coverage changes, update
   [PostgreSQL Stat Views Matrix](pg-stat-views-matrix.md) or add a note there.
5. Mention coverage limits and unsupported cases explicitly.
6. Define how each source column is handled by PostgreSQL version. Unsupported
   source columns must be skipped or stored as `null`; they must not break the
   whole collector cycle.
7. Define retention before merge. New fact/snapshot/aggregate tables must be
   wired into `control.retention_policy`, `PurgeEvaluator`, and
   `PartitionManager` when partitioned storage is needed.
8. If the data needs long-range analysis, define the rollup table and purge
   behavior at the same time. Raw telemetry must not be kept forever by
   accident.

This keeps pgstat standalone and makes pgdbaagent reasoning evidence-driven
instead of assumption-driven.
