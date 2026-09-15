# Repository Working Rules

## Measure Before Deciding

Never make a behavior, compatibility, performance, fleet-impact, or production-impact decision from code inspection or intuition alone.

- Use code and schema inspection to form a hypothesis, then verify the behavior with the closest safe measurement available.
- Run generated SQL against a real, disposable PostgreSQL instance when PostgreSQL behavior or version compatibility is involved.
- Measure performance claims with `EXPLAIN (ANALYZE, BUFFERS)` and record the workload size, environment, repetitions, and what the experiment does not prove.
- Check production/fleet data for impact claims when access is available. A zero value is not proof that a column exists, and a successful query is not proof that every field was populated correctly.
- Keep measured facts, inferences, and unknowns explicitly separate. Record the boundary of the evidence.
- If measurement contradicts an earlier claim, state the correction explicitly and update stale comments, logs, docs, and board evidence.
- Obtain test counts from a clean Maven test summary, not by summing possibly stale Surefire XML files.

Production collectors remain read-only. Run DDL, workload generation, destructive probes, and `EXPLAIN ANALYZE` only against disposable local/test PostgreSQL instances unless the user explicitly authorizes a different target.
