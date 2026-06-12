-- =============================================================================
-- V079: db_objects manuel tetikleme tablosu
-- Vacuum Lag / tablo istatistikleri UI'dan "Simdi Topla" ile bir instance'in
-- tum tablolarini hemen toplamak icin. nightly_snapshot_trigger pattern'i.
-- =============================================================================

create table if not exists control.db_objects_trigger (
  trigger_id    bigserial primary key,
  instance_pk   bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  status        text not null default 'pending',  -- pending, running, done, failed
  requested_by  text null,
  requested_at  timestamptz not null default now(),
  started_at    timestamptz null,
  finished_at   timestamptz null,
  rows_written  bigint null
);

-- Bekleyen tetikleri hizli bulmak icin
create index if not exists ix_db_objects_trigger_pending
  on control.db_objects_trigger (instance_pk)
  where status = 'pending';
