-- AI DBA investigation history and evidence-backed telemetry improvement queue.
-- AI has no direct database access: rows are written through pgstat API only.

create schema if not exists agent;

create table if not exists agent.investigation (
    investigation_id bigserial primary key,
    requested_by text not null default 'admin',
    question text not null check (length(btrim(question)) between 1 and 4000),
    investigation_type text not null default 'autovacuum'
        check (investigation_type in ('autovacuum')),
    instance_pk bigint references control.instance_inventory(instance_pk) on delete set null,
    dbid oid,
    time_from timestamptz not null,
    time_to timestamptz not null,
    status text not null default 'queued'
        check (status in ('queued', 'planning', 'collecting_evidence', 'interpreting',
                          'completed', 'insufficient_evidence', 'failed', 'cancelled', 'timed_out')),
    model_provider text,
    model_name text,
    failure_code text,
    failure_detail text,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (time_from < time_to),
    check (time_to - time_from <= interval '31 days')
);

create index if not exists ix_agent_investigation_created
    on agent.investigation (created_at desc);
create index if not exists ix_agent_investigation_instance_created
    on agent.investigation (instance_pk, created_at desc);
create index if not exists ix_agent_investigation_pending
    on agent.investigation (created_at)
    where status in ('queued', 'planning', 'collecting_evidence', 'interpreting');

create table if not exists agent.investigation_message (
    message_id bigserial primary key,
    investigation_id bigint not null references agent.investigation(investigation_id) on delete cascade,
    role text not null check (role in ('user', 'assistant', 'system')),
    content text not null check (length(content) between 1 and 20000),
    created_at timestamptz not null default now()
);

create index if not exists ix_agent_message_investigation
    on agent.investigation_message (investigation_id, created_at, message_id);

create table if not exists agent.investigation_tool_call (
    tool_call_id bigserial primary key,
    investigation_id bigint not null references agent.investigation(investigation_id) on delete cascade,
    tool_name text not null,
    tool_version text not null default '1',
    request_summary jsonb not null default '{}'::jsonb,
    status text not null check (status in ('started', 'succeeded', 'failed', 'timed_out')),
    coverage_state text
        check (coverage_state is null or coverage_state in
               ('complete', 'partial', 'no_data', 'not_collected', 'unsupported_version',
                'unknown_capability', 'stale', 'insufficient_samples', 'tool_not_available', 'failed')),
    result_item_count integer check (result_item_count is null or result_item_count >= 0),
    result_bytes integer check (result_bytes is null or result_bytes >= 0),
    error_code text,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    duration_ms integer check (duration_ms is null or duration_ms >= 0)
);

create index if not exists ix_agent_tool_call_investigation
    on agent.investigation_tool_call (investigation_id, started_at, tool_call_id);

create table if not exists agent.investigation_result (
    investigation_id bigint primary key references agent.investigation(investigation_id) on delete cascade,
    schema_version text not null default '1.0',
    conclusion text not null,
    confidence text not null check (confidence in ('low', 'medium', 'high')),
    observed_facts jsonb not null default '[]'::jsonb check (jsonb_typeof(observed_facts) = 'array'),
    interpretations jsonb not null default '[]'::jsonb check (jsonb_typeof(interpretations) = 'array'),
    hypotheses jsonb not null default '[]'::jsonb check (jsonb_typeof(hypotheses) = 'array'),
    limitations jsonb not null default '[]'::jsonb check (jsonb_typeof(limitations) = 'array'),
    external_knowledge jsonb not null default '[]'::jsonb check (jsonb_typeof(external_knowledge) = 'array'),
    created_at timestamptz not null default now()
);

create table if not exists agent.telemetry_improvement (
    improvement_id bigserial primary key,
    dedup_key text not null unique,
    gap_type text not null
        check (gap_type in ('DATA_NOT_COLLECTED', 'DATA_INSUFFICIENT', 'MCP_FUNCTION_MISSING')),
    technical_reason text
        check (technical_reason is null or technical_reason in
               ('STALE_DATA', 'TOO_FEW_SAMPLES', 'RETENTION_TOO_SHORT',
                'CAPABILITY_UNKNOWN', 'UNSUPPORTED_VERSION', 'COLLECTION_FAILED',
                'API_FAILED', 'TOOL_NOT_AVAILABLE')),
    requested_capability text not null,
    title text not null,
    simple_reason text not null,
    status text not null default 'review_required'
        check (status in ('review_required', 'accepted', 'in_progress', 'resolved', 'rejected')),
    occurrence_count integer not null default 0 check (occurrence_count >= 0),
    first_detected_at timestamptz not null default now(),
    last_detected_at timestamptz not null default now(),
    resolved_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check ((status = 'resolved' and resolved_at is not null)
        or (status <> 'resolved' and resolved_at is null))
);

create index if not exists ix_agent_improvement_status_last_seen
    on agent.telemetry_improvement (status, last_detected_at desc);

create table if not exists agent.telemetry_improvement_occurrence (
    occurrence_id bigserial primary key,
    improvement_id bigint not null references agent.telemetry_improvement(improvement_id) on delete cascade,
    investigation_id bigint not null references agent.investigation(investigation_id) on delete cascade,
    instance_pk bigint references control.instance_inventory(instance_pk) on delete set null,
    pg_major integer,
    requested_text text not null,
    available_text text not null,
    missing_text text not null,
    reason_text text not null,
    tool_call_id bigint references agent.investigation_tool_call(tool_call_id) on delete set null,
    coverage_summary jsonb not null default '{}'::jsonb,
    detected_at timestamptz not null default now(),
    unique (improvement_id, investigation_id)
);

create index if not exists ix_agent_improvement_occurrence_improvement
    on agent.telemetry_improvement_occurrence (improvement_id, detected_at desc);

comment on table agent.telemetry_improvement is
    'Human-reviewed product backlog: what AI requested but pgstat could not provide. Never changes collector behavior automatically.';
comment on column agent.telemetry_improvement.dedup_key is
    'Server-derived stable key; never accept an AI-provided key as authoritative.';
