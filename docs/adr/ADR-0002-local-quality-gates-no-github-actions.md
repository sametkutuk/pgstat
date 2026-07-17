# ADR-0002: Quality gates are enforced locally; GitHub Actions will not be used

Status: accepted
Date: 2026-07-17
Deciders: product owner (samet.kutuk)

## Context

GitHub Actions was disabled for billing reasons and the board carried a task
to "restore server-side CI". On 2026-07-17 the product owner decided GitHub
Actions will not be used at all, and asked for the CI problem to be solved
locally. Until then only documentation checks ran in hooks; collector tests
and api/ui type checks were manual.

## Decision

1. GitHub Actions (or any hosted CI) is not part of the project. Quality
   gates are enforced on the developer machine by git hooks.
2. The pre-push hook runs `scripts/check-quality-gates.mjs`, which detects
   which layers changed in the pushed range and runs their gates:
   collector -> `mvn test`, api -> `tsc --noEmit`, ui -> `tsc -b` + `eslint`.
3. `make verify` runs every gate unconditionally (full local CI run).
4. `PGSTAT_SKIP_GATES=1` is the documented emergency escape hatch; using it
   is expected to be rare and visible in the push output.
5. Fresh clones must run `node scripts/install-git-hooks.mjs` (already
   auto-checked by `./pgstat` at startup).

## Consequences

- No server-side enforcement: a contributor who bypasses hooks can push
  unchecked work. Accepted because the team is effectively a single
  developer; revisit this ADR if the team grows.
- Push time grows when collector code changes (mvn test runs). Accepted;
  layer detection keeps docs-only pushes fast.
- The gates require Node, Maven, and npm toolchains on the dev machine; a
  missing toolchain fails the push with a clear message.

## Alternatives Considered

- Restore GitHub Actions billing: rejected by product owner.
- Self-hosted runner: rejected for now; operational overhead not justified
  for a single-developer project.
- Post-receive checks on a git server: no self-managed git server exists.

## Affected Docs

- docs/test-strategy.md (Section 6 CI note)
- docs/platform-governance-and-sdlc.md
- docs/project-execution-plan.md (current state table)
- docs/project-board.json (PGSTAT-P1-006)

## Affected Code Areas

- .githooks/pre-push
- scripts/check-quality-gates.mjs
- Makefile (`verify` target)
