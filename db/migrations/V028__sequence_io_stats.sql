-- V028: pg_statio_all_sequences snapshot tablosu
-- Sequence I/O istatistikleri — tum versiyonlarda mevcut

create table if not exists fact.pg_sequence_io_snapshot (
  sample_ts    timestamptz not null,
  instance_pk  bigint      not null,
  dbid         bigint      not null,
  relid        bigint      not null,
  schemaname   text        null,
  relname      text        null,
  blks_read    bigint      null,
  blks_hit     bigint      null,
  primary key (sample_ts, instance_pk, dbid, relid)
) partition by range (sample_ts);

create index if not exists ix_pg_sequence_io_snapshot_instance_ts
  on fact.pg_sequence_io_snapshot (instance_pk, sample_ts desc);

-- Ilk partition'lar
do $
declare
  d date;
begin
  for d in select generate_series(current_date - interval '1 day',
                                   current_date + interval '14 days',
                                   interval '1 day')::date
  loop
    execute format(
      'create table if not exists fact.%I partition of fact.pg_sequence_io_snapshot for values from (%L) to (%L)',
      'pg_sequence_io_snapshot_' || to_char(d, 'YYYYMMDD'), d, d + 1
    );
  end loop;
end $;

-- metric_type constraint guncelle
alter table control.alert_rule drop constraint if exists ck_alert_rule_metric_type;
alter table control.alert_rule add constraint ck_alert_rule_metric_type check (
  metric_type in (
    'cluster_metric', 'io_metric', 'database_metric',
    'statement_metric', 'table_metric', 'index_metric',
    'activity_metric', 'replication_metric',
    'wal_metric', 'archiver_metric', 'slot_metric', 'conflict_metric',
    'slru_metric', 'subscription_metric', 'prefetch_metric', 'function_metric',
    'sequence_metric'
  )
);

-- Alert templates
insert into control.alert_rule (
  rule_name, description,
  metric_type, metric_name, scope,
  condition_operator, warning_threshold, critical_threshold,
  evaluation_window_minutes, aggregation,
  evaluation_type, change_threshold_pct, min_data_days,
  alert_category, spike_fallback_pct, flatline_minutes,
  is_enabled, cooldown_minutes, auto_resolve, created_by
) values
('Sequence Disk Okuma Artisi',
 'Sequence blks_read artisi — sequence cache''e sigmiyor, disk I/O yapiyor.',
 'sequence_metric', 'blks_read', 'all_instances',
 '>', null, null, 10, 'sum',
 'spike', 100.0, 3,
 'smart', 200.0, 0,
 false, 30, true, 'system')
on conflict (rule_name, metric_type, metric_name) do nothing;

comment on table fact.pg_sequence_io_snapshot is 'pg_statio_all_sequences — sequence I/O istatistikleri (blks_read/hit)';
