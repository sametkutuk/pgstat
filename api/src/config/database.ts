import { Pool } from 'pg';

// Central PostgreSQL bağlantı havuzu
export const pool = new Pool({
  host: process.env.PGSTAT_DB_HOST || 'localhost',
  port: parseInt(process.env.PGSTAT_DB_PORT || '5417'),
  database: process.env.PGSTAT_DB_NAME || 'pgstat',
  user: process.env.PGSTAT_DB_USER || 'samet',
  password: process.env.PGSTAT_DB_PASSWORD || 'samet',
  max: 10, // maksimum bağlantı sayısı
});
