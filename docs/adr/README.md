# Architecture Decision Records

This directory holds one file per architecture decision, numbered
sequentially. The ADR requirement and the list of decision types that demand
an ADR are defined in
[Platform Governance And SDLC](../platform-governance-and-sdlc.md)
(Section 12).

Rules:

- One decision per file: `ADR-####-short-kebab-title.md`.
- Use [ADR-template.md](ADR-template.md).
- An accepted ADR is immutable history. If a decision changes, write a new
  ADR that supersedes the old one and update both status lines.
- Small decisions stay in PR descriptions; boundary, contract, data model,
  AI, validation, and packaging decisions require a full ADR.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-0001](ADR-0001-product-family-baseline.md) | Product family baseline: pgstat Core + pgdbaagent boundary and collection rules | accepted |
| [ADR-0002](ADR-0002-local-quality-gates-no-github-actions.md) | Quality gates are enforced locally; GitHub Actions will not be used | accepted |
