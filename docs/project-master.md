# pgstat Project Master Document

Date: 2026-07-13
Status: draft
Owner: pgstat / pgdbaagent product direction

This is the master project document for the full pgstat product family. It is
not limited to agentic DBA work. It tracks the whole project: pgstat Core,
collector behavior, central storage, UI, Insights, reports, alerts, retention,
security, setup, pgdbaagent, validation targets, past decisions, current
capabilities, and planned capabilities.

The purpose of this document is to answer:

- What does the product do?
- What has already been built?
- What is planned next?
- How does each capability work?
- Which data does pgstat collect, store, expose, summarize, and purge?
- Which capability depends on which data contract?
- How does pgdbaagent consume pgstat evidence?
- Which docs must change when code changes?
- How do we keep documentation continuously current?

Related documents:

- [Agentic DBA Platform Architecture](agentic-dba-platform-architecture.md)
- [Platform Governance And SDLC](platform-governance-and-sdlc.md)
- [pgstat Telemetry Completion Roadmap](pgstat-telemetry-completion-roadmap.md)
- [pgstat Data Source Dictionary](pgstat-data-source-dictionary.md)
- [Data Contract Registry](data-contract-registry.md)
- [pgdbaagent Contracts](pgdbaagent-contracts.md)
- [PostgreSQL Stat Views Matrix](pg-stat-views-matrix.md)

## 1. Scope

This master document covers:

| Area | In scope |
| --- | --- |
| pgstat Core | Collector, central database, API, UI, dashboards, reports, alerts, setup, retention, security |
| pgstat Insights | Top Queries, Temp Spill, WAL Spike, Cache Hit, Vacuum Lag, future insight tabs |
| Fleet operations | Instance inventory, schedules, retention profiles, health state, Telegram/reporting |
| Data platform | Migrations, fact/snapshot/aggregate tables, purge, partitions, rollups |
| Data contracts | Source fields, PG version coverage, consumers, compatibility, evidence usage |
| pgdbaagent | Evidence packages, findings, recommendations, AI explanation, validation analysis |
| Validation targets | User-provided clone/staging targets and before/after evidence |
| Governance | SDLC, documentation, ADRs, security, release discipline |

This document does not replace detailed domain docs. It points to them and
records the project-wide rules and capability map.

## 2. Product Thesis

The product family should become:

```text
Production-history-aware PostgreSQL observability and DBA intelligence.
```

The long-term product family has two clear layers:

```text
pgstat Core =
  standalone PostgreSQL telemetry, monitoring, alerting, reporting, and history

pgdbaagent =
  advice, findings, AI explanation, validation analysis, and recommendations
```

Hard boundary:

- pgstat must remain useful without pgdbaagent.
- pgdbaagent must not duplicate pgstat central history collection.
- AI must consume structured evidence, not raw guesses.
- clone/staging validation is user-provided in the early phase.
- production collection must stay read-only and safe.

## 3. Product Narrative

Short stakeholder version:

```text
pgstat observes PostgreSQL production behavior over time.
It stores history, summarizes trends, renders dashboards, sends alerts, and
produces reports.

pgdbaagent consumes pgstat evidence, explains findings, proposes safe actions,
and compares validation results from user-provided clone/staging databases.
```

Competitive framing:

```text
PostgresAI is strong at clone validation.
DBtune is strong at parameter tuning.
pgstat + pgdbaagent aims to combine production history, settings context,
query evidence, clone validation, risk scoring, and AI-assisted explanation.
```

The advantage does not come from AI alone. It comes from:

- reliable telemetry
- historical baselines
- version-aware data contracts
- deterministic signals and findings
- safe validation targets
- structured evidence packages
- explicit risk and confidence models

## 4. Capability Ledger

Every capability should be tracked as one of:

```text
planned -> in_progress -> active -> deprecated -> removed
```

Current master capability map:

| Capability area | Current state | Main docs | Direction |
| --- | --- | --- | --- |
| Instance inventory | active | Data source dictionary, API/UI code | Keep standalone, add richer fleet reporting |
| Schedule profiles | active | Governance, code | All collectors must use central schedule ownership |
| Retention profiles | active | Telemetry roadmap, data contracts | No data family without purge/retention |
| PostgreSQL collectors | active | Data source dictionary | Complete catalog/stats/lock/event gaps |
| Fact/snapshot storage | active | Data model, migrations | Version-aware schemas and purge wiring |
| Hourly/daily rollups | active | Telemetry roadmap | Add rollups only where raw volume requires it |
| Instance detail UI | active | UI code, data contracts | Keep pgstat Core useful without advice engine |
| Insights Top Queries | active | Insights code, data contracts | Feed evidence packages |
| Insights Temp Spill | active | Insights code, data contracts | Feed memory/query-shape findings |
| Insights WAL Spike | active | Insights code, data contracts | Feed write/replication/checkpoint findings |
| Insights Cache Hit | active | Insights code, data contracts | Feed read/cache/index findings |
| Insights Vacuum Lag | active/in_progress | Insights code, telemetry roadmap | Feed autovacuum/table-health findings |
| Reports | active | Report code, governance | Keep export/audit/security rules explicit |
| Alerts/Telegram | active | Alert code, governance | Keep command security and audit strict |
| Security hardening | active | Governance, setup docs | Fail-fast config, secret hygiene, least privilege |
| Data contract registry | draft/active | Data contract registry | Promote high-value fields first |
| pgdbaagent evidence packages | planned | Architecture, future schema docs | Define v1 schemas before broad reasoning |
| Findings/recommendations | planned | Architecture, future schema docs | Deterministic first, AI explanation second |
| Clone/staging validation | planned | Architecture | User-provided targets first, no automatic clone lifecycle yet |
| Documentation automation | planned | Governance, this document | Add docs impact checker and steward workflow |

When a capability is added, changed, deprecated, or removed, this ledger or a
more detailed linked capability registry must be updated.

## 5. How pgstat Works

High-level pgstat flow:

```text
instance inventory
-> schedule profile
-> collector job
-> PostgreSQL source view/catalog/function
-> version-aware source query
-> delta/snapshot normalization
-> central fact/dimension/aggregate storage
-> rollup and purge
-> API
-> UI / reports / alerts / evidence packages
```

Important behavior:

- Collection is production read-only.
- Source SQL must be PostgreSQL-version and column aware.
- Unsupported fields are `null`, skipped, or marked unsupported.
- Cumulative counters are converted to deltas where needed.
- Snapshot state is stored as point-in-time evidence.
- Aggregates are built for long-range analysis.
- Purge and partition cleanup are central responsibilities.
- UI and reports must show missing/stale evidence honestly.

## 6. How pgdbaagent Should Work

pgdbaagent should consume documented pgstat contracts:

```text
pgstat evidence APIs / packages
-> deterministic signals
-> findings
-> recommendation candidates
-> optional clone/staging validation plan
-> before/after validation result
-> risk and confidence score
-> AI-assisted explanation
-> action plan and rollback plan
```

Rules:

- pgdbaagent does not become a second collector for pgstat-owned history.
- pgdbaagent may read clone/staging validation outputs.
- AI is not the source of truth.
- AI must not invent missing evidence.
- AI must not connect directly to production databases.
- Recommendations must keep production impact, validation evidence, risk, and
  confidence separate.

## 7. Master Data Collection Rules

All pgstat collection work must follow these rules.

| Rule | Meaning |
| --- | --- |
| Production safety | Production collectors are read-only. No production DDL, no workload experiments, no automatic `EXPLAIN ANALYZE` in production. |
| Version awareness | Every source field must declare PostgreSQL version coverage. Collector SQL must use `server_version_num`, capability rows, or query families to avoid missing-column failures. |
| Column awareness | A storage table may be a superset, but unsupported source columns must be skipped or stored as `null`, never treated as zero evidence. |
| Retention first | Every fact, snapshot, and aggregate table must have a retention policy, purge path, partition decision, and rollup/no-rollup decision. Nothing is kept forever by accident. |
| Schedule ownership | Collection cadence belongs to `control.schedule_profile` or a documented event trigger. No one-off cron behavior. |
| Purge ownership | Purge and partition cleanup belong to `PurgeEvaluator` and `PartitionManager` where relevant. |
| Volume budget | New high-cardinality data must estimate row volume, partition impact, index cost, and retention cost before implementation. |
| Privilege gate | Required PostgreSQL privileges must be documented. Lack of privilege must degrade gracefully and show coverage limits. |
| Security classification | Query text, settings, host names, application names, and event metadata must be classified for exposure, masking, export, and AI context use. |
| Data freshness | Collection status, last success, last error, lag, and missing coverage must be observable. Stale evidence must not look current. |
| Consumer mapping | Every field must list API, UI, alert, report, evidence package, and pgdbaagent consumers before being treated as stable. |
| Compatibility | Contract changes must declare additive, breaking, deprecated, or removed behavior. Removals require downstream impact analysis. |
| Testability | Collector SQL must have version/null behavior covered by tests or documented fixtures. |
| Documentation | The master document and related domain documents must be updated in the same PR as product, collector, schema, or reasoning changes. |

## 8. Collection Statement

pgstat collection must be implemented according to the master rules above.

For each collected data family, the project must record:

- source view/function/catalog
- required privilege
- PostgreSQL version and column coverage
- collector job and cadence
- storage table and column mapping
- semantics: snapshot, delta, aggregate, dimension, or derived finding
- retention policy and purge path
- rollup or no-rollup decision
- API/UI/report/alert consumers
- pgdbaagent evidence usage
- unsupported-version behavior
- security and export considerations
- expected row volume and operational cost

If this information is unknown, the data family is not ready to become a stable
collector contract.

## 9. Capability Card Template

Every new or changed capability should have a short card before implementation:

```yaml
capability: ...
status: planned|in_progress|active|deprecated|removed
product_area: pgstat_core|insights|alerts|reports|pgdbaagent|validation|security|setup
purpose: ...
user_visible_behavior: ...
production_safety: read_only|not_applicable|approved_operation
data_families:
  - ...
sources:
  - view: pg_stat_...
    columns:
      - name: ...
        since_pg: ...
        removed_pg: null
        unsupported_behavior: null|skip_field|skip_collector|error
privileges:
  - pg_read_all_stats
collector:
  job_type: ...
  cadence_source: control.schedule_profile....
  failure_behavior: ...
storage:
  tables:
    - fact....
  partitioned: true|false
  retention_policy_field: ...
  purge_owner: PurgeEvaluator
  rollup: none|hourly|daily|custom
api:
  routes: []
ui:
  pages_or_tabs: []
alerts_reports:
  alerts: []
  reports: []
pgdbaagent:
  evidence_packages: []
  findings: []
  recommendations: []
security:
  contains_query_text: true|false
  contains_host_or_app_metadata: true|false
  export_allowed: true|false
volume_budget:
  expected_rows_per_instance_per_day: ...
  high_cardinality_keys: []
docs:
  master: updated
  source_dictionary: updated
  data_contract_registry: updated
  pg_version_matrix: updated
```

## 10. Documentation Source Of Truth

| Concern | Source of truth |
| --- | --- |
| Product-wide scope, capability ledger, master rules | This document |
| Architecture and pgstat/pgdbaagent boundaries | `agentic-dba-platform-architecture.md` |
| SDLC and change governance | `platform-governance-and-sdlc.md` |
| Current and planned pgstat telemetry | `pgstat-telemetry-completion-roadmap.md` |
| Source-level collection inventory | `pgstat-data-source-dictionary.md` |
| Field-level contracts and consumers | `data-contract-registry.md` |
| pgdbaagent evidence, finding, recommendation, and reasoning contracts | `pgdbaagent-contracts.md` |
| PostgreSQL version availability | `pg-stat-views-matrix.md` |
| Generated code inventory | [Generated pgstat Project Inventory](generated/project-inventory.md) |
| Generated data lifecycle matrix | [Generated pgstat Data Lifecycle Matrix](generated/data-lifecycle-matrix.md) |
| Generated data family contracts | [Generated pgstat Data Family Contracts](generated/data-family-contracts.md) |
| Generated field contract scaffold | [Generated pgstat Field Contracts](generated/field-contracts.md) |
| Generated contract review queue | [Generated pgstat Contract Review Queue](generated/contract-review-queue.md) |

The master document should not duplicate every field or SQL detail. It keeps
the project-wide map, product boundaries, capability ledger, and non-negotiable
rules. Domain documents hold detailed inventory.

The generated inventory, lifecycle matrix, data family contracts, field
contracts, and review queue are mechanical and should be
regenerated whenever
migrations, collector SQL, API routes, UI endpoint references, purge, partition,
rollup ownership, schedule ownership, source ownership, or consumer mapping
changes:

```text
node scripts/generate-doc-inventory.mjs
# or on systems with make: make docs-inventory
```

## 11. Automatic Documentation Model

Documentation must stay current automatically as much as possible.

Target process:

```text
code diff
-> docs impact scanner
-> changed area detected
-> generated inventory refreshed
-> required docs identified
-> docs patch suggested or PR blocked
-> human review
-> merge
```

Triggers that must be detected:

| Change detected | Required docs |
| --- | --- |
| migration under `db/migrations` | data model, retention, source dictionary, data contract if exposed |
| collector SQL/source query | generated inventory, generated data family/field contracts, source dictionary, PG version matrix, data contract |
| new fact/snapshot/aggregate table | telemetry roadmap, retention/purge/partition notes |
| API route or response shape | generated inventory, generated data family/field contracts, data contract, capability docs |
| UI tab/card/chart | generated inventory, generated data family/field contracts, capability ledger, data contract consumers |
| alert/report behavior | governance, data contract consumers, user-facing docs |
| setup/config/security change | governance, setup/security notes |
| pgdbaagent schema/reasoning change | architecture, evidence/finding/recommendation docs |
| AI prompt/context change | AI boundary and evidence package docs |

Automation phases:

1. Manual PR checklist now.
2. Scripted docs impact checker via `node scripts/check-doc-impact.mjs --staged`.
3. Documentation steward agent after the checker is stable.
4. CI blocking for missing required docs after repository token/workflow scope is available.
5. Scheduled documentation audit.

## 12. Documentation Update Rule

Documentation is part of implementation, not a follow-up task.

Any PR must update documentation when it changes:

- product positioning
- pgstat vs pgdbaagent boundary
- collector behavior
- schema, migrations, retention, or purge behavior
- API contracts
- UI insights, reports, or alerts
- evidence packages
- findings or recommendations
- AI context
- clone/validation behavior
- security, permissions, or export behavior

Required minimum process:

```text
code change
-> documentation impact check
-> update domain docs
-> update this master document if a rule, boundary, capability, or product
   decision changes
-> PR/review
```

The project should eventually fail CI when collector/schema/API/reasoning
changes are missing required documentation updates.

## 13. Additional Criteria

The version-aware and retention rules are correct, but they need these
additional enterprise rules:

1. Data classification and masking: decide whether a field can appear in UI,
   exports, reports, alerts, and AI context.
2. Operational overhead budget: estimate collector query cost, row volume,
   storage growth, index cost, and partition count.
3. Freshness and quality tracking: every collector must expose whether evidence
   is current, stale, missing, or partially collected.
4. Privilege fallback: missing privileges should produce an explicit coverage
   gap, not silent wrong data.
5. Consumer map before stable use: no UI, alert, report, or recommendation
   should depend on an undocumented field.
6. Compatibility lifecycle: fields move through proposed, active, deprecated,
   and removed states.
7. Security review for sensitive data: query text, application names, host
   metadata, credentials, webhook data, and AI context need explicit handling.
8. Validation boundary: production evidence and clone/staging validation
   evidence must never be confused.

## 14. Near-Term Project Work

Immediate documentation and platform work:

1. Promote field-level contracts for query workload, temp spill, WAL, cache,
   vacuum/table health, and settings evidence.
2. Add the P0 pgstat data gaps: catalog metadata, safe planner stats, validation
   storage contracts, deploy/application events, and full lock graph.
3. Harden evidence package v1 for pgdbaagent.
4. Harden signal/finding/recommendation schemas.
5. Harden documentation impact checker rules over time.
6. Keep clone lifecycle user-provided until the evidence and reasoning layer is
   stable.

## 15. Decision Log

| Date | Decision |
| --- | --- |
| 2026-07-13 | The master document covers the whole pgstat product family, not only agentic DBA work. |
| 2026-07-13 | pgstat remains standalone; pgdbaagent is the advice/reasoning layer. |
| 2026-07-13 | Clone lifecycle is user-provided in early phases; pgstat does not create/destroy clones yet. |
| 2026-07-13 | Production collection must be read-only. |
| 2026-07-13 | New telemetry must be PostgreSQL-version aware and column aware. |
| 2026-07-13 | New telemetry must have retention, purge, partition, and rollup/no-rollup decisions before implementation is complete. |
| 2026-07-13 | Documentation must be maintained as a project artifact and eventually checked automatically. |
