# pgstat Telemetry Completion Roadmap

Date: 2026-07-13
Status: draft
Scope: pgstat-side data, storage, API, and UI work needed before broad
pgdbaagent reasoning

Related documents:

- [pgstat Project Master Document](project-master.md)
- [Project Execution Plan](project-execution-plan.md)
- [pgstat Data Source Dictionary](pgstat-data-source-dictionary.md)
- [Data Contract Registry](data-contract-registry.md)
- [Agentic DBA Platform Architecture](agentic-dba-platform-architecture.md)
- [Platform Governance And SDLC](platform-governance-and-sdlc.md)

## 1. Purpose

pgstat already collects strong PostgreSQL telemetry. The next step is to make
that telemetry complete enough for structured DBA findings and later
pgdbaagent recommendations.

This roadmap defines what pgstat must add first.

Boundary:

```text
pgstat completes production-safe telemetry, storage, APIs, and UI.
pgdbaagent performs reasoning and clone/staging validation.
```

pgstat must remain read-only against production PostgreSQL. Anything that runs
`EXPLAIN ANALYZE`, test DDL, or workload experiments belongs to a user-provided
clone/staging validation target, not to the production collector.

## 2. Completion Principles

1. Prefer safe catalog/stat view reads over invasive checks.
2. Make optional/heavy collectors explicit, disabled by default, and
   rate-limited.
3. Make collection PostgreSQL-version and column aware. A collector must know
   which `server_version_num` values expose each source column and must skip or
   store `null` for unsupported columns instead of failing the whole cycle.
4. Store coverage metadata so recommendations know when evidence is missing.
   For every field, keep `since_pg`, optional `removed_pg`, collector SQL
   family, and unsupported-version behavior in the data contract.
5. Do not store any new fact, snapshot, or aggregate family forever. Every new
   table must be assigned to an explicit retention policy, purge path, and
   rollup/no-rollup decision before implementation is considered complete.
6. Every new data family updates:
   - [pgstat Data Source Dictionary](pgstat-data-source-dictionary.md)
   - [Data Contract Registry](data-contract-registry.md)
   - APIs/UI consumers if exposed
7. Do not make AI or UI heuristics depend on undocumented columns.

## 3. Priority Order

| Priority | Workstream | Why first |
| --- | --- | --- |
| P0 | Catalog metadata for tables/indexes/columns | Required for index advice and write-risk scoring |
| P0 | Safe column/statistics metadata | Required for selectivity/cardinality reasoning |
| P0 | Validation storage contracts | Required before pgdbaagent can write explain/validation evidence back |
| P0 | Lock graph and wait context | Required for blocking/root-cause findings |
| P0 | Deploy/application context | Required to correlate metric changes with releases |
| P0 | OS metric ingestion contract | Required to separate PostgreSQL from host bottlenecks without loading the target DB |
| P2 | Optional exact bloat checks | Useful, but should be extension-gated and throttled |
| P2 | Optional wait sampling integration | Useful if `pg_wait_sampling` exists; not core dependency |
| P3 | Production plan history | Useful, but risky/noisy; keep explicit and off by default |

## 4. Existing Coverage, Scheduling, And Retention

Some of the P0/P1 workstreams already exist partially. The work is not "start
from zero"; it is completion and contract hardening.

### 4.1 Current Coverage

| Workstream | Already exists | Missing completion |
| --- | --- | --- |
| Catalog metadata | `dim.relation_ref`, table/index relids and names, table/index stats, some index validity flags | column metadata, constraints, index definition text, expression indexes, partial predicates, included columns, structured current catalog model |
| Safe planner stats | none | safe `pg_stats` scalar fields and extended stats metadata |
| Deploy/application events | none | event ingestion API, UI/manual entry, CI/CD webhook shape, chart timeline overlays |
| Lock graph | waiting lock snapshot and `blocked_by_pids` | explicit blocked->blocker edge rows, blocker session/query context, hourly graph summary |

### 4.2 Use Existing Profile And Retention Model

New pgstat-side telemetry must use the existing control-plane model:

- `control.schedule_profile` controls collection cadence.
- `control.retention_policy` controls raw, snapshot, hourly, daily, nightly,
  audit, and alert retention.
- instance assignment remains through `control.instance_inventory`.
- purge remains centralized in `PurgeEvaluator`.
- rollup remains centralized in `AggRepository` / `PurgeEvaluator`.

Do not add one-off cron jobs outside this model.

### 4.3 Proposed Cadence And Retention Matrix

| Data family | Collection trigger | Default cadence | Schedule profile field | Raw storage | Summarize? | Retention policy |
| --- | --- | --- | --- | --- | --- | --- |
| Catalog metadata completion | catalog snapshot job, plus manual trigger after deploy/schema change | 6h or nightly in first implementation | Prefer `catalog_snapshot_interval_seconds` if separate from nightly; otherwise reuse nightly snapshot trigger | current dimension/upsert tables + change snapshot tables | No hourly rollup; keep current state plus change history | `catalog_snapshot_retention_days` if added; otherwise `nightly_snapshot_retention_days` |
| Safe `pg_stats` scalar metadata | stats snapshot job, plus manual trigger after ANALYZE/deploy | daily by default | `stats_snapshot_interval_seconds` only if separate cadence is needed | `fact.pg_column_stats_snapshot`, `fact.pg_extended_stats_snapshot` | No hourly rollup; daily snapshot is enough | `stats_snapshot_retention_days` if added; otherwise `nightly_snapshot_retention_days` |
| Deploy/application events | API/manual/CI webhook | event-driven | none | `fact.application_event` | No rollup; events are sparse | `application_event_retention_days` if added; otherwise `daily_retention_days` |
| Full lock graph | cluster collector, only when blockers/waiters exist | same as `cluster_interval_seconds` | existing `cluster_interval_seconds` | `fact.pg_lock_graph_snapshot` | Yes: hourly graph summary | raw: `snapshot_retention_hours`; hourly: `hourly_snapshot_retention_days` |

### 4.4 Default Policy Recommendation

Use these defaults unless real production volume proves otherwise:

| Policy | Catalog snapshot | Stats snapshot | App events | Lock graph raw |
| --- | --- | --- | --- | --- |
| `r3-short` | 90 days | 90 days | 365 days | `snapshot_retention_hours` |
| `r6-default` | 180 days | 180 days | 730 days | `snapshot_retention_hours` |
| `r12-long` | 365 days | 365 days | 1095 days | `snapshot_retention_hours` |

Rationale:

- catalog/stats snapshots are slow-moving and useful for historical
  recommendation context.
- application/deploy events must survive as long as daily trend analysis.
- lock graph raw data can grow quickly and should follow existing short
  snapshot retention; long-range use should read hourly summaries.

### 4.5 Summarization Rules

| Data family | Rollup rule |
| --- | --- |
| Catalog metadata | No time-series rollup. Store current state and change history keyed by hash/version. |
| Safe stats metadata | No hourly rollup. Store sampled daily/scheduled snapshots. |
| Deploy/application events | No rollup. Sparse event log only. |
| Lock graph | Roll raw samples into hourly aggregates by instance, database, relation when available, blocker role/application when safe. |

### 4.6 State Tracking

Avoid adding many one-off `last_*_collect_at` columns to
`control.instance_state`.

Preferred new pattern for non-core collectors:

```text
control.collector_job_state
  instance_pk
  job_type
  scope_type       -- instance, database, relation, external
  scope_key
  last_collect_at
  next_collect_at
  consecutive_failures
  last_error_at
  last_error_text
```

Existing state columns can remain for core jobs:

- cluster
- statements
- db_objects
- rollup
- table freeze, until it is migrated

Catalog/stats/optional collectors should use the generic job state pattern.

### 4.7 Version Gates And Retention Gates

Version and retention rules are hard gates for every new telemetry family.

Version gate:

| Rule | Required behavior |
| --- | --- |
| Source availability | Detect by `server_version_num`, capability rows, or source-query family; do not assume a column exists on every supported PG version. |
| Storage shape | Storage may be a superset schema, but fields unavailable on a PG version must be `null`, absent from the collector SQL, or explicitly marked unsupported. |
| Field contract | Every exposed field must record `since_pg`, optional `removed_pg`, source column/expression, and unsupported-version behavior. |
| Consumer behavior | UI, alerts, reports, and pgdbaagent must treat missing evidence as missing evidence, not as zero or success. |
| Matrix update | Any version coverage change updates the PostgreSQL stat views matrix or adds a precise note in this roadmap. |

Initial workstream gates:

| Workstream | Version rule |
| --- | --- |
| Catalog metadata | Base catalogs are broadly available, but individual expressions, index features, and generated/identity metadata are version-gated. Use version-specific select lists when needed. |
| Safe planner stats | `pg_stats` and extended statistics metadata must be collected only when the view/column exists. Prefer view/capability detection over optimistic SQL. |
| Deploy/application events | Not PostgreSQL-version gated because events are pgstat-owned input. Still record producer version if the event comes from CI/CD tooling. |
| Lock graph | `pg_blocking_pids` is broadly available, but lock/session context fields vary. Store unavailable fields as `null` and record the capability. |
| Future EXPLAIN/validation evidence | Production collector does not run validation. Clone/staging evidence must still record target PG version and plan format version. |

Retention gate:

| Rule | Required behavior |
| --- | --- |
| Policy mapping | Every new table maps to `control.retention_policy` directly or through an existing policy family. |
| Purge path | `PurgeEvaluator` must know how to delete or partition-prune the data. |
| Partition path | Monthly/time partitions must be added to `PartitionManager` for high-volume time-series tables. |
| Rollup decision | If raw data can grow quickly, define an hourly/daily rollup or explicitly justify no rollup. |
| UI/API setting | If a separate retention knob is required, update setup defaults, settings UI/API, and docs together. |
| No infinite default | A table without purge/partition/retention wiring is not accepted, even if it starts small. |

## 5. Workstream Details

### 5.1 Catalog Metadata For Tables, Indexes, And Columns

Problem:

pgstat knows table/index usage, but not enough structural metadata to reason
about precise index candidates, duplicate indexes, write overhead, expression
indexes, partial indexes, included columns, or constraints.

Sources:

- `pg_class`
- `pg_namespace`
- `pg_attribute`
- `pg_type`
- `pg_index`
- `pg_am`
- `pg_opclass`
- `pg_constraint`
- `pg_get_indexdef(indexrelid)`
- `pg_get_expr(indpred, indrelid)`
- `pg_get_expr(indexprs, indrelid)`

Proposed storage:

- `dim.relation_catalog_ref`
- `dim.column_catalog_ref`
- `dim.index_catalog_ref`
- or snapshot-style `fact.pg_catalog_relation_snapshot`,
  `fact.pg_catalog_column_snapshot`, `fact.pg_catalog_index_snapshot`

Recommended approach:

Use snapshot tables first. Catalog shape changes over time and recommendations
need historical context.

Minimum fields:

- instance, dbid, schema, relation name, relkind
- table relid and index relid
- table/index size at snapshot time if cheap or joinable
- index access method
- index definition text
- key column names and attnums
- included columns
- expression definition
- predicate definition
- uniqueness, primary, exclusion, validity, readiness
- constraint dependency if any
- column type, nullable, default presence, generated/identity flags

Consumers:

- index duplicate/overlap analysis
- missing-index candidate generation
- write overhead scoring
- recommendation risk model
- pgdbaagent evidence package

First implementation:

Add collector + API + UI read-only catalog view. Do not generate index advice
inside this collector.

### 5.2 Safe Column Statistics And Extended Statistics

Problem:

pg_stat_* counters show symptoms, but cardinality/selectivity reasoning needs
planner statistics.

Sources:

- `pg_stats`
- `pg_stats_ext`
- `pg_stats_ext_exprs`
- `pg_statistic_ext`
- `pg_statistic_ext_data` only through safe views where possible

Privacy risk:

`pg_stats.most_common_vals` and histogram values can contain real application
data. They may be sensitive.

Collection levels:

| Level | Default | Data | Risk |
| --- | --- | --- | --- |
| stats_safe | yes | `null_frac`, `avg_width`, `n_distinct`, `correlation`, inherited flag | low |
| stats_shape | optional | counts of MCV/histogram buckets, no raw values | low/medium |
| stats_values_redacted | optional | hashed/truncated values | medium |
| stats_values_raw | no | raw MCV/histogram values | high |

Recommended first implementation:

Collect `stats_safe` only:

- schema/table/column
- inherited flag
- null fraction
- average width
- n_distinct
- correlation
- MCV count if available without storing values
- histogram bucket count if available without storing values
- extended statistics name, kind, keys, expression text

Proposed storage:

- `fact.pg_column_stats_snapshot`
- `fact.pg_extended_stats_snapshot`

Consumers:

- selectivity context for missing-index findings
- skew warnings
- stale statistics detection
- pgdbaagent EXPLAIN interpretation

### 5.3 Validation Storage Contracts

Problem:

pgdbaagent will run EXPLAIN and before/after tests on user-provided
clone/staging targets. pgstat must store and display those results.

Important boundary:

pgstat production collector does not execute EXPLAIN or EXPLAIN ANALYZE on
production automatically.

pgstat-side responsibilities:

- validation target metadata
- validation job request/state
- explain result storage
- before/after comparison storage
- audit trail
- UI viewer
- evidence package linkage

Proposed tables:

- `control.validation_target`
- `control.validation_job`
- `fact.validation_explain_result`
- `fact.validation_comparison_result`
- `control.recommendation_validation_link`

Minimum validation target fields:

- target id
- owner instance
- target type: clone, staging, readonly replica
- host/port/db/user secret ref
- freshness metadata supplied by user or pgdbaagent
- policy: allow analyze, allow DDL, max runtime, max rows, statement timeout
- enabled/disabled

Minimum explain result fields:

- job id
- statement_series_id/queryid/query_text_id
- phase: before/after
- explain options
- plan JSON
- planning time
- execution time if analyze was allowed
- shared/local/temp buffers if present
- WAL if present
- rows observed
- errors/timeouts

Consumers:

- pgdbaagent recommendation confidence
- before/after UI
- audit trail
- evidence package v1+

### 5.4 Lock Graph And Wait Context

Problem:

Current lock data focuses on waiting locks. DBA findings need the blocking
relationship and session context at the same sample.

Sources:

- `pg_locks`
- `pg_stat_activity`
- `pg_blocking_pids(pid)`

Proposed storage:

- `fact.pg_lock_graph_snapshot`
- optional aggregate `agg.pg_lock_graph_hourly`

Minimum fields:

- blocked pid/session
- blocking pid/session
- database/relation/lock mode
- blocked query short text
- blocking query short text
- wait event/type
- wait age
- transaction age
- application/user/client

Consumers:

- blocking root-cause cards
- long-running transaction findings
- pgdbaagent evidence packages

First implementation:

Keep current `fact.pg_lock_snapshot`, add graph snapshot rather than breaking
existing lock UI.

### 5.5 Wait-Time Accounting

Problem:

`pg_stat_activity` snapshots show current waits, not cumulative wait time.
This is enough for live diagnosis but weak for historical root cause.

Safe first step:

Derive approximate wait pressure from activity snapshots:

- count active sessions by wait_event_type/wait_event
- count blocked sessions
- max/avg observed wait age
- hourly aggregates

Proposed storage:

- `agg.pg_wait_event_hourly`

Optional advanced step:

If `pg_wait_sampling` is installed and explicitly enabled:

- collect wait profiles from extension views
- store by event, queryid if available, database/user

Boundary:

`pg_wait_sampling` must remain optional. pgstat core cannot require it.

### 5.6 Exact Or Approximate Bloat

Problem:

Current table/index health uses proxies: dead tuples, relation size, scans,
freeze age. Exact bloat requires heavier checks or extensions.

Levels:

| Level | Default | Source | Notes |
| --- | --- | --- | --- |
| bloat_proxy | yes | existing stats + relation size | safe but approximate |
| bloat_estimate | optional | catalog formulas | no extension, can be inaccurate |
| bloat_approx | optional | `pgstattuple_approx()` | extension-gated, lighter than exact |
| bloat_exact | no | `pgstattuple()` / `pgstatindex()` | heavy; manual/limited only |

Recommended first implementation:

Add bloat proxy/estimate fields and mark confidence explicitly. Do not run
exact checks by default.

Proposed storage:

- `fact.pg_bloat_estimate_snapshot`

Consumers:

- Vacuum Lag recommendations
- index maintenance candidates
- risk model for storage-heavy recommendations

### 5.7 OS Metric Ingestion Contract

Problem:

PostgreSQL views cannot prove whether the bottleneck is CPU, memory, disk,
filesystem, or network.

pgstat must correlate PostgreSQL evidence with host pressure without adding
load to the monitored PostgreSQL database. OS metric collection must not run
extra diagnostic SQL on the target DB. It should use OS-level or external
metric evidence and write only to the central pgstat store.

pgstat should not require a host agent in the core product, but it must define a
global ingestion contract.

Decision:

- Build an optional first-party `pgstat-node-agent` as the official V1 path.
- Use mature OS libraries/native APIs for low-level counters instead of
  re-inventing every parser.
- Keep node_exporter/windows_exporter, Telegraf, and Prometheus as bridge
  sources.
- Keep SSH as a restricted fallback/onboarding path, not as the default
  enterprise collection model.
- Keep target PostgreSQL database load at zero for OS/service collection.

Detailed agent requirements are maintained in
[pgstat Node Agent Requirements](pgstat-node-agent-requirements.md).

Sources:

- manual/API metric ingestion
- pgstat-node-agent push ingestion
- optional node_exporter/windows_exporter scrape/import
- optional Telegraf/Prometheus bridge
- optional direct read-only OS user collection with an allowlisted source/command
  model

Proposed storage:

- `fact.host_metric_delta`
- `fact.host_metric_snapshot`
- `dim.host_ref`
- OS observation/history table to preserve OS family/distro changes over time
- host/container to PostgreSQL instance binding history
- PostgreSQL-related service inventory and service health snapshots

Minimum metrics:

- CPU usage, load, iowait, steal, core count
- memory total/available, swap usage
- disk read/write bytes, IOPS, latency, utilization, queue depth where available
- filesystem bytes and inode usage
- network throughput, errors, drops
- optional PostgreSQL process CPU/memory where safely available from OS evidence

Service health:

- PostgreSQL server
- PgBouncer
- Patroni
- pgpool-II
- PostgreSQL traffic HAProxy/Keepalived when tagged or explicitly configured
- container/Kubernetes equivalents

Service health uses a faster heartbeat than OS metrics so stopped, failed,
unhealthy, or restart-looping PostgreSQL-related services can alert quickly.

Supported OS families:

- Linux generic through procfs/sysfs or exporter/import data
- RHEL/Rocky/Alma/CentOS/Fedora family
- Ubuntu/Debian family
- SUSE family
- Windows Server through windows_exporter, Performance Counters, WMI/CIM, or
  import data

OS changes:

- A host can change from Windows to Linux, from RHEL to Ubuntu, or to another
  derivative. pgstat must preserve point-in-time OS identity/history instead of
  overwriting old evidence.
- Host identity must be separate from OS family/version observation.
- Unsupported or partially supported OS evidence must be recorded as a coverage
  gap, not silently treated as zero or healthy.

Security and load rules:

- Target PostgreSQL database load for OS metric collection must be zero.
- Direct OS collection should work with a read-only OS user where possible.
- No root/sudo requirement by default.
- Missing/stale/partial OS metrics must be visible in coverage state and should
  reduce finding confidence when host context is needed.
- OS metrics follow the same retention/purge model as comparable database
  metric families where practical; high-volume tables should be timestamp
  partitioned.

Consumers:

- cache miss vs disk saturation findings
- WAL/archive throughput findings
- checkpoint I/O pressure findings
- capacity recommendations

### 5.8 Deploy And Application Context

Problem:

Many performance regressions are release-related. pgstat currently cannot
correlate metric changes with deploys, migrations, feature flags, or app
versions.

Source:

- user/API supplied events
- CI/CD webhook
- manual UI event entry

Proposed storage:

- `control.application_ref`
- `fact.application_event`

Minimum fields:

- application/service name
- environment
- version/build SHA
- event type: deploy, migration, config_change, incident, rollback
- timestamp
- related instance/database if known
- free-text note

Consumers:

- anomaly explanation
- post-deploy regression findings
- report timelines
- pgdbaagent evidence packages

### 5.9 Production Plan History

Problem:

Plan history can explain regressions, but collecting plans from production has
cost and safety implications.

Boundary:

Do not add automatic production EXPLAIN collection to the normal collector.

Allowed future modes:

1. Manual operator-triggered `EXPLAIN (FORMAT JSON)` only.
2. Read-only, timeout-protected, no ANALYZE.
3. Disabled by default.
4. Audit logged.
5. Never substitutes clone validation.

Preferred early alternative:

Store plan history from pgdbaagent validation results first.

## 6. First Implementation Batch

The first pgstat-side implementation batch should avoid risky production work
and unlock the most reasoning value.

Batch 1 is completion work on top of existing pgstat telemetry:

1. Catalog metadata snapshots:
   - keep current table/index refs
   - add columns
   - add constraints
   - add index definitions, expressions, predicates, included columns
2. Safe stats snapshots:
   - `pg_stats` scalar fields
   - extended stats metadata
3. Deploy/application event API and UI:
   - simple event ingestion
   - timeline overlay in Insights later
4. Lock graph snapshot:
   - blocking/blocked relationship
   - wait age and session context

Why this batch:

- no production writes
- no EXPLAIN execution
- no extension dependency
- high value for recommendations
- improves pgstat standalone UI too

## 7. Second Implementation Batch

Batch 2:

1. Validation target/job/result schema:
   - storage and API only
   - pgdbaagent execution later
2. Explain result viewer UI:
   - display JSON plan
   - before/after summary shell
3. Wait event hourly aggregate:
   - derived from activity snapshots
4. OS metric ingestion contract:
   - schema and API
   - no mandatory agent yet

## 8. Optional / Enterprise Batch

Batch 3:

1. Optional `pgstattuple`/bloat approximate collector.
2. Optional `pg_wait_sampling` collector.
3. Optional raw/redacted histogram values.
4. Optional manual production `EXPLAIN (FORMAT JSON)` endpoint.

All optional collectors must have:

- explicit enable flag
- per-instance policy
- timeout
- rate limit
- audit log
- visible coverage status

## 9. What This Means For pgdbaagent

After Batch 1 and Batch 2, pgdbaagent can reason with much better evidence:

- query impact from pgss
- table/index usage and size
- exact index definitions
- column/stats context
- lock/wait context
- settings history
- deployment timeline
- validation target and result contracts

pgdbaagent still owns:

- signal interpretation
- finding generation
- recommendation candidates
- EXPLAIN analysis
- clone/staging validation execution
- confidence and risk scoring
- AI context preparation

## 10. Open Decisions

| Decision | Default recommendation |
| --- | --- |
| Store index definitions as text only or structured JSON too? | Store both raw `pg_get_indexdef` and parsed JSON when parser is available |
| Store raw histogram/MCV values? | No by default; start with safe scalar stats |
| Add separate schedule/retention columns for catalog and stats? | Add them only if nightly cadence is not enough in production; otherwise reuse nightly snapshot retention |
| Add host agent now? | No; start with ingestion contract |
| Run production EXPLAIN automatically? | No |
| Use exact bloat by default? | No; start proxy/estimate, make exact optional |
| Put reasoning in pgstat UI tabs? | No; pgstat exposes signals/findings, pgdbaagent reasons |

## 11. Definition Of Done For Each Workstream

Each workstream is done only when:

1. Collector/schema/API/UI changes are implemented if needed.
2. Coverage and limits are visible to users.
3. Data source dictionary is updated.
4. Data contract registry has field-level entries for exposed fields.
5. PostgreSQL version coverage is documented, including `since_pg`,
   `removed_pg` when applicable, and unsupported-version behavior.
6. Collector SQL is version-safe and column-safe for supported versions.
7. Retention is implemented: policy mapping, purge path, partition path when
   needed, and rollup/no-rollup decision.
8. Tests/build are clean.
9. Existing pgstat standalone behavior is not weakened.
10. pgdbaagent consumer impact is documented.
