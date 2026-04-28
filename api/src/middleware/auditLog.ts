// =============================================================================
// Audit log middleware — kim ne zaman ne degistirdi
// =============================================================================
// PUT/POST/DELETE/PATCH istekleri ops.audit_log'a yazilir. Tek admin sistemde
// user hep 'admin' olur, ama IP, endpoint, body, response status fark eder.
// Async fire-and-forget — response gecikmez. DB hatasi varsa sessizce atlar.

import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';

const TRACKED_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// Bu endpoint'leri loglamiyoruz (gurultu, hassas, veya cok sik)
const SKIP_PATHS = [
    '/api/auth/',           // login/logout/refresh — ayri auth log var
    '/api/health',          // healthcheck
];

// Body'de mask edilecek alanlar (sifre, secret, token)
const SENSITIVE_FIELDS = ['password', 'secret_ref', 'bot_token', 'api_key', 'token'];

/** Sensitive alanlari '***' ile mask et — DB'ye duz sifre yazmamak icin */
function sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') return body;
    if (Array.isArray(body)) return body.map(sanitizeBody);

    const out: any = {};
    for (const [k, v] of Object.entries(body)) {
        if (SENSITIVE_FIELDS.some(s => k.toLowerCase().includes(s))) {
            out[k] = v ? '***' : v;
        } else if (typeof v === 'object') {
            out[k] = sanitizeBody(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

export function auditLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!TRACKED_METHODS.has(req.method)) return next();
    if (SKIP_PATHS.some(p => req.path.startsWith(p))) return next();

    const startTime = Date.now();
    const originalJson = res.json.bind(res);
    let responseSummary: string | null = null;

    // Response'u yakala (kisa ozet icin)
    res.json = function (body: any) {
        try {
            if (body) {
                const summary = typeof body === 'string'
                    ? body.slice(0, 200)
                    : JSON.stringify(body).slice(0, 200);
                responseSummary = summary;
            }
        } catch { /* ignore */ }
        return originalJson(body);
    };

    // Request bittiginde async log yaz
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const sanitized = sanitizeBody(req.body);
        const ip = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');

        // Tek admin sistemde user 'admin', ileride JWT'den cekilebilir
        const userName = 'admin';

        pool.query(
            `insert into ops.audit_log
               (user_name, client_ip, http_method, endpoint, request_body,
                response_status, response_summary, duration_ms)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [userName, ip, req.method, req.originalUrl,
             sanitized ? JSON.stringify(sanitized) : null,
             res.statusCode,
             responseSummary,
             duration]
        ).catch((e) => {
            // Tablo yoksa veya hata olursa sessizce atla — uygulama akisini durdurmasin
            if (e.code !== '42P01') {  // 42P01 = relation does not exist (V038 yoksa)
                console.error('audit_log yazma hatasi:', e.message);
            }
        });
    });

    next();
}
