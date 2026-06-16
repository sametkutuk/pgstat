// Telegram komut allowlist API'leri
//   GET    /api/telegram-allowlist        — izinli Telegram user_id listesi
//   POST   /api/telegram-allowlist        — yeni user_id ekle
//   PATCH  /api/telegram-allowlist/:id    — is_enabled / note guncelle
//   DELETE /api/telegram-allowlist/:id    — sil
//
// Bu liste, Telegram'dan gelen alert susturma komutlarini KIM verebilir
// kontrolu icindir (control.telegram_command_allowlist). Liste BOSSA hicbir
// komut kabul edilmez (fail-closed). CRUD islemleri /api auditLog middleware
// ile otomatik denetlenir (kim ekledi/sildi iz birakir).

import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

// Telegram user_id 64-bit pozitif tam sayidir. UI'dan string de gelebilir,
// strict dogrula (injection/abuse yuzeyi yok ama temiz tutalim).
function parseUserId(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!/^\d{1,19}$/.test(s)) return null;
  try {
    const id = BigInt(s);
    return id > 0n ? id : null;
  } catch {
    return null;
  }
}

// GET — tum allowlist kayitlari
router.get('/', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      select telegram_user_id::text as telegram_user_id,
             username, note, is_enabled, created_at
      from control.telegram_command_allowlist
      order by created_at desc
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST — yeni user_id ekle
router.post('/', async (req, res, next) => {
  try {
    const userId = parseUserId(req.body?.telegram_user_id);
    if (userId === null) {
      res.status(400).json({ error: 'Gecersiz telegram_user_id (pozitif tam sayi olmali)' });
      return;
    }
    const username = req.body?.username ? String(req.body.username).slice(0, 200) : null;
    const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
    const isEnabled = req.body?.is_enabled !== undefined ? Boolean(req.body.is_enabled) : true;

    const result = await pool.query(
      `insert into control.telegram_command_allowlist
         (telegram_user_id, username, note, is_enabled)
       values ($1, $2, $3, $4)
       on conflict (telegram_user_id) do update
         set username = excluded.username,
             note = excluded.note,
             is_enabled = excluded.is_enabled
       returning telegram_user_id::text as telegram_user_id, username, note, is_enabled, created_at`,
      [userId.toString(), username, note, isEnabled]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH — is_enabled / note guncelle
router.patch('/:id', async (req, res, next) => {
  try {
    const userId = parseUserId(req.params.id);
    if (userId === null) {
      res.status(400).json({ error: 'Gecersiz id' });
      return;
    }
    const isEnabled = req.body?.is_enabled !== undefined ? Boolean(req.body.is_enabled) : null;
    const note = req.body?.note !== undefined ? String(req.body.note).slice(0, 500) : null;

    const result = await pool.query(
      `update control.telegram_command_allowlist set
         is_enabled = coalesce($2, is_enabled),
         note = coalesce($3, note)
       where telegram_user_id = $1
       returning telegram_user_id::text as telegram_user_id, username, note, is_enabled, created_at`,
      [userId.toString(), isEnabled, note]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Kayit bulunamadi' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE — kaydi sil
router.delete('/:id', async (req, res, next) => {
  try {
    const userId = parseUserId(req.params.id);
    if (userId === null) {
      res.status(400).json({ error: 'Gecersiz id' });
      return;
    }
    const result = await pool.query(
      `delete from control.telegram_command_allowlist
       where telegram_user_id = $1
       returning telegram_user_id::text as telegram_user_id`,
      [userId.toString()]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Kayit bulunamadi' });
      return;
    }
    res.json({ ok: true, deleted_id: userId.toString() });
  } catch (err) {
    next(err);
  }
});

export default router;
