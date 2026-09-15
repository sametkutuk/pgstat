// Arastirma kuyrugu — gercek PostgreSQL uzerinde davranis testi.
//
// Kanitlanan sey "kod derleniyor" degil; es zamanlilik altinda isin tek
// sahibi oldugu, iptalin worker tarafindan EZILEMEDIGI ve olen worker'in
// isini kaybettirmedigi.
//
//   PGSTAT_QUEUE_TEST_URL=postgres://... node --import tsx --test tests/investigationQueue.spec.ts

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { cancelInvestigation } from '../src/services/investigationLifecycle';
import {
    MAX_ATTEMPTS,
    advanceInvestigation,
    claimNextInvestigation,
    finishInvestigation,
    heartbeatInvestigation,
    queueDepth,
    reclaimStaleInvestigations,
} from '../src/services/investigationQueue';

test('queue keeps one owner, cannot overwrite a cancellation, and loses no work', async () => {
    const url = process.env.PGSTAT_QUEUE_TEST_URL;
    assert.ok(url, 'PGSTAT_QUEUE_TEST_URL tek kullanimlik bir veritabanini gostermelidir');
    const pool = new Pool({ connectionString: url, max: 8 });

    try {
        // Mevcut semayi asla sifirlamayiz: sema varsa test durur.
        await pool.query('create schema control');
        await pool.query('create table control.instance_inventory (instance_pk bigint primary key)');
        await pool.query('insert into control.instance_inventory values (1)');
        for (const file of [
            'V120__ai_investigation_and_telemetry_improvement.sql',
            'V122__investigation_clarification.sql',
            'V123__investigation_worker_claim.sql',
        ]) {
            await pool.query(await readFile(`../db/migrations/${file}`, 'utf8'));
        }

        const create = async (status: string) => String((await pool.query(
            `insert into agent.investigation (question, instance_pk, time_from, time_to, status)
             values ('soru', 1, now() - interval '1 hour', now(), $1)
             returning investigation_id`, [status])).rows[0].investigation_id);

        // --- 1. Ayni is iki worker'a verilmez -----------------------------
        const a = await create('queued');
        const b = await create('queued');
        const waiting = await create('needs_clarification');

        const claims = await Promise.all(
            Array.from({ length: 6 }, (_, i) => claimNextInvestigation(pool, `worker-${i}`))
        );
        const claimed = claims.filter((c): c is NonNullable<typeof c> => c !== null);
        assert.equal(claimed.length, 2, 'yalnizca iki queued is vardi');
        assert.equal(new Set(claimed.map(c => String(c.investigation_id))).size, 2,
            'ayni is iki worker tarafindan alinmamali');
        assert.deepEqual(
            claimed.map(c => String(c.investigation_id)).sort(),
            [a, b].sort()
        );

        // needs_clarification kullaniciyi bekler, worker'i degil.
        const stillWaiting = await pool.query(
            'select status from agent.investigation where investigation_id = $1', [waiting]);
        assert.equal(stillWaiting.rows[0].status, 'needs_clarification');
        assert.equal(await claimNextInvestigation(pool, 'worker-x'), null, 'kuyruk bosalmali');

        const ownerOf = new Map<string, string>();
        for (const [i, c] of claims.entries()) if (c) ownerOf.set(String(c.investigation_id), `worker-${i}`);

        // --- 2. Sahiplik ve beklenen durum birlikte kontrol edilir ---------
        const ownerA = ownerOf.get(a)!;
        assert.deepEqual(
            await advanceInvestigation(pool, a, 'baska-worker', 'planning', 'collecting_evidence'),
            { outcome: 'superseded' }, 'baska worker ilerletememeli');
        assert.deepEqual(
            await advanceInvestigation(pool, a, ownerA, 'interpreting', 'completed' as never),
            { outcome: 'superseded' }, 'yanlis beklenen durumla ilerletilememeli');

        const advanced = await advanceInvestigation(pool, a, ownerA, 'planning', 'collecting_evidence');
        assert.deepEqual(advanced, { outcome: 'advanced', status: 'collecting_evidence' });

        // --- 3. IPTAL EZILEMEZ --------------------------------------------
        // Kullanici is worker'dayken iptal ediyor.
        const cancelled = await cancelInvestigation(pool, a);
        assert.equal(cancelled.outcome, 'cancelled');

        // Worker sonucu yazmaya calisiyor: hicbir sey degismemeli.
        assert.deepEqual(
            await finishInvestigation(pool, a, ownerA, 'completed'),
            { outcome: 'superseded' }, 'iptal edilmis arastirma completed olmamali');
        assert.deepEqual(
            await heartbeatInvestigation(pool, a, ownerA),
            { outcome: 'superseded' }, 'iptal sonrasi heartbeat kabul edilmemeli');

        const afterCancel = await pool.query(
            'select status, completed_at from agent.investigation where investigation_id = $1', [a]);
        assert.equal(afterCancel.rows[0].status, 'cancelled');

        // --- 4. Normal tamamlanma -----------------------------------------
        const ownerB = ownerOf.get(b)!;
        await advanceInvestigation(pool, b, ownerB, 'planning', 'collecting_evidence');
        await advanceInvestigation(pool, b, ownerB, 'collecting_evidence', 'interpreting');
        assert.deepEqual(
            await finishInvestigation(pool, b, ownerB, 'completed'),
            { outcome: 'advanced', status: 'completed' });
        const finished = await pool.query(
            `select status, completed_at, claimed_by, heartbeat_at
               from agent.investigation where investigation_id = $1`, [b]);
        assert.equal(finished.rows[0].status, 'completed');
        assert.notEqual(finished.rows[0].completed_at, null);
        assert.equal(finished.rows[0].claimed_by, null, 'is bitince sahiplik birakilmali');

        // --- 5. Olen worker'in isi kaybolmaz ------------------------------
        const c = await create('queued');
        const claimedC = await claimNextInvestigation(pool, 'olen-worker');
        assert.equal(String(claimedC!.investigation_id), c);
        assert.equal(claimedC!.attempt_count, 1);

        // Heartbeat taze iken geri alinmamali.
        assert.deepEqual(await reclaimStaleInvestigations(pool, 300), { requeued: [], timedOut: [] });

        // Heartbeat'i bayatlat.
        await pool.query(
            `update agent.investigation set heartbeat_at = now() - interval '10 minutes'
              where investigation_id = $1`, [c]);
        const reclaimed = await reclaimStaleInvestigations(pool, 300);
        assert.deepEqual(reclaimed.requeued, [c]);
        assert.deepEqual(reclaimed.timedOut, []);
        const requeued = await pool.query(
            'select status, claimed_by, attempt_count from agent.investigation where investigation_id = $1', [c]);
        assert.equal(requeued.rows[0].status, 'queued');
        assert.equal(requeued.rows[0].claimed_by, null);

        // --- 6. Sonsuz yeniden deneme yok ---------------------------------
        // attempt_count'u sinira tasi, sonra tekrar bayatlat.
        await pool.query(
            `update agent.investigation set attempt_count = $2 where investigation_id = $1`,
            [c, MAX_ATTEMPTS - 1]);
        const retry = await claimNextInvestigation(pool, 'yine-olen-worker');
        assert.equal(String(retry!.investigation_id), c);
        assert.equal(retry!.attempt_count, MAX_ATTEMPTS);
        await pool.query(
            `update agent.investigation set heartbeat_at = now() - interval '10 minutes'
              where investigation_id = $1`, [c]);
        const exhausted = await reclaimStaleInvestigations(pool, 300);
        assert.deepEqual(exhausted.timedOut, [c]);
        assert.deepEqual(exhausted.requeued, []);
        const timedOut = await pool.query(
            'select status, failure_code from agent.investigation where investigation_id = $1', [c]);
        assert.equal(timedOut.rows[0].status, 'timed_out');
        assert.equal(timedOut.rows[0].failure_code, 'worker_timeout');

        // --- 7. Bitmis ve iptal edilmis isler geri alinmaz -----------------
        await pool.query(
            `update agent.investigation set heartbeat_at = now() - interval '1 day'
              where investigation_id = any($1::bigint[])`, [[a, b, c]]);
        assert.deepEqual(await reclaimStaleInvestigations(pool, 1), { requeued: [], timedOut: [] },
            'terminal durumdaki isler kuyruga geri donmemeli');

        // --- 8. Kuyruk gozlemi --------------------------------------------
        const depth = await queueDepth(pool);
        assert.equal(depth.needs_clarification, 1);
        assert.equal(depth.queued, undefined, 'kuyrukta bekleyen is kalmamali');
    } finally {
        await pool.end();
    }
});
