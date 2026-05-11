-- =============================================================================
-- V059: Capacity-aware work_mem guidance for temp file alerts
-- =============================================================================

update control.alert_message_template
set message_template =
  E'DB={{database}}, temp_files={{temp_files}}, temp={{temp_bytes_human}}\n' ||
  E'work_mem={{work_mem}}, max_connections={{max_connections}}, shared_buffers={{shared_buffers}}, effective_cache_size={{effective_cache_size}}\n' ||
  E'Recommendation: SET LOCAL work_mem=''{{suggested_work_mem}}''; conservative global upper bound ~= {{safe_global_work_mem}}.\n' ||
  E'Note: effective_cache_size is a planner cache estimate/proxy, not exact host RAM.\n' ||
  E'{{top_temp_queries}}',
    description = 'Temp file high; work_mem recommendation uses max_connections and memory settings',
    updated_at = now()
where alert_code = 'high_temp_files';
