// Kaynak basina kapsam olcumu.
//
// Bu dosyadaki butun sayimlar GOZLEMDIR. Ozellikle:
//
//  - Ornek sayisi = DISTINCT sample_ts. Satir sayisi degil: tek bir toplama
//    turunda yuzlerce tablo satiri yazilir; satirlari saymak toplama sikligini
//    yuzlerce kat abartir.
//  - `expected_sample_count` her zaman null. control.schedule_profile yalnizca
//    BUGUNKU araliklari tutar; zamanlama gecmisi saklanmaz. Bugunku araligi
//    gecmis bir pencereye uygulayip "su kadar tur kacirilmis" demek uydurma
//    olur.
//  - `max_observed_gap_seconds` gozlenen bosluktur. Toplama o aralikta hic
//    planlanmamis da olabilir; bu deger "kacirilmis tur" DEGILDIR.

import { CoverageEntry, ReasonCode, Resolution, SampleUnit, EvidenceStatus } from './contract';
import { asFloat, asIso, asSafeInt } from './numeric';
import { QueryOutcome, QuerySpec } from './db';

export interface CoverageProbe {
    source: string;
    capability: string;
    resolution: Resolution | null;
    sampleUnit: SampleUnit;
}

/**
 * Bir fact/agg tablosunun pencere icindeki toplama turlarini olcer.
 *
 * `extraPredicate` tablo/DB filtresi eklemek icindir ve YALNIZ sunucu
 * kodundan gelir; istemci metni asla buraya girmez.
 */
export function buildRoundProbeQuery(options: {
    table: string;
    timeColumn: string;
    instancePk: string | number;
    from: string;
    to: string;
    extraPredicate?: string;
    extraValues?: unknown[];
}): QuerySpec {
    const extra = options.extraPredicate ? ` and ${options.extraPredicate}` : '';
    return {
        text: `
            with rounds as (
                select distinct ${options.timeColumn} as ts
                  from ${options.table}
                 where instance_pk = $1
                   and ${options.timeColumn} >= $2::timestamptz
                   and ${options.timeColumn} <  $3::timestamptz
                   ${extra}
            ),
            gaps as (
                select ts, ts - lag(ts) over (order by ts) as gap
                  from rounds
            )
            select count(*)::int                              as sample_count,
                   min(ts)                                    as earliest_sample_at,
                   max(ts)                                    as latest_sample_at,
                   extract(epoch from max(gap))::float8       as max_gap_seconds
              from gaps
        `,
        values: [options.instancePk, options.from, options.to, ...(options.extraValues ?? [])],
    };
}

/**
 * Sonucu CoverageEntry'ye cevirir.
 *
 * Sifir satir `no_data` + `zero_rows_in_window` uretir. Bu bilincli olarak
 * "toplanmiyor" DEMEZ: neden bilinmiyordur. Toplama hatasi ayrica
 * ops.job_run_instance'tan dogrulanir (bkz. applyJobRunEvidence).
 */
export function toCoverageEntry(probe: CoverageProbe, outcome: QueryOutcome): CoverageEntry {
    if (!outcome.ok) {
        return {
            source: probe.source,
            capability: probe.capability,
            status: 'failed',
            reason_code: 'query_failed',
            resolution: probe.resolution,
            sample_unit: probe.sampleUnit,
            sample_count: 0,
            expected_sample_count: null,
            missing_sample_pct: null,
            earliest_sample_at: null,
            latest_sample_at: null,
            max_observed_gap_seconds: null,
            note: outcome.timedOut
                ? 'Kapsam sorgusu statement_timeout sinirinda iptal edildi.'
                : 'Kapsam sorgusu teknik hata ile sonuclandi.',
        };
    }

    const row = outcome.rows[0] ?? {};
    const sampleCount = asSafeInt(row.sample_count) ?? 0;

    return {
        source: probe.source,
        capability: probe.capability,
        status: sampleCount > 0 ? 'ok' : 'no_data',
        reason_code: sampleCount > 0 ? 'ok' : 'zero_rows_in_window',
        resolution: probe.resolution,
        sample_unit: probe.sampleUnit,
        sample_count: sampleCount,
        expected_sample_count: null,
        missing_sample_pct: null,
        earliest_sample_at: asIso(row.earliest_sample_at),
        latest_sample_at: asIso(row.latest_sample_at),
        max_observed_gap_seconds: asFloat(row.max_gap_seconds),
        note: sampleCount > 0
            ? null
            : 'Bu hedef ve pencerede kayit bulunamadi. Toplamanin kapali oldugu SONUCU CIKARILAMAZ.',
    };
}

// =============================================================================
// Toplama isi kaniti
// =============================================================================

/** Collector is tipi — pg_table_stat_delta'yi DbObjectsCollector yazar. */
export const TABLE_STATS_JOB_TYPE = 'db_objects';
export const STATEMENTS_JOB_TYPE = 'statements';
export const CLUSTER_JOB_TYPE = 'cluster';

export function buildJobRunProbeQuery(options: {
    instancePk: string | number;
    jobType: string;
    from: string;
    to: string;
}): QuerySpec {
    return {
        text: `
            select count(*)::int                                          as run_count,
                   count(*) filter (where status = 'success')::int        as success_count,
                   count(*) filter (where status = 'failed')::int         as failed_count,
                   count(*) filter (where status = 'partial')::int        as partial_count,
                   count(*) filter (where status = 'skipped')::int        as skipped_count,
                   min(started_at)                                        as earliest_run_at,
                   max(started_at)                                        as latest_run_at
              from ops.job_run_instance
             where instance_pk = $1
               and job_type = $2
               and started_at >= $3::timestamptz
               and started_at <  $4::timestamptz
        `,
        values: [options.instancePk, options.jobType, options.from, options.to],
    };
}

export interface JobRunEvidence {
    runCount: number;
    successCount: number;
    failedCount: number;
    partialCount: number;
    skippedCount: number;
    earliestRunAt: string | null;
    latestRunAt: string | null;
}

export function readJobRunEvidence(outcome: QueryOutcome): JobRunEvidence | null {
    if (!outcome.ok) return null;
    const row = outcome.rows[0] ?? {};
    return {
        runCount: asSafeInt(row.run_count) ?? 0,
        successCount: asSafeInt(row.success_count) ?? 0,
        failedCount: asSafeInt(row.failed_count) ?? 0,
        partialCount: asSafeInt(row.partial_count) ?? 0,
        skippedCount: asSafeInt(row.skipped_count) ?? 0,
        earliestRunAt: asIso(row.earliest_run_at),
        latestRunAt: asIso(row.latest_run_at),
    };
}

/**
 * Sifir satirin NEDENINI, uydurmadan, is kosumu kanitiyla daraltir.
 *
 * Yalnizca dogrulanabilen ayrimi yapar:
 *  - hic is kosumu yok            -> neden bilinmiyor (zero_rows_in_window korunur)
 *  - is kosmus ve basarisiz olmus -> collection_failed (dogrulanmis)
 *  - is kosmus ve basarili        -> veri gercekten yok (zero_rows_in_window,
 *                                    fakat notta basarili kosum sayisi verilir)
 *
 * Veri VARKEN bu fonksiyon durumu degistirmez.
 */
export function applyJobRunEvidence(entry: CoverageEntry, evidence: JobRunEvidence | null): CoverageEntry {
    if (entry.sample_count > 0 || entry.status === 'failed') return entry;
    if (evidence === null) return entry;

    if (evidence.runCount === 0) {
        return {
            ...entry,
            note:
                'Bu pencerede kayit yok ve bu hedef icin kayitli toplama isi de yok. '
                + 'Toplamanin planlanip planlanmadigi mevcut veriyle bilinemiyor.',
        };
    }

    if (evidence.successCount === 0 && (evidence.failedCount > 0 || evidence.partialCount > 0)) {
        return {
            ...entry,
            status: 'failed' as EvidenceStatus,
            reason_code: 'query_failed' as ReasonCode,
            note:
                `Bu pencerede ${evidence.runCount} toplama isi kaydi var ve hicbiri basarili degil `
                + `(failed=${evidence.failedCount}, partial=${evidence.partialCount}). `
                + 'Kayit yoklugu toplama hatasiyla aciklaniyor.',
        };
    }

    if (evidence.skippedCount > 0 && evidence.successCount === 0) {
        return {
            ...entry,
            note:
                `Bu pencerede ${evidence.skippedCount} toplama isi 'skipped' olarak kaydedilmis; `
                + 'toplama calismamis gorunuyor.',
        };
    }

    return {
        ...entry,
        note:
            `Bu pencerede ${evidence.successCount} basarili toplama isi var, fakat bu kaynak icin kayit yok. `
            + 'Bu, olcumun gercekten bos oldugunu gosterir; nedeni yine de kanitlanmis degildir.',
    };
}

// =============================================================================
// Bayatlik
// =============================================================================

/**
 * Bayatlik SADECE istenen pencereye gore degerlendirilir.
 *
 * Tarihsel bir pencere sorulduysa (orn. 3 ay once), verinin "bugune gore eski"
 * olmasi bayatlik DEGILDIR — dogru davranistir. Bu yuzden karsilastirma
 * noktasi `now()` degil, pencerenin sonudur.
 */
export function markStaleWithinRange(
    entry: CoverageEntry,
    rangeTo: string,
    staleThresholdSeconds: number
): CoverageEntry {
    if (entry.sample_count === 0 || entry.latest_sample_at === null) return entry;

    const latest = Date.parse(entry.latest_sample_at);
    const to = Date.parse(rangeTo);
    const lagSeconds = (to - latest) / 1000;
    if (lagSeconds <= staleThresholdSeconds) return entry;

    return {
        ...entry,
        status: 'stale',
        reason_code: 'data_stale',
        note:
            `Pencerenin sonuna gore son olcum ${Math.round(lagSeconds)} saniye geride. `
            + 'Bu, pencere icindeki en son gozlemdir; bugunku saate gore degil pencereye gore hesaplanmistir.',
    };
}
