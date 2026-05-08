import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

// Şu an tek kullanıcı ('admin'). İleride JWT'den userId çekilebilir.
const CURRENT_USER = 'admin';

// GET /api/preferences — Mevcut kullanıcı tercihlerini döner
router.get('/', async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select pinned_instances, dashboard_widgets, updated_at
            from control.user_preferences
            where user_id = $1
        `, [CURRENT_USER]);

        if (result.rows.length === 0) {
            // Hiç yoksa default oluştur
            await pool.query(`
                insert into control.user_preferences (user_id) values ($1)
                on conflict (user_id) do nothing
            `, [CURRENT_USER]);
            return res.json({
                pinned_instances: [],
                dashboard_widgets: {
                    open_alerts: true,
                    instance_health: true,
                    wal_production: true,
                    top_bloat: true,
                    recent_jobs: true,
                },
                updated_at: null,
            });
        }
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// PATCH /api/preferences — Kısmi güncelleme
// Body: { pinned_instances?: number[], dashboard_widgets?: object }
router.patch('/', async (req, res, next) => {
    try {
        const { pinned_instances, dashboard_widgets } = req.body;

        const updates: string[] = [];
        const params: any[] = [];

        if (pinned_instances !== undefined) {
            if (!Array.isArray(pinned_instances)) {
                return res.status(400).json({ error: 'pinned_instances must be an array' });
            }
            params.push(JSON.stringify(pinned_instances));
            updates.push(`pinned_instances = $${params.length}::jsonb`);
        }
        if (dashboard_widgets !== undefined) {
            if (typeof dashboard_widgets !== 'object' || dashboard_widgets === null) {
                return res.status(400).json({ error: 'dashboard_widgets must be an object' });
            }
            params.push(JSON.stringify(dashboard_widgets));
            updates.push(`dashboard_widgets = $${params.length}::jsonb`);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'no updatable fields' });
        }

        updates.push('updated_at = now()');
        params.push(CURRENT_USER);

        // Upsert — kayıt yoksa ekle
        const result = await pool.query(`
            insert into control.user_preferences (user_id) values ($${params.length})
            on conflict (user_id) do update set ${updates.join(', ')}
            returning pinned_instances, dashboard_widgets, updated_at
        `, params);

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// POST /api/preferences/pin/:instance_pk — Tek instance pin/unpin toggle
router.post('/pin/:instance_pk', async (req, res, next) => {
    try {
        const instancePk = parseInt(req.params.instance_pk);
        if (isNaN(instancePk)) return res.status(400).json({ error: 'Invalid instance_pk' });

        // Mevcut listeyi al, ekle veya çıkar
        const cur = await pool.query(`
            select pinned_instances from control.user_preferences where user_id = $1
        `, [CURRENT_USER]);

        let pinned: number[] = cur.rows[0]?.pinned_instances || [];
        if (pinned.includes(instancePk)) {
            pinned = pinned.filter(p => p !== instancePk);
        } else {
            pinned = [...pinned, instancePk];
        }

        const result = await pool.query(`
            insert into control.user_preferences (user_id, pinned_instances)
            values ($2, $1::jsonb)
            on conflict (user_id) do update
            set pinned_instances = $1::jsonb, updated_at = now()
            returning pinned_instances
        `, [JSON.stringify(pinned), CURRENT_USER]);

        res.json({ pinned_instances: result.rows[0].pinned_instances });
    } catch (err) {
        next(err);
    }
});

export default router;
