-- =============================================================================
-- V055: Safe temp file alert recommendation
-- Do not recommend global work_mem without host RAM and concurrency context.
-- =============================================================================

update control.alert_message_template
set message_template =
 E'Yuksek Temp File Uretimi\n' ||
 E'Instance: {{instance}} - DB: {{database}}\n\n' ||
 E'Tespit:\n' ||
 E'- Temp file: {{temp_files}} dosya/saat\n' ||
 E'- Temp bytes: {{temp_bytes_human}}\n' ||
 E'- Mevcut work_mem: {{work_mem}}\n' ||
 E'- max_connections: {{max_connections}}\n\n' ||
 E'Top temp ureten sorgular:\n' ||
 E'{{top_temp_queries}}\n\n' ||
 E'Aksiyon:\n' ||
 E'Global ALTER SYSTEM work_mem onermiyoruz; host RAM ve eszamanli sort/hash sayisi bilinmeden OOM riski olusur.\n' ||
 E'Query/session bazli test et:\n' ||
 E'```sql\nBEGIN;\nSET LOCAL work_mem = ''{{suggested_work_mem}}'';\n-- ilgili sorguyu EXPLAIN (ANALYZE, BUFFERS) ile test et\nROLLBACK;\n```\n\n' ||
 E'{{work_mem_guidance}}',
    description = 'Sorgular sort/hash icin disk kullaniyor; query-level work_mem testi onerilir',
    updated_at = now()
where alert_code = 'high_temp_files';

update control.system_alert_config
set threshold_value = 300,
    updated_at = now()
where alert_code = 'lock_contention'
  and instance_pk is null
  and threshold_value is null;
