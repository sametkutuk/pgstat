# Design Document: Per-Table Freeze Insights

## Overview

Per-table XID/MXID freeze izleme ozelligini ekler. Collector pg_class'tan relfrozenxid age verisi toplar, central DB'de fact.pg_table_freeze_snapshot'ta saklar. Insights'a Freeze sekmesi eklenir.

## Architecture

Mevcut V039 pattern (fact.pg_database_freeze_snapshot) birebir takip edilir, ek olarak per-table granularite eklenir.

## Components and Interfaces

- V078 migration: fact tablo + retention + schedule kolonlari
- PartitionManager: DAILY_FACT_TABLES'a ekleme
- NightlySnapshotCollector: collectTableFreeze + collectTableFreezeOnly
- JobOrchestrator: instance bazli interval tetigi
- PurgeEvaluator: partition drop + batched delete
- API: /insights/freeze/databases + /insights/freeze/tables
- UI: Freeze sekmesi + Settings retention/schedule

## Data Models

fact.pg_table_freeze_snapshot: snapshot_ts, instance_pk, dbid, schemaname, relname, relkind, relfrozenxid_age, relminmxid_age, relpages, last_autovacuum_at

## Correctness Properties

N/A - bu ozellik veri toplama + gosterim. Deterministik SQL mapping + UI render.

## Error Handling

- coalesce null-safe SQL
- on conflict do nothing (tekrar toplama)
- try/catch per-DB (tek DB hatasi digerleri durdurmasın)

## Testing Strategy

- mvn clean compile (Java)
- npx tsc --noEmit (API + UI)
- npm run build (UI)
- Mojibake tarama (rg)
