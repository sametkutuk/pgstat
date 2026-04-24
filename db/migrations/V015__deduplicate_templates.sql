-- Tekrarlayan template kayıtlarını temizle.
-- Her (rule_name, metric_type, metric_name) grubundan en küçük rule_id'yi tutar, geri kalanı siler.
delete from control.alert_rule
where rule_id not in (
  select min(rule_id)
  from control.alert_rule
  group by rule_name, metric_type, metric_name
);

-- İleride tekrar oluşmaması için unique constraint ekle (template'ler için)
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'uq_alert_rule_name_metric'
      and conrelid = 'control.alert_rule'::regclass
  ) then
    alter table control.alert_rule
      add constraint uq_alert_rule_name_metric
      unique (rule_name, metric_type, metric_name);
  end if;
end $$;
