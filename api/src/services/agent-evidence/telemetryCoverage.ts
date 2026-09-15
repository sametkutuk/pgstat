// Yetenek 2: bu arastirma icin gereken telemetri kapsami.
//
// Tek bir genel "complete" etiketi URETILMEZ. Tablo istatistigi kullanilabilir
// olsa bile pgss desteklenmiyor olabilir; bu ayrim kaynak bazinda korunur.
//
// Kapsam cevabinin amaci AI'in ONCE neyin olculebilir oldugunu ogrenmesidir,
// boylece olmayan veriyi yorumlamaya calismaz.

import {
    CoverageEntry,
    EvidenceEnvelope,
    GapCandidate,
    Limitation,
    TargetRef,
    buildEnvelope,
} from './contract';
import {
    CLUSTER_JOB_TYPE,
    STATEMENTS_JOB_TYPE,
    TABLE_STATS_JOB_TYPE,
    applyJobRunEvidence,
    buildJobRunProbeQuery,
    buildRoundProbeQuery,
    readJobRunEvidence,
    toCoverageEntry,
} from './coverage';
import { QueryOutcome, runBoundedQueries } from './db';
import { ResolvedRange } from './timeRange';
import { asIso } from './numeric';

/** Kapsam cevabinin `data` govdesi. */
export interface TelemetryCoverageData {
    /** pgss durumu — collector'un olctugu gercek extension durumu. */
    pg_stat_statements: {
        status: string;
        extversion: string | null;
        collection_dbname: string | null;
        preloaded: boolean | null;
        checked_at: string | null;
    } | null;
    /**
     * Tablo duzeyi autovacuum override'lari. Bu kaynak GECMIS TUTMAZ:
     * her toplama turunda UPSERT edilir, yalnizca su anki durumu bilinir.
     */
    table_level_overrides: {
        rows_present: boolean;
        last_updated_at: string | null;
        history_available: false;
    };
}

const SOURCES = {
    tableStatsRaw: 'fact.pg_table_stat_delta',
    tableStatsHourly: 'agg.pg_table_stat_hourly',
    settings: 'fact.pg_settings_snapshot',
    relopts: 'control.table_relopts_snapshot',
    activity: 'fact.pg_activity_snapshot',
    pgssRaw: 'fact.pgss_delta',
    capability: 'control.instance_capability',
};

export async function getTelemetryCoverage(
    target: TargetRef,
    range: ResolvedRange
): Promise<EvidenceEnvelope<TelemetryCoverageData>> {
    const { from, to } = range.requested;
    const instancePk = target.instance_pk;
    const useHourly = range.effective.resolution !== 'raw';

    const outcomes = await runBoundedQueries({
        tableStats: useHourly
            ? buildRoundProbeQuery({
                table: SOURCES.tableStatsHourly,
                timeColumn: 'bucket_start',
                instancePk,
                from,
                to,
            })
            : buildRoundProbeQuery({
                table: SOURCES.tableStatsRaw,
                timeColumn: 'sample_ts',
                instancePk,
                from,
                to,
            }),
        settings: buildRoundProbeQuery({
            table: SOURCES.settings,
            timeColumn: 'snapshot_ts',
            instancePk,
            from,
            to,
        }),
        activity: buildRoundProbeQuery({
            table: SOURCES.activity,
            timeColumn: 'snapshot_ts',
            instancePk,
            from,
            to,
        }),
        pgss: buildRoundProbeQuery({
            table: SOURCES.pgssRaw,
            timeColumn: 'sample_ts',
            instancePk,
            from,
            to,
        }),
        tableStatsJobRuns: buildJobRunProbeQuery({ instancePk, jobType: TABLE_STATS_JOB_TYPE, from, to }),
        statementsJobRuns: buildJobRunProbeQuery({ instancePk, jobType: STATEMENTS_JOB_TYPE, from, to }),
        clusterJobRuns: buildJobRunProbeQuery({ instancePk, jobType: CLUSTER_JOB_TYPE, from, to }),
        capability: {
            text: `
                select pgss_status, pgss_extversion, pgss_collection_dbname,
                       pgss_preloaded, pgss_checked_at
                  from control.instance_capability
                 where instance_pk = $1
            `,
            values: [instancePk],
        },
        relopts: {
            text: `
                select count(*)::int as row_count, max(updated_at) as last_updated_at
                  from control.table_relopts_snapshot
                 where instance_pk = $1
            `,
            values: [instancePk],
        },
    });

    const tableStatsJobs = readJobRunEvidence(outcomes.tableStatsJobRuns);
    const statementsJobs = readJobRunEvidence(outcomes.statementsJobRuns);

    const coverage: CoverageEntry[] = [
        applyJobRunEvidence(
            toCoverageEntry(
                {
                    source: useHourly ? SOURCES.tableStatsHourly : SOURCES.tableStatsRaw,
                    capability: 'table_vacuum_statistics',
                    resolution: range.effective.resolution,
                    sampleUnit: useHourly ? 'hourly_bucket' : 'collection_round',
                },
                outcomes.tableStats
            ),
            tableStatsJobs
        ),
        applyJobRunEvidence(
            toCoverageEntry(
                {
                    source: SOURCES.settings,
                    capability: 'autovacuum_settings',
                    resolution: null,
                    sampleUnit: 'collection_round',
                },
                outcomes.settings
            ),
            null
        ),
        applyJobRunEvidence(
            toCoverageEntry(
                {
                    source: SOURCES.activity,
                    capability: 'autovacuum_worker_activity',
                    resolution: 'raw',
                    sampleUnit: 'collection_round',
                },
                outcomes.activity
            ),
            null
        ),
        buildPgssCoverage(outcomes.capability, outcomes.pgss, statementsJobs),
    ];

    const limitations: Limitation[] = [
        {
            code: 'expected_sample_count_unknown',
            scope: 'coverage.*',
            message:
                'Beklenen ornek sayisi hesaplanmadi: zamanlama gecmisi saklanmiyor '
                + '(control.schedule_profile yalnizca bugunku araliklari tutar). '
                + 'Gozlenen bosluk verilir, kayip yuzdesi verilmez.',
        },
        {
            code: 'relopts_no_history',
            scope: SOURCES.relopts,
            message:
                'Tablo duzeyi autovacuum override kaynagi gecmis tutmaz (her turda UPSERT). '
                + 'Gecmis bir pencere icin o andaki override degeri bilinemez; yalnizca su anki durum bilinir.',
        },
    ];

    const gapCandidates: GapCandidate[] = [];
    const capabilityRow = outcomes.capability.ok ? outcomes.capability.rows[0] : undefined;
    const pgssStatus = capabilityRow ? String(capabilityRow.pgss_status) : null;

    // Yalnizca DOGRULANMIS urun eksigi aday olur.
    if (pgssStatus === 'not_installed') {
        gapCandidates.push({
            kind: 'DATA_NOT_COLLECTED',
            detail_code: 'pgss_not_installed',
            capability: 'query_performance_evidence',
            observed: 'control.instance_capability.pgss_status = not_installed',
            impact: 'Sorgu performansi kaniti uretilemez; autovacuum etkisi sorgu tarafinda olculemiyor.',
        });
    }
    if (pgssStatus === 'version_unknown') {
        gapCandidates.push({
            kind: 'DATA_INSUFFICIENT',
            detail_code: 'unknown_capability',
            capability: 'query_performance_evidence',
            observed: 'control.instance_capability.pgss_status = version_unknown',
            impact: 'pgss surumu bilinmedigi icin hangi kolonlarin guvenilir oldugu belirlenemiyor.',
        });
    }

    const reloptsRow = outcomes.relopts.ok ? outcomes.relopts.rows[0] : undefined;

    const data: TelemetryCoverageData = {
        pg_stat_statements: capabilityRow
            ? {
                status: String(capabilityRow.pgss_status),
                extversion: capabilityRow.pgss_extversion === null || capabilityRow.pgss_extversion === undefined
                    ? null
                    : String(capabilityRow.pgss_extversion),
                collection_dbname:
                    capabilityRow.pgss_collection_dbname === null || capabilityRow.pgss_collection_dbname === undefined
                        ? null
                        : String(capabilityRow.pgss_collection_dbname),
                preloaded: capabilityRow.pgss_preloaded === null || capabilityRow.pgss_preloaded === undefined
                    ? null
                    : capabilityRow.pgss_preloaded === true,
                checked_at: asIso(capabilityRow.pgss_checked_at),
            }
            : null,
        table_level_overrides: {
            rows_present: reloptsRow ? Number(reloptsRow.row_count) > 0 : false,
            last_updated_at: reloptsRow ? asIso(reloptsRow.last_updated_at) : null,
            history_available: false,
        },
    };

    return buildEnvelope({
        capability: 'telemetry_coverage',
        target,
        requestedRange: range.requested,
        effectiveRange: range.effective,
        data,
        coverage,
        limitations,
        gapCandidates,
        sources: Object.values(SOURCES),
    });
}

/**
 * pgss kapsami capability kaydiyla birlikte degerlendirilir.
 *
 * Ayrim onemli: satir olmamasi ile extension'in kurulu olmamasi farkli
 * seylerdir ve farkli statuse dusulur.
 */
function buildPgssCoverage(
    capabilityOutcome: QueryOutcome,
    pgssOutcome: QueryOutcome,
    jobs: ReturnType<typeof readJobRunEvidence>
): CoverageEntry {
    const base = applyJobRunEvidence(
        toCoverageEntry(
            {
                source: SOURCES.pgssRaw,
                capability: 'query_performance_evidence',
                resolution: 'raw',
                sampleUnit: 'collection_round',
            },
            pgssOutcome
        ),
        jobs
    );

    if (!capabilityOutcome.ok || capabilityOutcome.rows.length === 0) {
        return {
            ...base,
            status: base.sample_count > 0 ? base.status : 'unknown_capability',
            reason_code: base.sample_count > 0 ? base.reason_code : 'capability_unknown',
            note: 'control.instance_capability kaydi okunamadi; pgss destegi bilinmiyor.',
        };
    }

    const status = String(capabilityOutcome.rows[0].pgss_status);

    // Veri varsa capability durumu cevabi degistirmez — olculen sey kazanir.
    if (base.sample_count > 0) return base;

    switch (status) {
        case 'not_installed':
            return { ...base, status: 'not_collected', reason_code: 'collector_mapping_missing', note: 'pg_stat_statements kurulu degil.' };
        case 'unsupported':
            return { ...base, status: 'unsupported_version', reason_code: 'version_unsupported', note: 'pg_stat_statements bu surumde desteklenmiyor.' };
        case 'version_incompatible':
            return { ...base, status: 'unsupported_version', reason_code: 'version_unsupported', note: 'pg_stat_statements surumu uyumsuz olarak kaydedilmis.' };
        case 'permission_denied':
            return { ...base, status: 'not_collected', reason_code: 'permission_denied_recorded', note: 'pg_stat_statements erisimi reddedilmis olarak kaydedilmis.' };
        case 'collection_failed':
            return { ...base, status: 'failed', reason_code: 'query_failed', note: 'pg_stat_statements toplamasi basarisiz olarak kaydedilmis.' };
        case 'version_unknown':
            return { ...base, status: 'unknown_capability', reason_code: 'capability_unknown', note: 'pg_stat_statements surumu bilinmiyor.' };
        default:
            return base;
    }
}
