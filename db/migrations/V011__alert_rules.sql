-- Alert kuralları tabloları

create table if not exists control.alert_rule (
  rule_id bigint generated always as identity primary key,
  rule_name text not null,
  description text null,

  -- Ne ölçülüyor
  metric_type text not null,
  metric_name text not null,

  -- Kapsam
  scope text not null default 'all_instances',
  instance_pk bigint null references control.instance_inventory(instance_pk),
  service_group text null,

  -- Koşul
  condition_operator text not null default '>',
  warning_threshold numeric null,
  critical_threshold numeric null,

  -- Değerlendirme
  evaluation_window_minutes integer not null default 5,
  aggregation text not null default 'avg',

  -- Davranış
  is_enabled boolean not null default true,
  cooldown_minutes integer not null default 15,
  auto_resolve boolean not null default true,

  -- Meta
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ck_alert_rule_metric_type check (
    metric_type in ('cluster_metric', 'io_metric', 'database_metric',
                    'statement_metric', 'table_metric', 'index_metric',
                    'activity_metric', 'replication_metric')
  ),
  constraint ck_alert_rule_scope check (
    scope in ('all_instances', 'specific_instance', 'service_group')
  ),
  constraint ck_alert_rule_operator check (
    condition_operator in ('>', '<', '>=', '<=', '=')
  ),
  constraint ck_alert_rule_aggregation check (
    aggregation in ('avg', 'sum', 'max', 'min', 'last', 'count')
  ),
  constraint ck_alert_rule_threshold check (
    warning_threshold is not null or critical_threshold is not null
  ),
  constraint ck_alert_rule_window check (evaluation_window_minutes > 0),
  constraint ck_alert_rule_cooldown check (cooldown_minutes >= 0)
);

create index if not exists ix_alert_rule_enabled
  on control.alert_rule (is_enabled, metric_type)
  where is_enabled;

-- Kural başına son değerlendirme durumu (cooldown takibi)
create table if not exists control.alert_rule_last_eval (
  rule_id bigint not null references control.alert_rule(rule_id) on delete cascade,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  last_evaluated_at timestamptz not null default now(),
  last_alert_at timestamptz null,
  last_value numeric null,
  current_severity text null, -- null = normal, 'warning', 'critical'
  primary key (rule_id, instance_pk)
);

-- Template'lerin ON CONFLICT hedefi. V012 ve V014 bu constraint'e dayaniyordu
-- ama constraint yalnizca V015'te olusturuluyordu; temiz bir veritabaninda
-- V012 "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" ile kiriliyordu. V015 ayni bloga sahip oldugu icin orada
-- no-op'a duser.
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

-- updated_at trigger
-- Fonksiyon control semasinda tanimli (V001). Semasiz cagri yalnizca
-- search_path'te control varsa cozulur; temiz bir veritabaninda
-- "function set_updated_at() does not exist" ile kiriliyordu.
create trigger trg_alert_rule_updated_at
  before update on control.alert_rule
  for each row execute function control.set_updated_at();
