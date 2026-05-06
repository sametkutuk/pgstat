-- V050: Küme görünümü — primary+replica gruplandırması
-- system_identifier control.instance_capability'de (instance_inventory'de değil)

alter table control.instance_inventory
    add column if not exists manual_cluster_group_id varchar(50);

drop view if exists control.v_cluster_summary;
drop view if exists control.v_instance_cluster;

-- Etkin küme kimliği: manuel öncelikli, yoksa capability.system_identifier
create view control.v_instance_cluster as
select
    i.instance_pk,
    i.display_name,
    case
        when i.manual_cluster_group_id is not null and i.manual_cluster_group_id <> ''
             then i.manual_cluster_group_id
        when c.system_identifier is not null
             then c.system_identifier::text
        else null
    end as cluster_id,
    coalesce(c.is_primary, false) as is_primary,
    c.system_identifier,
    i.manual_cluster_group_id,
    i.is_active
from control.instance_inventory i
left join control.instance_capability c on c.instance_pk = i.instance_pk;

create view control.v_cluster_summary as
select
    cluster_id,
    count(*)::int as total_instances,
    count(*) filter (where is_primary)::int as primary_count,
    count(*) filter (where not is_primary)::int as replica_count,
    (array_agg(display_name order by is_primary desc, display_name))[1] as label,
    array_agg(instance_pk order by is_primary desc, display_name) as instance_pks
from control.v_instance_cluster
where is_active and cluster_id is not null
group by cluster_id;
