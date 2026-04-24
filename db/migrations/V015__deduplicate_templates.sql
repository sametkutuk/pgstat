-- Tekrarlayan template kayıtlarını temizle.
-- Her (rule_name, metric_type, metric_name) grubundan en küçük rule_id'yi tutar, geri kalanı siler.
delete from control.alert_rule
where rule_id not in (
  select min(rule_id)
  from control.alert_rule
  group by rule_name, metric_type, metric_name
);

-- İleride tekrar oluşmaması için unique constraint ekle (template'ler için)
alter table control.alert_rule
  add constraint uq_alert_rule_name_metric
  unique (rule_name, metric_type, metric_name);
