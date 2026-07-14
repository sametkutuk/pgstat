# Work Order: PGSTAT-P0-001 Critical Data-Family Contracts

Date: 2026-07-14
Status: ready for execution
Task: `PGSTAT-P0-001`
Owner role: Codex as project manager, product manager, lead developer, and first-pass tester
Customer role: Samet Kutuk as product owner and acceptance tester

## 1. Objective

Promote the next high-value generated data-family contracts from scaffolded
state to reviewed semantic contracts.

This is a documentation and contract-hardening task. It does not add new
database tables, migrations, collectors, APIs, or UI behavior.

## 2. Why This Comes Before More Coding

pgdbaagent, OS metrics, clone validation, and global reasoning will consume
pgstat data as evidence. If table-family semantics are weak, the advice layer
can produce confident but wrong recommendations.

This work makes the existing telemetry dependable before new telemetry is
added.

## 3. Inputs

Primary generated inputs:

- `docs/generated/contract-review-queue.md`
- `docs/generated/data-family-contracts.md`
- `docs/generated/data-lifecycle-matrix.md`
- `docs/generated/project-inventory.md`

Primary manual contract target:

- `docs/data-contract-registry.md`

Implementation sources to verify:

- `db/migrations/*.sql`
- `collector/src/main/java/com/pgstat/collector/repository/AggRepository.java`
- `collector/src/main/java/com/pgstat/collector/service/PurgeEvaluator.java`
- `collector/src/main/java/com/pgstat/collector/service/PartitionManager.java`
- `api/src/routes/insights.ts`
- `api/src/routes/instances.ts`
- `api/src/routes/statements.ts`
- `ui/src/pages/Insights.tsx`
- `ui/src/pages/InstanceDetail.tsx`
- `ui/src/pages/Instances.tsx`
- `ui/src/pages/StatementDetail.tsx`
- `ui/src/pages/Statements.tsx`

## 4. Selected Batch

The first P0-001 batch promotes aggregate and long-range history families
because they are used by Insights trends, reports, baselines, and future
pgdbaagent evidence packages. They also have retention and purge behavior that
must be exact before agentic reasoning uses long-range history.

Required batch:

| Order | Data family | Why selected |
| ---: | --- | --- |
| 1 | `agg.pgss_hourly` | Query trend source for Insights, statements, pgdbaagent workload history |
| 2 | `agg.pgss_daily` | Long-range query workload history and report source |
| 3 | `agg.pg_table_stat_hourly` | Vacuum Lag and table-health trend source |
| 4 | `agg.pg_wal_hourly` | WAL Spike trend, WAL baseline, instance WAL UI/report source |
| 5 | `agg.pg_wal_daily` | Long-range WAL volume and capacity history |
| 6 | `agg.pg_activity_hourly` | Long-range session/activity operational context |
| 7 | `agg.pg_lock_hourly` | Historical lock/wait trend and incident context |
| 8 | `agg.pg_replication_hourly` | Replication trend and lag history |
| 9 | `agg.pg_slru_hourly` | SLRU pressure trend and transaction/checkpoint context |
| 10 | `agg.pg_archiver_hourly` | Archiver backlog/failure long-range trend |

Stretch targets, only after the required batch is complete:

| Order | Data family | Why selected |
| ---: | --- | --- |
| 11 | `control.instance_inventory` | Fleet identity used by almost every API/UI/report path |
| 12 | `control.instance_state` | Health, success/error state, scheduling, and UI trust |

## 5. Explicit Non-Scope

This work order does not:

- promote field-level contracts beyond what is needed to describe the family
- define AI/export redaction policy; that is `PGSTAT-P0-011`
- implement OS metrics or pgstat-node-agent
- change retention values
- change purge SQL
- add or remove migrations
- change API or UI behavior

## 6. Required Contract Fields Per Family

Each promoted data family must have:

- semantics
- source family/table
- source collector/job or rollup job
- source PostgreSQL view/catalog/function where applicable
- schedule or rollup cadence
- retention policy field or durable-retention exception
- purge owner
- partitioning behavior
- rollup relationship
- API consumers
- UI consumers
- alert/report consumers
- pgdbaagent relevance
- sensitivity classification
- unsupported behavior
- contract status

## 7. Review Method

For each family:

1. Read generated row in `docs/generated/data-family-contracts.md`.
2. Read table DDL in migrations.
3. Verify write path in collector/repository/service code.
4. Verify purge and partition behavior.
5. Verify API/UI/report consumers with `rg`.
6. Update the manual registry or generator hints.
7. Regenerate generated docs.
8. Confirm queue count and promoted row status changed as expected.

## 8. Acceptance Criteria Mapping

Task AC1:

- At least the 10 required families above have reviewed semantic contracts.

Task AC2:

- Each promoted family explicitly states retention and purge behavior.

Task AC3:

- `docs/generated/contract-review-queue.md` reflects the reduced data-family
  review gap after regeneration.

## 9. Verification Commands

Required:

```text
node scripts/generate-doc-inventory.mjs
node scripts/generate-project-status.mjs
node scripts/check-project-board.mjs
node scripts/check-doc-impact.mjs --staged
git diff --check
```

Also run the local pre-commit and pre-push hooks before final push.

## 10. Done Flow

When Codex finishes the work:

1. Mark P0-001 acceptance criteria as `done`.
2. Add verification evidence to the task.
3. Set customer acceptance to `customer_validation`.
4. Push the branch.
5. Customer reviews the promoted contract batch.
6. Only after customer acceptance, set task status to `done` with
   `completed_at`.

## 11. Risk Controls

| Risk | Control |
| --- | --- |
| Generated scaffold is treated as semantic truth | Every promoted family must be verified against code and migrations |
| Retention/purge behavior is guessed | Must cite `PurgeEvaluator`, retention policy, or durable exception |
| UI/API consumers missed | Use `rg` and generated inventory before promotion |
| Sensitive fields leak into future AI evidence | Mark sensitivity and defer detailed AI policy to `PGSTAT-P0-011` |
| Scope expands into implementation | No code/migration/API behavior changes in this work order |
