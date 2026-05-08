-- =============================================================================
-- V054: User preferences — pin'lenen instance'lar + dashboard widget config
--
-- Şu an tek admin kullanıcı, ileride çoklu kullanıcıya açılırsa user_id kolonu
-- eklenir. Tek satırda key-value yapı, hızlı okuma.
-- =============================================================================

create table if not exists control.user_preferences (
  user_id              text not null default 'admin' primary key,
  pinned_instances     jsonb not null default '[]'::jsonb,  -- [3, 5, 7]
  dashboard_widgets    jsonb not null default '{}'::jsonb,  -- {"wal_production": true, "open_alerts": true, ...}
  updated_at           timestamptz not null default now()
);

-- Default kayıt — admin için boş başlangıç
insert into control.user_preferences (user_id, pinned_instances, dashboard_widgets)
values ('admin', '[]'::jsonb, '{
  "open_alerts": true,
  "instance_health": true,
  "wal_production": true,
  "top_bloat": true,
  "recent_jobs": true
}'::jsonb)
on conflict (user_id) do nothing;

comment on table control.user_preferences is
  'Kullanıcı dashboard tercihleri (pinned instances, widget visibility)';
