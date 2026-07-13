# Agentic DBA Platform Architecture

Date: 2026-07-13
Status: draft
Owner: pgstat / pgdbaagent product direction

Related documents:

- [Platform Governance And SDLC](platform-governance-and-sdlc.md)
- [Data Contract Registry](data-contract-registry.md)

## 1. Purpose

This document defines the target architecture for combining `pgstat` and
`pgdbaagent` into an agentic PostgreSQL DBA platform.

The goal is not to add isolated UI heuristics or one-off AI prompts. The goal is
to create a durable architecture where production telemetry, historical
behavior, clone-based validation, deterministic DBA reasoning, and AI-assisted
explanation work together.

Target product claim:

```text
Production-history-aware, clone-validated PostgreSQL DBA intelligence.
```

The platform should answer:

- What is happening?
- Why does it matter?
- What evidence supports the finding?
- What context is missing?
- What should be tested safely?
- What recommendation is validated?
- What risk does the action carry?
- What should be done next?

## 2. Competitive Position

### PostgresAI

PostgresAI is strong at clone-based query and index validation. Its DBLab model
can create writable full-size thin clones and run safe experiments outside
production.

Simplified position:

```text
PostgresAI = clone validation + AI DBA assistant
```

### DBtune

DBtune is strong at workload-aware PostgreSQL parameter tuning. It focuses on
server/runtime configuration optimization with guardrails and rollback thinking.

Simplified position:

```text
DBtune = parameter tuning loop
```

### pgstat + pgdbaagent

The combined platform should cover the strongest parts of both categories, but
with a different foundation: long-running production history.

Target position:

```text
pgstat + pgdbaagent =
  production history
  + parameter context
  + EXPLAIN evidence
  + clone validation
  + deterministic DBA reasoning
  + AI-assisted explanation
```

When a user-provided clone or staging database is available, this architecture
can produce stronger recommendations because it combines:

- historical production impact
- workload trend and baseline
- PostgreSQL settings context
- query plan evidence
- before/after clone test evidence
- risk model
- confidence model

## 3. Responsibility Split

### Product Boundary And Edition Model

The platform is one product family, but the core observability application must
remain independently useful.

Product boundary:

```text
pgstat Core = standalone PostgreSQL telemetry, monitoring, alerting, reporting
pgdbaagent = advice, AI, validation, recommendation, and operations reasoning
```

Hard rules:

- pgstat must always be able to run without pgdbaagent.
- pgstat must continue collecting data, rendering dashboards, producing reports,
  and sending alerts without the advice engine.
- pgdbaagent must consume pgstat data through documented contracts, not by
  reaching into unstable UI or route internals.
- paid/advice features must not break or weaken free/core observability.
- all shared data contracts must be versioned and documented.

Possible commercial packaging:

| Layer | Capability | Possible edition |
| --- | --- | --- |
| pgstat Core | collectors, central history, dashboards, basic reports | free / community |
| pgstat Ops | alerting, report automation, audit, fleet operations | pro |
| pgdbaagent Advice | findings, recommendations, risk scoring | pro / enterprise |
| AI Explanation | DBA-language explanation, action plans, summaries | paid |
| Clone Validation | validation targets, EXPLAIN before/after, test jobs | enterprise |
| Approved Operations | approval workflow, rollback plan, post-apply observation | enterprise |

Packaging decisions are product decisions, but architecture must preserve this
separation from the beginning.

### pgstat

`pgstat` is the telemetry, history, orchestration, UI, alerting, and reporting
platform.

Responsibilities:

- collect production PostgreSQL telemetry
- store fact and aggregate history
- track settings history
- track alerts, reports, and audit events
- show UI and Grafana dashboards
- expose evidence APIs
- manage validation targets
- enqueue validation jobs
- store validation results
- display recommendations and action history
- notify operators

Non-goal:

- pgstat should not contain scattered DBA reasoning logic inside individual UI
  tabs.

### pgdbaagent

`pgdbaagent` is the DBA reasoning engine.

Responsibilities:

- consume evidence packages from pgstat or direct PostgreSQL collectors
- detect signals
- produce findings
- score risk
- score confidence
- generate recommendation candidates
- create validation plans
- analyze EXPLAIN output
- compare before/after validation results
- prepare AI context
- generate final recommendation objects

Non-goal:

- pgdbaagent should not become another monitoring collector that duplicates
  pgstat central history.

### AI Layer

The AI layer explains and plans. It is not the source of truth.

Responsibilities:

- summarize evidence in DBA language
- explain tradeoffs
- produce action plans
- produce rollback plans
- convert structured recommendations into operator-friendly text

Hard boundaries:

- AI must not connect directly to production databases.
- AI must not invent evidence.
- AI must not execute changes.
- AI receives structured evidence packages and recommendation candidates.

### Clone / Validation Layer

The validation layer provides safe execution environments.

Responsibilities:

- attach to user-provided clone or staging databases
- isolate test execution from production
- run controlled EXPLAIN and optional EXPLAIN ANALYZE
- run candidate DDL in clone when policy permits
- enforce timeout, access policy, and concurrency limits
- store before/after evidence

Initial supported model:

- manual/staging clone target

Explicit non-goal for early phases:

- pgstat will not create, refresh, or destroy clones automatically.
- clone database provisioning is the user's responsibility.
- pgstat only stores the validation target connection and runs controlled tests
  against it.

Possible future providers:

- DBLab provider
- pgBackRest restore provider
- WAL-G restore provider
- native ZFS/LVM provider

## 4. Global Reasoning Pipeline

The reasoning model must be global and shared. Individual UI tabs should render
signals and recommendations, not own the reasoning rules.

Pipeline:

```text
raw metric
-> derived metric
-> signal
-> finding
-> recommendation candidate
-> validation plan
-> clone validation result
-> final recommendation
-> action plan
-> post-apply observation
```

Definitions:

| Object | Meaning |
| --- | --- |
| Raw metric | Collected PostgreSQL or system value |
| Derived metric | Computed value such as MB/call, WAL/row, p95, delta |
| Signal | Noteworthy symptom |
| Finding | DBA-readable interpretation with evidence |
| Recommendation candidate | Possible action that may help |
| Validation plan | Safe test plan for clone or staging |
| Validation result | Before/after evidence |
| Final recommendation | Validated or unvalidated advice with confidence |
| Action plan | Human-readable steps and rollback |
| Post-apply observation | Production effect after the change is applied |

## 5. Core Domain Model

### Evidence

Evidence is the atomic fact used by the reasoning engine.

Example:

```json
{
  "name": "temp_written_mb_7d",
  "value": 820,
  "unit": "MB",
  "source": "agg.pgss_hourly",
  "window": "7d"
}
```

### Signal

A signal is a symptom detected from one or more evidence items.

Example:

```json
{
  "id": "QUERY_TEMP_SPILL_SIGNAL",
  "severity_hint": "high",
  "evidence_refs": ["temp_written_mb_7d", "temp_mb_per_call"],
  "description": "Query has sustained temp spill pressure."
}
```

### Finding

A finding is a DBA-style interpretation.

Required fields:

- id
- category
- severity
- confidence
- affected entity
- evidence
- derived metrics
- interpretation
- possible causes
- missing context
- next actions
- safety level

### Recommendation Candidate

A candidate is a possible fix or mitigation. It is not necessarily validated.

Candidate types:

- create index
- change query shape
- session-level setting
- server parameter change
- vacuum/analyze action
- autovacuum parameter adjustment
- partitioning plan
- replication/slot cleanup
- capacity action

### Validation Result

Validation result compares a candidate against baseline behavior in a clone or
staging environment.

Required fields:

- validation target
- clone freshness
- before plan
- after plan
- runtime delta
- buffer delta
- temp delta
- WAL delta
- row estimate changes
- DDL side effects
- errors
- timeout status

### Final Recommendation

A final recommendation combines production impact and validation result.

Required fields:

- recommendation id
- target
- action type
- proposed SQL or steps
- expected benefit
- observed clone benefit
- production impact justification
- risk level
- confidence
- approval requirement
- rollback plan
- post-apply observation plan

## 6. Evidence Package v1

AI and pgdbaagent should not consume arbitrary raw tables. They should consume a
canonical evidence package.

Example shape:

```json
{
  "schema_version": "1.0",
  "generated_at": "2026-07-13T12:00:00Z",
  "source": "pgstat",
  "problem": "temp_spill",
  "target": {
    "instance_pk": 12,
    "instance_name": "prod-db-01",
    "dbid": 16384,
    "datname": "app",
    "statement_series_id": "9912",
    "queryid": "-1234567890"
  },
  "production_impact": {
    "window": "30d",
    "db_time_pct": 38.0,
    "calls": 1240000,
    "total_exec_time_ms": 913000000,
    "peak_hours": ["10:00-12:00"],
    "trend": "increasing"
  },
  "query_pressure": {
    "temp_written_mb": 820000,
    "temp_mb_per_call": 12.4,
    "max_temp_mb_per_call": 140.2,
    "wal_mb": 61000,
    "wal_mb_per_call": 0.04,
    "cache_hit_pct": 91.2,
    "disk_read_mb": 340000
  },
  "settings_context": {
    "work_mem": "16MB",
    "shared_buffers": "32GB",
    "max_connections": 300,
    "max_parallel_workers_per_gather": 4,
    "track_io_timing": "on"
  },
  "table_context": [],
  "index_context": [],
  "explain_before": null,
  "explain_after": null,
  "clone_validation": null,
  "signals": [],
  "missing_context": [
    "PLAN_CONTEXT",
    "CLONE_VALIDATION_CONTEXT"
  ]
}
```

Rules:

- Evidence package must not include secrets.
- Query text may be included only when needed and should be truncatable.
- Every value must include units where relevant.
- The package must distinguish production evidence from clone evidence.
- Missing context must be explicit.

## 7. Recommendation Lifecycle

Recommendations must move through states.

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

State meanings:

| State | Meaning |
| --- | --- |
| candidate | Derived from production evidence |
| needs_validation | Potentially useful but untested |
| validating | Clone/staging test is running |
| validated | Test supports benefit |
| rejected_by_validation | Test did not support benefit or failed |
| needs_approval | Human approval required |
| approved | Operator approved execution |
| applied | Change was applied outside or through controlled workflow |
| observing | Production effect is being monitored |
| confirmed | Post-apply metrics support benefit |
| rolled_back | Change was reverted |

No recommendation should skip evidence and validation status.

## 8. Clone Validation Flow

The clone validation flow is separate from recommendation generation.

```text
recommendation candidate
-> choose validation target
-> connect to user-provided clone/staging database
-> verify clone freshness
-> run baseline EXPLAIN
-> apply candidate change if policy allows
-> run after EXPLAIN
-> optionally run EXPLAIN ANALYZE
-> compare plans and metrics
-> leave validation target lifecycle to the user
-> store validation result
```

Safety controls:

- statement timeout
- lock timeout
- max runtime
- validation target access policy
- concurrent validation limit per target
- per-instance policy
- read-only production guarantee
- explicit permission for DDL on clone
- audit log for all executed SQL

Early-phase constraint:

```text
Clone lifecycle is external. pgstat does not provision clone databases.
```

EXPLAIN ANALYZE policy:

- never on production by default
- allowed only on clone/staging
- requires timeout
- blocked for mutating SQL unless explicitly permitted and isolated

## 9. Parameter Tuning Model

Parameter tuning should not be blind global tuning.

The platform should distinguish:

- query-local mitigation
- session-level setting
- role-level setting
- database-level setting
- server-level setting
- restart-required setting

Example rule:

```text
Do not recommend global work_mem increase from temp spill alone.
First identify whether spill is concentrated in a small number of queries.
Then compare index/query-shape/session-level options.
```

Parameter recommendations must include:

- current value
- proposed value
- reload or restart requirement
- memory/capacity risk
- affected workload
- rollback command
- validation status
- post-apply observation plan

## 10. AI Boundary

AI input:

- evidence package
- findings
- recommendation candidates
- validation results
- risk model

AI output:

- DBA explanation
- executive summary
- tradeoff analysis
- action plan
- rollback plan
- operator message

AI must not output unsupported facts. If evidence is missing, the AI output must
say so.

Prompt rule:

```text
Use only the provided evidence. Do not infer database facts that are not in the
evidence package. Mark uncertainty explicitly.
```

## 11. pgstat Gap Analysis

Current pgstat is strong at telemetry, UI, reports, and alerts. To become the
platform layer for agentic DBA recommendations, it needs these additions.

### Data / Storage Gaps

- recommendation table
- finding table
- evidence package snapshot table
- validation target table
- validation job table
- validation result table
- EXPLAIN plan storage
- before/after comparison storage
- recommendation state history
- post-apply observation table

### API Gaps

- evidence package endpoint
- findings endpoint
- recommendations endpoint
- validation target CRUD
- validation job enqueue/status
- EXPLAIN result retrieval
- recommendation approval endpoint
- recommendation state transition endpoint

### UI Gaps

- DBA Agent / Action Center page
- recommendation detail page
- evidence viewer
- clone validation result viewer
- before/after plan comparison
- approval workflow
- post-apply observation timeline

### Reasoning Gaps

- UI-local badges should become backend signals
- signal definitions should be centralized
- severity and confidence should be shared models
- risk scoring should be shared
- findings should be durable records
- recommendations should have lifecycle state

## 12. pgdbaagent Gap Analysis

Current pgdbaagent is an early CLI prototype. Its documentation has the right
direction, but the code needs to become a reusable reasoning engine.

Required modules:

```text
pgdbaagent_core/
  models/
  evidence/
  signals/
  findings/
  recommendations/
  validation/
  explain/
  risk/
  ai_context/
  renderers/
```

Interfaces:

- CLI
- pgstat API caller
- future worker/daemon
- future MCP server

Rules:

- CLI must not own business logic.
- pgstat UI must not own business logic.
- reasoning must live in pgdbaagent core.
- pgdbaagent should accept evidence packages from pgstat.
- pgdbaagent can also collect directly from PostgreSQL in standalone mode.

## 13. Phase Roadmap

### Phase 0: Design Freeze

Deliverables:

- this architecture document
- evidence package v1
- recommendation lifecycle v1
- clone validation design v1
- pgstat gap list
- pgdbaagent target architecture

No code required.

### Phase 1: Evidence Package

Deliverables:

- pgstat backend evidence builder for one domain
- recommended first domain: temp spill or cache hit
- canonical JSON response
- tests for package shape

Example endpoint:

```text
GET /api/agent/evidence/:instance_pk/query/:statement_series_id
```

### Phase 2: pgdbaagent Reasoning Engine

Deliverables:

- consume evidence package
- emit findings
- emit recommendation candidates
- terminal and JSON output

### Phase 3: Action Center

Deliverables:

- pgstat UI page for findings and recommendation candidates
- evidence viewer
- state display

### Phase 4: Manual Validation Target

Deliverables:

- validation target CRUD
- user-provided clone/staging DSN support
- validation job queue
- EXPLAIN before/after storage

### Phase 5: AI Explanation

Deliverables:

- AI context builder
- provider abstraction
- AI-generated explanation
- AI-generated action plan
- strict evidence-only prompt contract

### Phase 6: Global Reasoning Coverage

Deliverables:

- migrate UI-local heuristics into backend signals
- expand shared finding model across Temp Spill, WAL Spike, Cache Hit, Vacuum Lag
- centralize severity, confidence, and risk scoring
- store durable findings and recommendation candidates

### Phase 7: Approved Operations

Deliverables:

- approval workflow
- generated SQL/change plan
- rollback plan
- audit log
- post-apply observation

### Future Optional: Clone Provider Automation

Clone creation, refresh, delete, TTL, quota, and provider integration are future
capabilities. They must not block the first advisory platform.

Possible providers:

- DBLab
- pgBackRest restore
- WAL-G restore
- native ZFS/LVM

## 14. First Domain Recommendation

Start with Temp Spill.

Reasons:

- pgstat already has strong temp spill UI and metrics
- work_mem, query shape, sort/hash, temp files, rows, calls are clear evidence
- clone validation can compare temp usage and plan changes
- risk model is meaningful
- recommendations can stay safe and scoped

First end-to-end target:

```text
Temp spill evidence package
-> pgdbaagent finding
-> recommendation candidate
-> optional user-provided clone validation
-> final recommendation
-> AI action plan
```

## 15. Non-Goals For Early Phases

- no production auto-execution
- no autonomous ALTER SYSTEM
- no autonomous CREATE INDEX on production
- no AI direct DB access
- no broad root-cause claims from a single metric
- no clone provider implementation before manual validation works
- no rewriting every pgstat tab before the global model exists

## 16. Design Principles

- Evidence first.
- History before advice.
- Clone validation before confidence upgrade.
- AI explains, deterministic engine decides.
- UI renders, reasoning engine reasons.
- Every recommendation has risk and rollback.
- Every automation path starts as read-only finding.
- Production remains protected by default.
