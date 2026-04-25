-- =============================================================================
-- V031: Grafana icin read-only kullanici (yetkiler)
-- =============================================================================
-- ROL OLUSTURMA superuser gerektirdigi icin migration burada yapamaz.
-- pgstat_admin kullanicisi normalde CREATEROLE yetkisine sahip degildir.
--
-- ROLU OLUSTURMAK ICIN superuser ile bir kez su komutu calistir:
--
--   PGPASSWORD=postgres-superuser-pwd psql -h $PGSTAT_DB_HOST -p $PGSTAT_DB_PORT \
--     -U postgres -d $PGSTAT_DB_NAME -f db/setup/grafana-user.sql
--
-- Veya tek satir:
--   psql -U postgres -d pgstat -c "CREATE ROLE pgstat_grafana_ro LOGIN PASSWORD 'grafana-ro';"
--
-- Sonra ./pgstat upgrade calistir — bu migration GRANT'leri uygular ve
-- pgstat upgrade .env'deki PGSTAT_GRAFANA_DB_PASSWORD'u rolune sync eder.
--
-- Bu migration rolu yoksa SESSIZ atlar (idempotent), grant'leri sadece
-- rol mevcutsa uygular.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pgstat_grafana_ro') then
    raise notice 'pgstat_grafana_ro rolu yok — superuser ile olustur: psql -U postgres -d pgstat -f db/setup/grafana-user.sql';
    return;
  end if;

  -- Connect izni
  execute 'grant connect on database ' || current_database() || ' to pgstat_grafana_ro';

  -- Schema kullanim izni
  grant usage on schema fact   to pgstat_grafana_ro;
  grant usage on schema agg    to pgstat_grafana_ro;
  grant usage on schema dim    to pgstat_grafana_ro;
  grant usage on schema control to pgstat_grafana_ro;
  grant usage on schema ops    to pgstat_grafana_ro;

  -- Mevcut tablolarda SELECT
  grant select on all tables in schema fact   to pgstat_grafana_ro;
  grant select on all tables in schema agg    to pgstat_grafana_ro;
  grant select on all tables in schema dim    to pgstat_grafana_ro;
  grant select on all tables in schema control to pgstat_grafana_ro;
  grant select on all tables in schema ops    to pgstat_grafana_ro;

  -- NOT: ALTER ROLE ... SET statement_timeout superuser/CREATEROLE gerektirir.
  -- Bu yuzden timeout ayarlari db/setup/grafana-user.sql'de (superuser ile)
  -- yapilir, V031 sadece pgstat_admin'in yapabilecegi GRANT'leri uygular.

  raise notice 'pgstat_grafana_ro: GRANT''ler uygulandi.';
end $$;

-- DEFAULT PRIVILEGES — bu DO blogu icinde calismaz cunku ALTER DEFAULT PRIVILEGES
-- transaction baglaminda role gerektirir. Sadece rol mevcutsa, ayri komutlarla.
-- Asagidaki komutlar rol yoksa hata verir; ama DO blogundaki return durumunda
-- bu komutlar hala calisir. Bu yuzden conditional psql \gexec pattern'i kullaniyoruz.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pgstat_grafana_ro') then
    execute 'alter default privileges in schema fact    grant select on tables to pgstat_grafana_ro';
    execute 'alter default privileges in schema agg     grant select on tables to pgstat_grafana_ro';
    execute 'alter default privileges in schema dim     grant select on tables to pgstat_grafana_ro';
    execute 'alter default privileges in schema control grant select on tables to pgstat_grafana_ro';
    execute 'alter default privileges in schema ops     grant select on tables to pgstat_grafana_ro';
  end if;
end $$;
