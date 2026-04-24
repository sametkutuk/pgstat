-- V021: evaluation_type constraint'ine 'adaptive' degerini ekle.
-- V016'da olusturulan ck_alert_rule_eval_type constraint'i adaptive'i icermiyor.

alter table control.alert_rule
  drop constraint if exists ck_alert_rule_eval_type;
alter table control.alert_rule
  drop constraint if exists alert_rule_evaluation_type_check;

alter table control.alert_rule
  add constraint ck_alert_rule_eval_type
  check (evaluation_type in (
    'threshold',
    'alltime_high', 'alltime_low',
    'day_over_day', 'week_over_week',
    'spike',
    'flatline',
    'hourly_pattern',
    'adaptive'
  ));
