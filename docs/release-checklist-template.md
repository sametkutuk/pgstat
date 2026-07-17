# pgstat Release Checklist Template

Date: 2026-07-17
Status: active
Owner: pgstat product direction

Copy this template into the release PR description (or a
`docs/releases/<version>.md` file for larger releases) and complete every
section. A section that does not apply is marked `not applicable`, never
deleted, so reviewers can see it was considered.

This template implements the release discipline in
[Platform Governance And SDLC](platform-governance-and-sdlc.md) (Section 11).

Related documents:

- [Test Strategy](test-strategy.md)
- [Project Execution Plan](project-execution-plan.md)
- [Data Contract Registry](data-contract-registry.md)

## Versioning Rule

The product version lives in the `VERSION` file and follows semver:

- **major**: breaking change to a stable contract (API response shape, stored
  data semantics, collector behavior consumers depend on)
- **minor**: additive capability (new collector, new table, new API route,
  new UI tab, new optional field)
- **patch**: bug fix, performance fix, docs-only or internal change

Contract compatibility classes (additive / breaking / deprecated / removed)
are defined in the governance document and must match the version bump.

---

## Release Checklist: pgstat vX.Y.Z

Date:
Release owner:
VERSION file updated: yes/no

### 1. Scope Summary

- What is in this release (one paragraph):
- Board tasks closed by this release:

### 2. Migration Impact

- New migrations (list `V###__*.sql`):
- Fresh-install apply verified: yes/no
- Upgrade apply verified from version <previous>: yes/no
- Idempotency concerns:
- New partitioned tables and PartitionManager wiring:
- Rollback path for schema changes (or `forward-only, reason:`):

### 3. Retention And Purge Impact

- New/changed data families and their retention policy:
- PurgeEvaluator wiring verified: yes/no/not applicable
- Expected storage growth per instance per day:

### 4. Collector Impact

- Changed collector jobs / source query families:
- PostgreSQL version coverage changes (new since_pg / removed_pg):
- Unsupported-version behavior verified: yes/no/not applicable
- New privileges required on target databases:

### 5. Contract Impact

- Field/data-family contracts added, changed, deprecated, or removed:
- Compatibility class (additive / breaking / deprecated / removed):
- `data-contract-registry.md` and generated docs regenerated: yes/no
- Downstream consumers notified/updated (API, UI, alerts, reports):

### 6. API Impact

- New/changed routes:
- Response shape changes and their compatibility class:
- Auth/permission changes:

### 7. UI Impact

- New/changed pages, tabs, charts:
- Empty/error/loading states covered:

### 8. Alerts And Reports Impact

- New/changed alert rules or thresholds:
- Report content or export changes:
- Telegram command/security changes:

### 9. Config And Deployment Impact

- New/changed environment variables or config keys:
- Default value changes:
- Deployment steps beyond `deploy.sh` standard flow:
- Service restart requirements (collector/API/UI):

### 10. Security Impact

- New sensitive data collected or exposed:
- Secret handling changes:
- Redaction/masking impact (see AI/export policy when defined):
- Security review needed and done: yes/no/not applicable

### 11. Testing Evidence

- `mvn test` result:
- `npx tsc --noEmit` (api) result:
- `npm run lint` + `tsc -b` (ui) result:
- Migration fresh/upgrade verification evidence:
- Manual verification notes for user-visible changes:

### 12. Documentation

- Master/execution plan/domain docs updated in this release: list
- Generated docs regenerated and committed: yes/no
- ADR written for architecture-level decisions: link or `not applicable`

### 13. Upgrade Notes (User-Facing)

- Steps an operator must take beyond pulling the release:
- Known compatibility limits:

### 14. Rollback Plan

- How to roll back the deployment:
- What cannot be rolled back (applied migrations, purged data) and mitigation:
