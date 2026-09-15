// Yetenek 4: incelenecek tablo adaylari.
//
// SIRALAMA TESHIS DEGILDIR. Bu liste "su tablolarda sorun var" demez; yalnizca
// secilen olcute gore ONCE bakilmasi gereken tablolari verir. Olcut cevapta
// acikca tasinir ki AI onu sonuc sansin.
//
// Olcut, PostgreSQL'in KENDI autovacuum esigidir:
//     vacthresh = autovacuum_vacuum_threshold
//               + autovacuum_vacuum_scale_factor * reltuples
//
// Bu formul collector'daki yetkili uygulamayla ayni: AlertRuleEvaluator.java
// (bkz. findStaleStatisticsTables, analyze tarafinin ayni formulu). Ayni
// mantigin iki dilde bulunmasi kasitli bir tekrardir: Java collector'daki
// hesap Node API'den cagrilamaz. Bu yuzden formul burada gercek PostgreSQL'e
// karsi ayrica test edilir.
//
// reltuples tercih edilir cunku autovacuum'un kendi esigi onu kullanir ve
// istatistik sifirlanmasindan etkilenmez (bkz. V100__table_reltuples.sql).
// reltuples bilinmiyorsa (PG14+ -1 sentinel, ya da hic vacuum/analyze gormemis
// tablo) hangi tabana dusuldugu satir basina raporlanir.

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
import { asBigIntString, asFloat, asIso, asSafeInt, round } from './numeric';

/** Sunucu tarafinda tanimli siralama olcutleri — istemci metni SQL'e girmez. */
export const CANDIDATE_ORDERINGS = {
    /** Olu satirin PostgreSQL'in kendi vacuum esigine orani. */
    dead_vs_threshold: {
        sql: 'threshold_ratio desc nulls last, n_dead_tup desc nulls last',
        description:
            'Olu satir sayisinin, instance ayarlarindan hesaplanan PostgreSQL vacuum esigine orani. '
            + '1.0 uzeri "esik asilmis" demektir. Tablo boyutuna gore kendini olcekler.',
    },
    /** Mutlak olu satir sayisi. */
    dead_tuples: {
        sql: 'n_dead_tup desc nulls last',
        description: 'Mutlak olu satir tahmini. Buyuk tablolari one cikarir; esik bilgisi tasimaz.',
    },
    /** Son vacuum'dan bu yana gecen sure (pencere sonuna gore). */
    vacuum_age: {
        sql: 'seconds_since_vacuum desc nulls last, n_dead_tup desc nulls last',
        description:
            'Pencerenin SONUNA gore son vacuum uzerinden gecen sure. Bugunku saate gore degil; '
            + 'tarihsel pencere sorgulandiginda yanlis "bayat" damgasi vurmaz.',
    },
} as const;

export type CandidateOrdering = keyof typeof CANDIDATE_ORDERINGS;

export function parseOrdering(raw: unknown): CandidateOrdering {
    if (raw === undefined || raw === null || raw === '') return 'dead_vs_threshold';
    const value = String(raw);
    if (value in CANDIDATE_ORDERINGS) return value as CandidateOrdering;
    return 'dead_vs_threshold';
}

export interface VacuumCandidate {
    dbid: number;
    relid: number;
    datname: string | null;
    schemaname: string;
    relname: string;
    n_dead_tup: string | null;
    n_live_tup: string | null;
    n_mod_since_analyze: string | null;
    /** Esik hesabinda kullanilan satir sayisi tabani. */
    row_count_basis: string | null;
    row_count_source: 'reltuples' | 'n_live_tup_estimate' | 'unknown';
    /** PostgreSQL'in kendi formuluyle hesaplanan vacuum esigi. */
    vacuum_threshold: string | null;
    /** n_dead_tup / vacuum_threshold. 1.0 uzeri esik asilmis demektir. */
    threshold_ratio: number | null;
    threshold_exceeded: boolean | null;
    last_vacuum_at: string | null;
    last_autovacuum_at: string | null;
    /** Pencerenin SONUNA gore gecen sure. now() kullanilmaz. */
    seconds_since_vacuum: number | null;
    autovacuum_count_in_range: string | null;
    /** Bu tablonun pencerede kac toplama turunda gorundugu. */
    observed_rounds: number;
    sample_at: string | null;
}

const METRICS: MetricCatalog = {
    n_dead_tup: {
        unit: 'rows',
        kind: 'snapshot',
        source: 'fact.pg_table_stat_delta.n_dead_tup_estimate',
        estimate: true,
        null_means: 'Kaynak raporlamadi; sifir DEGILDIR.',
        note: 'PostgreSQL istatistik TAHMINIDIR, kesin olu satir sayisi degildir.',
    },
    row_count_basis: {
        unit: 'rows',
        kind: 'snapshot',
        source: 'fact.pg_table_stat_delta.reltuples (yoksa n_live_tup_estimate)',
        estimate: true,
        null_means: 'Satir sayisi tabani bilinmiyor; esik hesaplanamadi.',
        note: 'Hangi kaynagin kullanildigi row_count_source alanindadir.',
    },
    vacuum_threshold: {
        unit: 'rows',
        kind: 'ratio',
        source: 'fact.pg_settings_snapshot + reltuples (PostgreSQL formulu)',
        estimate: true,
        null_means: 'Ayarlar ya da satir sayisi tabani bilinmedigi icin hesaplanamadi.',
    },
    seconds_since_vacuum: {
        unit: 'seconds',
        kind: 'timestamp',
        source: 'greatest(last_vacuum, last_autovacuum) ile pencere sonu farki',
        estimate: false,
        null_means: 'Bu tablo icin hic vacuum zamani gozlenmedi; "hic vacuum edilmedi" ANLAMINA GELMEZ.',
    },
};

export async function getVacuumCandidates(
    target: TargetRef,
    range: ResolvedRange,
    options: { limit: number; ordering: CandidateOrdering; dbid: number | null }
): Promise<EvidenceEnvelope<{ ordering: string; ordering_description: string; candidates: VacuumCandidate[] }>> {
    const { from, to } = range.requested;
    const instancePk = target.instance_pk;

    // Aday listesi yalnizca HAM cozunurlukten uretilir: saatlik aggregate
    // reltuples ve n_mod_since_analyze tasimaz, dolayisiyla esik hesaplanamaz.
    const dbFilter = options.dbid === null ? '' : ' and d.dbid = $6::oid';
    const values: unknown[] = [instancePk, from, to, options.limit, to];
    if (options.dbid !== null) values.push(options.dbid);

    const outcomes = await runBoundedQueries({
        candidates: {
            text: `
                with settings as (
                    select
                        coalesce(max(case when setting_name = 'autovacuum_vacuum_threshold'
                                          then setting_value::numeric end), 50)  as base_thresh,
                        coalesce(max(case when setting_name = 'autovacuum_vacuum_scale_factor'
                                          then setting_value::numeric end), 0.2) as scale_factor
                      from (
                        select distinct on (setting_name) setting_name, setting_value
                          from fact.pg_settings_snapshot
                         where instance_pk = $1
                           and setting_name in ('autovacuum_vacuum_threshold',
                                                'autovacuum_vacuum_scale_factor')
                           and snapshot_ts < $5::timestamptz
                         order by setting_name, snapshot_ts desc
                      ) s
                ),
                -- Pencere ICINDEKI en son ornek. now() ya da sabit bir "son 7 gun"
                -- penceresi KULLANILMAZ: tarihsel sorgu kendi penceresini gorur.
                latest as (
                    select distinct on (d.dbid, d.relid)
                           d.dbid, d.relid, d.schemaname, d.relname, d.sample_ts,
                           d.n_dead_tup_estimate, d.n_live_tup_estimate,
                           d.n_mod_since_analyze, d.reltuples,
                           d.last_vacuum, d.last_autovacuum
                      from fact.pg_table_stat_delta d
                     where d.instance_pk = $1
                       and d.sample_ts >= $2::timestamptz
                       and d.sample_ts <  $3::timestamptz
                       ${dbFilter}
                     order by d.dbid, d.relid, d.sample_ts desc
                ),
                windowed as (
                    select d.dbid, d.relid,
                           sum(d.autovacuum_count_delta)::bigint as autovacuum_count_in_range,
                           count(distinct d.sample_ts)::int      as observed_rounds
                      from fact.pg_table_stat_delta d
                     where d.instance_pk = $1
                       and d.sample_ts >= $2::timestamptz
                       and d.sample_ts <  $3::timestamptz
                       ${dbFilter}
                     group by d.dbid, d.relid
                ),
                -- Satir sayisi tabani ayri bir adimda secilir; esik bir sonraki
                -- adimda ONUN uzerinden hesaplanir. Tek ifadede birlestirmek
                -- okunmasi zor ve hataya acik oluyordu.
                basis as (
                    select l.dbid, l.relid, l.schemaname, l.relname, l.sample_ts,
                           dbr.datname,
                           l.n_dead_tup_estimate                 as n_dead_tup,
                           l.n_live_tup_estimate                 as n_live_tup,
                           l.n_mod_since_analyze,
                           -- reltuples negatif/NULL ise bilinmiyordur (PG14+ -1 sentinel).
                           case
                             when l.reltuples is not null and l.reltuples >= 0 then l.reltuples
                             when l.n_live_tup_estimate is not null            then l.n_live_tup_estimate
                             else null
                           end                                   as row_count_basis,
                           case
                             when l.reltuples is not null and l.reltuples >= 0 then 'reltuples'
                             when l.n_live_tup_estimate is not null            then 'n_live_tup_estimate'
                             else 'unknown'
                           end                                   as row_count_source,
                           greatest(l.last_vacuum, l.last_autovacuum) as last_any_vacuum,
                           l.last_vacuum, l.last_autovacuum,
                           coalesce(w.autovacuum_count_in_range, 0)::bigint as autovacuum_count_in_range,
                           coalesce(w.observed_rounds, 0)::int    as observed_rounds
                      from latest l
                      left join windowed w on w.dbid = l.dbid and w.relid = l.relid
                      left join dim.database_ref dbr
                             on dbr.instance_pk = $1 and dbr.dbid = l.dbid
                ),
                scored as (
                    select b.*,
                           case
                             when b.row_count_basis is null then null
                             else (s.base_thresh
                                   + s.scale_factor * greatest(b.row_count_basis, 0))::bigint
                           end                                   as vacuum_threshold
                      from basis b
                      cross join settings s
                ),
                ranked as (
                    select scored.*,
                           case when vacuum_threshold is not null and vacuum_threshold > 0
                                     and n_dead_tup is not null
                                then n_dead_tup::numeric / vacuum_threshold::numeric
                                else null end                    as threshold_ratio,
                           case when last_any_vacuum is not null
                                then extract(epoch from ($5::timestamptz - last_any_vacuum))::float8
                                else null end                    as seconds_since_vacuum
                      from scored
                )
                select * from ranked
                 order by ${CANDIDATE_ORDERINGS[options.ordering].sql}
                 limit $4
            `,
            values,
        },
        statsProbe: buildRoundProbeQuery({
            table: 'fact.pg_table_stat_delta',
            timeColumn: 'sample_ts',
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

    const limitations: Limitation[] = [
        {
            code: 'ranking_is_not_diagnosis',
            scope: 'data.candidates',
            message:
                'Bu siralama bir teshis degildir. Olcut: '
                + CANDIDATE_ORDERINGS[options.ordering].description,
        },
        {
            code: 'threshold_formula_duplicated',
            scope: 'vacuum_threshold',
            message:
                'Esik formulu collector\'daki AlertRuleEvaluator ile ayni mantigi tekrar eder; '
                + 'Java kodu Node API\'den cagrilamadigi icin bu tekrar kacinilmazdir. '
                + 'Mevcut alarm kurali DEGISTIRILMEMISTIR.',
        },
        {
            code: 'dead_tuples_are_estimates',
            scope: 'n_dead_tup',
            message: 'Olu satir sayilari PostgreSQL tahminidir; kesin satir sayisi degildir.',
        },
    ];

    if (range.effective.resolution !== 'raw') {
        limitations.push({
            code: 'candidates_require_raw',
            scope: 'data.candidates',
            message:
                'Aday listesi yalnizca ham cozunurlukten uretilir: saatlik aggregate reltuples ve '
                + 'n_mod_since_analyze tasimaz, bu yuzden esik hesaplanamaz. Daha dar bir pencere isteyin.',
        });
    }

    const candidates: VacuumCandidate[] = [];
    if (outcomes.candidates.ok && range.effective.resolution === 'raw') {
        for (const row of outcomes.candidates.rows) {
            const source = String(row.row_count_source) as VacuumCandidate['row_count_source'];
            const ratio = asFloat(row.threshold_ratio);
            candidates.push({
                dbid: asSafeInt(row.dbid)!,
                relid: asSafeInt(row.relid)!,
                datname: row.datname === null || row.datname === undefined ? null : String(row.datname),
                schemaname: String(row.schemaname),
                relname: String(row.relname),
                n_dead_tup: asBigIntString(row.n_dead_tup),
                n_live_tup: asBigIntString(row.n_live_tup),
                n_mod_since_analyze: asBigIntString(row.n_mod_since_analyze),
                row_count_basis: asBigIntString(row.row_count_basis),
                row_count_source: source,
                vacuum_threshold: asBigIntString(row.vacuum_threshold),
                threshold_ratio: round(ratio, 4),
                threshold_exceeded: ratio === null ? null : ratio >= 1,
                last_vacuum_at: asIso(row.last_vacuum),
                last_autovacuum_at: asIso(row.last_autovacuum),
                seconds_since_vacuum: round(asFloat(row.seconds_since_vacuum), 0),
                autovacuum_count_in_range: asBigIntString(row.autovacuum_count_in_range),
                observed_rounds: asSafeInt(row.observed_rounds) ?? 0,
                sample_at: asIso(row.sample_ts),
            });
        }
    }

    const unknownBasis = candidates.filter((c) => c.row_count_source === 'unknown').length;
    if (unknownBasis > 0) {
        limitations.push({
            code: 'row_count_basis_unknown',
            scope: 'vacuum_threshold',
            message:
                `${unknownBasis} tablo icin satir sayisi tabani bilinmiyor (reltuples NULL/negatif ve `
                + 'n_live_tup da yok). Bu tablolar icin esik hesaplanmadi; tahmin uretilmedi.',
        });
    }

    const jobs = readJobRunEvidence(outcomes.jobRuns);
    const coverage: CoverageEntry[] = [
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
        toCoverageEntry(
            {
                source: 'fact.pg_settings_snapshot',
                capability: 'autovacuum_settings',
                resolution: null,
                sampleUnit: 'collection_round',
            },
            outcomes.settingsProbe
        ),
    ];

    return buildEnvelope({
        capability: 'vacuum_candidates',
        target,
        requestedRange: range.requested,
        effectiveRange: range.effective,
        data: {
            ordering: options.ordering,
            ordering_description: CANDIDATE_ORDERINGS[options.ordering].description,
            candidates,
        },
        metricCatalog: METRICS,
        coverage,
        limitations,
        sources: ['fact.pg_table_stat_delta', 'fact.pg_settings_snapshot', 'dim.database_ref', 'ops.job_run_instance'],
    });
}
