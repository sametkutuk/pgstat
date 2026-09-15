// AI DBA autovacuum kanit API'si — salt okunur, sinirli, semantik.
//
//   GET /api/agent-evidence/instances                  — hedef kimligi + surum baglami
//   GET /api/agent-evidence/:id/telemetry-coverage     — kaynak basina kapsam
//   GET /api/agent-evidence/:id/autovacuum-overview    — genel gorunum
//   GET /api/agent-evidence/:id/vacuum-candidates      — incelenecek tablo adaylari
//   GET /api/agent-evidence/:id/table-vacuum-evidence  — tek tablo kaniti
//
// Sinirlar:
//  - Istemciden tablo, kolon ya da SQL ifadesi KABUL EDILMEZ. Siralama olcutu
//    sunucudaki sabit sozlukten secilir.
//  - Hedef ve zaman araligi zorunludur; aralik yari aciktir [from, to).
//  - Her sorgu read-only transaction icinde ve statement_timeout altinda kosar.
//  - Ham query text, secret ve baglanti bilgisi dondurulmez.
//
// Router /api/agent-evidence altinda mount edilir. Servis token'lari yalniz
// etkin arastirmanin hedef ve penceresinde kullanilabilir.

import { Router } from 'express';
import { getAutovacuumOverview } from '../services/agent-evidence/autovacuumOverview';
import { getTelemetryCoverage } from '../services/agent-evidence/telemetryCoverage';
import { getTableVacuumEvidence } from '../services/agent-evidence/tableVacuumEvidence';
import { getVacuumCandidates, parseOrdering } from '../services/agent-evidence/vacuumCandidates';
import { parseOid, parsePositiveInt, resolveTable, resolveTarget } from '../services/agent-evidence/identity';
import { EvidenceValidationError, resolveLimit, resolveRange } from '../services/agent-evidence/timeRange';
import { queryBounded } from '../services/agent-evidence/db';
import { asSafeInt } from '../services/agent-evidence/numeric';

const router = Router();

/** Aday listesi ve zaman serisi ust sinirlari — cevap boyutunu sinirlar. */
const MAX_CANDIDATES = 200;
const DEFAULT_CANDIDATES = 20;
const MAX_TIMELINE_POINTS = 500;
const DEFAULT_TIMELINE_POINTS = 200;
const MAX_INSTANCE_ROWS = 200;

/**
 * Yetenek 1: hedef kimligi ve surum baglami.
 * Arama metni yalnizca parametre olarak kullanilir, SQL'e gomulmez.
 */
router.get('/instances', async (req, res, next) => {
    try {
        const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        const limit = resolveLimit(req.query.limit, 50, MAX_INSTANCE_ROWS);

        const rows = await queryBounded({
            text: `
                select inv.instance_pk, inv.instance_id, inv.display_name,
                       inv.environment, inv.is_active,
                       cap.pg_major, cap.server_version_num, cap.pgss_status
                  from control.instance_inventory inv
                  left join control.instance_capability cap
                         on cap.instance_pk = inv.instance_pk
                 where ($3::bigint is null or inv.instance_pk = $3)
                   and ($1 = '' or inv.display_name ilike '%' || $1 || '%'
                                or inv.instance_id  ilike '%' || $1 || '%')
                 order by inv.display_name
                 limit $2
            `,
            values: [search, limit, res.locals.agent_instance_pk ?? null],
        });

        res.json({
            schema_version: '1.0.0',
            capability: 'find_instance',
            data: rows.map((row) => ({
                instance_pk: String(row.instance_pk),
                instance_id: String(row.instance_id),
                display_name: String(row.display_name),
                environment: row.environment === null || row.environment === undefined ? null : String(row.environment),
                is_active: row.is_active === true,
                pg_major: asSafeInt(row.pg_major),
                server_version_num: asSafeInt(row.server_version_num),
                pgss_status: row.pgss_status === null || row.pgss_status === undefined ? null : String(row.pgss_status),
            })),
            limit_applied: limit,
        });
    } catch (error) { next(error); }
});

router.get('/:id/telemetry-coverage', async (req, res, next) => {
    try {
        const target = await requireTarget(req.params.id, res);
        if (!target) return;
        const range = resolveRange(req.query as Record<string, unknown>);
        res.json(await getTelemetryCoverage(target, range));
    } catch (error) { handle(error, res, next); }
});

router.get('/:id/autovacuum-overview', async (req, res, next) => {
    try {
        const target = await requireTarget(req.params.id, res);
        if (!target) return;
        const range = resolveRange(req.query as Record<string, unknown>);
        res.json(await getAutovacuumOverview(target, range));
    } catch (error) { handle(error, res, next); }
});

router.get('/:id/vacuum-candidates', async (req, res, next) => {
    try {
        const target = await requireTarget(req.params.id, res);
        if (!target) return;
        const range = resolveRange(req.query as Record<string, unknown>);
        const limit = resolveLimit(req.query.limit, DEFAULT_CANDIDATES, MAX_CANDIDATES);
        const ordering = parseOrdering(req.query.ordering);

        // dbid opsiyoneldir; verilmisse hedefe ait oldugu dogrulanir.
        let dbid: number | null = null;
        if (req.query.dbid !== undefined && String(req.query.dbid).trim() !== '') {
            dbid = parseOid(req.query.dbid, 'dbid');
        }

        res.json(await getVacuumCandidates(target, range, { limit, ordering, dbid }));
    } catch (error) { handle(error, res, next); }
});

router.get('/:id/table-vacuum-evidence', async (req, res, next) => {
    try {
        const target = await requireTarget(req.params.id, res);
        if (!target) return;
        const dbid = parseOid(req.query.dbid, 'dbid');
        const relid = parseOid(req.query.relid, 'relid');
        const range = resolveRange(req.query as Record<string, unknown>);
        const maxPoints = resolveLimit(req.query.max_points, DEFAULT_TIMELINE_POINTS, MAX_TIMELINE_POINTS);

        // Kimlik dogrulamasi ayni zamanda hedef izolasyonudur: baska bir
        // instance'in tablosu istenirse 404 doner, veri sizmaz.
        const resolved = await resolveTable(target.instance_pk, dbid, relid);
        if (!resolved) {
            res.status(404).json({ error: 'Tablo bu hedefte bulunamadi', code: 'table_not_found' });
            return;
        }

        res.json(await getTableVacuumEvidence(
            target,
            resolved.table,
            resolved.limitations,
            range,
            { maxTimelinePoints: maxPoints }
        ));
    } catch (error) { handle(error, res, next); }
});

/** Hedefi cozer; yoksa 404 yazip null doner. */
async function requireTarget(rawId: string, res: import('express').Response) {
    const instancePk = parsePositiveInt(rawId, 'id');
    const target = await resolveTarget(instancePk);
    if (!target) {
        res.status(404).json({ error: 'Instance bulunamadi', code: 'instance_not_found' });
        return null;
    }
    return target;
}

/**
 * Girdi hatasi ile sunucu hatasini ayirir.
 *
 * Gecersiz kullanici girdisi urun eksigi DEGILDIR: 400 doner ve hicbir
 * gap_candidate uretmez.
 */
function handle(error: unknown, res: import('express').Response, next: import('express').NextFunction) {
    if (error instanceof EvidenceValidationError) {
        res.status(400).json({ error: error.message, code: error.code, field: error.field });
        return;
    }
    next(error as Error);
}

export default router;
