-- V019: V018 tutarsizliklari giderilir + alert_notification tablosu eklenir
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) scope constraint'ini V011 degerleriyle uyumlu hale getir
-- ----------------------------------------------------------------------------
-- V018 'single_instance' dedi ama V011/V016 'specific_instance' kullaniyor.
-- Mevcut scope degerlerini specific_instance ile hizala.
update control.alert_rule set scope = 'specific_instance' where scope = 'single_instance';

-- Eski check constraint'lerini dusur
alter table control.alert_rule drop constraint if exists alert_rule_scope_check;
alter table control.alert_rule drop constraint if exists ck_alert_rule_scope;
alter table control.alert_rule drop constraint if exists check_scope_consistency;

-- scope default'unu duzelt
alter table control.alert_rule alter column scope set default 'all_instances';

-- V018'deki sert check constraint'i esnet (service_group ve specific_instance birlikte)
alter table control.alert_rule
  add constraint ck_alert_rule_scope
  check (scope in ('all_instances', 'specific_instance', 'service_group', 'instance_group'));

-- Tutarlilik: scope ile ilgili alan esleme
alter table control.alert_rule
  add constraint ck_alert_rule_scope_consistency check (
    (scope = 'all_instances')
    or (scope = 'specific_instance' and instance_pk is not null)
    or (scope = 'service_group'     and service_group is not null)
    or (scope = 'instance_group'    and instance_group_id is not null)
  );

-- ----------------------------------------------------------------------------
-- B) use_adaptive / absolute_* kolonlarini kaldir
-- alert_category = 'smart' tek kaynak olarak kullanilacak.
-- warning_threshold / critical_threshold zaten V011'den beri var.
-- ----------------------------------------------------------------------------
alter table control.alert_rule drop column if exists use_adaptive;
alter table control.alert_rule drop column if exists absolute_warning;
alter table control.alert_rule drop column if exists absolute_critical;

-- ----------------------------------------------------------------------------
-- C) alert_notification tablosu (Phase 4 hazirligi)
-- ----------------------------------------------------------------------------
create table if not exists control.alert_notification (
  notification_id bigserial primary key,
  alert_id bigint references ops.alert(alert_id) on delete cascade,
  channel_id integer references control.notification_channel(channel_id) on delete set null,

  sent_at timestamptz default now(),
  status text check (status in ('sent', 'failed', 'retrying')),
  error_message text,
  retry_count integer default 0,

  response_code integer,
  response_body text
);

create index if not exists idx_alert_notification_alert on control.alert_notification (alert_id);
create index if not exists idx_alert_notification_status on control.alert_notification (status, sent_at);

-- ----------------------------------------------------------------------------
-- D) Fonksiyonel iyilestirmeler
-- ----------------------------------------------------------------------------

-- is_in_maintenance: timezone destegi (maintenance_window.timezone)
create or replace function control.is_in_maintenance(
  p_instance_pk bigint
) returns boolean as $$
begin
  return exists (
    select 1
    from control.maintenance_window w
    where w.is_enabled = true
      and (w.instance_pks is null or p_instance_pk = any(w.instance_pks))
      and (w.day_of_week  is null or extract(dow from (now() at time zone coalesce(w.timezone, 'UTC')))::int = any(w.day_of_week))
      and (now() at time zone coalesce(w.timezone, 'UTC'))::time between w.start_time and w.end_time
  );
end;
$$ language plpgsql stable;

-- adaptive kural evaluator'i icin: instance icin belirli bir metric + hour baseline'ini getir.
-- Saatlik baseline yoksa -1 (genel) baseline'ini dondur.
create or replace function control.get_baseline(
  p_instance_pk bigint,
  p_metric_key  text,
  p_hour        integer
) returns table(
  avg_value     numeric,
  stddev_value  numeric,
  p50_value     numeric,
  p95_value     numeric,
  p99_value     numeric,
  sample_count  integer
) as $$
begin
  return query
  select b.avg_value, b.stddev_value, b.p50_value, b.p95_value, b.p99_value, b.sample_count
  from control.metric_baseline b
  where b.instance_pk = p_instance_pk
    and b.metric_key  = p_metric_key
    and b.hour_of_day = p_hour
  limit 1;

  if not found then
    return query
    select b.avg_value, b.stddev_value, b.p50_value, b.p95_value, b.p99_value, b.sample_count
    from control.metric_baseline b
    where b.instance_pk = p_instance_pk
      and b.metric_key  = p_metric_key
      and b.hour_of_day = -1
    limit 1;
  end if;
end;
$$ language plpgsql stable;

comment on function control.get_baseline(bigint, text, integer)
  is 'Adaptive evaluator icin: saatlik baseline, yoksa genel baseline doner';
comment on table control.alert_notification
  is 'Alert icin gonderilen bildirimlerin izi';
