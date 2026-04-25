-- =============================================================================
-- Grafana read-only kullanici olustur (TEK SEFER, superuser ile)
-- =============================================================================
-- pgstat_admin CREATEROLE yetkisine sahip degil. Bu komut superuser ile bir
-- kez calistirilir. .env'deki PGSTAT_GRAFANA_DB_PASSWORD psql variable olarak
-- gecirilir.
--
-- Onerilen calistirma yontemi (pgstat script'i):
--   ./pgstat setup-grafana
--
-- Manuel calistirma:
--   set -a; source .env; set +a
--   PGPASSWORD=<superuser-pwd> psql \
--     -h $PGSTAT_DB_HOST -p $PGSTAT_DB_PORT \
--     -U postgres -d $PGSTAT_DB_NAME \
--     -v ON_ERROR_STOP=1 \
--     -v grafana_pwd="$PGSTAT_GRAFANA_DB_PASSWORD" \
--     -f db/setup/grafana-user.sql
-- =============================================================================

\if :{?grafana_pwd}
\else
  \echo 'HATA: -v grafana_pwd=... ile sifre verilmedi. Bkz dosya basindaki yorum.'
  \quit 1
\endif

-- psql :var substitution sadece düz SQL'de çalışır, PL/pgSQL DO blogunda
-- calismaz. Bu yuzden \gexec ile dinamik SQL uretip calistirmak gerekiyor.

-- 1) Rol yoksa olustur
select format('create role pgstat_grafana_ro login password %L', :'grafana_pwd')
where not exists (select 1 from pg_roles where rolname = 'pgstat_grafana_ro')
\gexec

-- 2) Rol varsa sifreyi guncelle (idempotent)
select format('alter role pgstat_grafana_ro with login password %L', :'grafana_pwd')
where exists (select 1 from pg_roles where rolname = 'pgstat_grafana_ro')
\gexec

\echo 'pgstat_grafana_ro rolu hazir (sifre senkronize edildi).'
