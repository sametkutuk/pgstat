create table if not exists control.long_query_subscription (
    subscription_id bigserial primary key,
    instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
    is_enabled boolean not null default true,
    long_query_minutes integer not null default 5 check (long_query_minutes >= 1),
    idle_tx_minutes integer not null default 30 check (idle_tx_minutes >= 1),
    notify_on_long_query boolean not null default true,
    notify_on_idle_tx boolean not null default true,
    notify_on_idle_tx_aborted boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (instance_pk)
);

create index if not exists ix_long_query_subscription_enabled
    on control.long_query_subscription (instance_pk)
    where is_enabled = true;

insert into control.long_query_subscription (instance_pk)
select instance_pk
from control.instance_inventory
where is_active = true
on conflict (instance_pk) do nothing;
