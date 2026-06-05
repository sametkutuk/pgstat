-- V073: alert cleanup before the new system health evaluator.

truncate ops.alert restart identity cascade;

alter table ops.alert
  add column if not exists alert_source text default 'legacy' not null;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'ck_alert_source'
    ) then
        alter table ops.alert
          add constraint ck_alert_source
          check (alert_source in ('system', 'user_rule', 'adaptive', 'legacy'));
    end if;
end$$;

drop table if exists control.system_alert_config cascade;

update control.alert_rule
set is_enabled = false
where is_enabled = true;

comment on table ops.alert is
  'Alert records. alert_source: system (pgstat health), user_rule (user rule), adaptive (adaptive alerting), legacy (old removed system).';
