-- =============================================================================
-- V038: Audit log — kim ne zaman ne degistirdi
--
-- API middleware her PUT/POST/DELETE/PATCH istegini kaydeder. Kim hangi
-- endpoint'e ne body ile geldi, response status ne — debug ve compliance icin.
--
-- Tek admin sistemde "user" hep ayni — ama yine de IP, endpoint, body fark
-- eder. Sorun cikarsa kim/ne yaptini bulur.
-- =============================================================================

create table if not exists ops.audit_log (
  audit_id      bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  user_name     text null,
  client_ip     text null,
  http_method   text not null,
  endpoint      text not null,
  request_body  jsonb null,
  response_status integer null,
  response_summary text null,
  duration_ms   integer null
);

create index if not exists ix_audit_log_occurred_at
  on ops.audit_log (occurred_at desc);
create index if not exists ix_audit_log_endpoint
  on ops.audit_log (endpoint, occurred_at desc);
create index if not exists ix_audit_log_user
  on ops.audit_log (user_name, occurred_at desc)
  where user_name is not null;

comment on table ops.audit_log is 'API tarafinda yapilan degisiklik kayitlari (PUT/POST/DELETE/PATCH)';
