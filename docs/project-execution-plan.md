# pgstat Project Execution Plan

Date: 2026-07-14
Status: active
Owner: pgstat product/program direction

This document is the project control plane for the pgstat product family. It
answers:

- Where are we now?
- What are we doing next?
- Which work is blocked?
- Which rules must be satisfied before coding starts?
- Which docs and contracts must move with each change?

Use this file as the living program board. Product architecture belongs in
[Agentic DBA Platform Architecture](agentic-dba-platform-architecture.md).
Project-wide rules belong in [pgstat Project Master Document](project-master.md).
This file turns those rules into executable work.

## 1. Product Operating Model

The product family is managed as one project, but it has two independent
runtime layers:

```text
pgstat Core
  standalone collection, history, dashboards, alerts, reports, setup, security

pgdbaagent
  evidence packages, findings, recommendations, AI explanation, validation
  analysis against user-provided clone/staging targets
```

Rules:

- pgstat Core must run and remain valuable without pgdbaagent.
- pgdbaagent consumes documented pgstat contracts; it must not scrape unstable
  UI internals or duplicate pgstat production history collection.
- Clone database lifecycle is user-provided for the current phase.
- Production collectors stay read-only.
- New telemetry is not complete until source, version coverage, schedule,
  retention, purge, partition/rollup, consumers, security, and unsupported
  behavior are documented.

## 2. Current State

As of 2026-07-14:

| Area | State | Evidence |
| --- | --- | --- |
| Project master docs | active | `docs/project-master.md` |
| pgstat/pgdbaagent boundary | active | `docs/agentic-dba-platform-architecture.md` |
| Local docs automation | active | `.githooks`, `scripts/install-git-hooks.mjs`, `scripts/check-doc-impact.mjs` |
| Generated inventory | active | `docs/generated/project-inventory.md` |
| Data lifecycle matrix | active | `docs/generated/data-lifecycle-matrix.md` |
| Data family contracts | scaffolded | `docs/generated/data-family-contracts.md` |
| Field contracts | scaffolded plus core promotions | `docs/generated/field-contracts.md` |
| Contract review queue | active | `docs/generated/contract-review-queue.md` |
| Project board | active | `docs/project-board.json` |
| Generated project status | active | `docs/generated/project-status.md` |
| pgstat node agent requirements | draft | `docs/pgstat-node-agent-requirements.md` |
| pgdbaagent contracts | draft | `docs/pgdbaagent-contracts.md` |
| Server-side docs CI | intentionally off | GitHub Actions disabled due billing constraints |

Current generated inventory baseline:

| Metric | Count |
| --- | ---: |
| Tables | 92 |
| Columns | 1148 |
| API routes | 211 |
| Column registries | 33 |

Current contract state:

| Item | Count | Meaning |
| --- | ---: | --- |
| Manual core field contracts | 161 | First critical fields promoted from generated scaffold |
| Field contracts needing exact review | 924 | Source/version/unsupported/consumer details still need confirmation |
| Data-family contracts needing review | 56 | Table-level lifecycle semantics still need human promotion |
| Sensitive or conditional AI fields | 561 | Need redaction, allowlist, or block policy before pgdbaagent use |
| Fact/aggregate families needing retention confirmation | 7 | Need purge mapping or durable-retention exception |

The project is no longer in an unknown-state phase. It has a generated map and
a known review queue. The next phase is contract hardening before broad
pgdbaagent coding.

## 3. Project Management Model

The project board source of truth is:

```text
docs/project-board.json
```

The generated readable status is:

```text
docs/generated/project-status.md
```

Rules:

- `docs/project-board.json` owns task status, requirements, acceptance
  criteria, implementation plan, verification plan, dependencies, and customer
  acceptance gate.
- `docs/generated/project-status.md` is generated. Do not edit it manually.
- Local hooks regenerate project status before commit and reject drift before
  push.
- `scripts/check-project-board.mjs` validates board shape, required fields,
  missing docs, max in-progress count, and done-task closure rules.
- A task is not `done` only because code exists. It must have Codex
  verification evidence and either customer acceptance or a documented
  `not_required` customer gate.
- The customer can ask for product outcomes. Codex owns project management,
  product decomposition, implementation, and first-pass verification. Customer
  validation remains a gate where required.

Task lifecycle:

```text
planned
-> in_progress
-> codex_verified
-> customer_validation
-> done
```

Exceptional state:

```text
blocked
```

Sequential execution rule:

- The board default is `max_in_progress = 1`.
- When a task is completed, update its acceptance criteria and verification
  evidence, move it to the correct next status, then start the next highest
  priority planned task.
- If parallel work is intentionally needed, update `max_in_progress` with a
  reason in this document.

## 4. Milestone Roadmap

### M0 - Program Control And Contract Baseline

Status: in_progress

Goal: make the project governable before new broad feature work.

Exit criteria:

- project master, architecture, governance, execution plan, and generated docs
  are linked
- local docs hooks installed and documented
- first critical evidence tables promoted to manual field contracts
- remaining contract gaps are visible in the review queue
- every new task starts from a capability card

### M1 - pgstat Evidence Completeness

Status: planned

Goal: complete the pgstat-side data needed for strong DBA findings.

Primary scope:

- catalog metadata: tables, columns, indexes, constraints
- safe `pg_stats` and extended statistics scalar metadata
- deploy/application event API
- full lock graph snapshot
- OS/system metric ingestion without target PostgreSQL database load
- PostgreSQL-related host service health observation and fast alerting
- validation target and validation result storage contracts
- exact retention and purge rules for new data families

Exit criteria:

- all new data families have source dictionary, field contracts, schedule,
  retention, purge, partition, security, and consumer mapping
- pgstat UI/API can expose the evidence without pgdbaagent dependency
- generated review queue shrinks for new stable families

### M2 - Shared Reasoning Model

Status: planned

Goal: move durable DBA reasoning out of isolated UI tabs and into global
contracts.

Primary scope:

- signal contract implementation
- finding contract implementation
- recommendation candidate contract
- evidence package builders for Temp Spill, WAL Spike, Cache Hit, Vacuum Lag,
  and Lock Wait
- deterministic rule registry
- missing-context and confidence scoring

Exit criteria:

- UI badges are either backed by reusable signal definitions or explicitly
  marked as UI-only hints
- pgdbaagent can consume evidence packages without raw table coupling
- every finding links back to source field contract IDs

### M3 - pgdbaagent Advice V1

Status: planned

Goal: produce explainable, evidence-backed DBA findings and recommendations.

Primary scope:

- pgdbaagent evidence reader
- finding generation
- recommendation generation
- AI prompt/context layer over structured evidence
- action plan, rollback plan, and observation plan output
- human approval boundary

Exit criteria:

- AI never receives undocumented raw fields
- recommendations distinguish evidence, inference, validation, risk, and
  confidence
- production execution remains out of scope unless explicitly approved later

### M4 - User-Provided Clone Validation

Status: planned

Goal: compare before/after evidence on a user-provided clone or staging target.

Primary scope:

- validation target registry
- validation job queue
- EXPLAIN / optional EXPLAIN ANALYZE capture
- before/after comparison
- candidate DDL test policy
- timeout, concurrency, and audit controls

Exit criteria:

- clone provisioning remains user-owned
- validation outputs are stored as structured evidence
- recommendations can move from `needs_validation` to `validated` or
  `rejected_by_validation`

### M5 - Enterprise Hardening

Status: planned

Goal: make the platform operable as a professional enterprise product.

Primary scope:

- release process and changelog discipline
- backup/restore and upgrade notes
- RBAC and audit expansion
- export/AI redaction policy
- self-hosted/server-side docs checks if GitHub billing remains unavailable
- operational runbooks

## 5. Active Backlog

The canonical backlog is `docs/project-board.json`; the readable snapshot is
`docs/generated/project-status.md`. The table below is a human summary and must
not diverge from the board.

Backlog priority is explicit. Work should not skip P0 items unless there is a
production bug or a user-approved urgent feature.

| Order | ID | Priority | Workstream | Status | Task | Depends on |
| ---: | --- | --- | --- | --- | --- | --- |
| 0 | PGSTAT-P0-009 | P0 | governance | done | Harden docs impact checker rules | - |
| 1 | PGSTAT-P0-001 | P0 | contracts | in_progress | Promote next critical data-family contracts | PGSTAT-P0-009 |
| 2 | PGSTAT-P0-002 | P0 | contracts | planned | Promote next field contracts beyond the first 161 | PGSTAT-P0-001 |
| 3 | PGSTAT-P0-011 | P0 | security | planned | Define AI/export redaction policy | PGSTAT-P0-002 |
| 4 | PGSTAT-P0-012 | P0 | release | planned | Add release checklist and upgrade impact template | PGSTAT-P0-009 |
| 5 | PGSTAT-P0-003 | P0 | telemetry | planned | Add catalog metadata collection contracts | PGSTAT-P0-001, PGSTAT-P0-002, PGSTAT-P0-011, PGSTAT-P0-012 |
| 6 | PGSTAT-P0-004 | P0 | telemetry | planned | Add safe planner stats metadata contracts | PGSTAT-P0-003, PGSTAT-P0-011 |
| 7 | PGSTAT-P0-005 | P0 | telemetry | planned | Add deploy/application event API | PGSTAT-P0-001, PGSTAT-P0-002, PGSTAT-P0-012 |
| 8 | PGSTAT-P0-006 | P0 | telemetry | planned | Add full lock graph snapshot | PGSTAT-P0-001, PGSTAT-P0-002, PGSTAT-P0-011 |
| 9 | PGSTAT-P0-017 | P0 | telemetry | planned | Define OS/system metric ingestion contract | PGSTAT-P0-001, PGSTAT-P0-002, PGSTAT-P0-011, PGSTAT-P0-012 |
| 10 | PGSTAT-P0-018 | P0 | telemetry | planned | Implement OS/system metric ingestion storage and API | PGSTAT-P0-017 |
| 11 | PGSTAT-P0-019 | P0 | telemetry | planned | Implement pgstat-node-agent V1 | PGSTAT-P0-017, PGSTAT-P0-018 |
| 12 | PGSTAT-P0-007 | P0 | pgdbaagent | planned | Define evidence package schemas v1 | PGSTAT-P0-001, PGSTAT-P0-002, PGSTAT-P0-003, PGSTAT-P0-004, PGSTAT-P0-005, PGSTAT-P0-006, PGSTAT-P0-011, PGSTAT-P0-017, PGSTAT-P0-018 |
| 13 | PGSTAT-P0-010 | P0 | validation | planned | Define validation target and result contracts | PGSTAT-P0-007, PGSTAT-P0-011, PGSTAT-P0-012 |
| 14 | PGSTAT-P0-008 | P0 | pgdbaagent | planned | Define signal/finding/recommendation registry | PGSTAT-P0-007, PGSTAT-P0-010 |
| 15 | PGSTAT-P0-013 | P0 | pgdbaagent | planned | Implement evidence package builders v1 | PGSTAT-P0-007, PGSTAT-P0-008 |
| 16 | PGSTAT-P0-014 | P0 | pgdbaagent | planned | Implement deterministic signal/finding engine v1 | PGSTAT-P0-013 |
| 17 | PGSTAT-P0-015 | P0 | pgdbaagent | planned | Implement pgdbaagent Advice V1 and AI explanation boundary | PGSTAT-P0-014 |
| 18 | PGSTAT-P0-016 | P0 | validation | planned | Implement validation target/result storage and API | PGSTAT-P0-010 |
| 19 | PGSTAT-P1-004 | P1 | validation | planned | Implement user-provided clone validation execution jobs | PGSTAT-P0-014, PGSTAT-P0-016 |
| 20 | PGSTAT-P1-001 | P1 | UI | planned | Add project status view or docs link in admin UI | PGSTAT-P0-009, PGSTAT-P0-012 |

## 6. Workstream Rules

### Contracts

No field becomes pgdbaagent-stable until it has:

- source view/catalog/function
- source column or expression
- PostgreSQL version coverage
- unsupported behavior
- schedule profile
- retention policy
- purge owner
- partition or no-partition decision
- rollup or no-rollup decision
- API/UI/alert/report/pgdbaagent consumers
- security classification

### Telemetry

No new collector work is complete until:

- collector SQL is version-aware
- unsupported columns degrade safely
- row volume is estimated
- retention and purge are implemented
- generated docs are refreshed
- data source dictionary and contract registry are updated

### Reasoning

No durable recommendation should be implemented as only UI logic.

Allowed:

- UI-only badges for quick visual hints

Required for pgdbaagent:

- evidence package
- deterministic signal
- finding
- recommendation candidate
- risk model
- confidence inputs
- missing-context handling

### Validation

The early validation model uses user-provided clone/staging databases.

Out of scope for now:

- automatic clone provisioning
- automatic production DDL
- AI-initiated execution

## 7. Capability Card Gate

Before coding any meaningful feature, create or update a capability card in the
relevant design/roadmap doc using the template in
[pgstat Project Master Document](project-master.md#9-capability-card-template).

Minimum fields:

- status
- product area
- user-visible behavior
- data families
- source and PG version behavior
- storage and retention
- API/UI consumers
- pgdbaagent evidence impact
- security classification
- test plan
- docs impact

If a task has no capability card, it is not ready for implementation unless it
is a narrow bug fix.

## 8. Definition Of Done

### Any pgstat Core Change

- code compiles and relevant tests/checks pass
- generated docs refreshed
- docs impact checker clean
- affected data/source/contract docs updated
- retention and purge impact documented
- security/export/AI sensitivity considered
- capability ledger updated if user-visible behavior changed
- project board status and generated project status updated if task scope,
  acceptance, status, or priority changed

### Any pgdbaagent-Facing Change

- evidence package contract updated
- signal/finding/recommendation contract updated if affected
- source field contract IDs listed
- sensitive fields have redaction/allow/block behavior
- validation requirement documented
- AI prompt/context boundary documented
- project board status and generated project status updated

### Any New Data Family

- source dictionary entry
- PG version coverage
- schedule profile
- storage table
- partition decision
- retention policy
- purge owner
- rollup decision
- API/UI/report/alert/pgdbaagent consumer map
- generated inventory refreshed
- project board acceptance criteria updated

### Any Project Task Closure

- all acceptance criteria are `done` or `not_required`
- Codex verification evidence is recorded
- customer acceptance is `accepted` if required, otherwise `not_required`
- `completed_at` is set
- generated project status is refreshed
- next task is moved to `in_progress` when appropriate

## 9. Operating Rhythm

Recommended working rhythm:

1. Pick the top item from Active Backlog.
2. Write or update the capability card.
3. Update contracts before or with code.
4. Implement the narrowest code change.
5. Run compile/tests.
6. Run generated docs and docs impact checks.
7. Update `docs/project-board.json` if status, scope, priority, requirements,
   acceptance criteria, or verification evidence changed.
8. Regenerate `docs/generated/project-status.md`.
9. Update this execution plan if rules, milestones, or project direction
   change.
10. Commit and push.

Local automation:

```text
node scripts/install-git-hooks.mjs
```

This is local Git config. It must be run once per fresh clone or new machine.
The `./pgstat` helper checks it and installs hooks automatically when Node is
available.

## 10. Current Open Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| GitHub Actions unavailable due billing | Server-side docs guard is missing | Keep local hooks; later add self-hosted CI or re-enable billing-safe checks |
| Generated contracts are not all semantically reviewed | pgdbaagent could consume weak evidence | Promote contracts by priority before pgdbaagent implementation |
| Reasoning scattered in UI badges | Advice quality becomes inconsistent | Move durable signals/findings into shared registry |
| Sensitive fields may enter AI/export context | Security/privacy risk | Define redaction and allowlist policy before evidence export |
| Clone lifecycle is manual | Validation UX is less automated than PostgresAI | Treat as explicit early-phase boundary; focus on evidence quality first |

## 11. Decision Log

| Date | Decision |
| --- | --- |
| 2026-07-14 | Manage pgstat Core and pgdbaagent as one product family with two independent runtime layers. |
| 2026-07-14 | Use this execution plan as the living project board for current state, next work, and gaps. |
| 2026-07-14 | Do not start broad pgdbaagent coding until pgstat evidence contracts and first evidence schemas are stable. |
| 2026-07-14 | Keep clone/staging targets user-provided for now; automatic clone lifecycle is out of scope. |
| 2026-07-14 | Use `docs/project-board.json` as the machine-readable task source of truth and `docs/generated/project-status.md` as the generated readable status. |
| 2026-07-14 | Build optional first-party `pgstat-node-agent` as the official OS/service health path; keep exporter bridge support and SSH only as restricted fallback. |
