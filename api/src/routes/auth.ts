import { Router } from 'express';
import {
    checkPassword, generateAccessToken, generateRefreshToken,
    verifyRefreshToken, isLockedOut, recordFailedAttempt, clearAttempts
} from '../config/auth';

const router = Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';

    if (isLockedOut(ip)) {
        res.status(429).json({ error: 'Çok fazla başarısız deneme. 15 dakika sonra tekrar deneyin.' });
        return;
    }

    const { password } = req.body;
    if (!password || typeof password !== 'string') {
        res.status(400).json({ error: 'Şifre zorunlu' });
        return;
    }

    if (!checkPassword(password)) {
        const result = recordFailedAttempt(ip);
        if (result.locked) {
            res.status(429).json({ error: 'Çok fazla başarısız deneme. 15 dakika kilitlendi.' });
        } else {
            res.status(401).json({ error: 'Şifre yanlış', remaining: result.remaining });
        }
        return;
    }

    clearAttempts(ip);

    const accessToken = generateAccessToken();
    const refreshToken = generateRefreshToken();

    // Refresh token httpOnly cookie'ye yaz
    res.cookie('pgstat_refresh', refreshToken, {
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 gün
        secure: process.env.NODE_ENV === 'production',
    });

    res.json({ token: accessToken, expiresIn: 3600 });
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
    const refreshToken = req.cookies?.pgstat_refresh;
    if (!refreshToken) {
        res.status(401).json({ error: 'Refresh token bulunamadı' });
        return;
    }
    if (!verifyRefreshToken(refreshToken)) {
        res.clearCookie('pgstat_refresh');
        res.status(401).json({ error: 'Geçersiz refresh token' });
        return;
    }
    const accessToken = generateAccessToken();
    res.json({ token: accessToken, expiresIn: 3600 });
});

// POST /api/auth/logout
router.post('/logout', (_req, res) => {
    res.clearCookie('pgstat_refresh');
    res.json({ ok: true });
});

export default router;
