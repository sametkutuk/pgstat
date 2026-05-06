-- V053: Manuel oluşturulan gruplar tek üyeliyse de listede görünsün
-- Auto/orphan_clone gruplar için 2+ üye filtresi kalır.

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
having
    -- manuel grup: kullanıcı bilerek oluşturdu, tek üyeli olsa bile göster
    bool_or(cluster_kind = 'manual')
    -- otomatik (auto/orphan_clone): en az 2 üye olmalı
    or count(*) >= 2;
