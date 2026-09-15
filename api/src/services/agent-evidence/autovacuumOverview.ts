// Yetenek 3: autovacuum genel gorunumu.
//
// Uc bagimsiz kanit tasir ve hicbirini digerinden turetmez:
//   1. Instance ayarlari — pencerede gecerli olan snapshot'tan
//   2. Pencere icindeki vacuum/analyze aktivitesi — delta toplamlari
//   3. Autovacuum worker gozlemi — activity snapshot'lari
//
// Nedensellik iddiasi YOKTUR. "Worker gorulmedi" ile "autovacuum calismadi"
// ayni sey degildir; ornekleme cozunurlugu kisa suren worker'lari kacirabilir.

import {
    CoverageEntry,
    EvidenceEnvelope,
    Limitation,
    MetricCatalog,
    TargetRef,
    buildEnvelope,
} from './contract';
import {
    TABLE_STATS_JOB_TYPE,
    applyJobRunEvidence,
    buildJobRunProbeQuery,
    buildRoundProbeQuery,
    readJobRunEvidence,
    toCoverageEntry,
} from './coverage';
import { runBoundedQueries } from './db';
import { ResolvedRange } from './timeRange';
import { asBigIntString, asFloat, asIso, asSafeInt } from './numeric';

/** Genel gorunumde raporlanan instance duzeyi autovacuum ayarlari. */
const TRACKED_SETTINGS = [
    'autovacuum',
    'autovacuum_max_workers',
    'autovacuum_naptime',
    'autovacuum_vacuum_threshold',
    'autovacuum_vacuum_scale_factor',
    'autovacuum_analyze_threshold',
    'autovacuum_analyze_scale_factor',
    'autovacuum_vacuum_cost_delay',
    'autovacuum_vacuum_cost_limit',
    'autovacuum_freeze_max_age',
];

export interface AutovacuumSettingValue {
    setting_name: string;
    setting_value: string;
    unit: string | null;
    /** Bu degerin olculdugu an — pencere disinda olabilir, acikca tasinir. */
    observed_at: string | null;
    /** true ise deger istenen pencerenin ICINDE olculmustur. */
    observed_in_range: boolean;
}

export interface AutovacuumOverviewData {
    settings: AutovacuumSettingValue[];
    /** Pencere icindeki toplam vacuum/analyze aktivitesi (delta toplami). */
    activity: {
        autovacuum_count: string | null;
        manual_vacuum_count: string | null;
        autoanalyze_count: string | null;
        manual_analyze_count: string | null;
        tables_observed: number;
        tables_with_autovacuum: number;
    };
    /**
     * Autovacuum worker gozlemi. `worker_observation_rounds` bir toplama
     * turunda en az bir autovacuum backend'i goruldugu tur sayisidir —
     * worker SAYISI degil.
     */
    worker_observations: {
        activity_rounds_total: number;
        worker_observation_rounds: number;
        distinct_worker_pids: number;
        first_observed_at: string | null;
        last_observed_at: string | null;
    };
}

const METRICS: MetricCatalog = {
    autovacuum_count: {
        unit: 'operations',
        kind: 'delta_sum',
        source: 'fact.pg_table_stat_delta.autovacuum_count_delta',
        estimate: false,
        null_means: 'Kaynak bu alani raporlamadi; sifir DEGILDIR.',
    },
    manual_vacuum_count: {
        unit: 'operations',
        kind: 'delta_sum',
        source: 'fact.pg_table_stat_delta.vacuum_count_delta',
        estimate: false,
        null_means: 'Kaynak bu alani raporlamadi; sifir DEGILDIR.',
    },
    autoanalyze_count: {
        unit: 'operations',
        kind: 'delta_sum',
        source: 'fact.pg_table_stat_delta.autoanalyze_count_delta',
        estimate: false,
        null_means: 'Kaynak bu alani raporlamadi; sifir DEGILDIR.',
    },
    manual_analyze_count: {
        unit: 'operations',
        kind: 'delta_sum',
        source: 'fact.pg_table_stat_delta.analyze_count_delta',
        estimate: false,
        null_means: 'Kaynak bu alani raporlamadi; sifir DEGILDIR.',
    },
    worker_observation_rounds: {
        unit: 'collection_rounds',
        kind: 'delta_sum',
        source: 'fact.pg_activity_snapshot',
        estimate: false,
        null_means: 'Olculmedi.',
        note:
            'Bir turda en az bir autovacuum backend gorulduyse sayilir. Kisa suren '
            + 'worker iki ornek arasinda basladi ve bitti ise gorunmez; bu yuzden '
            + 'dusuk deger "autovacuum calismadi" ANLAMINA GELMEZ.',
    },
};

export async function getAutovacuumOverview(
    target: TargetRef,
    range: ResolvedRange
): Promise<EvidenceEnvelope<AutovacuumOverviewData>> {
    const { from, to } = range.requested;
    const instancePk = target.instance_pk;
    const useHourly = range.effective.resolution !== 'raw';

    const statsTable = useHourly ? 'agg.pg_table_stat_hourly' : 'fact.pg_table_stat_delta';
    const statsTimeColumn = useHourly ? 'bucket_start' : 'sample_ts';

    // Ayni pencerede ham ve saatlik veri KARISTIRILMAZ: tek kaynaktan okunur.
    const activitySql = useHourly
        ? `
            select sum(autovacuum_count_sum)::bigint                    as autovacuum_count,
                   sum(vacuum_count_sum)::bigint                        as manual_vacuum_count,
                   sum(autoanalyze_count_sum)::bigint                   as autoanalyze_count,
                   sum(analyze_count_sum)::bigint                       as manual_analyze_count,
                   count(distinct (dbid, relid))::int                   as tables_observed,
                   count(distinct (dbid, relid))
                     filter (where autovacuum_count_sum > 0)::int       as tables_with_autovacuum
              from agg.pg_table_stat_hourly
             where instance_pk = $1
               and bucket_start >= $2::timestamptz
               and bucket_start <  $3::timestamptz
        `
        : `
            select sum(autovacuum_count_delta)::bigint                  as autovacuum_count,
                   sum(vacuum_count_delta)::bigint                      as manual_vacuum_count,
                   sum(autoanalyze_count_delta)::bigint                 as autoanalyze_count,
                   sum(analyze_count_delta)::bigint                     as manual_analyze_count,
                   count(distinct (dbid, relid))::int                   as tables_observed,
                   count(distinct (dbid, relid))
                     filter (where autovacuum_count_delta > 0)::int     as tables_with_autovacuum
              from fact.pg_table_stat_delta
             where instance_pk = $1
               and sample_ts >= $2::timestamptz
               and sample_ts <  $3::timestamptz
        `;

    const outcomes = await runBoundedQueries({
        // Ayar: pencerenin SONUNDAN once olculmus en son snapshot. now() KULLANILMAZ.
        settings: {
            text: `
                select distinct on (setting_name)
                       setting_name, setting_value, unit, snapshot_ts
                  from fact.pg_settings_snapshot
                 where instance_pk = $1
                   and setting_name = any($2::text[])
                   and snapshot_ts < $3::timestamptz
                 order by setting_name, snapshot_ts desc
            `,
            values: [instancePk, TRACKED_SETTINGS, to],
        },
        activity: { text: activitySql, values: [instancePk, from, to] },
        // Autovacuum worker gozlemi: tur basina en az bir backend.
        workers: {
            text: `
                with rounds as (
                    select snapshot_ts,
                           count(*) filter (
                               where backend_type = 'autovacuum worker'
                                  or query like 'autovacuum:%'
                           ) as worker_rows,
                           count(distinct pid) filter (
                               where backend_type = 'autovacuum worker'
                                  or query like 'autovacuum:%'
                           ) as worker_pids
                      from fact.pg_activity_snapshot
                     where instance_pk = $1
                       and snapshot_ts >= $2::timestamptz
                       and snapshot_ts <  $3::timestamptz
                     group by snapshot_ts
                )
                select count(*)::int                                          as activity_rounds_total,
                       count(*) filter (where worker_rows > 0)::int           as worker_observation_rounds,
                       coalesce(max(worker_pids), 0)::int                     as distinct_worker_pids,
                       min(snapshot_ts) filter (where worker_rows > 0)        as first_observed_at,
                       max(snapshot_ts) filter (where worker_rows > 0)        as last_observed_at
                  from rounds
            `,
            values: [instancePk, from, to],
        },
        statsProbe: buildRoundProbeQuery({
            table: statsTable,
            timeColumn: statsTimeColumn,
            instancePk,
            from,
            to,
        }),
        activityProbe: buildRoundProbeQuery({
            table: 'fact.pg_activity_snapshot',
            timeColumn: 'snapshot_ts',
            instancePk,
            from,
            to,
        }),
        settingsProbe: buildRoundProbeQuery({
            table: 'fact.pg_settings_snapshot',
            timeColumn: 'snapshot_ts',
            instancePk,
            from,
            to,
        }),
        jobRuns: buildJobRunProbeQuery({ instancePk, jobType: TABLE_STATS_JOB_TYPE, from, to }),
    });

    const jobs = readJobRunEvidence(outcomes.jobRuns);
    const limitations: Limitation[] = [];

    // --- Ayarlar ---------------------------------------------------------
    const settings: AutovacuumSettingValue[] = [];
    if (outcomes.settings.ok) {
        for (const row of outcomes.settings.rows) {
            const observedAt = asIso(row.snapshot_ts);
            const inRange = observedAt !== null && Date.parse(observedAt) >= Date.parse(from);
            settings.push({
                setting_name: String(row.setting_name),
                setting_value: String(row.setting_value),
                unit: row.unit === null || row.unit === undefined ? null : String(row.unit),
                observed_at: observedAt,
                observed_in_range: inRange,
            });
        }
    }

    const outOfRangeSettings = settings.filter((s) => !s.observed_in_range).map((s) => s.setting_name);
    if (outOfRangeSettings.length > 0) {
        limitations.push({
            code: 'settings_snapshot_outside_range',
            scope: 'fact.pg_settings_snapshot',
            message:
                `Su ayarlar icin istenen pencere ICINDE snapshot yok; pencereden ONCEKI son bilinen deger `
                + `raporlandi: ${outOfRangeSettings.join(', ')}. Ayarin pencere boyunca degismedigi KANITLANMIS degildir.`,
        });
    }
    const missingSettings = TRACKED_SETTINGS.filter(
        (name) => !settings.some((s) => s.setting_name === name)
    );
    if (missingSettings.length > 0) {
        limitations.push({
            code: 'settings_never_observed',
            scope: 'fact.pg_settings_snapshot',
            message: `Su ayarlar icin hic snapshot bulunamadi: ${missingSettings.join(', ')}.`,
        });
    }

    // --- Aktivite --------------------------------------------------------
    const activityRow = outcomes.activity.ok ? outcomes.activity.rows[0] ?? {} : {};
    const workerRow = outcomes.workers.ok ? outcomes.workers.rows[0] ?? {} : {};

    const workerRounds = asSafeInt(workerRow.worker_observation_rounds) ?? 0;
    const activityRounds = asSafeInt(workerRow.activity_rounds_total) ?? 0;

    if (activityRounds > 0 && workerRounds === 0) {
        limitations.push({
            code: 'no_worker_observed',
            scope: 'fact.pg_activity_snapshot',
            message:
                `${activityRounds} activity turunun hicbirinde autovacuum worker gorulmedi. `
                + 'Bu, autovacuum\'un calismadigini KANITLAMAZ: ornekleme araligindan kisa suren '
                + 'worker\'lar gorunmez. Ayrica worker satirinin yoklugu activity toplamasinin '
                + 'basarisiz oldugunu da gostermez.',
        });
    }

    const data: AutovacuumOverviewData = {
        settings,
        activity: {
            autovacuum_count: asBigIntString(activityRow.autovacuum_count),
            manual_vacuum_count: asBigIntString(activityRow.manual_vacuum_count),
            autoanalyze_count: asBigIntString(activityRow.autoanalyze_count),
            manual_analyze_count: asBigIntString(activityRow.manual_analyze_count),
            tables_observed: asSafeInt(activityRow.tables_observed) ?? 0,
            tables_with_autovacuum: asSafeInt(activityRow.tables_with_autovacuum) ?? 0,
        },
        worker_observations: {
            activity_rounds_total: activityRounds,
            worker_observation_rounds: workerRounds,
            distinct_worker_pids: asSafeInt(workerRow.distinct_worker_pids) ?? 0,
            first_observed_at: asIso(workerRow.first_observed_at),
            last_observed_at: asIso(workerRow.last_observed_at),
        },
    };

    const coverage: CoverageEntry[] = [
        applyJobRunEvidence(
            toCoverageEntry(
                {
                    source: statsTable,
                    capability: 'table_vacuum_statistics',
                    resolution: range.effective.resolution,
                    sampleUnit: useHourly ? 'hourly_bucket' : 'collection_round',
                },
                outcomes.statsProbe
            ),
            jobs
        ),
        toCoverageEntry(
            {
                source: 'fact.pg_settings_snapshot',
                capability: 'autovacuum_settings',
                resolution: null,
                sampleUnit: 'collection_round',
            },
            outcomes.settingsProbe
        ),
        toCoverageEntry(
            {
                source: 'fact.pg_activity_snapshot',
                capability: 'autovacuum_worker_activity',
                resolution: 'raw',
                sampleUnit: 'collection_round',
            },
            outcomes.activityProbe
        ),
    ];

    // Ayar kaynagi pencerede bos ama pencere oncesinden deger bulunduysa,
    // kapsam 'no_data' kalir fakat veri yine de raporlanir — bu kasitlidir:
    // kapsam neyin OLCULDUGUNU, data neyin BILINDIGINI tasir.
    if (asFloat(activityRow.autovacuum_count) === null && outcomes.activity.ok) {
        limitations.push({
            code: 'activity_counters_null',
            scope: statsTable,
            message:
                'Vacuum/analyze sayaclari NULL dondu. NULL sifira cevrilmedi; '
                + 'bu alanlarin bu pencerede raporlanmadigi anlamina gelir.',
        });
    }

    return buildEnvelope({
        capability: 'autovacuum_overview',
        target,
        requestedRange: range.requested,
        effectiveRange: range.effective,
        data,
        metricCatalog: METRICS,
        coverage,
        limitations,
        sources: [statsTable, 'fact.pg_settings_snapshot', 'fact.pg_activity_snapshot', 'ops.job_run_instance'],
    });
}
