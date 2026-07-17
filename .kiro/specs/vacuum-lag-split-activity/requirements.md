# Requirements Document

## Introduction

Vacuum Lag grafiklerinde vacuum/analyze aktivitesini 4 ayri line olarak gostermek icin backend ve frontend degisiklikleri. Mevcut tekil `vacuum_count` alani yerine 4 ayri alan (manual vacuum, autovacuum, manual analyze, auto analyze) donulecek ve frontend'te Bar yerine 4 renkli Line ile render edilecek.

## Glossary

- **API**: Express.js backend (`api/src/routes/insights.ts`)
- **VacuumLagTrend_Endpoint**: `/api/insights/:id/vacuum-lag-trend` — instance geneli vacuum lag trend verisi donen endpoint
- **TableVacuumTrend_Endpoint**: `/api/insights/:id/table-vacuum-trend` — tablo bazli vacuum trend verisi donen endpoint
- **MainChart**: VacuumLagCardInner icerisindeki "Dead Tuple & Vacuum Aktivitesi" ComposedChart
- **ExpandPanel**: TableVacuumTrendPanel icerisindeki 3. grafik (mevcut "Vacuum Aktivitesi" BarChart)
- **fact_branch**: `fact.pg_table_stat_delta` tablosundan okuyan SQL dalı
- **agg_branch**: `agg.pg_table_stat_hourly` tablosundan okuyan SQL dalı

## Requirements

### Requirement 1: Backend 4 Ayri Alan

**User Story:** As a developer, I want the vacuum-lag-trend and table-vacuum-trend endpoints to return 4 separate activity counts (manual vacuum, autovacuum, manual analyze, auto analyze), so that the frontend can display each activity type independently.

#### Acceptance Criteria

1. WHEN the VacuumLagTrend_Endpoint is called, THE API SHALL return `vacuum_count_manual`, `vacuum_count_auto`, `analyze_count_manual`, and `analyze_count_auto` fields in each response row
2. WHEN the VacuumLagTrend_Endpoint is called, THE API SHALL NOT return the `vacuum_count` field in any response row
3. WHEN the VacuumLagTrend_Endpoint uses the fact_branch, THE API SHALL compute `vacuum_count_manual` as `sum(coalesce(vacuum_count_delta, 0))::bigint`
4. WHEN the VacuumLagTrend_Endpoint uses the fact_branch, THE API SHALL compute `vacuum_count_auto` as `sum(coalesce(autovacuum_count_delta, 0))::bigint`
5. WHEN the VacuumLagTrend_Endpoint uses the fact_branch, THE API SHALL compute `analyze_count_manual` as `sum(coalesce(analyze_count_delta, 0))::bigint`
6. WHEN the VacuumLagTrend_Endpoint uses the fact_branch, THE API SHALL compute `analyze_count_auto` as `sum(coalesce(autoanalyze_count_delta, 0))::bigint`
7. WHEN the VacuumLagTrend_Endpoint uses the agg_branch, THE API SHALL compute `vacuum_count_manual` as `sum(coalesce(vacuum_count_sum, 0))::bigint`
8. WHEN the VacuumLagTrend_Endpoint uses the agg_branch, THE API SHALL compute `vacuum_count_auto` as `sum(coalesce(autovacuum_count_sum, 0))::bigint`
9. WHEN the VacuumLagTrend_Endpoint uses the agg_branch, THE API SHALL compute `analyze_count_manual` as `sum(coalesce(analyze_count_sum, 0))::bigint`
10. WHEN the VacuumLagTrend_Endpoint uses the agg_branch, THE API SHALL compute `analyze_count_auto` as `sum(coalesce(autoanalyze_count_sum, 0))::bigint`

### Requirement 2: Table Vacuum Trend Endpoint 4 Ayri Alan

**User Story:** As a developer, I want the table-vacuum-trend endpoint to return 4 separate activity counts per table, so that the per-table expand panel can show granular vacuum/analyze breakdown.

#### Acceptance Criteria

1. WHEN the TableVacuumTrend_Endpoint is called, THE API SHALL return `vacuum_count_manual`, `vacuum_count_auto`, `analyze_count_manual`, and `analyze_count_auto` fields in each response row
2. WHEN the TableVacuumTrend_Endpoint is called, THE API SHALL NOT return the combined `vacuum_count` field in any response row
3. WHEN the TableVacuumTrend_Endpoint uses the fact_branch, THE API SHALL compute the 4 fields using `vacuum_count_delta`, `autovacuum_count_delta`, `analyze_count_delta`, and `autoanalyze_count_delta` columns
4. WHEN the TableVacuumTrend_Endpoint uses the agg_branch, THE API SHALL compute the 4 fields using `vacuum_count_sum`, `autovacuum_count_sum`, `analyze_count_sum`, and `autoanalyze_count_sum` columns

### Requirement 3: Frontend Ana Grafik 4 Line

**User Story:** As an operator, I want to see 4 separate colored lines for manual vacuum, autovacuum, manual analyze, and auto analyze in the main Vacuum Lag chart, so that I can distinguish which type of maintenance activity is running.

#### Acceptance Criteria

1. WHEN the MainChart renders, THE MainChart SHALL display 4 Line components on the right Y axis instead of the previous single Bar
2. THE MainChart SHALL use the following colors: Manuel Vacuum #059669 (yesil), Autovacuum #7C3AED (mor), Manuel Analyze #D97706 (turuncu), Auto Analyze #2563EB (mavi)
3. WHEN the MainChart renders Lines, THE MainChart SHALL set strokeWidth to 1.5, dot to false, and connectNulls to true for each Line
4. WHEN compare mode is active, THE MainChart SHALL display a single dashed gray line representing the total of all 4 previous values (previous_vacuum_total)
5. THE MainChart SHALL NOT render a Bar component for vacuum activity

### Requirement 4: Frontend Per-Table Panel 4 Line

**User Story:** As an operator, I want the per-table expand panel's vacuum chart to show 4 separate lines instead of a bar chart, so that I can see granular vacuum/analyze activity per table.

#### Acceptance Criteria

1. WHEN the ExpandPanel renders the vacuum activity chart, THE ExpandPanel SHALL use a LineChart with 4 Line components instead of a BarChart with Bar components
2. THE ExpandPanel SHALL use the same 4 colors as the MainChart: #059669, #7C3AED, #D97706, #2563EB
3. WHEN the ExpandPanel renders Lines, THE ExpandPanel SHALL set strokeWidth to 1.5, dot to false, and connectNulls to true for each Line
4. WHEN compare mode is active, THE ExpandPanel SHALL display a single dashed gray line representing the total of all 4 previous values
5. THE ExpandPanel chart title SHALL be "Vacuum & Analyze Aktivitesi"
6. THE ExpandPanel chart layout (colSpan) SHALL remain unchanged

### Requirement 5: Interface Guncellemeleri

**User Story:** As a developer, I want the TypeScript interfaces to reflect the new 4-field structure, so that type safety is maintained.

#### Acceptance Criteria

1. THE VacuumLagTrendPoint interface SHALL contain `vacuum_count_manual`, `vacuum_count_auto`, `analyze_count_manual`, and `analyze_count_auto` fields of type `string | number`
2. THE VacuumLagTrendPoint interface SHALL NOT contain the `vacuum_count` field
3. THE TableVacuumTrendPoint interface SHALL contain `vacuum_count_manual`, `vacuum_count_auto`, `analyze_count_manual`, and `analyze_count_auto` fields of type `string | number`
4. THE TableVacuumTrendPoint interface SHALL NOT contain the combined `vacuum_count` field
5. THE chartData mapping in VacuumLagCardInner SHALL produce `current_vacuum_manual`, `current_vacuum_auto`, `current_analyze_manual`, and `current_analyze_auto` data keys
6. THE chartData mapping in TableVacuumTrendPanel SHALL produce the same 4 data keys for current values and a single `previous_vacuum_total` for compare overlay
