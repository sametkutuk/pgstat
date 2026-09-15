-- AI provider configuration. Secret values stay in the encrypted secret store;
-- this table contains only a file reference and non-sensitive metadata.

create table if not exists agent.provider_connection (
    connection_id bigserial primary key,
    provider text not null unique
        check (provider in ('gemini', 'openrouter', 'ollama', 'openai', 'anthropic')),
    model_name text not null check (length(btrim(model_name)) between 1 and 120),
    base_url text not null check (length(base_url) between 8 and 500),
    secret_ref text,
    is_enabled boolean not null default true,
    data_policy_acknowledged_at timestamptz,
    last_tested_at timestamptz,
    last_test_status text
        check (last_test_status is null or last_test_status in ('success', 'failed')),
    last_test_error_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (provider = 'ollama' or secret_ref is not null)
);

comment on column agent.provider_connection.secret_ref is
    'Encrypted file reference only. API responses must never expose this value.';
