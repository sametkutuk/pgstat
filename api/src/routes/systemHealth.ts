import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

router.get('/checks', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select
        check_name,
        last_run_at,
        last_status,
        detail_message,
        updated_at
      from control.health_check_state
      order by check_name
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

export default router;
