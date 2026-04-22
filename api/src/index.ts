import express from 'express';
import cors from 'cors';
import { pool } from './config/database';
import { errorHandler } from './middleware/errorHandler';
import dashboardRoutes from './routes/dashboard';
import instanceRoutes from './routes/instances';
import alertRoutes from './routes/alerts';
import jobRunRoutes from './routes/jobRuns';
import retentionRoutes from './routes/retentionPolicies';
import scheduleRoutes from './routes/scheduleProfiles';
import statementRoutes from './routes/statements';

// Express uygulaması oluştur
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware'ler
app.use(cors());
app.use(express.json());

// Route'ları bağla
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/instances', instanceRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/job-runs', jobRunRoutes);
app.use('/api/retention-policies', retentionRoutes);
app.use('/api/schedule-profiles', scheduleRoutes);
app.use('/api/statements', statementRoutes);

// Sağlık kontrolü
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

// Hata yakalama middleware'i
app.use(errorHandler);

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`pgstat API running on port ${PORT}`);
});

export default app;
