# pgstat Node Agent Requirements

Date: 2026-07-14
Status: draft decision
Owner: pgstat product/program direction

This document defines the product decision and V1 requirements for the
optional host-side pgstat agent.

Related documents:

- [Project Master](project-master.md)
- [Project Execution Plan](project-execution-plan.md)
- [pgstat Telemetry Completion Roadmap](pgstat-telemetry-completion-roadmap.md)
- [Data Contract Registry](data-contract-registry.md)

## 1. Decision

pgstat will have an optional first-party host agent:

```text
pgstat-node-agent
```

The official V1 path is:

```text
pgstat-node-agent runs on the database host or host-equivalent container/node
and pushes OS metrics, service health, host identity, and coverage metadata to
the central pgstat API.
```

The agent must not connect to the monitored PostgreSQL database and must not
run diagnostic SQL. PostgreSQL telemetry remains owned by the existing pgstat
collector.

## 2. Why A First-Party Agent

Existing tools such as node_exporter, windows_exporter, Telegraf, and
Prometheus are excellent metric collection tools, but they do not fully solve
pgstat's product requirements:

- PostgreSQL instance to host/container binding
- central pgstat API push with pgstat auth and tenant/fleet metadata
- PostgreSQL-related service health heartbeat
- PgBouncer/Patroni/pgpool-II/HAProxy/Keepalived state tracking
- missing/stale/partial coverage semantics
- evidence confidence for pgdbaagent
- pgstat retention, purge, partition, and consumer contracts
- deployment without forcing a Prometheus dependency

The agent should reuse mature OS collection libraries where practical. The
agent is pgstat-specific orchestration, identity, binding, coverage, and
transport logic. It should not re-invent every low-level OS counter parser.

## 3. Non-Goals

V1 must not:

- query the monitored PostgreSQL database
- require a database password
- start, stop, restart, or reconfigure services
- run arbitrary shell commands
- require root or sudo by default
- require Docker socket access by default
- require Prometheus to be installed
- treat missing OS data as healthy or zero
- give pgdbaagent high-confidence host evidence when binding confidence is low

## 4. Implementation Direction

Preferred implementation:

| Area | Decision |
| --- | --- |
| Language | Go |
| Packaging | single binary, Linux packages, Windows service package, Docker image |
| OS metrics | mature Go libraries and native OS APIs where practical |
| Linux sources | procfs, sysfs, cgroups, filesystem counters, optional systemd DBus |
| Windows sources | Service Control Manager, performance counters, WMI/CIM where needed |
| Transport | HTTPS push to central pgstat API |
| Auth | scoped ingest token, not DB credentials |
| Config | file/env/flags, no secret in logs |

Rationale:

- low memory footprint
- single static-ish binary distribution
- good Linux and Windows support
- clean systemd and Windows Service deployment
- good Docker/Kubernetes packaging story

## 5. Deployment Modes

### 5.1 Host Service

Default deployment for VM/bare-metal hosts.

- Linux: systemd service
- Windows: Windows Service
- Runs as least-privilege OS user where possible
- Reads OS counters and service state
- Pushes to central pgstat API

### 5.2 Container / Sidecar / DaemonSet

Supported for Docker and Kubernetes environments.

Default container mode should work without Docker socket:

- read-only `/proc` and `/sys` style mounts where accepted
- cgroup v1/v2 observation
- host filesystem metadata only where explicitly mounted

Docker socket is optional enrichment only. If enabled, it must be documented as
high privilege.

Kubernetes mode should prefer DaemonSet deployment and labels/annotations for
binding.

### 5.3 Exporter Bridge

If the customer already runs node_exporter, windows_exporter, Telegraf, or
Prometheus, pgstat may import or scrape from that source.

Exporter bridge is supported, but it is not the primary product path for V1.

### 5.4 SSH Fallback

SSH collection is allowed only as a fallback or onboarding bridge.

Rules:

- read-only OS user
- command allowlist
- short timeout and rate limit
- no sudo by default
- no arbitrary shell interpolation
- no service management
- Linux-first, not enterprise default
- failed SSH means stale/unknown, never healthy

SSH is not suitable for fast service heartbeat at fleet scale.

## 6. Data Families

### 6.1 Host Identity

The agent reports stable and observed host identity:

- agent id
- hostname
- machine id / cloud instance id / Windows MachineGuid where available
- IP addresses
- OS family
- OS distribution
- OS version
- kernel version
- architecture
- boot time where available
- source adapter
- collection coverage

Host identity and OS observation are time-versioned. OS changes must not
overwrite historical evidence.

### 6.2 Instance To Host / Container Binding

The central pgstat side owns binding reconciliation.

Required binding model:

```text
instance_pk
host_ref
container_ref optional
valid_from
valid_to
source
confidence
evidence
```

Binding precedence:

1. manual binding
2. explicit agent claim
3. Kubernetes/Docker label or annotation
4. listener/process match
5. cloud tag match
6. unbound or ambiguous

If binding is missing, stale, ambiguous, or low-confidence, pgdbaagent must not
use OS evidence as high-confidence proof.

### 6.3 OS Metrics

Minimum V1 metric groups:

| Group | Metrics |
| --- | --- |
| CPU | usage, user, system, iowait, steal, load average, core count |
| Memory | total, available, used, cache/buffers where available, swap |
| Disk device | read/write bytes, IOPS, latency, utilization, queue depth where available |
| Filesystem | total/free/used bytes, inode usage, mountpoint, filesystem type |
| Network | rx/tx bytes, errors, drops |
| Optional process | PostgreSQL process CPU and memory where safely available from OS evidence |
| Container | cgroup CPU, memory, I/O, restart/unhealthy signals where available |

Unsupported metrics are null with coverage metadata, not zero.

### 6.4 PostgreSQL-Related Service Health

The agent observes service state for PostgreSQL-related services:

- PostgreSQL server
- PgBouncer
- Patroni
- pgpool-II
- PostgreSQL traffic HAProxy/Keepalived when tagged or explicitly configured
- Docker/Kubernetes equivalents

The agent reports status only. It does not manage services.

Status values should include:

- running
- stopped
- failed
- unhealthy
- restarting
- restart_loop
- not_installed
- unknown

Service health must be separate from OS metric cadence.

Recommended V1 cadence:

| Data | Cadence |
| --- | --- |
| Service heartbeat | 5-15 seconds |
| OS metric sample | 30-60 seconds |
| Host identity refresh | 1 hour and on change |
| Container/service discovery refresh | 30-60 seconds and on change |

Fast alert candidates:

- bound PostgreSQL service running -> stopped/failed
- bound PgBouncer running -> stopped/failed
- Patroni role/state unhealthy
- container/pod restart loop
- service heartbeat stale

Alert evaluation and notification are owned by central pgstat, not by the
agent.

## 7. Security Requirements

The agent security baseline:

- no monitored PostgreSQL credentials
- central API token scoped to OS/service metric ingestion
- TLS required for production transport
- token masked in logs
- no arbitrary command execution
- no service management
- Docker socket disabled by default
- least-privilege OS user by default
- configuration and token files should use restrictive permissions
- every payload includes source adapter and coverage metadata
- local retry spool must not leak secrets

## 8. Reliability Requirements

The agent should:

- continue collecting when one metric group fails
- report partial coverage explicitly
- retry central API failures with backoff
- keep a bounded local spool
- avoid unbounded memory growth
- expose self-health locally and to central pgstat
- include agent version in every payload
- support rolling upgrade without losing host identity

Initial resource budget target:

| Resource | Target |
| --- | --- |
| Average CPU | under 1 percent on typical DB hosts |
| Memory | under 100 MB RSS target |
| Network | compact batched payloads, no high-cardinality flood |
| Disk spool | bounded and configurable |

## 9. Retention And Rollup

The central pgstat side owns retention and purge.

Recommended V1 defaults:

| Data family | Raw retention | Rollup |
| --- | ---: | --- |
| OS metric samples | 7-14 days | hourly and daily |
| Service health transitions | 90 days | daily state summary optional |
| Host/OS observation history | durable while referenced | not applicable |
| Instance-host binding history | durable while referenced | not applicable |
| Coverage events | 90 days | daily coverage summary optional |

Exact values must be wired to existing pgstat retention profiles before
implementation.

## 10. API Contract Sketch

Central ingestion should be versioned:

```text
POST /api/agent/v1/host-observation
POST /api/agent/v1/os-metrics
POST /api/agent/v1/service-heartbeat
POST /api/agent/v1/coverage
```

Payloads must include:

- agent id
- host identity
- observed_at
- source adapter
- agent version
- metric schema version
- coverage status
- units

The central API validates and normalizes. It must reject unknown schema
versions unless explicitly allowed.

## 11. Product Decision Summary

Final decision for V1:

```text
Build pgstat-node-agent as the official optional host agent.
Use mature OS libraries/native APIs for counters.
Keep exporter bridge support.
Keep SSH as a restricted fallback, not the default.
Do not load or query the monitored PostgreSQL database.
Track PostgreSQL-related service health with a faster heartbeat.
Keep binding and confidence explicit before pgdbaagent consumes OS evidence.
```
