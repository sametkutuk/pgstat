-- =============================================================================
-- V031: Grafana icin read-only kullanici
-- =============================================================================
-- Grafana data source bu kullaniciyi kullanir. Sadece SELECT yetkisi vardir.
-- Sifre apply.sh / pgstat upgrade tarafindan PGSTAT_GRAFANA_DB_PASSWORD ile set edilir.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pgstat_grafana_ro') then
    create role pgstat_grafana_ro with login password 'grafana-ro-changeme';
  end if;
end$$;

-- Connect izni
grant connect on database pgstat to pgstat_grafana_ro;

-- Schema kullanim izni — sadece okumak icin lazim olan schema'lar
grant usage on schema fact, agg, dim, control, ops to pgstat_grafana_ro;

-- Mevcut tablolarda SELECT
grant select on all tables in schema fact to pgstat_grafana_ro;
grant select on all tables in schema agg to pgstat_grafana_ro;
grant select on all tables in schema dim to pgstat_grafana_ro;
grant select on all tables in schema control to pgstat_grafana_ro;
grant select on all tables in schema ops to pgstat_grafana_ro;

-- Yeni tablolar olusursa otomatik SELECT yetkisi
alter default privileges in schema fact   grant select on tables to pgstat_grafana_ro;
alter default privileges in schema agg    grant select on tables to pgstat_grafana_ro;
alter default privileges in schema dim    grant select on tables to pgstat_grafana_ro;
alter default privileges in schema control grant select on tables to pgstat_grafana_ro;
alter default privileges in schema ops    grant select on tables to pgstat_grafana_ro;

-- Grafana yavas sorgu yazsa bile DB'yi kilitlememesi icin timeout'lar
alter role pgstat_grafana_ro set statement_timeout = '30s';
alter role pgstat_grafana_ro set lock_timeout = '5s';
alter role pgstat_grafana_ro set idle_in_transaction_session_timeout = '60s';
