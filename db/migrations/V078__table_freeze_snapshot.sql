-- =============================================================================
-- V078: Per-table XID/MXID freeze snapshot + retention/schedule kolonlari
-- =============================================================================

-- A) Fact tablosu (partition'li, V039 pg_database_freeze_snapshot pattern'i)
create table if not exists fact.pg_table_freeze_snapshot (
  snapshot_ts         timestamptz not null,
  instance_pk         bigint not null,
  dbid                bigint not null,
  schemaname          text not null,
  relname             text not null,
  relkind             text not null,
  relfrozenxid_age    bigint null,
  relminmxid_age      bigint null,
  relpages            bigint null,
  last_autovacuum_at  timestamptz null,
  primary key (snapshot_ts, instance_pk, dbid, schemaname, relname)
) partition by range (snapshot_ts);

create index if not exists ix_table_freeze_snapshot_inst_age
  on fact.pg_table_freeze_snapshot (instance_pk, snapshot_ts desc)
  where relfrozenxid_age is not null;

-- Baslangic partition'lari (gecmis 1 + gelecek 14 gun)
do $body$
declare
  d date;
  part_name text;
begin
  for d in select generate_series(current_date - 1, current_date + 14, '1 day'::interval)::date loop
    part_name := 'pg_table_freeze_snapshot_' || to_char(d, 'YYYYMMDD');
    begin
      execute format(
        'create table if not exists fact.%I partition of fact.pg_table_freeze_snapshot for values from (%L) to (%L)',
        part_name,
        (d::text || ' 00:00:00+00')::timestamptz,
        ((d + 1)::text || ' 00:00:00+00')::timestamptz
      );
    exception when others then null;
    end;
  end loop;
end
$body$;

-- B) Retention policy - saklama suresi kolonu
alter table control.retention_policy
  add column if not exists table_freeze_retention_days integer not null default 90;

-- C) Schedule profile - toplama sikligi kolonu
alter table control.schedule_profile
  add column if not exists table_freeze_interval_seconds integer not null default 21600;

-- Check constraint (idempotent guard)
do $body$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ck_schedule_profile_table_freeze_interval'
  ) then
    alter table control.schedule_profile
      add constraint ck_schedule_profile_table_freeze_interval
      check (table_freeze_interval_seconds >= 3600);
  end if;
end
$body$;
