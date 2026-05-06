import { Router } from 'express';
import { Client } from 'pg';

const router = Router();

interface PreCheck {
    name: string;
    label: string;
    status: 'ok' | 'warning' | 'critical' | 'info';
    detail: string;
    fix_sql?: string;
}

// POST /api/onboarding/precheck — Yeni instance icin prerequisite kontrolu
// Body: { host, port, dbname, username, password, ssl_mode? }
router.post('/precheck', async (req, res) => {
    const { host, port, dbname, username, password, ssl_mode } = req.body;

    if (!host || !port || !dbname || !username || !password) {
        return res.status(400).json({ error: 'host, port, dbname, username, password zorunlu' });
    }

    // Hedef PG'ye direkt baglanti — collector_username degil, admin/superuser ile baglanip kontrol edilir
    const client = new Client({
        host, port: Number(port), database: dbname, user: username, password,
        ssl: ssl_mode && ssl_mode !== 'disable' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
    });

    const checks: PreCheck[] = [];

    try {
        await client.connect();
    } catch (err: any) {
        return res.json({
            connected: false,
            error: err.message,
            checks: [],
        });
    }

    try {
        // 1. PG versiyon
        const ver = await client.query(`select current_setting('server_version_num')::int as ver, version() as full_version`);
        const pgMajor = Math.floor(ver.rows[0].ver / 10000);
        checks.push({
            name: 'pg_version',
            label: 'PostgreSQL Versiyonu',
            status: pgMajor >= 11 ? 'ok' : 'critical',
            detail: `PG${pgMajor} — ${ver.rows[0].full_version.split(',')[0]}`,
        });

        // 2. pg_stat_statements yüklü mü?
        const pgss = await client.query(`
            select
                (select count(*) from pg_available_extensions where name='pg_stat_statements') > 0 as available,
                (select count(*) from pg_extension where extname='pg_stat_statements') > 0 as installed,
                (select setting from pg_settings where name='shared_preload_libraries') as preload
        `);
        const r = pgss.rows[0];
        const inPreload = String(r.preload || '').includes('pg_stat_statements');
        if (r.installed && inPreload) {
            checks.push({ name: 'pgss', label: 'pg_stat_statements', status: 'ok', detail: 'Aktif ve yüklü' });
        } else if (inPreload && !r.installed) {
            checks.push({
                name: 'pgss', label: 'pg_stat_statements',
                status: 'warning',
                detail: 'shared_preload_libraries\'da var ama extension yüklü değil',
                fix_sql: `CREATE EXTENSION pg_stat_statements;`
            });
        } else {
            checks.push({
                name: 'pgss', label: 'pg_stat_statements',
                status: 'critical',
                detail: 'shared_preload_libraries\'a eklenmeli (PG restart gerekir)',
                fix_sql: `-- postgresql.conf'a ekle:\nshared_preload_libraries = 'pg_stat_statements'\n\n-- Sonra PG restart, ardından:\nCREATE EXTENSION pg_stat_statements;`
            });
        }

        // 3. track_io_timing
        const trackIo = await client.query(`select setting from pg_settings where name='track_io_timing'`);
        const trackIoOn = trackIo.rows[0]?.setting === 'on';
        checks.push({
            name: 'track_io_timing',
            label: 'track_io_timing',
            status: trackIoOn ? 'ok' : 'warning',
            detail: trackIoOn ? 'Açık' : 'Kapalı — IO metrikleri eksik olur',
            fix_sql: trackIoOn ? undefined : `ALTER SYSTEM SET track_io_timing = on;\nSELECT pg_reload_conf();`
        });

        // 4. track_functions
        const trackFn = await client.query(`select setting from pg_settings where name='track_functions'`);
        const trackFnVal = trackFn.rows[0]?.setting;
        checks.push({
            name: 'track_functions',
            label: 'track_functions',
            status: trackFnVal !== 'none' ? 'ok' : 'info',
            detail: `Mevcut: '${trackFnVal}'${trackFnVal === 'none' ? ' — function metrikleri toplanmaz' : ''}`,
            fix_sql: trackFnVal === 'none' ? `ALTER SYSTEM SET track_functions = 'pl';\nSELECT pg_reload_conf();` : undefined
        });

        // 5. pg_monitor rolü var mı?
        const pgMonitor = await client.query(`select count(*) as cnt from pg_roles where rolname='pg_monitor'`);
        checks.push({
            name: 'pg_monitor_role',
            label: 'pg_monitor rolü (built-in)',
            status: pgMonitor.rows[0].cnt > 0 ? 'ok' : 'warning',
            detail: pgMonitor.rows[0].cnt > 0 ? 'Mevcut (PG10+)' : 'Bulunamadı',
        });

        // 6. Collector kullanicisi mevcut mu? (varsayilan: pgstats_collector)
        const collectorUser = req.body.collector_username || 'pgstats_collector';
        const userCheck = await client.query(`
            select count(*) as cnt,
                   bool_or(rolsuper) as is_super,
                   bool_or(pg_has_role(oid, 'pg_monitor', 'MEMBER')) as has_monitor
            from pg_roles where rolname = $1
        `, [collectorUser]);
        const userRow = userCheck.rows[0];
        if (userRow.cnt > 0) {
            const detail = userRow.is_super ? 'Var (superuser)' : userRow.has_monitor ? 'Var (pg_monitor üyesi)' : 'Var ama pg_monitor üyesi değil';
            checks.push({
                name: 'collector_user',
                label: `Collector kullanıcısı: ${collectorUser}`,
                status: userRow.is_super || userRow.has_monitor ? 'ok' : 'warning',
                detail,
                fix_sql: !userRow.is_super && !userRow.has_monitor ? `GRANT pg_monitor TO ${collectorUser};` : undefined
            });
        } else {
            checks.push({
                name: 'collector_user',
                label: `Collector kullanıcısı: ${collectorUser}`,
                status: 'critical',
                detail: 'Mevcut değil — oluşturulmalı',
                fix_sql: `CREATE ROLE ${collectorUser} LOGIN PASSWORD '<güçlü-parola>';\nGRANT pg_monitor TO ${collectorUser};\nGRANT pg_read_all_stats TO ${collectorUser};\n\n-- Statements toplama icin:\nGRANT EXECUTE ON FUNCTION pg_stat_statements(boolean) TO ${collectorUser};\nGRANT EXECUTE ON FUNCTION pg_stat_statements_reset() TO ${collectorUser};`
            });
        }

        // 7. log_min_duration_statement
        const logMin = await client.query(`select setting from pg_settings where name='log_min_duration_statement'`);
        const logMinVal = parseInt(logMin.rows[0]?.setting || '-1');
        checks.push({
            name: 'log_min_duration',
            label: 'log_min_duration_statement',
            status: 'info',
            detail: logMinVal === -1 ? 'Kapalı (yavaş query log\'lanmaz)' : logMinVal === 0 ? 'Tüm query\'ler loglanır' : `${logMinVal}ms üzeri loglanır`,
        });

        // 8. max_connections
        const maxConn = await client.query(`select setting::int as val from pg_settings where name='max_connections'`);
        checks.push({
            name: 'max_connections',
            label: 'max_connections',
            status: 'info',
            detail: `${maxConn.rows[0].val}`,
        });

        // 9. Replica/standby kontrol
        const isReplica = await client.query(`select pg_is_in_recovery() as in_recovery`);
        checks.push({
            name: 'role',
            label: 'Rol',
            status: 'info',
            detail: isReplica.rows[0].in_recovery ? 'Replica (standby)' : 'Primary',
        });

        await client.end();

        // Genel durum
        const hasCritical = checks.some(c => c.status === 'critical');
        const hasWarning = checks.some(c => c.status === 'warning');
        const overall = hasCritical ? 'critical' : hasWarning ? 'warning' : 'ok';

        res.json({
            connected: true,
            pg_major: pgMajor,
            overall,
            checks,
        });
    } catch (err: any) {
        try { await client.end(); } catch { /* ignore */ }
        res.json({
            connected: true,
            error: `Kontrol sırasında hata: ${err.message}`,
            checks,
        });
    }
});

export default router;
