-- V027: alert_rule metric_type constraint'ini guncelle
-- Yeni eklenen metric type'lar: wal_metric, archiver_metric, slot_metric,
-- conflict_metric, slru_metric, subscription_metric, prefetch_metric, function_metric

alter table control.alert_rule drop constraint if exists ck_alert_rule_metric_type;

alter table control.alert_rule add constraint ck_alert_rule_metric_type check (
  metric_type in (
    'cluster_metric', 'io_metric', 'database_metric',
    'statement_metric', 'table_metric', 'index_metric',
    'activity_metric', 'replication_metric',
    'wal_metric', 'archiver_metric', 'slot_metric', 'conflict_metric',
    'slru_metric', 'subscription_metric', 'prefetch_metric', 'function_metric'
  )
);

-- Scope constraint'ini de guncelle (instance_group eklenmisti)
alter table control.alert_rule drop constraint if exists ck_alert_rule_scope;
alter table control.alert_rule add constraint ck_alert_rule_scope check (
  scope in ('all_instances', 'specific_instance', 'service_group', 'single_instance', 'instance_group')
);
