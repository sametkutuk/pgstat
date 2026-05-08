import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import { pool } from './config/database';
import { validateAuthConfig, requireAuth } from './config/auth';
import { errorHandler } from './middleware/errorHandler';
import { auditLogMiddleware } from './middleware/auditLog';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import instanceRoutes from './routes/instances';
import alertRoutes from './routes/alerts';
import jobRunRoutes from './routes/jobRuns';
import retentionRoutes from './routes/retentionPolicies';
import scheduleRoutes from './routes/scheduleProfiles';
import statementRoutes from './routes/statements';
import alertRuleRoutes from './routes/alertRules';
import adaptiveAlertingRoutes from './routes/adaptiveAlerting';
import systemAlertRoutes from './routes/systemAlerts';
import reportRoutes from './routes/reports';
import workloadRoutes from './routes/workload';
import clusterRoutes from './routes/clusters';
import auditLogRoutes from './routes/auditLog';
import onboardingRoutes from './routes/onboarding';
import preferencesRoutes from './routes/preferences';

// Zorunlu env değişkenlerini kontrol et
const requiredEnv = ['PGSTAT_DB_HOST', 'PGSTAT_DB_PORT', 'PGSTAT_DB_NAME', 'PGSTAT_DB_USER', 'PGSTAT_DB_PASSWORD'];
for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`HATA: Zorunlu env değişkeni eksik: ${key}`);
        process.exit(1);
    }
}

// Auth konfigürasyonunu doğrula
try {
    validateAuthConfig();
} catch (err: any) {
    console.error('HATA:', err.message);
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || `http://localhost:${process.env.UI_PORT || 3000}`;

// Güvenlik başlıkları
app.use(helmet({
    contentSecurityPolicy: false, // nginx proxy arkasında UI ayrı servis
}));

// CORS — sadece izin verilen origin
app.use(cors({
    origin: CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));

app.use(express.json());
app.use(cookieParser());
app.set('trust proxy', 1); // nginx arkasında gerçek IP için

// Login endpoint'i için sıkı rate limit (brute force koruması üst katman)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Çok fazla istek, 15 dakika sonra tekrar deneyin' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Genel API rate limit — pgstat UI çoklu polling (8+ instance × 5-6 endpoint
// × 60s refetch) ile dakikada ~30 req atar. 15 dk = 450 req. Buffer ile 5000.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5000,
    message: { error: 'Çok fazla istek' },
    standardHeaders: true,
    legacyHeaders: false,
    // /api/version sık çağrılır (sidebar her render) — bunu sayma
    skip: (req) => req.path === '/version' || req.path === '/health',
});

app.use('/api/', apiLimiter);

// Auth route'ları — korumasız (login/refresh/logout)
app.use('/api/auth', loginLimiter, authRoutes);

// Versiyon — korumasız (UI login ekranında gösterilebilsin)
app.get('/api/version', (_req, res) => {
    try {
        const versionFile = path.join(__dirname, '../VERSION');
        const version = fs.readFileSync(versionFile, 'utf8').trim();
        res.json({ version });
    } catch {
        res.json({ version: 'unknown' });
    }
});

// Sağlık kontrolü — korumasız (Docker healthcheck + external monitoring için)
// 3 katmanlı kontrol:
//   - DB connection
//   - Collector son job_run zamanı (5 dk'dan eski ise unhealthy → collector çökmüş demektir)
//   - Aktif instance sayısı (0 ise OK ama warning)
app.get('/api/health', async (_req, res) => {
    try {
        await pool.query('SELECT 1');
    } catch {
        return res.status(503).json({ status: 'error', database: 'disconnected' });
    }

    // Collector liveness — son job_run < 5dk değilse alarm
    let collectorStatus: 'ok' | 'stale' | 'unknown' = 'unknown';
    let lastJobRun: string | null = null;
    let lagSeconds: number | null = null;
    try {
        const r = await pool.query(
            `select max(started_at) as last_run,
                    extract(epoch from (now() - max(started_at)))::int as lag_seconds
             from ops.job_run`
        );
        if (r.rows[0]?.last_run) {
            lastJobRun = r.rows[0].last_run;
            lagSeconds = r.rows[0].lag_seconds;
            // 5dk üzeri stale (poll loop 5sn'de bir job çalışır, normal lag <30sn)
            collectorStatus = (lagSeconds !== null && lagSeconds < 300) ? 'ok' : 'stale';
        }
    } catch (e: any) {
        // ops.job_run yoksa veya migration yapılmadıysa
        collectorStatus = 'unknown';
    }

    let activeInstances = 0;
    try {
        const r = await pool.query(`select count(*) as cnt from control.instance_inventory where is_active`);
        activeInstances = parseInt(r.rows[0]?.cnt || '0', 10);
    } catch { /* ignore */ }

    const overall = collectorStatus === 'stale' ? 503 : 200;
    res.status(overall).json({
        status: overall === 200 ? 'ok' : 'degraded',
        database: 'connected',
        collector: collectorStatus,
        last_job_run: lastJobRun,
        collector_lag_seconds: lagSeconds,
        active_instances: activeInstances,
    });
});

// Audit log middleware — PUT/POST/DELETE/PATCH istekleri ops.audit_log'a yazilir
// requireAuth'tan SONRA, route'lardan ONCE — sadece auth gecmis istekleri logla
app.use('/api', auditLogMiddleware);

// Korumalı route'lar — JWT zorunlu
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/instances', requireAuth, instanceRoutes);
app.use('/api/alerts', requireAuth, alertRoutes);
app.use('/api/alert-rules', requireAuth, alertRuleRoutes);
app.use('/api/adaptive-alerting', requireAuth, adaptiveAlertingRoutes);
app.use('/api/job-runs', requireAuth, jobRunRoutes);
app.use('/api/retention-policies', requireAuth, retentionRoutes);
app.use('/api/schedule-profiles', requireAuth, scheduleRoutes);
app.use('/api/statements', requireAuth, statementRoutes);
app.use('/api/system-alerts', requireAuth, systemAlertRoutes);
app.use('/api/reports', requireAuth, reportRoutes);
app.use('/api/workload', requireAuth, workloadRoutes);
app.use('/api/clusters', requireAuth, clusterRoutes);
app.use('/api/audit-log', requireAuth, auditLogRoutes);
app.use('/api/onboarding', requireAuth, onboardingRoutes);
app.use('/api/preferences', requireAuth, preferencesRoutes);

// Hata yakalama middleware'i
app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`pgstat API running on port ${PORT}`);
});

export default app;
