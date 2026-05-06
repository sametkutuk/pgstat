import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

// GET /api/audit-log — Filtreli, sayfalı audit log listesi
// Query params:
//   limit (default 100, max 500), offset (default 0)
//   user, method, endpoint (ILIKE), status, hours (varsayilan 168 = 7 gun)
router.get('/', async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
        const offset = parseInt(req.query.offset as string) || 0;
        const hours = parseInt(req.query.hours as string) || 168;

        const where: string[] = ['occurred_at > now() - make_interval(hours => $1)'];
        const params: any[] = [hours];

        if (req.query.user) {
            params.push(req.query.user);
            where.push(`user_name = $${params.length}`);
        }
        if (req.query.method) {
            params.push(String(req.query.method).toUpperCase());
            where.push(`http_method = $${params.length}`);
        }
        if (req.query.endpoint) {
            params.push(`%${req.query.endpoint}%`);
            where.push(`endpoint ilike $${params.length}`);
        }
        if (req.query.status) {
            params.push(parseInt(req.query.status as string));
            where.push(`response_status = $${params.length}`);
        }

        const whereSql = `where ${where.join(' and ')}`;
        params.push(limit, offset);

        const result = await pool.query(`
            select audit_id, occurred_at, user_name, client_ip, http_method,
                   endpoint, request_body, response_status, response_summary, duration_ms
            from ops.audit_log
            ${whereSql}
            order by occurred_at desc
            limit $${params.length - 1} offset $${params.length}
        `, params);

        // Toplam sayım (sayfalama için)
        const countResult = await pool.query(`
            select count(*) as total from ops.audit_log ${whereSql}
        `, params.slice(0, -2));

        res.json({
            rows: result.rows,
            total: parseInt(countResult.rows[0]?.total || '0'),
            limit,
            offset,
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/audit-log/stats — Endpoint bazli ozet (son 7 gun)
router.get('/stats', async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select
                http_method,
                regexp_replace(endpoint, '/[0-9]+', '/:id', 'g') as endpoint_pattern,
                count(*) as cnt,
                count(*) filter (where response_status >= 400) as error_cnt,
                round(avg(duration_ms)::numeric, 1) as avg_duration_ms
            from ops.audit_log
            where occurred_at > now() - interval '7 days'
            group by http_method, regexp_replace(endpoint, '/[0-9]+', '/:id', 'g')
            order by cnt desc
            limit 30
        `);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

export default router;
