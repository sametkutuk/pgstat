-- =============================================================================
-- V044: Ensure default statement alert templates include top query context.
--
-- Some upgraded installations can have older/default templates without
-- {{top_queries_summary}}. AlertRuleEvaluator now enriches this placeholder with
-- statement detail URLs and execution frequency, so keep the templates wired.
-- =============================================================================

update control.alert_message_template
set message_template = message_template || E'\n{{top_queries_summary}}'
where alert_code in ('user_defined_rule', 'statement_spike', 'statement_threshold')
  and message_template not like '%{{top_queries_summary}}%';

