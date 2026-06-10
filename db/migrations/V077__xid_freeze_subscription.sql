create table if not exists control.xid_freeze_subscription (
    subscription_id bigserial primary key,
    instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
    is_enabled boolean not null default true,
    warning_pct integer not null default 80 check (warning_pct between 1 and 100),
    critical_pct integer not null default 95 check (critical_pct between 1 and 100),
    notify_on_xid boolean not null default true,
    notify_on_mxid boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (instance_pk)
);

create index if not exists ix_xid_freeze_subscription_enabled
    on control.xid_freeze_subscription (instance_pk)
    where is_enabled = true;

insert into control.xid_freeze_subscription (instance_pk)
select instance_pk
from control.instance_inventory
where is_active = true
on conflict (instance_pk) do nothing;
