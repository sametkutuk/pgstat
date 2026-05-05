// Workload classification API
//   GET   /api/workload/instance/:id    — bir instance'in tum DB'lerinin profili
//   PATCH /api/workload/db/:instance_pk/:dbid — manuel etiket override (workload_label)
//   GET   /api/workload/config          — esik konfigurasyonu
//   PATCH /api/workload/config          — esik guncelle

import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

const VALID_LABELS = ['oltp', 'analytical', 'bulk', 'mixed', 'idle', null];

router.get('/instance/:id', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const r = await pool.query(`
            select dbid, datname,
                   workload_label, workload_label_auto, workload_scores,
                   workload_classified_at
            from dim.database_ref
            where instance_pk = $1
            order by datname
        `, [id]);
        res.json(r.rows);
    } catch (err) { next(err); }
});

router.patch('/db/:instance_pk/:dbid', async (req, res, next) => {
    try {
        const instancePk = Number(req.params.instance_pk);
        const dbid = Number(req.params.dbid);
        const label = req.body?.workload_label ?? null;
        if (!VALID_LABELS.includes(label)) {
            res.status(400).json({ error: 'Geçersiz etiket. Geçerli: oltp/analytical/bulk/mixed/idle/null' });
            return;
        }
        const r = await pool.query(
            `update dim.database_ref set workload_label = $1
             where instance_pk = $2 and dbid = $3 returning *`,
            [label, instancePk, dbid]
        );
        if (r.rowCount === 0) {
            res.status(404).json({ error: 'DB bulunamadı' });
            return;
        }
        res.json(r.rows[0]);
    } catch (err) { next(err); }
});

router.get('/config', async (_req, res, next) => {
    try {
        const r = await pool.query(
            'select * from control.workload_classification_config where config_id = 1'
        );
        res.json(r.rows[0] || {});
    } catch (err) { next(err); }
});

router.patch('/config', async (req, res, next) => {
    try {
        const b = req.body || {};
        const r = await pool.query(`
            update control.workload_classification_config set
              window_hours = coalesce($1, window_hours),
              oltp_min_tps = coalesce($2, oltp_min_tps),
              oltp_max_avg_ms = coalesce($3, oltp_max_avg_ms),
              analytic_min_avg_ms = coalesce($4, analytic_min_avg_ms),
              analytic_min_rows = coalesce($5, analytic_min_rows),
              bulk_min_rows_write = coalesce($6, bulk_min_rows_write),
              idle_max_calls = coalesce($7, idle_max_calls),
              mixed_max_dominant = coalesce($8, mixed_max_dominant)
            where config_id = 1
            returning *
        `, [
            b.window_hours ?? null,
            b.oltp_min_tps ?? null,
            b.oltp_max_avg_ms ?? null,
            b.analytic_min_avg_ms ?? null,
            b.analytic_min_rows ?? null,
            b.bulk_min_rows_write ?? null,
            b.idle_max_calls ?? null,
            b.mixed_max_dominant ?? null,
        ]);
        res.json(r.rows[0]);
    } catch (err) { next(err); }
});

export default router;
