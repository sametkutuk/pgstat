create table if not exists control.slot_lifecycle_subscription (
    subscription_id bigserial primary key,
    instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
    is_enabled boolean not null default true,
    inactive_minutes integer not null default 30 check (inactive_minutes >= 5),
    retrigger_minutes integer not null default 30 check (retrigger_minutes >= 5),
    notify_on_lost boolean not null default true,
    notify_on_active_deleted boolean not null default true,
    notify_on_inactive_deleted boolean not null default true,
    notify_on_inactive boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (instance_pk)
);

create index if not exists ix_slot_lifecycle_subscription_enabled
    on control.slot_lifecycle_subscription (instance_pk)
    where is_enabled = true;

create table if not exists control.slot_observation_state (
    instance_pk bigint not null,
    slot_name text not null,
    last_seen_at timestamptz not null,
    last_restart_lsn pg_lsn,
    last_stats_reset timestamptz,
    last_active boolean,
    last_wal_status text,
    inactive_since timestamptz,
    last_retrigger_at timestamptz,
    tombstone_at timestamptz,
    primary key (instance_pk, slot_name)
);

create index if not exists ix_slot_observation_state_tombstone
    on control.slot_observation_state (instance_pk)
    where tombstone_at is not null;

insert into control.slot_lifecycle_subscription (instance_pk)
select instance_pk
from control.instance_inventory
where is_active = true
on conflict (instance_pk) do nothing;
