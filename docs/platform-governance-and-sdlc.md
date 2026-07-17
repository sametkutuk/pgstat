# Platform Governance And SDLC

Date: 2026-07-13
Status: draft
Scope: pgstat + pgdbaagent product family

Related documents:

- [pgstat Project Master Document](project-master.md)
- [Project Execution Plan](project-execution-plan.md)
- [Agentic DBA Platform Architecture](agentic-dba-platform-architecture.md)
- [pgstat Telemetry Completion Roadmap](pgstat-telemetry-completion-roadmap.md)
- [pgstat Data Source Dictionary](pgstat-data-source-dictionary.md)
- [Data Contract Registry](data-contract-registry.md)

## 1. Purpose

This document defines how the pgstat product family must be developed as an
enterprise-grade platform.

The platform has two strongly related components:

- `pgstat`: standalone telemetry, monitoring, alerting, reporting, and UI
- `pgdbaagent`: advice, AI, validation, recommendation, and reasoning engine

Both components can evolve independently, but every change that affects shared
data, recommendations, findings, or user workflows must be documented and traced.

## 2. Non-Negotiable Product Boundaries

### pgstat Core Must Stand Alone

pgstat must remain a useful product without pgdbaagent.

It must be able to:

- collect PostgreSQL telemetry
- store fact and aggregate history
- show UI dashboards and instance detail tabs
- produce reports
- send alerts
- operate without AI
- operate without clone validation
- operate without paid advice features

### pgdbaagent Is The Advice Layer

pgdbaagent is the reasoning and advisory layer.

It may provide:

- findings
- recommendations
- risk scoring
- confidence scoring
- AI explanation
- validation plan generation
- clone validation analysis
- approved operation planning

It must not become a second independent monitoring platform that duplicates
pgstat history.

### Shared Contracts Are Product Contracts

The boundary between pgstat and pgdbaagent must be explicit.

Shared contracts include:

- evidence package schema
- finding schema
- recommendation schema
- validation job schema
- validation result schema
- settings/context schema
- source data field registry

No shared contract may change silently.

## 3. Enterprise SDLC

Every non-trivial change must pass through this lifecycle:

```text
idea
-> issue / requirement
-> impact analysis
-> design note or ADR
-> implementation
-> tests
-> documentation update
-> review
-> release note
-> post-release observation
```

Small implementation changes can use a short design note. Architecture,
contract, data model, collector, or recommendation changes require a full ADR.

## 4. Required Change Impact Analysis

Before implementation, each change must answer:

1. Which product layer is affected?
2. Does pgstat Core still work without pgdbaagent?
3. Does this add, remove, rename, or change any collected data field?
4. Which API endpoints expose this data?
5. Which UI pages render this data?
6. Which alerts, reports, insights, or recommendations use this data?
7. Does pgdbaagent need the field in an evidence package?
8. Does the change affect AI prompt context?
9. Does the change affect clone validation?
10. Does the change require migration, backfill, or compatibility handling?
11. What tests prove the behavior?
12. Which docs must change?

This analysis must be stored in the issue, PR description, or ADR.

## 5. Documentation Is Part Of Definition Of Done

A change is not done until documentation is updated.

Required documentation updates by change type:

| Change type | Required docs |
| --- | --- |
| New collector field | data contract registry, pg-stat matrix if relevant, evidence package if used |
| Removed collector field | data contract registry, migration notes, consumers list |
| New API endpoint | API docs or route notes, evidence contract if relevant |
| New UI insight | reasoning model, signal/finding docs if more than display-only |
| New alert | alert reference, data source mapping, notification behavior |
| New recommendation | finding/recommendation schema, risk model, lifecycle docs |
| New AI prompt | AI boundary, evidence package, prompt contract |
| New clone behavior | validation design, safety controls, audit requirements |
| New paid feature | product boundary and packaging notes |

## 6. Documentation Steward

The project must treat documentation maintenance as an automated responsibility,
not a memory task.

Target process:

```text
code diff
-> documentation impact scan
-> generated inventory refresh
-> missing docs detected
-> docs patch generated or PR blocked
```

Implementation options:

- PR checklist enforced manually in early phase
- local git hooks that regenerate generated docs and reject stale docs before
  commit/push
- documentation steward agent that reviews every feature branch and proposes doc
  updates
- scheduled documentation audit

Minimum immediate rule:

```text
Any collector, schema, API, insight, alert, recommendation, validation, or AI
change must include a documentation impact section before merge.
If the change affects migrations, collector SQL, API routes, UI endpoint
references, purge, partitions, or rollups, regenerate
docs/generated/project-inventory.md and
docs/generated/data-lifecycle-matrix.md and
docs/generated/data-family-contracts.md and
docs/generated/field-contracts.md and
docs/generated/contract-review-queue.md.
```

Run the local documentation impact checker before commit:

```text
node scripts/install-git-hooks.mjs
node scripts/check-doc-impact.mjs --staged
```

Fresh clone rule: `core.hooksPath` is local Git config. On every new clone or
new machine, run `node scripts/install-git-hooks.mjs` once. The `./pgstat`
helper also checks this setting and installs the hooks automatically when Node
is available; otherwise it prints the exact command.

## 7. Data Lifecycle Rules

Collected data has a lifecycle:

```text
proposed
-> collected
-> stored
-> exposed
-> used by UI/report/alert/recommendation
-> deprecated
-> removed
```

Every field must have:

- owner
- source
- PostgreSQL version availability
- unsupported-version behavior
- storage table/column
- retention policy and purge path
- rollup or no-rollup decision
- operational volume budget
- security classification
- API exposure
- UI/report consumers
- alert/recommendation consumers
- compatibility policy
- removal policy

If a field is added, its downstream potential must be documented.

If a field is removed or stops being collected, every downstream consumer must be
identified before implementation.

## 8. Contract Versioning

Contracts must be versioned.

Versioned objects:

- evidence package
- finding
- recommendation
- validation job
- validation result
- AI context package

Rules:

- additive changes are allowed in minor versions
- required field removal requires major version
- pgdbaagent must reject unsupported major versions clearly
- pgstat must preserve old records or provide a migration path

## 9. Testing Gates

Enterprise-grade changes require tests at the correct layer. The concrete
strategy — current baseline, per-layer commands, fixtures, and gap roadmap —
is in [Test Strategy](test-strategy.md).

| Layer | Required tests |
| --- | --- |
| Collector SQL | version compatibility, null handling, reset handling |
| API | type contract, pagination/range behavior, permission handling |
| UI | render state, empty/error/loading, critical workflow |
| Reasoning engine | deterministic fixtures and golden outputs |
| Evidence package | schema validation and backward compatibility |
| AI layer | prompt contract tests and evidence-only constraints |
| Clone validation | timeout, cleanup, before/after comparison, audit log |
| Migration | idempotency and upgrade path |

No production-critical behavior should rely only on manual testing.

## 10. Security And Safety Gates

Required for every feature:

- no secrets in logs or JSON output
- parameterized SQL only
- least-privilege database access
- explicit production vs clone distinction
- no production DDL unless approved operations mode explicitly allows it
- no AI direct database access
- audit log for state-changing actions
- rollback plan for approved operations

## 11. Release Discipline

Every release completes the
[Release Checklist Template](release-checklist-template.md). Versioning
follows semver via the `VERSION` file as defined in that template.

Every release must include:

- migration list
- changed collectors
- changed contracts
- new or deprecated fields
- changed alerts/reports/recommendations
- upgrade notes
- rollback notes where possible
- known compatibility limits

## 12. ADR Requirement

Architecture Decision Records live in [docs/adr/](adr/README.md), one file
per decision, written from [the ADR template](adr/ADR-template.md).

Architecture Decision Records are required for:

- product boundary changes
- pgstat/pgdbaagent contract changes
- data model changes that affect recommendations
- validation target design
- future clone provider design
- AI provider design
- paid/free packaging boundaries
- automatic or approved operation capabilities
- removal of collected data

ADR format:

```text
Title
Status
Context
Decision
Consequences
Alternatives considered
Affected docs
Affected code areas
```

## 13. Definition Of Done

A feature is done only when:

- implementation is complete
- tests pass
- migration is idempotent if present
- data contract impact is documented
- UI/API/report/alert/recommendation consumers are documented
- pgstat standalone behavior is preserved
- pgdbaagent contract impact is documented
- security review is complete for sensitive changes
- release notes are prepared

## 14. Immediate Governance Backlog

Required next documents or tools:

1. Data contract registry (done: `data-contract-registry.md`)
2. ADR template (done: `adr/ADR-template.md`, 2026-07-17)
3. PR checklist template (release checklist covers releases:
   `release-checklist-template.md`, 2026-07-17; per-PR checklist still open)
4. Evidence package schema v1 hardening
5. Recommendation schema v1 validation tests
6. Documentation impact checker rule hardening
7. Documentation steward agent workflow
