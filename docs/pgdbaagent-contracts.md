# pgdbaagent Contracts

Date: 2026-07-13
Status: draft
Scope: evidence packages, reasoning model, findings, recommendations, and validation contracts

Related documents:

- [pgstat Project Master Document](project-master.md)
- [Project Execution Plan](project-execution-plan.md)
- [Agentic DBA Platform Architecture](agentic-dba-platform-architecture.md)
- [Data Contract Registry](data-contract-registry.md)
- [Generated pgstat Field Contracts](generated/field-contracts.md)
- [Generated pgstat Contract Review Queue](generated/contract-review-queue.md)

## 1. Product Boundary

pgstat and pgdbaagent are one product family, but not one runtime dependency.

```text
pgstat Core:
  collects, stores, summarizes, monitors, alerts, reports, and visualizes

pgdbaagent:
  consumes documented pgstat evidence, produces findings, explains tradeoffs,
  proposes recommendations, and compares user-provided clone/staging validation
```

Hard rules:

- pgstat must work without pgdbaagent.
- pgdbaagent must not duplicate pgstat production history collection.
- AI must not reason from arbitrary raw tables.
- AI receives structured evidence packages with units, source, confidence, and
  missing context.
- Clone lifecycle is user-provided in the current product phase.
- Production collection remains read-only.

## 2. Reasoning Pipeline

```text
pgstat data contract
-> evidence builder
-> deterministic signals
-> finding candidate
-> recommendation candidate
-> optional clone/staging validation
-> AI explanation
-> human approval
-> observation plan
```

Reasoning belongs above reusable evidence, not inside isolated UI tabs.

Each insight tab can show local badges and charts, but durable DBA advice must
use the shared contracts below.

## 3. Evidence Package v1

Evidence packages are immutable snapshots of the facts used to generate a
finding or recommendation.

Required envelope:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| schema_version | string | yes | Evidence schema version, initially `1.0` |
| evidence_id | string | yes | Stable generated ID |
| generated_at | timestamptz | yes | Package creation time |
| source | string | yes | Usually `pgstat` |
| problem_type | enum | yes | `query_latency`, `temp_spill`, `wal_spike`, `cache_miss`, `vacuum_lag`, `lock_wait`, `replication_lag`, `config_risk`, `storage_growth` |
| target | object | yes | Instance, database, relation, query, or cluster target |
| window | object | yes | Time range and bucket policy |
| production_impact | object | yes | Impact metrics with units |
| evidence_sections | object | yes | Domain-specific evidence blocks |
| source_fields | array | yes | Field IDs from generated/manual field contracts |
| missing_context | array | yes | Explicit list of missing evidence |
| sensitivity | object | yes | Query text, identity, settings, and AI redaction policy |
| confidence_inputs | object | yes | Data freshness, sample count, validation status |

Target object:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| instance_pk | number | yes | pgstat instance primary key |
| instance_name | string | yes | Display name |
| pg_major | number | yes | PostgreSQL major version |
| is_primary | boolean | yes | Primary/standby context |
| datname | string/null | no | Database scope |
| dbid | string/null | no | Database OID where relevant |
| relid | string/null | no | Relation OID where relevant |
| statement_series_id | string/null | no | Stable pgss series where relevant |
| queryid | string/null | no | PostgreSQL queryid where relevant |

Evidence section examples:

| Section | Use |
| --- | --- |
| query_pressure | latency, calls, rows, temp, WAL, cache, read/write I/O |
| table_health | dead tuples, vacuum/analyze activity, freeze age, size |
| index_context | index usage, size, validity, scan/fetch/read/hit counters |
| settings_context | relevant pg_settings values and risk multipliers |
| replication_context | slot lag, replay lag, WAL status, spill |
| lock_context | blockers, waiters, wait duration, relation/database context |
| validation_context | user-provided clone/staging before-after evidence |

## 4. Signal Contract

A signal is deterministic and explainable.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| signal_id | string | yes | Stable generated ID |
| signal_type | enum | yes | Domain signal type |
| severity | enum | yes | `info`, `low`, `medium`, `high`, `critical` |
| confidence | enum | yes | `low`, `medium`, `high` |
| evidence_id | string | yes | Evidence package that produced it |
| rule_id | string | yes | Deterministic rule name/version |
| value | number/string | yes | Observed value |
| threshold | number/string/null | no | Trigger threshold |
| unit | string/null | no | Unit |
| explanation | string | yes | Short DBA-readable reason |

Signals do not prescribe changes. They describe measured conditions.

## 5. Finding Contract

A finding interprets one or more signals.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| finding_id | string | yes | Stable ID |
| finding_type | enum | yes | `temp_spill_hotspot`, `wal_top_writer`, `cache_miss_hotspot`, `vacuum_lag_risk`, `lock_root_cause`, `settings_risk`, `replication_risk` |
| status | enum | yes | `open`, `acknowledged`, `muted`, `resolved`, `dismissed` |
| severity | enum | yes | Derived from impact and risk |
| confidence | enum | yes | Derived from evidence quality |
| evidence_id | string | yes | Source package |
| signal_ids | array | yes | Signals used |
| summary | string | yes | Human-readable summary |
| impact | object | yes | Impact with units |
| suspected_causes | array | yes | Ranked suspected causes |
| missing_context | array | yes | Unknowns that limit certainty |
| created_at | timestamptz | yes | Creation time |

Findings are durable records. A finding can exist without a recommendation.

## 6. Recommendation Contract

A recommendation proposes an action and its risk.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| recommendation_id | string | yes | Stable ID |
| finding_id | string | yes | Parent finding |
| action_type | enum | yes | `create_index`, `drop_index`, `alter_setting`, `session_setting`, `vacuum_analyze`, `query_rewrite`, `partitioning`, `replication_slot_cleanup`, `capacity_change`, `investigate` |
| status | enum | yes | Recommendation lifecycle state |
| proposed_change | object | yes | SQL, parameter, or action plan |
| expected_benefit | object | yes | Estimated benefit and unit |
| risk | object | yes | Memory, write, lock, storage, replication, operational risk |
| validation_requirement | enum | yes | `none`, `recommended`, `required` |
| clone_validation | object/null | no | User-provided clone/staging before-after result |
| approval_required | boolean | yes | Whether human approval is required |
| rollback_plan | string | yes | How to revert |
| observation_plan | string | yes | What to monitor after action |

Lifecycle:

```text
candidate
-> needs_validation
-> validating
-> validated
-> rejected_by_validation
-> needs_approval
-> approved
-> applied
-> observing
-> confirmed
-> rolled_back
```

## 7. AI Reasoning Contract

AI can explain and compare. It cannot invent evidence.

AI input must include:

- evidence package
- signal list
- finding candidate
- recommendation candidate if any
- missing context
- sensitivity/redaction policy

AI output must include:

- concise DBA explanation
- why this matters
- confidence and why
- risks and tradeoffs
- validation needs
- action plan
- rollback plan
- what not to do

AI output must not include:

- unapproved production DDL execution
- secrets or raw credentials
- claims unsupported by evidence
- hidden assumptions without marking uncertainty

## 8. Field Contract Dependency

Every evidence field must map back to a field contract ID:

```text
fact.pgss_delta.total_exec_time_ms_delta
fact.pgss_delta.temp_blks_written_delta
fact.pg_table_stat_delta.n_dead_tup
fact.pg_settings_snapshot.setting_value
```

Generated field contracts are a scaffold. Stable pgdbaagent evidence requires
manual promotion in [Data Contract Registry](data-contract-registry.md).

## 9. First Stable Evidence Packages

Priority order:

| Priority | Package | Depends on |
| --- | --- | --- |
| 1 | temp_spill_query_v1 | pgss, settings, query text, optional relation/index context |
| 2 | wal_spike_query_v1 | pgss WAL fields, WAL settings, slots/archive context |
| 3 | cache_miss_query_v1 | pgss cache/read fields, settings, relation/index context |
| 4 | vacuum_lag_table_v1 | table stats, freeze snapshots, settings, progress |
| 5 | lock_wait_v1 | activity, locks, query text, relation/database refs |

## 10. Definition Of Done

A pgdbaagent-facing feature is done only when:

- source fields exist in generated field contracts
- promoted fields exist in manual data contract registry
- evidence package schema is updated
- signal/finding/recommendation mapping is documented
- sensitive fields have redaction or block policy
- missing context behavior is explicit
- validation requirement is defined
- UI/report/API consumers are documented

## 11. Autovacuum Evidence API Contract (agent-evidence, v1.0.0)

Implemented in `api/src/services/agent-evidence/` and exposed by
`api/src/routes/agent-evidence.ts`. Read-only. The router is not mounted yet;
mounting requires `app.use('/api/agent-evidence', requireAuth, ...)`.

### 11.1 Shared envelope

Every read returns the same envelope so the model never has to guess what a
number means:

| Field | Meaning |
| --- | --- |
| `schema_version` | `1.0.0`. Removing a field or changing its meaning is a major bump. |
| `capability` | Semantic capability name, e.g. `autovacuum_overview`. |
| `status` | `ok`, `partial`, `no_data`, `not_collected`, `unsupported_version`, `unknown_capability`, `stale`, `insufficient_samples`, `failed`. |
| `target` | Instance identity plus `pg_major` / `server_version_num`; `null` means unknown, not old. |
| `requested_range` / `effective_range` | Half-open `[from, to)`. The effective range carries `resolution` (`raw`/`hourly`/`daily`) and why it differs. |
| `data` | Capability payload. |
| `metric_catalog` | Per metric: unit, kind (snapshot/delta_sum/average/ratio), source column, whether it is an estimate, and what `NULL` means. |
| `coverage` | One entry **per source**. There is no single "complete" flag. |
| `limitations` | What the answer cannot support. |
| `gap_candidates` | Verified product gaps only. This API never opens a record. |
| `sources` | Physical tables read. |

### 11.2 Coverage entry

`sample_count` counts collection rounds (`distinct` timestamp), never rows: one
round writes a row per table, and one activity snapshot writes a row per PID.

`expected_sample_count` and `missing_sample_pct` are always `null`. Schedule
history is not stored — `control.schedule_profile` holds only today's
intervals — so the expected number of rounds in a past window is unknown, and
applying today's interval backwards would be invention.

`max_observed_gap_seconds` is an observation. It is not a count of missed
collection rounds; collection may never have been scheduled in that gap.

### 11.3 Endpoints

| Endpoint | Capability | Required parameters |
| --- | --- | --- |
| `GET /instances` | `find_instance` | optional `search`, `limit` (max 200) |
| `GET /:id/telemetry-coverage` | `telemetry_coverage` | `from`, `to` |
| `GET /:id/autovacuum-overview` | `autovacuum_overview` | `from`, `to` |
| `GET /:id/vacuum-candidates` | `vacuum_candidates` | `from`, `to`; optional `ordering`, `dbid`, `limit` (max 200) |
| `GET /:id/table-vacuum-evidence` | `table_vacuum_evidence` | `from`, `to`, `dbid`, `relid`; optional `max_points` (max 500) |

Not implemented: `get_query_performance_evidence` and `compare_periods`.

### 11.4 Rules this contract enforces

- **Zero rows is not "not collected."** Empty results report
  `no_data` / `zero_rows_in_window`. The cause is narrowed only when
  `ops.job_run_instance` proves a failed or skipped collection in that window.
- **Staleness is measured against the end of the requested window,** not
  `now()`. A deliberately historical question is never labelled stale.
- **Table identity is `instance_pk` + `dbid` + `relid`.** Same-named tables in
  different databases never merge. OID reuse after drop/recreate and rename
  history are reported as identity limitations, because the stored data cannot
  distinguish them.
- **Ranking is not diagnosis.** Candidate ordering always ships its criterion.
  The default reuses PostgreSQL's own threshold
  (`autovacuum_vacuum_threshold + scale_factor * reltuples`), matching
  `AlertRuleEvaluator`. Where `reltuples` is unknown (PG14+ `-1` sentinel) no
  threshold is produced. The existing alert rule is unchanged.
- **Version limits are distinct from missing data.** Autovacuum duration needs
  PG18; below that the coverage entry is `unsupported_version`, and when
  `pg_major` is unknown it is `unknown_capability`.
- **NULL is never coerced to zero,** and zero denominators are distinguished
  from missing denominators.
- **bigint leaves as a string.** node-postgres returns `int8` as text and
  `Number()` would silently corrupt values above 2^53.
- **Client input never reaches SQL as identifiers.** Ordering comes from a
  server-side dictionary; time range, ids and limits are validated and bounded.
- **Every query runs read-only under `SET LOCAL statement_timeout`,** which is
  reverted with the transaction and does not leak to the next request sharing
  that pooled connection.
- **Invalid input is a 400, not a product gap.** It produces no gap candidate.

### 11.5 Verification state

`api/tests/agentEvidence.spec.ts` runs the real queries against a disposable
PostgreSQL 17 with all migrations applied: 13 tests, 13 passed, 0 skipped,
stable across two consecutive runs. The HTTP layer, `EXPLAIN (ANALYZE,
BUFFERS)` measurement and any fleet-scale claim remain unverified.

## 12. Investigation Intake Contract (target is not mandatory)

AI DBA is a conversation, so `POST /api/agent/investigations` requires only
`question`. `instance_pk`, `dbid`, `time_from` and `time_to` are optional.

### 12.1 How the target is resolved

| Situation | Behaviour |
| --- | --- |
| `instance_pk` supplied and active | used as given |
| `instance_pk` supplied but unknown or inactive | `404` — this is invalid input, not an ambiguity to ask about |
| omitted, exactly one active instance exists | that instance is selected, and the conversation records that it was chosen automatically |
| omitted, zero or several active instances | investigation opens as `needs_clarification` and the user is asked which instance they mean |

No instance is ever guessed from a question's wording by this layer.

### 12.2 Time window

When `time_from`/`time_to` are omitted the last `24 hours` are used. The
response carries `window_defaulted: true` and an assistant message states the
exact window that was applied, so a defaulted range is never silently
attributed to the user.

### 12.3 Answering the question

`POST /api/agent/investigations/:id/clarify` accepts `instance_pk`, `dbid`,
`time_from`, `time_to` and an optional free-text `message`. It only applies to
an investigation in `needs_clarification`; anything already queued or finished
answers `409`, because evidence already gathered would belong to a different
target. Once the instance is known the status moves to `queued`.

An investigation waiting on the user is still cancellable — `needs_clarification`
is part of `ACTIVE_INVESTIGATION_STATES` — so an unanswered question cannot
hang in the conversation forever.

### 12.4 Verification state

`api/tests/investigationIntake.spec.ts` runs against a disposable PostgreSQL
with the real V120 and V122 migrations: 1 test, passed, 0 skipped. It covers
zero, one and several active instances, an explicit target, an inactive
target, the defaulted window and its message, and cancelling an investigation
that is still waiting for an answer. The HTTP layer is not exercised.

## 13. Investigation Queue Contract (DB-only dispatch)

`api/src/services/investigationQueue.ts`. No Redis or Kafka; PostgreSQL row
locks are the whole mechanism.

- `claimNextInvestigation` takes the oldest `queued` investigation, sets it to
  `planning` and records `claimed_by`, `claimed_at`, `heartbeat_at` and an
  incremented `attempt_count`. `needs_clarification` is never claimed, because
  it waits on the user rather than a worker.
- Every later write is conditioned on `(investigation_id, expected status,
  claimed_by)`. If the user cancelled in the meantime the write matches zero
  rows and returns `superseded`, so **a cancelled investigation can never
  become `completed`**.
- `reclaimStaleInvestigations` returns work whose heartbeat has gone stale: it
  is requeued while attempts remain and becomes `timed_out` with
  `failure_code = 'worker_timeout'` once `MAX_ATTEMPTS` is reached, so a
  crash-looping worker cannot retry forever.

Correctness comes from the `for update` row lock in the claim subquery, not
from `skip locked`. Measured 2026-09-15: with the lock removed, six concurrent
workers claimed two investigations five times; with it, always twice. Removing
only `skip locked` kept the result correct and merely made workers queue up.

`api/tests/investigationQueue.spec.ts` proves all of the above against a
disposable PostgreSQL: 1 test, passed, 0 skipped. The suite was verified to
have teeth by removing the lock and confirming it fails.
