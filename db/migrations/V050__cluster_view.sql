-- V050: Küme görünümü — primary+replica gruplandırması
-- system_identifier (initdb otomatik) + manual_cluster_group_id (logical/farklı küme için)

alter table control.instance_inventory
    add column if not exists manual_cluster_group_id varchar(50);

-- Etkin küme kimliği: manuel öncelikli, yoksa system_identifier
create or replace view control.v_instance_cluster as
select
    i.instance_pk,
    i.display_name,
    coalesce(i.manual_cluster_group_id, nullif(i.system_identifier::text, '')) as cluster_id,
    coalesce(c.is_primary, false) as is_primary,
    i.system_identifier,
    i.manual_cluster_group_id,
    i.is_active
from control.instance_inventory i
left join control.instance_capability c on c.instance_pk = i.instance_pk;

-- Küme özeti
create or replace view control.v_cluster_summary as
with t as (
    select * from control.v_instance_cluster where is_active and cluster_id is not null
)
select
    cluster_id,
    count(*) as total_instances,
    count(*) filter (where is_primary) as primary_count,
    count(*) filter (where not is_primary) as replica_count,
    (array_agg(display_name order by is_primary desc, display_name))[1] as label,
    array_agg(instance_pk order by is_primary desc, display_name) as instance_pks
from t
group by cluster_id;
