alter table control.retention_policy
    add column if not exists audit_log_retention_days integer default 90,
    add column if not exists alert_retention_days integer default 90;

update control.retention_policy
set audit_log_retention_days = coalesce(audit_log_retention_days, 90),
    alert_retention_days = coalesce(alert_retention_days, 90)
where audit_log_retention_days is null
   or alert_retention_days is null;

alter table control.retention_policy
    alter column audit_log_retention_days set not null,
    alter column alert_retention_days set not null;

comment on column control.retention_policy.audit_log_retention_days is
    'ops.audit_log icin retention (gun). Default 90.';

comment on column control.retention_policy.alert_retention_days is
    'ops.alert icin retention (gun). Default 90.';
