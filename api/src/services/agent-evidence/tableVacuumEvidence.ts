// Yetenek 5: secilen tablonun vacuum/analyze kanitlari.
//
// Bu endpoint tek bir tabloya odaklanir ve kimligi (instance + dbid + relid)
// ONCE dogrular. Ayni isimli baska bir veritabanindaki tablo asla karismaz.
//
// Surum kapisi: toplam autovacuum SURESI (total_autovacuum_time_ms_delta)
// PostgreSQL 18 ile geldi (bkz. V067). PG18 oncesinde bu alan "veri yok"
// degil, "bu surumde desteklenmiyor" olarak raporlanir.

import {
    CoverageEntry,
    EvidenceEnvelope,
    Limitation,
    MetricCatalog,
    TableRef,
    TargetRef,
    buildEnvelope,
} from './contract';
import {
    TABLE_STATS_JOB_TYPE,
    applyJobRunEvidence,
    buildJobRunProbeQuery,
    buildRoundProbeQuery,
    markStaleWithinRange,
    readJobRunEvidence,
    toCoverageEntry,
} from './coverage';
import { runBoundedQueries } from './db';
import { ResolvedRange } from './timeRange';
import { asBigIntString, asFloat, asIso, asSafeInt, round } from './numeric';

/** total_autovacuum_time_ms_delta bu surumden itibaren mevcut. */
const VACUUM_TIME_MIN_PG_MAJOR = 18;

export interface VacuumTimelinePoint {
    at: string;
    n_dead_tup: string | null;
    n_live_tup: string | null;
    n_mod_since_analyze: string | null;
    autovacuum_count_delta: string | null;
    vacuum_count_delta: string | null;
}

export interface TableVacuumEvidenceData {
    table: TableRef;
    current: {
        sample_at: string | null;
        n_dead_tup: string | null;
        n_live_tup: string | null;
        reltuples: string | null;
        reltuples_known: boolean;
        n_mod_since_analyze: string | null;
        last_vacuum_at: string | null;
        last_autovacuum_at: string | null;
        last_analyze_at: string | null;
        last_autoanalyze_at: string | null;
        /** Pencerenin SONUNA gore; bugunku saate gore degil. */
        seconds_since_vacuum: number | null;
    } | null;
    window_totals: {
        autovacuum_count: string | null;
        manual_vacuum_count: string | null;
        autoanalyze_count: string | null;
        manual_analyze_count: string | null;
        observed_rounds: number;
        /** PG18+ disinda null; nedeni coverage'da 'unsupported_version'. */
        total_autovacuum_time_ms: number | null;
    };
    timeline: VacuumTimelinePoint[];
    /** Tablo duzeyi override — GECMIS YOK, yalnizca su anki kayit. */
    table_level_override: {
        autovacuum_enabled: boolean | null;
        autovacuum_vacuum_cost_delay: number | null;
        autovacuum_vacuum_cost_limit: number | null;
        reloptions_raw: string | null;
        updated_at: string | null;
        applies_to_requested_range: false;
    } | null;
}

const METRICS: MetricCatalog = {
    n_dead_tup: {
        unit: 'rows',
        kind: 'snapshot',
        source: 'fact.pg_table_stat_delta.n_dead_tup_estimate',
        estimate: true,
        null_means: 'Kaynak raporlamadi; sifir DEGILDIR.',
    },
    reltuples: {
        unit: 'rows',
        kind: 'snapshot',
        source: 'fact.pg_table_stat_delta.reltuples',
        estimate: true,
        null_means: 'Katalog satir sayisi bilinmiyor (PG14+ -1 sentinel ya da hic vacuum/analyze gormemis).',
    },
    autovacuum_count: {
        unit: 'operations',
        kind: 'delta_sum',
        source: 'fact.pg_table_stat_delta.autovacuum_count_delta',
        estimate: false,
        null_means: 'Kaynak raporlamadi; sifir DEGILDIR.',
    },
    total_autovacuum_time_ms: {
        unit: 'milliseconds',
        kind: 'delta_sum',
        source: 'fact.pg_table_stat_delta.total_autovacuum_time_ms_delta',
        estimate: false,
        null_means: 'PostgreSQL 18 oncesinde bu alan YOKTUR; veri eksikligi degil surum kisitidir.',
    },
};

export async function getTableVacuumEvidence(
    target: TargetRef,
    table: TableRef,
    identityLimitations: Limitation[],
    range: ResolvedRange,
    options: { maxTimelinePoints: number }
): Promise<EvidenceEnvelope<TableVacuumEvidenceData>> {
    const { from, to } = range.requested;
    const instancePk = target.instance_pk;
    const { dbid, relid } = table;

    const supportsVacuumTime = target.pg_major !== null && target.pg_major >= VACUUM_TIME_MIN_PG_MAJOR;
    const vacuumTimeExpr = supportsVacuumTime
        ? 'sum(total_autovacuum_time_ms_delta)::float8'
        : 'null::float8';

    const outcomes = await runBoundedQueries({
        current: {
            text: `
                select sample_ts, n_dead_tup_estimate, n_live_tup_estimate, reltuples,
                       n_mod_since_analyze, last_vacuum, last_autovacuum,
                       last_analyze, last_autoanalyze
                  from fact.pg_table_stat_delta
                 where instance_pk = $1 and dbid = $2::oid and relid = $3::oid
                   and sample_ts >= $4::timestamptz and sample_ts < $5::timestamptz
                 order by sample_ts desc
                 limit 1
            `,
            values: [instancePk, dbid, relid, from, to],
        },
        totals: {
            text: `
                select sum(autovacuum_count_delta)::bigint   as autovacuum_count,
                       sum(vacuum_count_delta)::bigint       as manual_vacuum_count,
                       sum(autoanalyze_count_delta)::bigint  as autoanalyze_count,
                       sum(analyze_count_delta)::bigint      as manual_analyze_count,
                       count(distinct sample_ts)::int        as observed_rounds,
                       ${vacuumTimeExpr}                     as total_autovacuum_time_ms
                  from fact.pg_table_stat_delta
                 where instance_pk = $1 and dbid = $2::oid and relid = $3::oid
                   and sample_ts >= $4::timestamptz and sample_ts < $5::timestamptz
            `,
            values: [instancePk, dbid, relid, from, to],
        },
        timeline: {
            text: `
                select sample_ts, n_dead_tup_estimate, n_live_tup_estimate,
                       n_mod_since_analyze, autovacuum_count_delta, vacuum_count_delta
                  from fact.pg_table_stat_delta
                 where instance_pk = $1 and dbid = $2::oid and relid = $3::oid
                   and sample_ts >= $4::timestamptz and sample_ts < $5::timestamptz
                 order by sample_ts
                 limit $6
            `,
            values: [instancePk, dbid, relid, from, to, options.maxTimelinePoints],
        },
        relopts: {
            text: `
                select autovacuum_enabled, autovacuum_vacuum_cost_delay,
                       autovacuum_vacuum_cost_limit, reloptions_raw, updated_at
                  from control.table_relopts_snapshot
                 where instance_pk = $1 and dbid = $2::oid and relid = $3::oid
            `,
            values: [instancePk, dbid, relid],
        },
        statsProbe: buildRoundProbeQuery({
            table: 'fact.pg_table_stat_delta',
            timeColumn: 'sample_ts',
            instancePk,
            from,
            to,
            extraPredicate: 'dbid = $4::oid and relid = $5::oid',
            extraValues: [dbid, relid],
        }),
        jobRuns: buildJobRunProbeQuery({ instancePk, jobType: TABLE_STATS_JOB_TYPE, from, to }),
    });

    const limitations: Limitation[] = [...identityLimitations];

    const currentRow = outcomes.current.ok ? outcomes.current.rows[0] : undefined;
    const reltuplesRaw = currentRow ? asBigIntString(currentRow.reltuples) : null;
    const reltuplesKnown = reltuplesRaw !== null && !reltuplesRaw.startsWith('-');

    const lastAnyVacuum = currentRow
        ? [asIso(currentRow.last_vacuum), asIso(currentRow.last_autovacuum)]
            .filter((v): v is string => v !== null)
            .sort()
            .pop() ?? null
        : null;

    const current = currentRow
        ? {
            sample_at: asIso(currentRow.sample_ts),
            n_dead_tup: asBigIntString(currentRow.n_dead_tup_estimate),
            n_live_tup: asBigIntString(currentRow.n_live_tup_estimate),
            reltuples: reltuplesKnown ? reltuplesRaw : null,
            reltuples_known: reltuplesKnown,
            n_mod_since_analyze: asBigIntString(currentRow.n_mod_since_analyze),
            last_vacuum_at: asIso(currentRow.last_vacuum),
            last_autovacuum_at: asIso(currentRow.last_autovacuum),
            last_analyze_at: asIso(currentRow.last_analyze),
            last_autoanalyze_at: asIso(currentRow.last_autoanalyze),
            seconds_since_vacuum: lastAnyVacuum === null
                ? null
                : round((Date.parse(to) - Date.parse(lastAnyVacuum)) / 1000, 0),
        }
        : null;

    if (currentRow && !reltuplesKnown) {
        limitations.push({
            code: 'reltuples_unknown',
            scope: 'current.reltuples',
            message:
                'Katalog satir sayisi bilinmiyor (PG14+ -1 sentinel ya da tablo hic vacuum/analyze gormemis). '
                + 'Esik ve oran hesaplarinda bu taban kullanilamaz.',
        });
    }

    const totalsRow = outcomes.totals.ok ? outcomes.totals.rows[0] ?? {} : {};
    const timeline: VacuumTimelinePoint[] = [];
    if (outcomes.timeline.ok) {
        for (const row of outcomes.timeline.rows) {
            timeline.push({
                at: asIso(row.sample_ts)!,
                n_dead_tup: asBigIntString(row.n_dead_tup_estimate),
                n_live_tup: asBigIntString(row.n_live_tup_estimate),
                n_mod_since_analyze: asBigIntString(row.n_mod_since_analyze),
                autovacuum_count_delta: asBigIntString(row.autovacuum_count_delta),
                vacuum_count_delta: asBigIntString(row.vacuum_count_delta),
            });
        }
    }

    const observedRounds = asSafeInt(totalsRow.observed_rounds) ?? 0;
    if (timeline.length >= options.maxTimelinePoints && observedRounds > timeline.length) {
        limitations.push({
            code: 'timeline_truncated',
            scope: 'data.timeline',
            message:
                `Zaman serisi ${options.maxTimelinePoints} noktada kesildi; pencerede ${observedRounds} `
                + 'toplama turu var. Daha dar bir pencere secin.',
        });
    }

    const reloptsRow = outcomes.relopts.ok ? outcomes.relopts.rows[0] : undefined;
    if (reloptsRow) {
        limitations.push({
            code: 'table_override_no_history',
            scope: 'data.table_level_override',
            message:
                'Tablo duzeyi autovacuum override kaydi gecmis tutmaz (her turda UPSERT edilir). '
                + `Gosterilen deger ${asIso(reloptsRow.updated_at) ?? 'bilinmeyen bir anda'} guncellenmis SU ANKI `
                + 'durumdur; istenen pencerede de gecerli oldugu KANITLANMIS degildir.',
        });
    }

    const jobs = readJobRunEvidence(outcomes.jobRuns);
    const coverage: CoverageEntry[] = [
        markStaleWithinRange(
            applyJobRunEvidence(
                toCoverageEntry(
                    {
                        source: 'fact.pg_table_stat_delta',
                        capability: 'table_vacuum_statistics',
                        resolution: 'raw',
                        sampleUnit: 'collection_round',
                    },
                    outcomes.statsProbe
                ),
                jobs
            ),
            to,
            // Bir saatten uzun gecikme bayat sayilir; esik pencere SONUNA goredir.
            3600
        ),
    ];

    // Surum kapisi ayri bir kapsam satiri olarak gorunur: "veri yok" degil,
    // "bu surumde yok".
    coverage.push({
        source: 'fact.pg_table_stat_delta.total_autovacuum_time_ms_delta',
        capability: 'autovacuum_duration',
        status: supportsVacuumTime ? 'ok' : 'unsupported_version',
        reason_code: supportsVacuumTime ? 'ok' : 'version_unsupported',
        resolution: 'raw',
        sample_unit: 'collection_round',
        sample_count: supportsVacuumTime ? observedRounds : 0,
        expected_sample_count: null,
        missing_sample_pct: null,
        earliest_sample_at: null,
        latest_sample_at: null,
        max_observed_gap_seconds: null,
        note: supportsVacuumTime
            ? null
            : target.pg_major === null
                ? 'PostgreSQL surumu bilinmiyor; autovacuum suresi destegi degerlendirilemedi.'
                : `Autovacuum suresi PostgreSQL ${VACUUM_TIME_MIN_PG_MAJOR}+ ile geldi; hedef PG ${target.pg_major}.`,
    });

    if (target.pg_major === null) {
        limitations.push({
            code: 'pg_version_unknown',
            scope: 'target.pg_major',
            message:
                'Hedefin PostgreSQL surumu bilinmiyor (capability kaydi yok). Surume bagli alanlarin '
                + 'durumu "desteklenmiyor" degil "bilinmiyor" olarak degerlendirilmelidir.',
        });
    }

    const data: TableVacuumEvidenceData = {
        table,
        current,
        window_totals: {
            autovacuum_count: asBigIntString(totalsRow.autovacuum_count),
            manual_vacuum_count: asBigIntString(totalsRow.manual_vacuum_count),
            autoanalyze_count: asBigIntString(totalsRow.autoanalyze_count),
            manual_analyze_count: asBigIntString(totalsRow.manual_analyze_count),
            observed_rounds: observedRounds,
            total_autovacuum_time_ms: supportsVacuumTime ? asFloat(totalsRow.total_autovacuum_time_ms) : null,
        },
        timeline,
        table_level_override: reloptsRow
            ? {
                autovacuum_enabled: reloptsRow.autovacuum_enabled === null || reloptsRow.autovacuum_enabled === undefined
                    ? null
                    : reloptsRow.autovacuum_enabled === true,
                autovacuum_vacuum_cost_delay: asSafeInt(reloptsRow.autovacuum_vacuum_cost_delay),
                autovacuum_vacuum_cost_limit: asSafeInt(reloptsRow.autovacuum_vacuum_cost_limit),
                reloptions_raw: reloptsRow.reloptions_raw === null || reloptsRow.reloptions_raw === undefined
                    ? null
                    : String(reloptsRow.reloptions_raw),
                updated_at: asIso(reloptsRow.updated_at),
                applies_to_requested_range: false,
            }
            : null,
    };

    return buildEnvelope({
        capability: 'table_vacuum_evidence',
        target,
        requestedRange: range.requested,
        effectiveRange: range.effective,
        data,
        metricCatalog: METRICS,
        coverage,
        limitations,
        sources: [
            'fact.pg_table_stat_delta',
            'control.table_relopts_snapshot',
            'dim.relation_ref',
            'ops.job_run_instance',
        ],
    });
}
