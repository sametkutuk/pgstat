-- V026: SLRU + Subscription + Recovery Prefetch + User Functions snapshot tablolari
-- ============================================================================
-- Versiyon destegi:
--   pg_stat_slru              : PG13+
--   pg_stat_subscription      : PG10+ (stats PG10+, temel fields)
--   pg_stat_subscription_stats: PG15+ (apply_error_count, sync_error_count)
--   pg_stat_recovery_prefetch : PG15+
--   pg_stat_user_functions    : Tum versiyonlar (track_functions acik olmali)

-- ----------------------------------------------------------------------------
-- 1) pg_stat_slru snapshot (PG13+)
-- ----------------------------------------------------------------------------
create table if not exists fact.pg_slru_snapshot (
  sample_ts      timestamptz not null,
  instance_pk    bigint      not null,
  name           text        not null,
  blks_zeroed    bigint      null,
  blks_hit       bigint      null,
  blks_read      bigint      null,
  blks_written   bigint      null,
  blks_exists    bigint      null,
  flushes        bigint      null,
  truncates      bigint      null,
  stats_reset    timestamptz null,
  primary key (sample_ts, instance_pk, name)
) partition by range (sample_ts);

create index if not exists ix_pg_slru_snapshot_instance_ts
  on fact.pg_slru_snapshot (instance_pk, sample_ts desc);

-- ----------------------------------------------------------------------------
-- 2) pg_stat_subscription snapshot (PG10+)
-- ----------------------------------------------------------------------------
create table if not exists fact.pg_subscription_snapshot (
  sample_ts          timestamptz not null,
  instance_pk        bigint      not null,
  subid              bigint      not null,
  subname            text        null,
  pid                integer     null,
  relid              bigint      null,
  received_lsn       text        null,
  last_msg_send_time timestamptz null,
  last_msg_receipt_time timestamptz null,
  latest_end_lsn     text        null,
  latest_end_time    timestamptz null,
  -- Lag byte cinsinden hesaplanir (received - latest_end):
  lag_bytes          bigint      null,
  -- pg_stat_subscription_stats (PG15+)
  apply_error_count  bigint      null,
  sync_error_count   bigint      null,
  stats_reset        timestamptz null,
  primary key (sample_ts, instance_pk, subid)
) partition by range (sample_ts);

create index if not exists ix_pg_subscription_snapshot_instance_ts
  on fact.pg_subscription_snapshot (instance_pk, sample_ts desc);

-- ----------------------------------------------------------------------------
-- 3) pg_stat_recovery_prefetch snapshot (PG15+; standby'larda anlamli)
-- ----------------------------------------------------------------------------
create table if not exists fact.pg_recovery_prefetch_snapshot (
  sample_ts     timestamptz not null,
  instance_pk   bigint      not null,
  prefetch      bigint      null,
  hit           bigint      null,
  skip_init     bigint      null,
  skip_new      bigint      null,
  skip_fpw      bigint      null,
  skip_rep      bigint      null,
  stats_reset   timestamptz null,
  wal_distance  bigint      null,
  block_distance bigint     null,
  io_depth      bigint      null,
  primary key (sample_ts, instance_pk)
) partition by range (sample_ts);

create index if not exists ix_pg_recovery_prefetch_snapshot_instance_ts
  on fact.pg_recovery_prefetch_snapshot (instance_pk, sample_ts desc);

-- ----------------------------------------------------------------------------
-- 4) pg_stat_user_functions snapshot (tum versiyonlar)
-- ----------------------------------------------------------------------------
create table if not exists fact.pg_user_function_snapshot (
  sample_ts    timestamptz not null,
  instance_pk  bigint      not null,
  dbid         bigint      not null,
  funcid       bigint      not null,
  schemaname   text        null,
  funcname     text        null,
  calls        bigint      null,
  total_time   numeric     null,    -- ms
  self_time    numeric     null,    -- ms
  primary key (sample_ts, instance_pk, dbid, funcid)
) partition by range (sample_ts);

create index if not exists ix_pg_user_function_snapshot_instance_ts
  on fact.pg_user_function_snapshot (instance_pk, sample_ts desc);

-- ----------------------------------------------------------------------------
-- Ilk partition'lar
-- ----------------------------------------------------------------------------
do $$
declare
  d date;
  part_name text;
  tbl text;
begin
  for d in select generate_series(current_date - interval '1 day',
                                   current_date + interval '14 days',
                                   interval '1 day')::date
  loop
    foreach tbl in array array[
      'pg_slru_snapshot',
      'pg_subscription_snapshot',
      'pg_recovery_prefetch_snapshot',
      'pg_user_function_snapshot'
    ]
    loop
      part_name := tbl || '_' || to_char(d, 'YYYYMMDD');
      execute format(
        'create table if not exists fact.%I partition of fact.%I for values from (%L) to (%L)',
        part_name, tbl, d, d + 1
      );
    end loop;
  end loop;
end $$;

comment on table fact.pg_slru_snapshot              is 'pg_stat_slru snapshot (PG13+) — SLRU cache hit/miss istatistikleri';
comment on table fact.pg_subscription_snapshot      is 'pg_stat_subscription (+stats PG15+) — logical replication aboneliklerinin durumu';
comment on table fact.pg_recovery_prefetch_snapshot is 'pg_stat_recovery_prefetch (PG15+) — standby recovery prefetch istatistikleri';
comment on table fact.pg_user_function_snapshot     is 'pg_stat_user_functions — fonksiyon cagri/zaman istatistikleri (track_functions aktif ise dolar)';

-- ----------------------------------------------------------------------------
-- 5) Hazir alert templates
-- ----------------------------------------------------------------------------
insert into control.alert_rule (
  rule_name, description,
  metric_type, metric_name, scope,
  condition_operator, warning_threshold, critical_threshold,
  evaluation_window_minutes, aggregation,
  evaluation_type, change_threshold_pct, min_data_days,
  alert_category, spike_fallback_pct, flatline_minutes,
  is_enabled, cooldown_minutes, auto_resolve, created_by
) values

-- SLRU: cache miss orani yukselmesi
('SLRU Cache Miss Artisi',
 'SLRU cache''inde blks_read (disk okuma) son 10 dakikada ani artti — kapasite zorlaniyor.',
 'slru_metric', 'blks_read', 'all_instances',
 '>', null, null, 10, 'sum',
 'spike', 100.0, 3,
 'smart', 200.0, 0,
 false, 30, true, 'system'),

-- Subscription: apply error
('Logical Replication Apply Hatasi',
 'pg_stat_subscription_stats.apply_error_count artisi var — subscriber''da apply hata aliyor.',
 'subscription_metric', 'apply_error_count', 'all_instances',
 '>', null, null, 10, 'max',
 'spike', 50.0, 3,
 'smart', 100.0, 0,
 false, 15, false, 'system'),

-- Subscription: lag
('Logical Replication Lag',
 'Subscription''in received_lsn ile latest_end_lsn farki cok buyuk.',
 'subscription_metric', 'lag_bytes', 'all_instances',
 '>', 104857600, 1073741824, 5, 'max',   -- 100 MB warning, 1 GB critical
 'threshold', null, 0,
 'threshold', null, 0,
 false, 30, true, 'system'),

-- Recovery prefetch: skip'ler fazla ise prefetch etkisi az demektir
('Recovery Prefetch Etkin Degil',
 'Standby''de prefetch sayisina gore hit orani dusuk (cache miss fazla).',
 'prefetch_metric', 'skip_fpw', 'all_instances',
 '>', null, null, 10, 'sum',
 'spike', 200.0, 3,
 'smart', 500.0, 0,
 false, 60, true, 'system'),

-- User functions: yavas fonksiyon
('Yavas Fonksiyon Artisi',
 'pg_stat_user_functions self_time toplami son 10 dakikada ani artti.',
 'function_metric', 'self_time', 'all_instances',
 '>', null, null, 10, 'sum',
 'spike', 200.0, 3,
 'smart', 500.0, 0,
 false, 30, true, 'system')

on conflict (rule_name, metric_type, metric_name) do nothing;
