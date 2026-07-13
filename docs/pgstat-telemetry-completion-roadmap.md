# pgstat Telemetry Completion Roadmap

Date: 2026-07-13
Status: draft
Scope: pgstat-side data, storage, API, and UI work needed before broad
pgdbaagent reasoning

Related documents:

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
3. Store coverage metadata so recommendations know when evidence is missing.
4. Every new data family updates:
   - [pgstat Data Source Dictionary](pgstat-data-source-dictionary.md)
   - [Data Contract Registry](data-contract-registry.md)
   - APIs/UI consumers if exposed
5. Do not make AI or UI heuristics depend on undocumented columns.

## 3. Priority Order

| Priority | Workstream | Why first |
| --- | --- | --- |
| P0 | Catalog metadata for tables/indexes/columns | Required for index advice and write-risk scoring |
| P0 | Safe column/statistics metadata | Required for selectivity/cardinality reasoning |
| P0 | Validation storage contracts | Required before pgdbaagent can write explain/validation evidence back |
| P1 | Lock graph and wait context | Required for blocking/root-cause findings |
| P1 | Deploy/application context | Required to correlate metric changes with releases |
| P1 | OS metric ingestion contract | Required to separate PostgreSQL from host bottlenecks |
| P2 | Optional exact bloat checks | Useful, but should be extension-gated and throttled |
| P2 | Optional wait sampling integration | Useful if `pg_wait_sampling` exists; not core dependency |
| P3 | Production plan history | Useful, but risky/noisy; keep explicit and off by default |

## 4. Workstream Details

### 4.1 Catalog Metadata For Tables, Indexes, And Columns

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

### 4.2 Safe Column Statistics And Extended Statistics

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

### 4.3 Validation Storage Contracts

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

### 4.4 Lock Graph And Wait Context

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

### 4.5 Wait-Time Accounting

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

### 4.6 Exact Or Approximate Bloat

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

### 4.7 OS Metric Ingestion Contract

Problem:

PostgreSQL views cannot prove whether the bottleneck is CPU, memory, disk,
filesystem, or network.

pgstat should not require a host agent in the core product, but it should define
an ingestion contract.

Sources:

- optional node exporter scrape/import
- optional Telegraf/Prometheus bridge
- manual/API metric ingestion

Proposed storage:

- `fact.host_metric_delta`
- `fact.host_metric_snapshot`
- `dim.host_ref`

Minimum metrics:

- CPU usage and load
- memory available, swap usage
- disk read/write IOPS
- disk read/write latency
- filesystem usage
- network throughput/errors

Consumers:

- cache miss vs disk saturation findings
- WAL/archive throughput findings
- checkpoint I/O pressure findings
- capacity recommendations

### 4.8 Deploy And Application Context

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

### 4.9 Production Plan History

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

## 5. First Implementation Batch

The first pgstat-side implementation batch should avoid risky production work
and unlock the most reasoning value.

Batch 1:

1. Catalog metadata snapshots:
   - tables
   - columns
   - indexes
   - constraints
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

## 6. Second Implementation Batch

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

## 7. Optional / Enterprise Batch

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

## 8. What This Means For pgdbaagent

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

## 9. Open Decisions

| Decision | Default recommendation |
| --- | --- |
| Store index definitions as text only or structured JSON too? | Store both raw `pg_get_indexdef` and parsed JSON when parser is available |
| Store raw histogram/MCV values? | No by default; start with safe scalar stats |
| Add host agent now? | No; start with ingestion contract |
| Run production EXPLAIN automatically? | No |
| Use exact bloat by default? | No; start proxy/estimate, make exact optional |
| Put reasoning in pgstat UI tabs? | No; pgstat exposes signals/findings, pgdbaagent reasons |

## 10. Definition Of Done For Each Workstream

Each workstream is done only when:

1. Collector/schema/API/UI changes are implemented if needed.
2. Coverage and limits are visible to users.
3. Data source dictionary is updated.
4. Data contract registry has field-level entries for exposed fields.
5. Tests/build are clean.
6. Existing pgstat standalone behavior is not weakened.
7. pgdbaagent consumer impact is documented.
