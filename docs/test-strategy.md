# pgstat Test Strategy

Date: 2026-07-17
Status: active
Owner: pgstat product direction

This document defines how pgstat is tested: what exists today, what every
layer requires before its changes count as done, where fixtures live, and how
the strategy grows with the roadmap. It makes the testing gates in
[Platform Governance And SDLC](platform-governance-and-sdlc.md) (Section 9)
concrete and honest.

Related documents:

- [Platform Governance And SDLC](platform-governance-and-sdlc.md)
- [Project Execution Plan](project-execution-plan.md)
- [Release Checklist Template](release-checklist-template.md)
- [pgstat Data Source Dictionary](pgstat-data-source-dictionary.md)

## 1. Current Baseline (Honest State)

| Layer | Test framework | Current coverage | State |
| --- | --- | --- | --- |
| Collector (Java) | JUnit via Maven | 4 test classes: `DiscoveryCollectorTest`, `AdvisoryLockManagerTest`, `Pg13QueriesTest`, `Pg17_18QueriesTest` | minimal |
| API (Node/TS) | none | `npx tsc --noEmit` type check only, no runtime tests | gap |
| UI (React) | none | `tsc -b` + `eslint` only, no render tests | gap |
| Migrations | none | manual apply against dev DB | gap |
| Docs/governance | Node scripts | `check-project-board.mjs`, `check-doc-impact.mjs`, generated-doc drift check in hooks | active |
| pgdbaagent / evidence / validation | not implemented yet | tests must land with the first implementation, not after | planned |

This baseline is a known debt. The strategy below defines the target, and the
project board tracks closing the gap. No document may claim coverage that does
not exist.

## 2. Principles

1. Tests land in the same PR as the change they cover. Testing is part of the
   definition of done, not a follow-up task.
2. Version-sensitive collector SQL is the highest-risk surface. Every new
   source query family must have version/null behavior tests or documented
   fixtures before its contract is promoted.
3. No production-critical behavior relies only on manual testing.
4. Prefer a few honest, deterministic tests over broad flaky suites. No
   over-engineering: test the contract, not the implementation detail.
5. When a bug is fixed, a regression test that would have caught it is added
   in the same PR where practical.

## 3. Layer Requirements And Commands

### 3.1 Collector (Java, Maven)

Run: `cd collector && mvn test`

Required for changes:

- New/changed source query family (`sql/Pg*.java`): a `*QueriesTest` covering
  version gating (correct query per `server_version_num`), null/unsupported
  column behavior, and counter-reset handling where deltas are computed.
- New collector job: at least one unit test for job wiring/parse behavior
  (pattern: `DiscoveryCollectorTest`).
- Scheduler/locking changes: concurrency behavior test
  (pattern: `AdvisoryLockManagerTest`).

### 3.2 API (Node/TS)

Run today: `cd api && npx tsc --noEmit`

Target: introduce a runtime test runner (vitest, matching the TS/ESM stack)
with the first PR that changes route response shapes after this strategy is
adopted. Required from then on:

- Type contract: response shape of changed routes asserted against a fixture.
- Range/pagination behavior for time-series endpoints.
- Error behavior: missing instance, empty range, invalid params.

### 3.3 UI (React)

Run today: `cd ui && npm run lint && npx tsc -b`

Target: render tests only for critical workflows (Insights tabs, alert views),
added when those areas next change. Minimum per changed page: renders with
data, empty state, and error state. No snapshot-everything policy.

### 3.4 Migrations

Required for every new migration:

- Applies cleanly on an empty database (fresh install path).
- Applies cleanly on top of the previous released version (upgrade path).
- Idempotency where the migration framework re-runs are possible.

Until automated, this is verified manually against a disposable PG17 instance
(docker-compose) and recorded in the release checklist.

### 3.5 Docs And Governance

Run: `node scripts/check-project-board.mjs` and
`node scripts/check-doc-impact.mjs --staged` (both run in the pre-commit hook).
Generated-doc drift is rejected by the pre-push hook.

### 3.6 Future Layers (must ship with tests from day one)

- Evidence packages: JSON schema validation tests + backward compatibility.
- Reasoning engine: deterministic fixtures and golden outputs.
- AI layer: prompt contract tests, evidence-only constraint tests.
- Clone validation: timeout, cleanup, before/after comparison, audit log.
- Node agent ingestion: payload schema validation, unknown-version rejection.

## 4. Fixtures And Test Data

- Collector SQL fixtures live next to the tests under
  `collector/src/test/java/com/pgstat/collector/`.
- Future API/UI fixtures live under `api/test/fixtures/` and
  `ui/src/test/fixtures/` when those runners are introduced.
- Golden outputs for the reasoning engine will live with the pgdbaagent module
  when it exists; the location is decided in its first ADR.
- No production data in fixtures. Query text fixtures must be synthetic.

## 5. Integration Environment

- A disposable PostgreSQL 17 instance via `docker-compose.yml` is the
  reference integration target for migrations and collector smoke runs.
- Multi-version collector verification (PG 11-18 query families) is currently
  covered by unit tests on query selection, not live multi-version instances.
  Live multi-version smoke testing becomes required when a query family
  changes for a version we cannot unit-cover.

## 6. Quality Gate Summary

Before merge, a change must pass the gates for the layers it touches:

```text
collector change  -> mvn test
api change        -> npx tsc --noEmit (+ vitest once introduced)
ui change         -> npm run lint + tsc -b (+ render tests once introduced)
migration         -> fresh + upgrade apply check
any change        -> pre-commit hooks (board check, doc impact, generated docs)
release           -> release checklist template completed
```

CI note: GitHub Actions will not be used (see
[ADR-0002](adr/ADR-0002-local-quality-gates-no-github-actions.md)). Gates are
enforced locally: the pre-push hook runs `scripts/check-quality-gates.mjs`,
which detects changed layers in the pushed range and runs their gates
(collector -> `mvn test`, api -> `tsc --noEmit`, ui -> `tsc -b` + `eslint`).
`make verify` runs every gate unconditionally. `PGSTAT_SKIP_GATES=1` is the
emergency-only escape hatch.

## 7. Roadmap Alignment

| Gap | Closed by |
| --- | --- |
| API runtime tests | First route-shape PR after adoption introduces vitest |
| UI render tests | First critical-workflow UI PR after adoption |
| Migration automation | Release checklist manual step; revisit if the team grows |
| CI enforcement | Solved locally per ADR-0002 (pre-push layer gates + `make verify`) |
| pgdbaagent/evidence/validation tests | Bundled into PGSTAT-P0-013/P0-014/P0-016 acceptance criteria |
