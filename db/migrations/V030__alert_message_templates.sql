-- =============================================================================
-- V030: Alert mesaj şablonları
-- =============================================================================
-- Amaç: Hem custom alert kuralları hem de sistem alert kodları için
-- başlık ve mesaj şablonlarını destekler. Şablonlar {{placeholder}} sözdizimiyle
-- runtime'da render edilir. Render motoru collector'da AlertMessageRenderer.
--
-- Kapsam:
--   1. control.alert_rule tablosuna title_template + message_template kolonları
--      (nullable — null ise default template veya hardcoded fallback kullanılır)
--   2. control.alert_message_template tablosu — alert_code başına default şablon
--   3. Seed: tüm AlertCode enum değerleri için varsayılan başlık/mesaj
-- =============================================================================

-- 1) alert_rule tablosuna template kolonları
alter table control.alert_rule
  add column if not exists title_template   text null,
  add column if not exists message_template text null;

comment on column control.alert_rule.title_template is
  'Alert başlığı için Mustache benzeri şablon. Boşsa varsayılan kullanılır. '
  'Placeholder: {{instance}} {{metric}} {{value}} {{threshold}} {{severity}} '
  '{{operator}} {{window}} {{aggregation}} {{rule_name}}';

comment on column control.alert_rule.message_template is
  'Alert detay mesajı için şablon. Boşsa varsayılan kullanılır. '
  'Placeholder: yukarıdakiler + {{baseline_avg}} {{warning_threshold}} {{critical_threshold}} '
  '{{started_at}} {{duration_minutes}} {{trend_pct}} {{dashboard_url}}';

-- =============================================================================
-- 2) Alert kodu başına varsayılan şablonlar
-- =============================================================================
create table if not exists control.alert_message_template (
  alert_code        text primary key,
  title_template    text not null,
  message_template  text not null,
  description       text null,
  is_system         boolean not null default true, -- false = kullanıcı override etmiş
  updated_at        timestamptz not null default now()
);

drop trigger if exists trg_alert_message_template_updated_at on control.alert_message_template;
create trigger trg_alert_message_template_updated_at
  before update on control.alert_message_template
  for each row execute function control.set_updated_at();

-- =============================================================================
-- 3) Seed — varsayılan şablonlar
-- =============================================================================
-- Format kuralları:
--   - Title: tek satır, severity emoji + instance + kısa özet
--   - Message: çok satırlı, ne/nerede/değer/eşik/öneri yapısı
--   - Türkçe metin, teknik terimler İngilizce kalabilir

insert into control.alert_message_template (alert_code, title_template, message_template, description) values

-- Custom kullanıcı kuralı — generic şablon
('user_defined_rule',
 '[{{severity_upper}}] {{instance}} · {{rule_name}}',
 E'{{severity_emoji}} **{{rule_name}}**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 Metrik: `{{metric}}` = **{{value}}** ({{aggregation}}, son {{window}} dk)\n' ||
 E'🎯 Eşik: {{operator}} {{threshold}} ({{severity}})\n' ||
 E'🕐 Başlangıç: {{started_at}}\n' ||
 E'💡 Kural: {{rule_name}}',
 'Kullanıcı tanımlı eşik kuralları için varsayılan şablon'),

-- Bağlantı/sağlık
('connection_failure',
 '[CRITICAL] {{instance}} · Bağlantı kurulamıyor',
 E'🔴 **Source PostgreSQL''e bağlantı kurulamıyor**\n' ||
 E'📍 Instance: **{{instance}}** ({{host}}:{{port}})\n' ||
 E'🕐 Başlangıç: {{started_at}}\n' ||
 E'⏱️ Süre: {{duration_minutes}} dk\n' ||
 E'❌ Hata: {{error_message}}\n' ||
 E'🔧 Kontrol: PG servisi çalışıyor mu? Network/firewall? pg_hba.conf?',
 'Source instance bağlantı hatası'),

('authentication_failure',
 '[CRITICAL] {{instance}} · Kimlik doğrulama hatası',
 E'🔴 **Authentication başarısız**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'👤 Kullanıcı: `pgstat_collector`\n' ||
 E'🔧 Kontrol: parola değişti mi? pg_hba.conf yöntemi?',
 'pgstat_collector kullanıcısının kimlik doğrulaması başarısız'),

('permission_denied',
 '[ERROR] {{instance}} · Yetki yetersiz',
 E'🟠 **Yetki yetersiz**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🔒 Detay: {{error_message}}\n' ||
 E'🔧 Çözüm: `GRANT pg_monitor TO pgstat_collector;`',
 'Source PG''de yetki problemi'),

('extension_missing',
 '[WARNING] {{instance}} · pg_stat_statements eksik',
 E'🟡 **pg_stat_statements extension yüklü değil**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'⚠️ Etki: SQL bazlı metrikler toplanamayacak\n' ||
 E'🔧 Çözüm: shared_preload_libraries''e ekleyip `CREATE EXTENSION pg_stat_statements;`',
 'pg_stat_statements eksik veya yüklenemedi'),

('high_connection_usage',
 '[{{severity_upper}}] {{instance}} · Bağlantı havuzu doluyor ({{value}}/{{max_value}})',
 E'{{severity_emoji}} **Bağlantı kullanım oranı yüksek**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'📊 Aktif: **{{value}} / {{max_value}}** (%{{usage_pct}})\n' ||
 E'🎯 Eşik: warning %{{warning_threshold}}, critical %{{critical_threshold}}\n' ||
 E'💡 Olası neden: idle_in_transaction backend, app pool sızıntısı, traffic spike\n' ||
 E'🔧 Sorgu: `SELECT state, count(*) FROM pg_stat_activity GROUP BY state;`',
 'numbackends / max_connections oranı eşik üstü'),

('long_running_query',
 '[WARNING] {{instance}} · Uzun süreli sorgu ({{duration_seconds}}s)',
 E'🟡 **Uzun süredir çalışan sorgu tespit edildi**\n' ||
 E'📍 Instance: **{{instance}}** · DB: {{database}}\n' ||
 E'⏱️ Süre: {{duration_seconds}} saniye\n' ||
 E'👤 PID: {{pid}} · User: {{username}}\n' ||
 E'📝 Query: `{{query_snippet}}`\n' ||
 E'🔧 Aksiyon: `SELECT pg_cancel_backend({{pid}});` veya `pg_terminate_backend`',
 'Eşik süreyi aşan aktif sorgu'),

('replication_lag',
 '[{{severity_upper}}] {{instance}} · Replication lag {{lag_bytes}} bayt',
 E'{{severity_emoji}} **Replication gecikmesi**\n' ||
 E'📍 Primary: **{{instance}}** · Standby: {{standby_name}}\n' ||
 E'📊 Lag: **{{lag_bytes}}** bayt ({{lag_human}})\n' ||
 E'⏱️ Replay lag: {{replay_lag_seconds}}s\n' ||
 E'🎯 Eşik: warning {{warning_threshold}}, critical {{critical_threshold}}\n' ||
 E'💡 Olası neden: ağ bant genişliği, standby disk I/O, uzun query',
 'Streaming replication gecikmesi'),

('high_bloat_ratio',
 '[INFO] {{instance}} · Tablo bloat yüksek: {{relation}}',
 E'🔵 **Tablo bloat oranı yüksek**\n' ||
 E'📍 Instance: **{{instance}}** · Tablo: `{{relation}}`\n' ||
 E'📊 Bloat: %{{bloat_pct}} ({{bloat_bytes}})\n' ||
 E'💾 Toplam boyut: {{total_size}}\n' ||
 E'🔧 Aksiyon: `VACUUM FULL {{relation}};` (lock alır) veya `pg_repack`',
 'Dead tuple oranı yüksek'),

('stale_data',
 '[WARNING] {{instance}} · Veri toplama duraksadı',
 E'🟡 **Son {{minutes}} dakikadır metrik toplanamadı**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🕐 Son başarılı toplama: {{last_successful_at}}\n' ||
 E'🔧 Kontrol: collector log, network, advisory lock çakışması',
 'Collector veri toplayamıyor ama bağlantı hatası raporlamadı'),

('stats_reset_detected',
 '[INFO] {{instance}} · pg_stat_statements reset edildi',
 E'🔵 **pg_stat_statements istatistikleri sıfırlandı**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🕐 Reset zamanı: {{reset_at}}\n' ||
 E'ℹ️ Etki: bir cycle delta hesaplanmaz, baseline yeniden başlar',
 'Stats reset tespiti — bilgi amaçlı'),

('bootstrap_failed',
 '[ERROR] {{instance}} · Bootstrap başarısız',
 E'🟠 **Instance bootstrap aşamasında hata**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🔄 Aşama: {{phase}}\n' ||
 E'❌ Hata: {{error_message}}\n' ||
 E'🔧 Aksiyon: instance''ı re-activate edin veya logları inceleyin',
 'Instance pending → discovering → ready akışında kırılma'),

('secret_ref_error',
 '[CRITICAL] {{instance}} · Secret çözümlenemedi',
 E'🔴 **Şifre/secret çözümlenemiyor**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'🔑 Referans: {{secret_ref}}\n' ||
 E'❌ Hata: {{error_message}}\n' ||
 E'🔧 Kontrol: file: yolunun varlığı, env: değişkeninin set olması',
 'file:/env: prefix çözümleme hatası'),

('lock_contention',
 '[WARNING] {{instance}} · Lock contention: {{waiting_count}} bekleyen',
 E'🟡 **Lock bekleme zinciri tespit edildi**\n' ||
 E'📍 Instance: **{{instance}}**\n' ||
 E'⛔ Bekleyen sayısı: {{waiting_count}}\n' ||
 E'🔒 Mod: {{lock_mode}}\n' ||
 E'🎯 İlişki: {{relation}}\n' ||
 E'🔧 Sorgu: `SELECT * FROM pg_blocking_pids(pid);`',
 'Granted=false lock''lar eşik üstü'),

-- Job seviyesi
('job_partial_failure',
 '[WARNING] Job kısmen başarısız: {{job_type}}',
 E'🟡 **{{job_type}} job''u {{failed_count}}/{{total_count}} instance''ta başarısız**\n' ||
 E'🕐 Run: {{job_run_at}}\n' ||
 E'❌ Başarısız: {{failed_instances}}\n' ||
 E'🔧 Detay için job_run sayfasına bakın',
 'Bir job içinde bazı instance''lar başarısız'),

('job_failed',
 '[ERROR] Job tamamen başarısız: {{job_type}}',
 E'🟠 **{{job_type}} job''u tüm instance''larda başarısız**\n' ||
 E'🕐 Run: {{job_run_at}}\n' ||
 E'❌ Hata: {{error_message}}\n' ||
 E'🔧 Aksiyon: collector log + central DB bağlantısı',
 'Job tamamen başarısız'),

('advisory_lock_skip',
 '[INFO] Advisory lock alınamadı: {{job_type}}',
 E'🔵 **{{job_type}} bir önceki run hâlâ çalışıyor olabilir**\n' ||
 E'🕐 Skip: {{skipped_at}}\n' ||
 E'ℹ️ İki collector instance''ı varsa normal — değilse uzun süren bir run var demektir',
 'Önceki run henüz bitmedi, skip')

on conflict (alert_code) do nothing;

-- =============================================================================
-- Index — alert_rule template araması (template tanımlı kuralları listelemek için)
-- =============================================================================
create index if not exists ix_alert_rule_has_template
  on control.alert_rule (rule_id)
  where title_template is not null or message_template is not null;
