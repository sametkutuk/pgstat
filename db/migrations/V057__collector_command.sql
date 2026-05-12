-- V057: API → collector komut kuyruğu
-- UI'dan manuel tetikleme için (refresh settings, retry bootstrap vb.)
-- Collector her 5s polling'de pending kayıtları işler.

create table if not exists control.collector_command (
    command_id     bigserial primary key,
    command        varchar(40) not null,
    instance_pk    bigint null,
    status         varchar(20) not null default 'pending'
        check (status in ('pending', 'running', 'done', 'failed')),
    requested_at   timestamptz not null default now(),
    processed_at   timestamptz null,
    error_message  text null
);

create index if not exists ix_collector_command_pending
    on control.collector_command (status) where status = 'pending';
