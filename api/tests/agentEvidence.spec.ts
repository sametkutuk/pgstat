// Autovacuum kanit API'si — gercek PostgreSQL uzerinde davranis testi.
//
// Bu test SQL METNI KARSILASTIRMAZ. Servislerin urettigi sorgular gercek
// semaya karsi kosar ve beklenen sayilar fixture'dan ELLE hesaplanir.
//
// Calistirma:
//   PGSTAT_EVIDENCE_TEST_URL=postgres://... node --import tsx --test tests/agentEvidence.spec.ts
//
// Yapilandirma yoksa test SESSIZCE ATLANMAZ, basarisiz olur.

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { Pool } from 'pg';

// Fixture penceresi bilincli olarak GECMISTEDIR. Boylece "bugune gore eski"
// olan verinin yanlislikla bayat ilan edilmedigi dogrulanabilir.
const WINDOW_FROM = '2026-03-10T00:00:00Z';
const WINDOW_TO = '2026-03-11T00:00:00Z';
const DAY = '20260310';

const INSTANCE_KNOWN = 1;     // pg_major 17 — PG18 vacuum suresi YOK
const INSTANCE_UNKNOWN = 2;   // pg_major NULL — capability bilinmiyor
const DB_APP = 16384;
const DB_OTHER = 16385;
const REL_ORDERS_APP = 20001;
const REL_ORDERS_OTHER = 20002;   // AYNI isim, farkli DB ve OID
const REL_QUIET = 20003;

let pool: Pool;
let services: {
    resolveTarget: typeof import('../src/services/agent-evidence/identity')['resolveTarget'];
    resolveTable: typeof import('../src/services/agent-evidence/identity')['resolveTable'];
    resolveRange: typeof import('../src/services/agent-evidence/timeRange')['resolveRange'];
    EvidenceValidationError: typeof import('../src/services/agent-evidence/timeRange')['EvidenceValidationError'];
    getTelemetryCoverage: typeof import('../src/services/agent-evidence/telemetryCoverage')['getTelemetryCoverage'];
    getAutovacuumOverview: typeof import('../src/services/agent-evidence/autovacuumOverview')['getAutovacuumOverview'];
    getVacuumCandidates: typeof import('../src/services/agent-evidence/vacuumCandidates')['getVacuumCandidates'];
    getTableVacuumEvidence: typeof import('../src/services/agent-evidence/tableVacuumEvidence')['getTableVacuumEvidence'];
    queryBounded: typeof import('../src/services/agent-evidence/db')['queryBounded'];
};

before(async () => {
    const url = process.env.PGSTAT_EVIDENCE_TEST_URL;
    assert.ok(url, 'PGSTAT_EVIDENCE_TEST_URL tek kullanimlik bir test veritabanini gostermelidir');

    // Servisler pool'u modul yuklenirken kurar; env once ayarlanmali.
    const parsed = new URL(url);
    process.env.PGSTAT_DB_HOST = parsed.hostname;
    process.env.PGSTAT_DB_PORT = parsed.port || '5432';
    process.env.PGSTAT_DB_NAME = parsed.pathname.replace(/^\//, '');
    process.env.PGSTAT_DB_USER = decodeURIComponent(parsed.username);
    process.env.PGSTAT_DB_PASSWORD = decodeURIComponent(parsed.password);

    pool = new Pool({ connectionString: url, max: 4 });
    await assertSchemaPresent();
    await seedFixture();

    const [identity, timeRange, coverage, overview, candidates, tableEvidence, db] = await Promise.all([
        import('../src/services/agent-evidence/identity'),
        import('../src/services/agent-evidence/timeRange'),
        import('../src/services/agent-evidence/telemetryCoverage'),
        import('../src/services/agent-evidence/autovacuumOverview'),
        import('../src/services/agent-evidence/vacuumCandidates'),
        import('../src/services/agent-evidence/tableVacuumEvidence'),
        import('../src/services/agent-evidence/db'),
    ]);
    services = {
        resolveTarget: identity.resolveTarget,
        resolveTable: identity.resolveTable,
        resolveRange: timeRange.resolveRange,
        EvidenceValidationError: timeRange.EvidenceValidationError,
        getTelemetryCoverage: coverage.getTelemetryCoverage,
        getAutovacuumOverview: overview.getAutovacuumOverview,
        getVacuumCandidates: candidates.getVacuumCandidates,
        getTableVacuumEvidence: tableEvidence.getTableVacuumEvidence,
        queryBounded: db.queryBounded,
    };
});

after(async () => {
    if (pool) await pool.end();
    const { pool: appPool } = await import('../src/config/database');
    await appPool.end();
});

/** Semanin gercekten uygulanmis oldugunu dogrular — eksikse sessizce gecmez. */
async function assertSchemaPresent() {
    const required = [
        ['fact', 'pg_table_stat_delta'],
        ['fact', 'pg_settings_snapshot'],
        ['fact', 'pg_activity_snapshot'],
        ['agg', 'pg_table_stat_hourly'],
        ['control', 'instance_inventory'],
        ['control', 'instance_capability'],
        ['control', 'table_relopts_snapshot'],
        ['dim', 'relation_ref'],
        ['dim', 'database_ref'],
        ['ops', 'job_run_instance'],
    ];
    for (const [schema, table] of required) {
        const r = await pool.query(
            `select 1 from information_schema.tables where table_schema = $1 and table_name = $2`,
            [schema, table]
        );
        assert.equal(r.rowCount, 1, `${schema}.${table} test veritabaninda yok — migration uygulanmamis`);
    }
}

async function seedFixture() {
    // Fixture idempotent olmali: ayni test veritabaninda tekrar kosulabilsin.
    // Yalnizca bu testin sahiplendigi iki instance temizlenir.
    const owned = [INSTANCE_KNOWN, INSTANCE_UNKNOWN];
    for (const table of [
        'fact.pg_table_stat_delta', 'fact.pg_settings_snapshot', 'fact.pg_activity_snapshot',
        'control.table_relopts_snapshot', 'ops.job_run_instance',
        'dim.relation_ref', 'dim.database_ref', 'control.instance_capability',
    ]) {
        await pool.query(`delete from ${table} where instance_pk = any($1::bigint[])`, [owned]);
    }

    // Fixture penceresi icin partition'lar. V007 yalnizca "bugun +/- birkac gun"
    // olusturur; tarihsel pencere icin acikca yaratilir.
    for (const table of ['pg_table_stat_delta', 'pg_settings_snapshot', 'pg_activity_snapshot']) {
        await pool.query(`
            create table if not exists fact.${table}_${DAY}
              partition of fact.${table}
              for values from ('2026-03-10') to ('2026-03-11')
        `);
    }

    await pool.query(`
        insert into control.retention_policy (policy_code, raw_retention_months, hourly_retention_months, daily_retention_months)
        values ('test', 1, 1, 1) on conflict (policy_code) do nothing
    `);
    await pool.query(`
        insert into control.schedule_profile (profile_code) values ('test')
        on conflict (profile_code) do nothing
    `);

    const policy = (await pool.query(`select retention_policy_id from control.retention_policy where policy_code='test'`)).rows[0];
    const profile = (await pool.query(`select schedule_profile_id from control.schedule_profile where profile_code='test'`)).rows[0];

    await pool.query(`
        insert into control.instance_inventory
            (instance_pk, instance_id, display_name, host, secret_ref, schedule_profile_id, retention_policy_id)
        overriding system value
        values ($1, 'known', 'Known Target', 'h1', 'ref', $3, $4),
               ($2, 'unknown', 'Unknown Target', 'h2', 'ref', $3, $4)
        on conflict (instance_pk) do nothing
    `, [INSTANCE_KNOWN, INSTANCE_UNKNOWN, profile.schedule_profile_id, policy.retention_policy_id]);

    // Yetenek ayrimi: biri bilinen PG17 + pgss available, digeri tamamen bilinmiyor.
    await pool.query(`
        insert into control.instance_capability (instance_pk, pg_major, server_version_num, pgss_status, pgss_extversion)
        values ($1, 17, 170004, 'available', '1.10')
        on conflict (instance_pk) do nothing
    `, [INSTANCE_KNOWN]);
    await pool.query(`
        insert into control.instance_capability (instance_pk, pgss_status)
        values ($1, 'version_unknown')
        on conflict (instance_pk) do nothing
    `, [INSTANCE_UNKNOWN]);

    await pool.query(`
        insert into dim.database_ref (instance_pk, dbid, datname) values
            ($1, $2, 'appdb'), ($1, $3, 'otherdb')
        on conflict (instance_pk, dbid) do nothing
    `, [INSTANCE_KNOWN, DB_APP, DB_OTHER]);

    // AYNI relname iki farkli DB'de — kimlik testi.
    await pool.query(`
        insert into dim.relation_ref (instance_pk, dbid, relid, schemaname, relname, relkind, first_seen_at) values
            ($1, $2, $4, 'public', 'orders', 'r', '2026-03-01T00:00:00Z'),
            ($1, $3, $5, 'public', 'orders', 'r', '2026-03-01T00:00:00Z'),
            ($1, $2, $6, 'public', 'quiet',  'r', '2026-03-01T00:00:00Z')
        on conflict (instance_pk, dbid, relid) do nothing
    `, [INSTANCE_KNOWN, DB_APP, DB_OTHER, REL_ORDERS_APP, REL_ORDERS_OTHER, REL_QUIET]);

    // Ayarlar: pencereden ONCE olculmus (gercek hayatta nightly snapshot).
    await pool.query(`
        insert into fact.pg_settings_snapshot (snapshot_ts, instance_pk, setting_name, setting_value, unit) values
            ('2026-03-10T00:30:00Z', $1, 'autovacuum_vacuum_threshold', '50', null),
            ('2026-03-10T00:30:00Z', $1, 'autovacuum_vacuum_scale_factor', '0.2', null),
            ('2026-03-10T00:30:00Z', $1, 'autovacuum', 'on', null)
    `, [INSTANCE_KNOWN]);

    // Tablo istatistikleri: uc toplama turu.
    //   appdb.orders  -> reltuples 1000, dead 500 (esik 50 + 0.2*1000 = 250 -> asilmis)
    //   otherdb.orders-> reltuples 1000, dead  10 (esik 250 -> asilmamis)
    //   quiet         -> reltuples NULL/-1, dead 5 -> taban bilinmiyor
    const rounds = ['2026-03-10T01:00:00Z', '2026-03-10T02:00:00Z', '2026-03-10T03:00:00Z'];
    for (const [i, ts] of rounds.entries()) {
        await pool.query(`
            insert into fact.pg_table_stat_delta
                (sample_ts, instance_pk, dbid, relid, schemaname, relname,
                 n_dead_tup_estimate, n_live_tup_estimate, reltuples, n_mod_since_analyze,
                 autovacuum_count_delta, vacuum_count_delta,
                 autoanalyze_count_delta, analyze_count_delta,
                 last_vacuum, last_autovacuum)
            values
                ($2, $1, $3, $5, 'public', 'orders', 500, 1000, 1000, 40, $8, 0, 0, 0, null, '2026-03-09T12:00:00Z'),
                ($2, $1, $4, $6, 'public', 'orders',  10, 1000, 1000,  5, 0, 0, 0, 0, null, '2026-03-10T00:10:00Z'),
                ($2, $1, $3, $7, 'public', 'quiet',    5,  100,   -1,  1, 0, 0, 0, 0, null, null)
        `, [INSTANCE_KNOWN, ts, DB_APP, DB_OTHER, REL_ORDERS_APP, REL_ORDERS_OTHER, REL_QUIET, i === 1 ? 2 : 0]);
    }

    // Activity: TEK bir toplama turunda dort PID. Ornek birimi tur olmali,
    // satir degil — bu yuzden sample_count 1 beklenir.
    await pool.query(`
        insert into fact.pg_activity_snapshot (snapshot_ts, instance_pk, pid, backend_type, query) values
            ('2026-03-10T01:00:00Z', $1, 101, 'client backend',     'select 1'),
            ('2026-03-10T01:00:00Z', $1, 102, 'client backend',     'select 2'),
            ('2026-03-10T01:00:00Z', $1, 103, 'autovacuum worker',  'autovacuum: VACUUM public.orders'),
            ('2026-03-10T01:00:00Z', $1, 104, 'autovacuum worker',  'autovacuum: VACUUM public.quiet')
    `, [INSTANCE_KNOWN]);

    // Toplama isi kaydi: uc basarili db_objects kosumu.
    await pool.query(`
        insert into ops.job_run (job_type, started_at, status) values ('db_objects', '2026-03-10T01:00:00Z', 'success')
        returning job_run_id
    `);
    const jobRun = (await pool.query(`select job_run_id from ops.job_run order by job_run_id desc limit 1`)).rows[0];
    for (const ts of rounds) {
        await pool.query(`
            insert into ops.job_run_instance (job_run_id, instance_pk, job_type, started_at, status)
            values ($1, $2, 'db_objects', $3, 'success')
        `, [jobRun.job_run_id, INSTANCE_KNOWN, ts]);
    }

    // Tablo duzeyi override — gecmis tutmayan kaynak.
    await pool.query(`
        insert into control.table_relopts_snapshot
            (instance_pk, dbid, relid, schemaname, relname, autovacuum_enabled, reloptions_raw, updated_at)
        values ($1, $2, $3, 'public', 'orders', false, 'autovacuum_enabled=false', now())
        on conflict (instance_pk, dbid, relid) do nothing
    `, [INSTANCE_KNOWN, DB_APP, REL_ORDERS_APP]);
}

function range() {
    return services.resolveRange({ from: WINDOW_FROM, to: WINDOW_TO });
}

// =============================================================================

test('tarihsel pencere bugunku saate gore bayat ilan edilmez', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;
    const resolved = (await services.resolveTable(INSTANCE_KNOWN, DB_APP, REL_ORDERS_APP))!;

    // Pencere son ornekten (03:00Z) bir saat sonra biter: pencereye gore gecikme
    // 3600 sn, bayatlik esigine esit -> 'ok'. Ayni veri BUGUNE gore aylarca
    // geride; now() kullanilsaydi bu kacinilmaz olarak 'stale' olurdu.
    const tight = services.resolveRange({ from: WINDOW_FROM, to: '2026-03-10T04:00:00Z' });
    const result = await services.getTableVacuumEvidence(
        target, resolved.table, resolved.limitations, tight, { maxTimelinePoints: 100 }
    );

    const stats = result.coverage.find((c) => c.source === 'fact.pg_table_stat_delta')!;
    assert.equal(stats.status, 'ok', 'pencere ici veri bugunku saate gore bayat sayilmamali');
    assert.equal(stats.latest_sample_at, '2026-03-10T03:00:00.000Z');

    // Son autovacuum 2026-03-09T12:00Z, pencere sonu 2026-03-10T04:00Z -> 16 sa.
    assert.equal(result.data!.current!.seconds_since_vacuum, 57600);

    // Ayni tablo, son ornekten cok sonra biten pencerede bayat olmali:
    // bayatlik pencereye gore olculuyor, sabit bir "bugun" degerine gore degil.
    const loose = await services.getTableVacuumEvidence(
        target, resolved.table, resolved.limitations, range(), { maxTimelinePoints: 100 }
    );
    const looseStats = loose.coverage.find((c) => c.source === 'fact.pg_table_stat_delta')!;
    assert.equal(looseStats.status, 'stale');
    assert.equal(looseStats.reason_code, 'data_stale');
});

test('ayni isimli tablolar DB kimligine gore ayrisir', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;

    const app = (await services.resolveTable(INSTANCE_KNOWN, DB_APP, REL_ORDERS_APP))!;
    const other = (await services.resolveTable(INSTANCE_KNOWN, DB_OTHER, REL_ORDERS_OTHER))!;
    assert.equal(app.table.relname, other.table.relname);
    assert.equal(app.table.datname, 'appdb');
    assert.equal(other.table.datname, 'otherdb');

    const appEvidence = await services.getTableVacuumEvidence(target, app.table, app.limitations, range(), { maxTimelinePoints: 100 });
    const otherEvidence = await services.getTableVacuumEvidence(target, other.table, other.limitations, range(), { maxTimelinePoints: 100 });

    assert.equal(appEvidence.data!.current!.n_dead_tup, '500');
    assert.equal(otherEvidence.data!.current!.n_dead_tup, '10', 'ayni isim birlestirilmemeli');
});

test('esik PostgreSQL formuluyle hesaplanir ve reltuples bilinmiyorsa uretilmez', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;
    const result = await services.getVacuumCandidates(target, range(), {
        limit: 10, ordering: 'dead_vs_threshold', dbid: null,
    });

    const byName = new Map(result.data!.candidates.map((c) => [`${c.datname}.${c.relname}`, c]));

    // 50 + 0.2 * 1000 = 250. dead 500 -> oran 2.0, esik asilmis.
    const appOrders = byName.get('appdb.orders')!;
    assert.equal(appOrders.vacuum_threshold, '250');
    assert.equal(appOrders.threshold_ratio, 2);
    assert.equal(appOrders.threshold_exceeded, true);
    assert.equal(appOrders.row_count_source, 'reltuples');

    // Ayni esik, dead 10 -> 0.04, asilmamis.
    const otherOrders = byName.get('otherdb.orders')!;
    assert.equal(otherOrders.threshold_ratio, 0.04);
    assert.equal(otherOrders.threshold_exceeded, false);

    // reltuples -1 (bilinmiyor) -> n_live_tup'a duser ve bunu bildirir.
    const quiet = byName.get('appdb.quiet')!;
    assert.equal(quiet.row_count_source, 'n_live_tup_estimate');
    assert.equal(quiet.vacuum_threshold, '70'); // 50 + 0.2 * 100

    // Siralama bir teshis degildir — bu acikca tasinir.
    assert.ok(result.limitations.some((l) => l.code === 'ranking_is_not_diagnosis'));
});

test('cok PID iceren tek snapshot tek toplama turu sayilir', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;
    const result = await services.getAutovacuumOverview(target, range());

    const activity = result.coverage.find((c) => c.source === 'fact.pg_activity_snapshot')!;
    assert.equal(activity.sample_unit, 'collection_round');
    assert.equal(activity.sample_count, 1, 'dort PID tek tur olmali, dort degil');

    assert.equal(result.data!.worker_observations.activity_rounds_total, 1);
    assert.equal(result.data!.worker_observations.worker_observation_rounds, 1);
    assert.equal(result.data!.worker_observations.distinct_worker_pids, 2);
});

test('beklenen ornek sayisi ve kayip yuzdesi uydurulmaz', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;
    const result = await services.getTelemetryCoverage(target, range());

    for (const entry of result.coverage) {
        assert.equal(entry.expected_sample_count, null, `${entry.source}: beklenen ornek sayisi bilinemez`);
        assert.equal(entry.missing_sample_pct, null, `${entry.source}: kayip yuzdesi bilinemez`);
    }
    assert.ok(result.limitations.some((l) => l.code === 'expected_sample_count_unknown'));
});

test('bos pencere "toplanmiyor" demez', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;
    const empty = services.resolveRange({ from: '2026-03-20T00:00:00Z', to: '2026-03-20T06:00:00Z' });
    const result = await services.getAutovacuumOverview(target, empty);

    const stats = result.coverage.find((c) => c.source === 'fact.pg_table_stat_delta')!;
    assert.equal(stats.status, 'no_data');
    assert.equal(stats.reason_code, 'zero_rows_in_window');
    assert.notEqual(stats.status, 'not_collected');

    // Asil kural: sifir satirdan NEDEN uydurulmamali. Not, toplamanin kapali
    // oldugunu, retention'in sildigini ya da yetki olmadigini IDDIA ETMEMELI.
    const note = String(stats.note);
    assert.doesNotMatch(note, /toplanmiyor|toplama kapali/i);
    assert.doesNotMatch(note, /retention|silin/i);
    assert.doesNotMatch(note, /yetki/i);
    assert.doesNotMatch(note, /autovacuum calismadi/i);
    assert.match(note, /bilinemiyor|CIKARILAMAZ/i, 'not, nedenin bilinmedigini acikca soylemeli');
});

test('desteklenmeyen surum ile bilinmeyen capability ayrilir', async () => {
    // PG17 hedefi: autovacuum SURESI PG18+ oldugu icin desteklenmiyor.
    const known = (await services.resolveTarget(INSTANCE_KNOWN))!;
    const app = (await services.resolveTable(INSTANCE_KNOWN, DB_APP, REL_ORDERS_APP))!;
    const knownResult = await services.getTableVacuumEvidence(known, app.table, app.limitations, range(), { maxTimelinePoints: 10 });
    const duration = knownResult.coverage.find((c) => c.capability === 'autovacuum_duration')!;
    assert.equal(duration.status, 'unsupported_version');
    assert.equal(duration.reason_code, 'version_unsupported');
    assert.equal(knownResult.data!.window_totals.total_autovacuum_time_ms, null);

    // Surumu bilinmeyen hedef: "desteklenmiyor" DEGIL, "bilinmiyor".
    const unknown = (await services.resolveTarget(INSTANCE_UNKNOWN))!;
    assert.equal(unknown.pg_major, null);
    const coverage = await services.getTelemetryCoverage(unknown, range());
    const pgss = coverage.coverage.find((c) => c.capability === 'query_performance_evidence')!;
    assert.equal(pgss.status, 'unknown_capability');
    assert.equal(pgss.reason_code, 'capability_unknown');
    assert.ok(coverage.gap_candidates.some((g) => g.detail_code === 'unknown_capability'));
});

test('NULL metrik sifira cevrilmez', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;
    const quiet = (await services.resolveTable(INSTANCE_KNOWN, DB_APP, REL_QUIET))!;
    const result = await services.getTableVacuumEvidence(target, quiet.table, quiet.limitations, range(), { maxTimelinePoints: 10 });

    // Bu tabloda hic vacuum zamani yok — sifir ya da epoch DEGIL, null.
    assert.equal(result.data!.current!.last_vacuum_at, null);
    assert.equal(result.data!.current!.last_autovacuum_at, null);
    assert.equal(result.data!.current!.seconds_since_vacuum, null);
    // reltuples -1 bilinmiyordur; -1 olarak sizmamali.
    assert.equal(result.data!.current!.reltuples, null);
    assert.equal(result.data!.current!.reltuples_known, false);
    assert.ok(result.limitations.some((l) => l.code === 'reltuples_unknown'));
});

test('tablo override gecmisi olmadigi acikca bildirilir', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;
    const app = (await services.resolveTable(INSTANCE_KNOWN, DB_APP, REL_ORDERS_APP))!;
    const result = await services.getTableVacuumEvidence(target, app.table, app.limitations, range(), { maxTimelinePoints: 10 });

    assert.equal(result.data!.table_level_override!.autovacuum_enabled, false);
    assert.equal(result.data!.table_level_override!.applies_to_requested_range, false);
    assert.ok(result.limitations.some((l) => l.code === 'table_override_no_history'));
});

test('ayar penceresi disindaysa bu acikca bildirilir', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;
    // Ayar snapshot'i 2026-03-10T00:30Z; bu pencere ondan SONRA basliyor.
    const later = services.resolveRange({ from: '2026-03-10T02:00:00Z', to: '2026-03-10T04:00:00Z' });
    const result = await services.getAutovacuumOverview(target, later);

    const threshold = result.data!.settings.find((s) => s.setting_name === 'autovacuum_vacuum_threshold')!;
    assert.equal(threshold.setting_value, '50');
    assert.equal(threshold.observed_in_range, false, 'pencere disindaki ayar boyle isaretlenmeli');
    assert.ok(result.limitations.some((l) => l.code === 'settings_snapshot_outside_range'));
});

test('gecersiz girdi urun eksigi degil, dogrulama hatasidir', async () => {
    // Offset'siz zaman reddedilir: yerel/sunucu saati ayrimi pencereyi kaydirir.
    assert.throws(
        () => services.resolveRange({ from: '2026-03-10T00:00:00', to: WINDOW_TO }),
        (e: Error) => e instanceof services.EvidenceValidationError && (e as any).code === 'ambiguous_timezone'
    );
    // Ters aralik.
    assert.throws(
        () => services.resolveRange({ from: WINDOW_TO, to: WINDOW_FROM }),
        (e: Error) => (e as any).code === 'empty_range'
    );
    // Cok genis aralik.
    assert.throws(
        () => services.resolveRange({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
        (e: Error) => (e as any).code === 'range_too_wide'
    );
    // 48 saatten uzun pencere otomatik saatlige duser ve bunu bildirir.
    const wide = services.resolveRange({ from: '2026-03-01T00:00:00Z', to: '2026-03-10T00:00:00Z' });
    assert.equal(wide.effective.resolution, 'hourly');
    assert.ok(wide.effective.adjusted_reason);
});

test('statement_timeout baglantiya sizmaz ve baglanti yeniden kullanilabilir', async () => {
    // Cok kisa timeout ile bilerek zaman asimina ugrat.
    await assert.rejects(
        services.queryBounded({ text: 'select pg_sleep(1)', values: [] }, 30),
        (e: any) => e.code === '57014'
    );

    // Ayni havuzdan gelen sonraki istek normal timeout ile calismali.
    // Sizinti olsaydi bu sorgu da iptal edilirdi.
    const rows = await services.queryBounded({ text: 'select pg_sleep(0.2), 42 as answer', values: [] }, 5000);
    assert.equal(Number(rows[0].answer), 42);

    // Sizinti kontrolu, bounded transaction'in DISINDA yapilmali: transaction
    // icinde SET LOCAL zaten gecerlidir, orada olcmek hicbir sey kanitlamaz.
    const { pool: appPool } = await import('../src/config/database');
    const outside = await appPool.query('show statement_timeout');
    assert.equal(
        String(outside.rows[0].statement_timeout), '0',
        'SET LOCAL transaction disina sizmamali; havuzdaki baglanti varsayilanla donmeli'
    );
});

test('cevapta secret, credential ya da ham query text bulunmaz', async () => {
    const target = (await services.resolveTarget(INSTANCE_KNOWN))!;
    const payloads = [
        JSON.stringify(await services.getTelemetryCoverage(target, range())),
        JSON.stringify(await services.getAutovacuumOverview(target, range())),
        JSON.stringify(await services.getVacuumCandidates(target, range(), { limit: 10, ordering: 'dead_vs_threshold', dbid: null })),
    ];
    for (const payload of payloads) {
        assert.doesNotMatch(payload, /secret_ref/i);
        assert.doesNotMatch(payload, /password/i);
        // Activity tablosundaki ham query metni cevaba tasinmamali.
        assert.doesNotMatch(payload, /autovacuum: VACUUM public\./);
        assert.doesNotMatch(payload, /select 1/);
    }
});
