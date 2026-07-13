# Agentic DBA Project Master Document

Date: 2026-07-13
Status: draft
Owner: pgstat / pgdbaagent product direction

This is the master project document for the pgstat + pgdbaagent product family.
It is the entry point for product positioning, architecture boundaries, data
collection rules, documentation ownership, and the long-term development model.

Related documents:

- [Agentic DBA Platform Architecture](agentic-dba-platform-architecture.md)
- [Platform Governance And SDLC](platform-governance-and-sdlc.md)
- [pgstat Telemetry Completion Roadmap](pgstat-telemetry-completion-roadmap.md)
- [pgstat Data Source Dictionary](pgstat-data-source-dictionary.md)
- [Data Contract Registry](data-contract-registry.md)
- [PostgreSQL Stat Views Matrix](pg-stat-views-matrix.md)

## 1. Product Thesis

The product family should become:

```text
Production-history-aware, clone-validated PostgreSQL DBA intelligence.
```

The platform is one product family with two clear responsibilities:

```text
pgstat Core =
  standalone PostgreSQL telemetry, monitoring, alerting, reporting, and history

pgdbaagent =
  advice, findings, AI explanation, validation analysis, and recommendations
```

This split is intentional:

- pgstat must remain useful without pgdbaagent.
- pgdbaagent must not duplicate pgstat history collection.
- AI must consume structured evidence, not raw guesses.
- clone/staging validation is user-provided in the early phase.
- production collection must stay read-only and safe.

## 2. Presentation Narrative

Short stakeholder version:

```text
pgstat observes PostgreSQL production behavior over time.
pgdbaagent turns that evidence into DBA findings and recommendations.
Clone or staging validation proves risky ideas away from production.
AI explains the evidence, tradeoffs, risk, and action plan.
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

## 3. Master Data Collection Rules

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

## 4. Collection Statement

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

## 5. Data Family Card Template

Every new collection family should have a short card before implementation:

```yaml
data_family: ...
status: proposed|active|deprecated|removed
purpose: ...
production_safety: read_only
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
volume_budget:
  expected_rows_per_instance_per_day: ...
  high_cardinality_keys: []
consumers:
  api: []
  ui: []
  alerts: []
  reports: []
  pgdbaagent_evidence: []
security:
  contains_query_text: true|false
  contains_host_or_app_metadata: true|false
  export_allowed: true|false
docs:
  source_dictionary: updated
  data_contract_registry: updated
  pg_version_matrix: updated
```

## 6. Current Product Boundary

Current boundary for planning:

| Area | Decision |
| --- | --- |
| pgstat standalone | Must always work independently. |
| pgdbaagent | Consumes pgstat contracts and produces reasoning/recommendations. |
| Clone lifecycle | User provides clone or staging database in early phases. pgstat does not create/destroy clones yet. |
| Production safety | pgstat production collectors stay read-only. |
| AI | AI explains structured evidence and recommendations; it does not invent evidence or connect directly to production. |
| Commercial split | pgstat Core can be free/community; advice, AI, validation, and advanced operations can be paid/pro/enterprise. |

## 7. Documentation Source Of Truth

| Concern | Source of truth |
| --- | --- |
| Product thesis and master rules | This document |
| Architecture and component boundaries | `agentic-dba-platform-architecture.md` |
| SDLC and change governance | `platform-governance-and-sdlc.md` |
| Current and planned pgstat telemetry | `pgstat-telemetry-completion-roadmap.md` |
| Source-level collection inventory | `pgstat-data-source-dictionary.md` |
| Field-level contracts and consumers | `data-contract-registry.md` |
| PostgreSQL version availability | `pg-stat-views-matrix.md` |

The master document should not duplicate every field or every SQL detail. It
keeps the project direction and non-negotiable rules. Domain documents hold the
detailed inventory.

## 8. Documentation Update Rule

Documentation is part of the implementation, not a follow-up task.

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
-> update this master document if a rule, boundary, or product decision changes
-> PR/review
```

Target automation:

- CI documentation impact checker
- PR checklist
- documentation steward agent
- scheduled docs audit

The project should eventually fail CI when collector/schema/API/reasoning
changes are missing required documentation updates.

## 9. Additional Rules To Add To The Current Criteria

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

## 10. Near-Term Project Work

Immediate documentation and platform work:

1. Complete field-level contracts for query workload, temp spill, WAL, cache,
   vacuum/table health, and settings evidence.
2. Add the P0 pgstat data gaps: catalog metadata, safe planner stats, validation
   storage contracts, deploy/application events, and full lock graph.
3. Define evidence package v1 for pgdbaagent.
4. Define signal/finding/recommendation schemas.
5. Build documentation impact checking.
6. Keep clone lifecycle user-provided until the evidence and reasoning layer is
   stable.

## 11. Decision Log

| Date | Decision |
| --- | --- |
| 2026-07-13 | pgstat remains standalone; pgdbaagent is the advice/reasoning layer. |
| 2026-07-13 | Clone lifecycle is user-provided in early phases; pgstat does not create/destroy clones yet. |
| 2026-07-13 | Production collection must be read-only. |
| 2026-07-13 | New telemetry must be PostgreSQL-version aware and column aware. |
| 2026-07-13 | New telemetry must have retention, purge, partition, and rollup/no-rollup decisions before implementation is complete. |
| 2026-07-13 | Documentation must be maintained as a project artifact and eventually checked automatically. |
