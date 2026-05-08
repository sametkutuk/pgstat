-- =============================================================================
-- V057: Concise templates for every built-in alert
-- All operational alert text follows: signal -> key values -> one action.
-- Rich diagnostics stay in details_json.
-- =============================================================================

with v(alert_code, title_template, message_template, description) as (
  values
  ('user_defined_rule',
   '[{{severity_upper}}] {{instance}} - {{rule_name}}',
   E'Metric: {{metric}}={{value}} ({{aggregation}}, window={{window}}m)\n' ||
   E'Condition: {{operator}} {{threshold}}; severity={{severity}}\n' ||
   E'Rule: {{rule_name}}',
   'Generic user-defined alert template'),

  ('statement_threshold',
   '[{{severity_upper}}] {{instance}} - Query threshold: {{rule_name}}',
   E'DB={{database}}, user={{user}}, queryid={{queryid}}\n' ||
   E'Metric={{metric}}, value={{current_value}}, condition={{operator}} {{threshold}}, window={{window}}m\n' ||
   E'Query: {{query_text}}',
   'Per-query threshold alert'),

  ('statement_spike',
   '[{{severity_upper}}] {{instance}} - Query spike: {{rule_name}}',
   E'DB={{database}}, user={{user}}, queryid={{queryid}}\n' ||
   E'Metric={{metric}}, prev={{previous_value}}, current={{current_value}}, change=%{{change_pct}}\n' ||
   E'Query: {{query_text}}',
   'Per-query spike alert'),

  ('table_threshold',
   '[{{severity_upper}}] {{instance}} - Table threshold: {{table}}',
   E'Table={{table}}, DB={{database}}, metric={{metric}}, value={{current_value}}\n' ||
   E'Condition={{operator}} {{threshold}}, window={{window}}m\n' ||
   E'Action: inspect table stats and autovacuum/index need.',
   'Per-table threshold alert'),

  ('table_spike',
   '[{{severity_upper}}] {{instance}} - Table spike: {{table}}',
   E'Table={{table}}, DB={{database}}, metric={{metric}}\n' ||
   E'Prev={{previous_value}}, current={{current_value}}, change=%{{change_pct}}, threshold=%{{threshold}}\n' ||
   E'Action: inspect recent workload on this table.',
   'Per-table spike alert'),

  ('index_threshold',
   '[{{severity_upper}}] {{instance}} - Index threshold: {{index}}',
   E'Index={{index}}, table={{table}}, DB={{database}}, metric={{metric}}, value={{current_value}}\n' ||
   E'Condition={{operator}} {{threshold}}, window={{window}}m',
   'Per-index threshold alert'),

  ('index_spike',
   '[{{severity_upper}}] {{instance}} - Index spike: {{index}}',
   E'Index={{index}}, table={{table}}, DB={{database}}, metric={{metric}}\n' ||
   E'Prev={{previous_value}}, current={{current_value}}, change=%{{change_pct}}, threshold=%{{threshold}}',
   'Per-index spike alert'),

  ('connection_failure',
   '[CRITICAL] {{instance}} - Connection failed',
   E'Target={{host}}:{{port}}, duration={{duration_minutes}}m\n' ||
   E'Error={{error_message}}\n' ||
   E'Action: check PostgreSQL service, network/firewall and pg_hba.conf.',
   'Source PostgreSQL connection failure'),

  ('authentication_failure',
   '[CRITICAL] {{instance}} - Authentication failed',
   E'Target={{host}}:{{port}}\n' ||
   E'Error={{error_message}}\n' ||
   E'Action: verify collector password/secret_ref and pg_hba.conf auth method.',
   'Collector authentication failure'),

  ('permission_denied',
   '[ERROR] {{instance}} - Permission denied',
   E'Target={{host}}:{{port}}\n' ||
   E'Error={{error_message}}\n' ||
   E'Action: grant required monitoring privileges, usually GRANT pg_monitor.',
   'Source PostgreSQL permission problem'),

  ('extension_missing',
   '[WARNING] {{instance}} - pg_stat_statements missing',
   E'pg_stat_statements is not available on {{instance}}.\n' ||
   E'Impact: SQL-level statement metrics cannot be collected.\n' ||
   E'Action: load extension and shared_preload_libraries if needed.',
   'pg_stat_statements missing'),

  ('secret_ref_error',
   '[CRITICAL] {{instance}} - Secret error',
   E'Secret ref={{secret_ref}}\n' ||
   E'Error={{error_message}}\n' ||
   E'Action: check file:/env: reference and collector permissions.',
   'Secret reference cannot be resolved'),

  ('bootstrap_failed',
   '[ERROR] {{instance}} - Bootstrap failed',
   E'Phase={{phase}}\n' ||
   E'Error={{error_message}}\n' ||
   E'Action: check collector logs and retry/bootstrap state.',
   'Instance bootstrap failed'),

  ('stale_data',
   '[WARNING] {{instance}} - Data stale',
   E'Last successful collect={{last_successful_at}}, stale={{minutes}}m\n' ||
   E'Action: check collector logs, scheduler, network and source availability.',
   'Metrics have not been collected recently'),

  ('stats_reset_detected',
   '[INFO] {{instance}} - pg_stat_statements reset',
   E'Reset at={{reset_at}}, loss window={{loss_window}}\n' ||
   E'Last known: queries={{query_count}}, calls={{total_calls}}\n' ||
   E'Action: baseline/delta will restart automatically.',
   'pg_stat_statements reset detected'),

  ('high_connection_usage',
   '[{{severity_upper}}] {{instance}} - Connection usage %{{usage_pct}}',
   E'Connections={{value}}/{{max_value}} (%{{usage_pct}})\n' ||
   E'Action: check pg_stat_activity states and application pool limits.',
   'numbackends / max_connections above configured threshold'),

  ('long_running_query',
   '[WARNING] {{instance}} - Long query {{duration_seconds}}s',
   E'DB={{database}}, pid={{pid}}, user={{username}}, duration={{duration_seconds}}s\n' ||
   E'Query={{query_snippet}}\n' ||
   E'Action: inspect plan; use pg_cancel_backend({{pid}}) only if safe.',
   'Active query exceeds configured duration'),

  ('replication_lag',
   '[{{severity_upper}}] {{instance}} - Replication lag {{lag_human}}',
   E'Lag={{lag_human}} ({{lag_bytes}} bytes), replay={{replay_lag_seconds}}\n' ||
   E'Thresholds: warning={{warning_threshold}}, critical={{critical_threshold}}\n' ||
   E'Action: check standby I/O, network, replay and long-running queries.',
   'Streaming replication lag above configured threshold'),

  ('high_bloat_ratio',
   '[INFO] {{instance}} - Bloat {{relation}} %{{bloat_pct}}',
   E'Table={{relation}}, DB={{database}}, dead_tuple=%{{bloat_pct}}, size={{total_size}}\n' ||
   E'Action: check autovacuum settings and vacuum/repack need.',
   'Dead tuple ratio above configured threshold'),

  ('lock_contention',
   '[WARNING] {{instance}} - Lock wait {{wait_seconds}}s',
   E'PID={{pid}}, wait={{wait_seconds}}s, mode={{lock_mode}}, relation={{relation}}\n' ||
   E'Action: find blocker with SELECT pg_blocking_pids({{pid}}).',
   'Lock wait exceeds configured threshold'),

  ('index_suspect_missing',
   '[WARNING] {{instance}} - Index candidate {{table}}',
   E'Table={{table}} ({{table_size_human}}), DB={{database}}\n' ||
   E'Seq={{seq_scans}}, idx={{idx_scans}}, ratio={{seq_idx_ratio}}x, seq_tup={{seq_tup_read}}\n' ||
   E'Action: validate with EXPLAIN (ANALYZE, BUFFERS); consider CREATE INDEX CONCURRENTLY.',
   'Sequential scan pressure suggests missing index'),

  ('index_unused',
   '[INFO] {{instance}} - Unused index {{index}}',
   E'Index={{index}}, DB={{database}}, size={{index_size_human}}\n' ||
   E'Condition: full 30d observation and idx_scan=0.\n' ||
   E'Action: check UNIQUE/FK dependency; consider DROP INDEX CONCURRENTLY.',
   'Index unused during full observation window'),

  ('high_temp_files',
   '[WARNING] {{instance}} - Temp files {{database}}',
   E'DB={{database}}, temp_files={{temp_files}}/h, temp={{temp_bytes_human}}\n' ||
   E'work_mem={{work_mem}}, max_connections={{max_connections}}\n' ||
   E'Action: do not change global work_mem blindly; test query/session with SET LOCAL work_mem=''{{suggested_work_mem}}''.',
   'Temp file count above configured threshold'),

  ('idle_in_tx_time_high',
   '[WARNING] {{instance}} - Idle in tx %{{idle_pct}}',
   E'DB={{database}}, idle_in_tx={{idle_in_tx_time_human}}, session={{session_time_human}}, ratio=%{{idle_pct}}\n' ||
   E'Action: inspect idle in transaction sessions and application pool behavior.',
   'Idle in transaction ratio above configured threshold'),

  ('replication_slot_inactive',
   '[WARNING] {{instance}} - Inactive slot {{slot_name}}',
   E'Slot={{slot_name}} ({{slot_type}}), retained WAL={{slot_lag_human}}\n' ||
   E'Action: verify consumer; drop slot only if it is no longer needed.',
   'Inactive replication slot retains WAL'),

  ('job_partial_failure',
   '[WARNING] {{job_type}} job partial failure',
   E'Failed={{failed_count}}/{{total_count}}, succeeded={{succeeded_count}}, run={{job_run_at}}\n' ||
   E'Error={{error_message}}\n' ||
   E'Action: inspect job run details and failed instances.',
   'Some instances failed in a job run'),

  ('job_failed',
   '[ERROR] {{job_type}} job failed',
   E'Run={{job_run_at}}\n' ||
   E'Error={{error_message}}\n' ||
   E'Action: check collector logs and central DB connectivity.',
   'Job failed'),

  ('advisory_lock_skip',
   '[INFO] {{job_type}} job skipped by advisory lock',
   E'Skipped at={{skipped_at}}\n' ||
   E'Action: normal if another collector is running; otherwise inspect long-running job.',
   'Job skipped because previous run still holds advisory lock')
)
update control.alert_message_template t
set title_template = v.title_template,
    message_template = v.message_template,
    description = v.description,
    updated_at = now()
from v
where t.alert_code = v.alert_code;
