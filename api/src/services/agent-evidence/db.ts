// Kanit sorgulari icin sinirli ve sizintisiz DB erisimi.
//
// Iki kural:
//
// 1. statement_timeout `SET LOCAL` ile, acik bir transaction icinde verilir.
//    Havuzdaki bir baglantiya `SET statement_timeout` yazmak ayari o
//    baglantiyi daha sonra kullanan BASKA bir istege tasir. `SET LOCAL`
//    transaction bitince geri alinir, sizinti olmaz.
//
// 2. Transaction READ ONLY acilir. Bu API kanit okur; yazma yolu yoktur.
//    Yanlislikla yazan bir sorgu sessizce calismak yerine hata verir.

import { PoolClient } from 'pg';
import { pool } from '../../config/database';

/** Tek bir kanit sorgusunun ust siniri. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;

/** PostgreSQL'in sorgu iptali icin urettigi SQLSTATE. */
const SQLSTATE_QUERY_CANCELED = '57014';

export function isTimeoutError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && (error as { code?: string }).code === SQLSTATE_QUERY_CANCELED;
}

export interface QuerySpec {
    text: string;
    values: unknown[];
}

/**
 * Read-only, zaman asimi sinirli bir transaction icinde birden cok sorgu
 * calistirir. Sorgular SIRAYLA calisir; her biri kendi sonucunu ya da kendi
 * hatasini tasir, biri digerini dusurmez.
 */
export async function runBoundedQueries<K extends string>(
    specs: Record<K, QuerySpec>,
    timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS
): Promise<Record<K, QueryOutcome>> {
    const client = await pool.connect();
    try {
        return await withReadOnlyTransaction(client, timeoutMs, async () => {
            const results = {} as Record<K, QueryOutcome>;
            for (const key of Object.keys(specs) as K[]) {
                results[key] = await runOne(client, specs[key]);
            }
            return results;
        });
    } finally {
        client.release();
    }
}

export type QueryOutcome =
    | { ok: true; rows: Record<string, unknown>[] }
    | { ok: false; timedOut: boolean; error: Error };

async function runOne(client: PoolClient, spec: QuerySpec): Promise<QueryOutcome> {
    try {
        const result = await client.query(spec.text, spec.values as never[]);
        return { ok: true, rows: result.rows as Record<string, unknown>[] };
    } catch (error) {
        // Zaman asimi transaction'i abort eder; sonraki sorgular da
        // calisamaz. Cagirici bunu 'partial' olarak raporlar.
        return { ok: false, timedOut: isTimeoutError(error), error: error as Error };
    }
}

/**
 * Transaction'i acar, SET LOCAL uygular ve her durumda kapatir.
 * Hata olsa bile ROLLBACK edilir; baglanti havuza temiz doner.
 */
async function withReadOnlyTransaction<T>(
    client: PoolClient,
    timeoutMs: number,
    body: () => Promise<T>
): Promise<T> {
    await client.query('begin read only');
    try {
        // SET LOCAL parametre alamaz; deger sayisal olarak dogrulanip gomulur.
        const safeTimeout = Math.max(1, Math.floor(timeoutMs));
        await client.query(`set local statement_timeout = ${safeTimeout}`);
        const out = await body();
        await client.query('commit');
        return out;
    } catch (error) {
        try {
            await client.query('rollback');
        } catch {
            // rollback da basarisizsa baglanti zaten kullanilamaz; release
            // eden taraf havuzdan dusurur.
        }
        throw error;
    }
}

/**
 * Tek sorgu icin kisayol. Hata firlatir — cagirici yakalayip coverage'a
 * 'failed' yazar.
 */
export async function queryBounded(
    spec: QuerySpec,
    timeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS
): Promise<Record<string, unknown>[]> {
    const out = await runBoundedQueries({ only: spec }, timeoutMs);
    if (!out.only.ok) throw out.only.error;
    return out.only.rows;
}
