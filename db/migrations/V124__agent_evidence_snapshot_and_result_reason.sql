-- Immutable investigation evidence captured before model interpretation.
-- Worker may write only through the scoped API; model text is never an evidence snapshot.
create table if not exists agent.investigation_evidence (
    evidence_id bigserial primary key,
    investigation_id bigint not null references agent.investigation(investigation_id) on delete cascade,
    tool_call_id bigint not null unique references agent.investigation_tool_call(tool_call_id) on delete cascade,
    envelope jsonb not null check (jsonb_typeof(envelope) = 'object'),
    sha256_hex char(64) not null check (sha256_hex ~ '^[a-f0-9]{64}$'),
    response_bytes integer not null check (response_bytes between 1 and 131072),
    recorded_at timestamptz not null default now()
);
create index if not exists ix_agent_evidence_investigation
    on agent.investigation_evidence (investigation_id, evidence_id);

create or replace function agent.reject_evidence_mutation()
returns trigger language plpgsql as $$
begin
    raise exception 'investigation evidence is append-only' using errcode = '23514';
end;
$$;
drop trigger if exists tr_agent_evidence_append_only on agent.investigation_evidence;
create trigger tr_agent_evidence_append_only before update or delete
    on agent.investigation_evidence for each row execute function agent.reject_evidence_mutation();

alter table agent.investigation_result
    add column if not exists confidence_reason text;
alter table agent.investigation_result
    drop constraint if exists ck_agent_confidence_reason;
alter table agent.investigation_result
    add constraint ck_agent_confidence_reason
    check (confidence_reason is null or length(btrim(confidence_reason)) between 1 and 500);

alter table agent.investigation
    add column if not exists input_tokens integer,
    add column if not exists output_tokens integer;
alter table agent.investigation
    drop constraint if exists ck_agent_token_counts;
alter table agent.investigation
    add constraint ck_agent_token_counts check
    ((input_tokens is null or input_tokens >= 0) and
     (output_tokens is null or output_tokens >= 0));
