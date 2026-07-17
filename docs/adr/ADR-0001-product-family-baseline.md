# ADR-0001: Product family baseline: pgstat Core + pgdbaagent boundary and collection rules

Status: accepted
Date: 2026-07-13 (recorded as ADR on 2026-07-17)
Deciders: product owner (samet.kutuk), documented during the codex
projelendirme work

## Context

pgstat grew feature by feature without a project-wide architecture record.
Before adding an advice/reasoning layer (pgdbaagent) and OS-level telemetry,
the product needed explicit boundaries: what pgstat is, what the agent layer
is, and which rules every new data family must satisfy. These decisions were
made in the 2026-07-13 master document work; this ADR records them in the ADR
system so later changes have a formal decision to supersede.

## Decision

1. The product family has two layers: **pgstat Core** (standalone telemetry,
   monitoring, alerting, reporting, history) and **pgdbaagent** (advice,
   findings, AI explanation, validation analysis). pgstat must remain useful
   without pgdbaagent.
2. Production collection is **read-only**: no production DDL, no workload
   experiments, no automatic `EXPLAIN ANALYZE` in production.
3. AI consumes **structured evidence only**: it is not the source of truth,
   must not invent missing evidence, and must not connect directly to
   production databases.
4. Clone/staging validation targets are **user-provided** in early phases;
   pgstat does not create or destroy clones.
5. Every new telemetry family must be **PostgreSQL-version and column aware**
   and must have retention, purge, partition, and rollup/no-rollup decisions
   before its implementation is considered complete.
6. Documentation is a project artifact maintained in the same PR as the code
   change, enforced by local hooks and (eventually) CI.

## Consequences

- New features start as capability cards and contracts, which slows the first
  step but prevents unversioned, unretained data families.
- pgdbaagent work cannot begin coding before evidence contracts exist
  (tracked as PGSTAT-P0-007 and later on the project board).
- All guards are local (hooks) until server-side CI is restored.

## Alternatives Considered

- Single merged product (agent built into pgstat): rejected; pgstat must stay
  sellable/usable standalone and the reasoning layer has a different risk
  profile.
- AI-first advice without deterministic signals: rejected; explanations would
  not be auditable or reproducible.
- Automatic clone lifecycle from day one: rejected; too much operational risk
  before the evidence and reasoning layers are stable.

## Affected Docs

- docs/project-master.md (Sections 2, 6, 7, 15)
- docs/agentic-dba-platform-architecture.md
- docs/platform-governance-and-sdlc.md
- docs/pgdbaagent-contracts.md

## Affected Code Areas

- collector/ (read-only collection, version-aware SQL families)
- db/migrations (retention/purge/partition wiring)
- future pgdbaagent module (boundary constraints)
