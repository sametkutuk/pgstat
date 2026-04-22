import { Pool } from 'pg';

// Central PostgreSQL bağlantı havuzu — tüm değerler env'den gelir, varsayılan yok
export const pool = new Pool({
  host: process.env.PGSTAT_DB_HOST,
  port: parseInt(process.env.PGSTAT_DB_PORT!),
  database: process.env.PGSTAT_DB_NAME,
  user: process.env.PGSTAT_DB_USER,
  password: process.env.PGSTAT_DB_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
