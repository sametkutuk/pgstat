-- V052: v_cluster_summary'de tek instance'lı kümeleri gizle (>=2 olmalı)
-- Standalone instance'lar v_instance_cluster'da cluster_id null;
-- ama 1 primary + 0 replica olan gruplar (sibling yok) yine de listeleniyordu.
-- Gerçek küme = en az 2 instance.

drop view if exists control.v_cluster_summary;

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
group by cluster_id
having count(*) >= 2;  -- sibling'i olmayan tek instance görünmez
