import { compareSync, hashSync } from 'bcryptjs';
import { sign, verify } from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

const JWT_SECRET = process.env.PGSTAT_JWT_SECRET || '';
const JWT_REFRESH_SECRET = process.env.PGSTAT_JWT_REFRESH_SECRET || '';
const ACCESS_TOKEN_TTL = '1h';
const REFRESH_TOKEN_TTL = '7d';

// Brute force koruma: IP başına başarısız deneme sayısı
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 dakika

export function getAdminPasswordHash(): string {
    return process.env.PGSTAT_ADMIN_PASSWORD_HASH || '';
}

export function checkPassword(plain: string): boolean {
    const hash = getAdminPasswordHash();
    if (!hash) return false;
    return compareSync(plain, hash);
}

export function generateAccessToken(): string {
    return sign({ role: 'admin' }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function generateRefreshToken(): string {
    return sign({ role: 'admin', type: 'refresh' }, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
}

export function verifyAccessToken(token: string): boolean {
    try {
        verify(token, JWT_SECRET);
        return true;
    } catch {
        return false;
    }
}

export function verifyRefreshToken(token: string): boolean {
    try {
        const payload = verify(token, JWT_REFRESH_SECRET) as any;
        return payload.type === 'refresh';
    } catch {
        return false;
    }
}

/** Brute force: IP kilitli mi? */
export function isLockedOut(ip: string): boolean {
    const entry = loginAttempts.get(ip);
    if (!entry) return false;
    if (entry.lockedUntil > Date.now()) return true;
    // Kilit süresi dolmuş, temizle
    loginAttempts.delete(ip);
    return false;
}

/** Başarısız deneme kaydet */
export function recordFailedAttempt(ip: string): { locked: boolean; remaining: number } {
    const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) {
        entry.lockedUntil = Date.now() + LOCK_DURATION_MS;
    }
    loginAttempts.set(ip, entry);
    return {
        locked: entry.count >= MAX_ATTEMPTS,
        remaining: Math.max(0, MAX_ATTEMPTS - entry.count),
    };
}

/** Başarılı girişte deneme sayacını sıfırla */
export function clearAttempts(ip: string): void {
    loginAttempts.delete(ip);
}

/** JWT auth middleware — tüm korumalı route'larda kullanılır */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Yetkilendirme gerekli' });
        return;
    }
    const token = authHeader.slice(7);
    if (!verifyAccessToken(token)) {
        res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token' });
        return;
    }
    next();
}

/** Uygulama başlarken JWT secret'larının set edilip edilmediğini kontrol et */
export function validateAuthConfig(): void {
    const errors: string[] = [];
    if (!JWT_SECRET || JWT_SECRET.length < 32) {
        errors.push('PGSTAT_JWT_SECRET en az 32 karakter olmalı');
    }
    if (!JWT_REFRESH_SECRET || JWT_REFRESH_SECRET.length < 32) {
        errors.push('PGSTAT_JWT_REFRESH_SECRET en az 32 karakter olmalı');
    }
    if (!getAdminPasswordHash()) {
        errors.push('PGSTAT_ADMIN_PASSWORD_HASH set edilmemiş');
    }
    if (errors.length > 0) {
        throw new Error('Auth konfigürasyon hatası:\n' + errors.join('\n'));
    }
}

/** Yardımcı: şifre hash'i üret (setup sırasında kullanılır) */
export function hashPassword(plain: string): string {
    return hashSync(plain, 12);
}
