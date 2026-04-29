-- =============================================================================
-- V041: Manuel nightly snapshot tetikleme tablosu
-- UI'dan veya curl ile "hemen topla" denildiginde collector 5sn icinde baslar.
-- Ayni mantik: control.baseline_trigger gibi.
-- =============================================================================

create table if not exists control.nightly_snapshot_trigger (
  trigger_id    serial primary key,
  status        text not null default 'pending',  -- pending, running, done, failed
  requested_by  text null,
  requested_at  timestamptz not null default now(),
  started_at    timestamptz null,
  finished_at   timestamptz null,
  rows_written  bigint null
);
