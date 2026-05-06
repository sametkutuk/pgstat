// Küme (primary + replikalar) API'leri
//   GET /api/clusters                — tum kumelerin listesi (ozet)
//   GET /api/clusters/:cluster_id    — bir kumenin detayi (instance listesi)
//   PATCH /api/instances/:id/manual-cluster — manuel grup ata (instances.ts'te)
import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

router.get('/', async (_req, res, next) => {
    try {
        const r = await pool.query(`
            select s.cluster_id, s.label, s.total_instances, s.primary_count, s.replica_count,
                   coalesce(o.open_alerts, 0) as open_alerts,
                   coalesce(c.critical_alerts, 0) as critical_alerts
            from control.v_cluster_summary s
            left join lateral (
                select count(*) as open_alerts
                from ops.alert a
                join control.v_instance_cluster ic on ic.instance_pk = a.instance_pk
                where ic.cluster_id = s.cluster_id and a.status = 'open'
            ) o on true
            left join lateral (
                select count(*) as critical_alerts
                from ops.alert a
                join control.v_instance_cluster ic on ic.instance_pk = a.instance_pk
                where ic.cluster_id = s.cluster_id and a.status = 'open' and a.severity = 'critical'
            ) c on true
            order by s.total_instances desc, s.label
        `);
        res.json(r.rows);
    } catch (err) { next(err); }
});

router.get('/:cluster_id', async (req, res, next) => {
    try {
        const cid = req.params.cluster_id;
        const r = await pool.query(`
            select i.instance_pk, i.display_name, i.host, i.port, i.bootstrap_state,
                   c.system_identifier, i.manual_cluster_group_id,
                   c.pg_major, c.is_primary,
                   s.last_cluster_collect_at, s.last_success_at, s.consecutive_failures,
                   coalesce((select count(*) from ops.alert a where a.instance_pk=i.instance_pk and a.status='open'), 0) as open_alerts
            from control.v_instance_cluster vic
            join control.instance_inventory i on i.instance_pk = vic.instance_pk
            left join control.instance_capability c on c.instance_pk = i.instance_pk
            left join control.instance_state s on s.instance_pk = i.instance_pk
            where vic.cluster_id = $1
            order by c.is_primary desc nulls last, i.display_name
        `, [cid]);
        if (r.rows.length === 0) {
            res.status(404).json({ error: 'Küme bulunamadı' });
            return;
        }
        res.json({ cluster_id: cid, instances: r.rows });
    } catch (err) { next(err); }
});

export default router;
