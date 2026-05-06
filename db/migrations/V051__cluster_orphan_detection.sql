-- V051: Orphan clone tespiti
-- Aynı system_identifier'a sahip ama içinde >1 primary olan gruplar →
-- pg_basebackup'tan klonlanmış sonra promote edilmiş bağımsız serverlar.
-- Bunları otomatik AYIR — her biri kendi başına küme sayılsın.

drop view if exists control.v_cluster_summary;
drop view if exists control.v_instance_cluster;

create view control.v_instance_cluster as
with sysid_primary_count as (
    select c.system_identifier,
           count(*) filter (where c.is_primary) as primary_count
    from control.instance_inventory i
    left join control.instance_capability c on c.instance_pk = i.instance_pk
    where c.system_identifier is not null
    group by c.system_identifier
)
select
    i.instance_pk,
    i.display_name,
    case
        when i.manual_cluster_group_id is not null and i.manual_cluster_group_id <> ''
             then i.manual_cluster_group_id
        when c.system_identifier is null
             then null
        when (select primary_count from sysid_primary_count
              where system_identifier = c.system_identifier) > 1
             then 'orphan-' || i.instance_pk::text  -- klon grup, otomatik ayrış
        else c.system_identifier::text
    end as cluster_id,
    coalesce(c.is_primary, false) as is_primary,
    c.system_identifier,
    i.manual_cluster_group_id,
    case
        when i.manual_cluster_group_id is not null and i.manual_cluster_group_id <> ''
             then 'manual'
        when c.system_identifier is null
             then 'standalone'
        when (select primary_count from sysid_primary_count
              where system_identifier = c.system_identifier) > 1
             then 'orphan_clone'
        else 'auto'
    end as cluster_kind,
    i.is_active
from control.instance_inventory i
left join control.instance_capability c on c.instance_pk = i.instance_pk;

create view control.v_cluster_summary as
select
    cluster_id,
    max(cluster_kind) as cluster_kind,
    count(*)::int as total_instances,
    count(*) filter (where is_primary)::int as primary_count,
    count(*) filter (where not is_primary)::int as replica_count,
    (array_agg(display_name order by is_primary desc, display_name))[1] as label,
    array_agg(instance_pk order by is_primary desc, display_name) as instance_pks
from control.v_instance_cluster
where is_active and cluster_id is not null
group by cluster_id;
