// =============================================================================
// Response time logger — tüm API isteklerinin sürelerini console'a yazar
// =============================================================================
// Audit log sadece PUT/POST/DELETE/PATCH'i DB'ye yazar (compliance icin).
// Bu middleware ek olarak GET dahil her isteğin süresini stdout'a yazar
// (debugging + performance görünürlük). DB'ye yazmaz, gürültü yaratmaz.

import { Request, Response, NextFunction } from 'express';

// 500ms üzeri istekleri uyarı seviyesinde logla
const SLOW_THRESHOLD_MS = 500;

// Çok sık çağrılan path'leri loglama (gürültü)
const SKIP_PATHS = [
    '/api/version',
    '/api/health',
];

export function responseTimeMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (SKIP_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) {
        return next();
    }

    const startTime = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const status = res.statusCode;
        const slow = duration > SLOW_THRESHOLD_MS;
        const error = status >= 400;

        // Format: "200 GET /api/instances 12ms" veya "500 POST /api/foo 1234ms (slow)"
        const tag = error ? '⚠️' : slow ? '🐢' : '✓';
        const line = `${tag} ${status} ${req.method.padEnd(6)} ${req.originalUrl} ${duration}ms${slow ? ' (slow)' : ''}`;

        if (error || slow) {
            console.warn(line);
        }
        // Normal istekleri sessizce geç — sadece yavaş veya hatalıları logla
    });

    next();
}
