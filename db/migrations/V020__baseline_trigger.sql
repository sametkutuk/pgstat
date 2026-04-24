-- V020: Manuel baseline tetikleme icin flag tablosu
-- API bu tabloya satir ekler, collector poll'da bunu gorur ve BaselineCalculator'i calistirir.

create table if not exists control.baseline_trigger (
  trigger_id    bigserial primary key,
  instance_pk   bigint references control.instance_inventory(instance_pk) on delete cascade,
  -- instance_pk null ise: tum instance'lar icin hesapla
  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  status        text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed')),
  error_message text,
  requested_by  text
);

create index if not exists idx_baseline_trigger_pending
  on control.baseline_trigger (requested_at)
  where status = 'pending';

comment on table control.baseline_trigger
  is 'Manuel baseline hesaplama istegi. Collector poll loopunda pending kayitlari isler.';
