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
--     -v grafana_pwd="$PGSTAT_GRAFANA_DB_PASSWORD" \
--     -f db/setup/grafana-user.sql
-- =============================================================================

\if :{?grafana_pwd}
\else
  \echo 'HATA: -v grafana_pwd=... ile sifre verilmedi. Bkz dosya basindaki yorum.'
  \quit
\endif

do $$
declare
  v_pwd text := :'grafana_pwd';
begin
  if not exists (select 1 from pg_roles where rolname = 'pgstat_grafana_ro') then
    execute format('create role pgstat_grafana_ro with login password %L', v_pwd);
    raise notice 'pgstat_grafana_ro rolu olusturuldu.';
  else
    execute format('alter role pgstat_grafana_ro with login password %L', v_pwd);
    raise notice 'pgstat_grafana_ro rolu zaten vardi, sifre guncellendi.';
  end if;
end $$;
