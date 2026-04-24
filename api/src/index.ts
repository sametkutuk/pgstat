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
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import instanceRoutes from './routes/instances';
import alertRoutes from './routes/alerts';
import jobRunRoutes from './routes/jobRuns';
import retentionRoutes from './routes/retentionPolicies';
import scheduleRoutes from './routes/scheduleProfiles';
import statementRoutes from './routes/statements';
import alertRuleRoutes from './routes/alertRules';

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

// Genel API rate limit
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: { error: 'Çok fazla istek' },
    standardHeaders: true,
    legacyHeaders: false,
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

// Sağlık kontrolü — korumasız (Docker healthcheck için)
app.get('/api/health', async (_req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch {
        res.status(503).json({ status: 'error', database: 'disconnected' });
    }
});

// Korumalı route'lar — JWT zorunlu
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/instances', requireAuth, instanceRoutes);
app.use('/api/alerts', requireAuth, alertRoutes);
app.use('/api/alert-rules', requireAuth, alertRuleRoutes);
app.use('/api/job-runs', requireAuth, jobRunRoutes);
app.use('/api/retention-policies', requireAuth, retentionRoutes);
app.use('/api/schedule-profiles', requireAuth, scheduleRoutes);
app.use('/api/statements', requireAuth, statementRoutes);

// Hata yakalama middleware'i
app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`pgstat API running on port ${PORT}`);
});

export default app;
