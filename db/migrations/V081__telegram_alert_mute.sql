-- V081: Telegram reply ile alert mute/snooze.

alter table control.alert_snooze
  add column if not exists alert_key text,
  add column if not exists alert_code text;

alter table control.alert_snooze
  alter column snooze_until drop not null;

alter table control.alert_snooze
  drop constraint if exists check_snooze_scope;

alter table control.alert_snooze
  add constraint check_snooze_scope check (
    alert_key is not null or
    alert_code is not null or
    rule_id is not null or
    instance_pk is not null or
    metric_key is not null or
    queryid is not null
  );

create index if not exists idx_alert_snooze_alert_key
  on control.alert_snooze (alert_key)
  where alert_key is not null;

create index if not exists idx_alert_snooze_alert_code
  on control.alert_snooze (alert_code, instance_pk)
  where alert_code is not null;

create table if not exists control.telegram_message_map (
  map_id bigserial primary key,
  chat_id text not null,
  message_id bigint not null,
  alert_id bigint,
  alert_key text not null,
  alert_code text,
  instance_pk bigint,
  sent_at timestamptz default now(),
  unique (chat_id, message_id)
);

create index if not exists ix_tg_msgmap_sent
  on control.telegram_message_map (sent_at);

create index if not exists ix_tg_msgmap_alert_key
  on control.telegram_message_map (alert_key);

create table if not exists control.telegram_poll_state (
  bot_key text primary key,
  last_update_id bigint not null default 0,
  updated_at timestamptz default now()
);

create table if not exists control.telegram_command_allowlist (
  telegram_user_id bigint primary key,
  username text,
  note text,
  is_enabled boolean not null default true,
  created_at timestamptz default now()
);
