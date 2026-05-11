-- =========================================================================
-- V060: Manual report trigger queue
-- =========================================================================
-- API writes pending rows; collector processes them asynchronously.

create table if not exists control.report_trigger (
    trigger_id     bigserial primary key,
    report_type    varchar(20) not null check (report_type in ('daily', 'weekly')),
    requested_by   text,
    requested_at   timestamptz not null default now(),
    started_at     timestamptz,
    completed_at   timestamptz,
    status         varchar(20) not null default 'pending'
                     check (status in ('pending', 'running', 'done', 'failed')),
    report_id      bigint references ops.report_history(report_id) on delete set null,
    error_message  text
);

create index if not exists ix_report_trigger_pending
    on control.report_trigger (requested_at)
    where status = 'pending';

create index if not exists ix_report_trigger_type_at
    on control.report_trigger (report_type, requested_at desc);

comment on table control.report_trigger is
    'Manual report trigger queue. API inserts pending rows, collector generates the report.';
