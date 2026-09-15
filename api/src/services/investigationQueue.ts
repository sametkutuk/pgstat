// Arastirma kuyrugu — DB tabanli, tek yazan garantili is dagitimi.
//
// Ucuncu bir altyapi (Redis/Kafka) eklenmez; PostgreSQL'in kendi kilitleri
// yeterlidir. Bu dosyanin korudugu uc ozellik:
//
//  1. TEK SAHIP. Adayi secen alt sorgudaki SATIR KILIDI ile ayni is iki
//     worker'a verilmez. Olculdu (2026-09-15): kilit kaldirilinca alti worker
//     iki isi bes kez aldi; kilitle her zaman iki. `skip locked` DOGRULUK
//     icin degil — onsuz da dogru calisir, yalnizca worker'lar sirayla bekler.
//  2. IPTAL EZILEMEZ. Her gecis (id, BEKLENEN durum, sahip) uclusuyle
//     kosullanir. Kullanici isi iptal ettiyse worker'in yazmasi sifir satir
//     gunceller ve 'superseded' doner — iptal edilmis bir arastirma asla
//     'completed' olmaz.
//  3. KAYIP IS KALMAZ. Worker olurse heartbeat bayatlar, is geri alinir;
//     deneme sayisi sinira ulasinca sonsuz donguye girmeden 'timed_out' olur.

import type { Pool } from 'pg';

/** Worker'in ise basladiginda girdigi durum. */
export const FIRST_WORKING_STATE = 'planning' as const;

/** Worker'in sahiplendigi, ilerleme bekleyen durumlar. */
export const WORKING_STATES = ['planning', 'collecting_evidence', 'interpreting'] as const;
export type WorkingState = (typeof WORKING_STATES)[number];

/** Isin bittigi durumlar. */
export const TERMINAL_STATES = ['completed', 'insufficient_evidence', 'failed', 'timed_out'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** Bu sayiya ulasan is yeniden kuyruga alinmaz. */
export const MAX_ATTEMPTS = 3;

/** Heartbeat bu sureden eskiyse is sahipsiz sayilir. */
export const DEFAULT_STALE_SECONDS = 300;

export interface ClaimedInvestigation {
    investigation_id: string;
    question: string;
    investigation_type: string;
    instance_pk: number | null;
    dbid: number | null;
    time_from: Date;
    time_to: Date;
    status: string;
    attempt_count: number;
}

/**
 * Siradaki isi atomik olarak alir.
 *
 * Dogrulugu saglayan `for update` satir kilididir: kilitli satir serbest
 * kalinca PostgreSQL alt sorgunun `status = 'queued'` kosulunu yeniden
 * degerlendirir ve is artik aday olmaz. `skip locked` bunun ustune yalnizca
 * bekleme suresini kaldirir; kaldirilirsa sonuc yine dogrudur, sadece
 * worker'lar sirayla bekler.
 *
 * Yalnizca 'queued' aday olur: 'needs_clarification' kullaniciyi bekler,
 * worker'i degil.
 */
export async function claimNextInvestigation(
    database: Pool,
    workerId: string
): Promise<ClaimedInvestigation | null> {
    const result = await database.query(
        `update agent.investigation inv
            set status        = $2,
                claimed_by    = $1,
                claimed_at    = now(),
                heartbeat_at  = now(),
                started_at    = coalesce(inv.started_at, now()),
                attempt_count = inv.attempt_count + 1,
                updated_at    = now()
          where inv.investigation_id = (
                select candidate.investigation_id
                  from agent.investigation candidate
                 where candidate.status = 'queued'
                 order by candidate.created_at
                   for update skip locked
                 limit 1
          )
        returning investigation_id, question, investigation_type, instance_pk, dbid,
                  time_from, time_to, status, attempt_count`,
        [workerId, FIRST_WORKING_STATE]
    );
    return result.rows[0] ?? null;
}

export type TransitionOutcome =
    | { outcome: 'advanced'; status: string }
    /** Baskasi durumu degistirdi (tipik olarak kullanici iptal etti). */
    | { outcome: 'superseded' };

/**
 * Worker'in bir sonraki asamaya gecisi. Beklenen durum ve sahiplik birlikte
 * kontrol edilir; ikisinden biri tutmuyorsa hicbir sey yazilmaz.
 */
export async function advanceInvestigation(
    database: Pool,
    investigationId: string,
    workerId: string,
    expected: WorkingState,
    next: WorkingState
): Promise<TransitionOutcome> {
    const result = await database.query(
        `update agent.investigation
            set status = $4, heartbeat_at = now(), updated_at = now()
          where investigation_id = $1
            and claimed_by = $2
            and status = $3
        returning status`,
        [investigationId, workerId, expected, next]
    );
    return result.rowCount === 1
        ? { outcome: 'advanced', status: result.rows[0].status }
        : { outcome: 'superseded' };
}

/** Worker yasadigini bildirir; sahiplik dusmusse 'superseded' doner. */
export async function heartbeatInvestigation(
    database: Pool,
    investigationId: string,
    workerId: string
): Promise<TransitionOutcome> {
    const result = await database.query(
        `update agent.investigation
            set heartbeat_at = now(), updated_at = now()
          where investigation_id = $1
            and claimed_by = $2
            and status = any($3::text[])
        returning status`,
        [investigationId, workerId, WORKING_STATES as unknown as string[]]
    );
    return result.rowCount === 1
        ? { outcome: 'advanced', status: result.rows[0].status }
        : { outcome: 'superseded' };
}

/**
 * Isi sonlandirir.
 *
 * Kullanici bu arada iptal ettiyse sifir satir guncellenir ve sonuc YAZILMAZ.
 * Iptal edilmis bir arastirmanin 'completed' gorunmesi, kullaniciya
 * durdurdugu isin sonucunu gostermek demektir.
 */
export async function finishInvestigation(
    database: Pool,
    investigationId: string,
    workerId: string,
    state: TerminalState,
    failure?: { code: string; detail: string }
): Promise<TransitionOutcome> {
    const result = await database.query(
        `update agent.investigation
            set status         = $3,
                completed_at   = now(),
                failure_code   = $4,
                failure_detail = $5,
                claimed_by     = null,
                heartbeat_at   = null,
                updated_at     = now()
          where investigation_id = $1
            and claimed_by = $2
            and status = any($6::text[])
        returning status`,
        [
            investigationId, workerId, state,
            failure?.code ?? null, failure?.detail ?? null,
            WORKING_STATES as unknown as string[],
        ]
    );
    return result.rowCount === 1
        ? { outcome: 'advanced', status: result.rows[0].status }
        : { outcome: 'superseded' };
}

export interface ReclaimResult {
    requeued: string[];
    timedOut: string[];
}

/**
 * Heartbeat'i bayatlamis isleri geri alir.
 *
 * Deneme hakki kalmissa kuyruga doner; kalmamissa 'timed_out' edilir. Boylece
 * surekli coken bir worker ayni isi sonsuza kadar tekrar denemez.
 *
 * Yalnizca calisma durumundaki isler taranir: iptal edilmis ya da bitmis bir
 * is buradan asla geri gelmez.
 */
export async function reclaimStaleInvestigations(
    database: Pool,
    staleSeconds: number = DEFAULT_STALE_SECONDS
): Promise<ReclaimResult> {
    const result = await database.query(
        `with stale as (
            select investigation_id, attempt_count
              from agent.investigation
             where status = any($2::text[])
               and heartbeat_at is not null
               and heartbeat_at < now() - make_interval(secs => $1)
               for update skip locked
         )
         update agent.investigation inv
            set status         = case when stale.attempt_count >= $3 then 'timed_out' else 'queued' end,
                claimed_by     = null,
                claimed_at     = null,
                heartbeat_at   = null,
                completed_at   = case when stale.attempt_count >= $3 then now() else null end,
                failure_code   = case when stale.attempt_count >= $3 then 'worker_timeout' else null end,
                failure_detail = case when stale.attempt_count >= $3
                                      then 'Worker yasam isareti vermedi ve deneme hakki bitti'
                                      else null end,
                updated_at     = now()
           from stale
          where inv.investigation_id = stale.investigation_id
        returning inv.investigation_id, inv.status`,
        [staleSeconds, WORKING_STATES as unknown as string[], MAX_ATTEMPTS]
    );

    const requeued: string[] = [];
    const timedOut: string[] = [];
    for (const row of result.rows) {
        (row.status === 'timed_out' ? timedOut : requeued).push(String(row.investigation_id));
    }
    return { requeued, timedOut };
}

/** Kuyruk gozlemi — operasyonel gorunurluk icin. */
export async function queueDepth(database: Pool): Promise<Record<string, number>> {
    const result = await database.query(
        `select status, count(*)::int as count
           from agent.investigation
          where status = any($1::text[])
          group by status`,
        [['needs_clarification', 'queued', ...WORKING_STATES]]
    );
    const depth: Record<string, number> = {};
    for (const row of result.rows) depth[String(row.status)] = Number(row.count);
    return depth;
}
