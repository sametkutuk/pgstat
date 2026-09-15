// Arastirma alimi — gercek PostgreSQL uzerinde davranis testi.
//
// Kullanici listeden instance secmek zorunda kalmamali. Bu testin kanitladigi
// sey, eksik hedefin ya GUVENLE cozuldugu ya da SORULDUGU; hicbir durumda
// tahmin yurutulmedigi.
//
//   PGSTAT_INTAKE_TEST_URL=postgres://... node --import tsx --test tests/investigationIntake.spec.ts

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
    DEFAULT_WINDOW_HOURS,
    decideIntake,
    resolveTarget,
    resolveWindow,
} from '../src/services/investigationIntake';
import { cancelInvestigation, ACTIVE_INVESTIGATION_STATES } from '../src/services/investigationLifecycle';

test('intake resolves or asks, never guesses, on disposable PostgreSQL', async () => {
    const url = process.env.PGSTAT_INTAKE_TEST_URL;
    assert.ok(url, 'PGSTAT_INTAKE_TEST_URL tek kullanimlik bir veritabanini gostermelidir');
    const pool = new Pool({ connectionString: url, max: 4 });

    try {
        // Mevcut semayi asla sifirlamayiz: sema varsa test durur.
        await pool.query('create schema control');
        await pool.query(`create table control.instance_inventory (
            instance_pk bigint primary key,
            display_name text not null,
            is_active boolean not null default true
        )`);
        await pool.query(await readFile('../db/migrations/V120__ai_investigation_and_telemetry_improvement.sql', 'utf8'));
        await pool.query(await readFile('../db/migrations/V122__investigation_clarification.sql', 'utf8'));

        const client = await pool.connect();
        try {
            // --- Hic aktif instance yok -> sorulur, uydurulmaz ----------------
            let target = await resolveTarget(client, null);
            assert.equal(target.kind, 'ask');
            let outcome = decideIntake(target as never, resolveWindow(null, null));
            assert.equal(outcome.status, 'needs_clarification');
            assert.equal(outcome.instancePk, null);
            assert.match(outcome.assistantMessages.join(' '), /Hangi instance/);

            // --- TEK aktif instance -> otomatik secilir, ama sessizce degil ---
            await pool.query(`insert into control.instance_inventory values (1, 'Tek Instance', true)`);
            target = await resolveTarget(client, null);
            assert.equal(target.kind, 'auto_single');
            outcome = decideIntake(target as never, resolveWindow(null, null));
            assert.equal(outcome.status, 'queued');
            assert.equal(outcome.instancePk, 1);
            assert.match(outcome.assistantMessages.join(' '), /Tek Instance/,
                'otomatik secim konusmaya yazilmali');

            // --- Iki aktif instance -> tahmin YOK, sorulur --------------------
            await pool.query(`insert into control.instance_inventory values (2, 'Ikinci Instance', true)`);
            target = await resolveTarget(client, null);
            assert.equal(target.kind, 'ask');
            assert.equal((target as { candidates: unknown[] }).candidates.length, 2);
            outcome = decideIntake(target as never, resolveWindow(null, null));
            assert.equal(outcome.status, 'needs_clarification');
            assert.equal(outcome.candidates.length, 2);

            // --- Acikca verilen hedef ---------------------------------------
            target = await resolveTarget(client, 2);
            assert.deepEqual(target, { kind: 'explicit', instancePk: 2 });

            // --- Pasif instance acik verilirse girdi hatasidir ---------------
            await pool.query(`insert into control.instance_inventory values (3, 'Pasif', false)`);
            assert.equal((await resolveTarget(client, 3)).kind, 'not_found');
            assert.equal((await resolveTarget(client, 999)).kind, 'not_found');
        } finally {
            client.release();
        }

        // --- Varsayilan pencere uygulanir ama isaretlenir ---------------------
        const now = new Date('2026-09-15T12:00:00Z');
        const defaulted = resolveWindow(null, null, now);
        assert.equal(defaulted.defaulted, true);
        assert.equal(defaulted.to, '2026-09-15T12:00:00.000Z');
        assert.equal(defaulted.from, '2026-09-14T12:00:00.000Z');
        assert.equal(
            (Date.parse(defaulted.to) - Date.parse(defaulted.from)) / 3600000,
            DEFAULT_WINDOW_HOURS
        );

        const explicit = resolveWindow('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', now);
        assert.equal(explicit.defaulted, false, 'kullanici verdiginde varsayilan isareti konmamali');

        const messages = decideIntake({ kind: 'explicit', instancePk: 1 }, defaulted).assistantMessages;
        assert.match(messages.join(' '), /son 24 saat/i, 'varsayilan pencere kullaniciya yazilmali');

        // --- needs_clarification iptal edilebilmeli ---------------------------
        assert.ok(ACTIVE_INVESTIGATION_STATES.includes('needs_clarification'));
        const created = await pool.query(
            `insert into agent.investigation (question, time_from, time_to, status)
             values ('soru', now() - interval '1 hour', now(), 'needs_clarification')
             returning investigation_id`
        );
        const id = created.rows[0].investigation_id;
        const cancelled = await cancelInvestigation(pool, String(id));
        assert.equal(cancelled.outcome, 'cancelled');
        const after = await pool.query(
            'select status from agent.investigation where investigation_id = $1', [id]
        );
        assert.equal(after.rows[0].status, 'cancelled');
    } finally {
        await pool.end();
    }
});
