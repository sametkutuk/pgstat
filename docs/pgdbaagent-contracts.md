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
| action_type | enum | yes | `create_index`, `drop_index`, `alter_setting`, `session_setting`, `vacuum_analyze`, `query_rewrite`, `partitioning`, `capacity_change`, `investigate` |
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
