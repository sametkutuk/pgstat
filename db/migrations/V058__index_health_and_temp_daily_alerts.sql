-- =============================================================================
-- V058: Index health flags and daily temp alerts
-- =============================================================================

alter table fact.pg_index_stat_delta
  add column if not exists is_valid boolean null,
  add column if not exists is_ready boolean null,
  add column if not exists is_primary boolean null,
  add column if not exists is_unique boolean null;

insert into control.system_alert_config (alert_code, is_enabled, threshold_value, cooldown_minutes) values
  ('index_invalid',          true, null, 1440),
  ('high_temp_files_daily',  true, 1000, 1440),
  ('high_temp_sqls_daily',   true, 10, 1440)
on conflict do nothing;

update control.system_alert_config
set threshold_value = null
where alert_code = 'index_unused';

insert into control.alert_message_template (alert_code, title_template, message_template, description) values
  ('index_invalid',
   '[WARNING] {{instance}} - Invalid index {{index}}',
   E'Index={{index}}, table={{table}}, DB={{database}}\n' ||
   E'Status: valid={{is_valid}}, ready={{is_ready}}, unique={{is_unique}}, primary={{is_primary}}\n' ||
   E'Action: investigate failed CREATE/REINDEX CONCURRENTLY; rebuild/drop only after dependency check.',
   'Invalid or not-ready index detected'),
  ('high_temp_files_daily',
   '[WARNING] {{instance}} - Daily temp files {{database}}',
   E'DB={{database}}, temp_files={{temp_files}}/24h, temp={{temp_bytes_human}}\n' ||
   E'Action: inspect top temp SQLs and batch windows.',
   'Daily temp file count above threshold'),
  ('high_temp_sqls_daily',
   '[WARNING] {{instance}} - Temp-heavy SQL count {{sql_count}}',
   E'Last 24h: {{sql_count}} SQL wrote at least {{min_temp_mb_per_sql}}MB temp each; total={{temp_bytes_human}}\n' ||
   E'Action: review top temp SQLs; test query-level work_mem only where safe.\n{{top_temp_queries}}',
   'Too many SQLs write large temp files in the last 24h')
on conflict (alert_code) do update
set title_template = excluded.title_template,
    message_template = excluded.message_template,
    description = excluded.description,
    updated_at = now();

update control.alert_message_template
set title_template = '[INFO] {{instance}} - Unused index {{index}}',
    message_template =
      E'Index={{index}}, DB={{database}}, size={{index_size_human}}\n' ||
      E'Condition: full 30d observation and idx_scan=0. Size is informational only.\n' ||
      E'Action: check UNIQUE/FK dependency; consider DROP INDEX CONCURRENTLY.',
    description = 'Index unused during full observation window; size does not suppress alert',
    updated_at = now()
where alert_code = 'index_unused';
