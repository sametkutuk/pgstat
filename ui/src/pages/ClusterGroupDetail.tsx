// Bir küme detayı: primary + tüm replikalar yan yana kart grid.
// Route: /clusters/:cluster_id (system_identifier veya manual_cluster_group_id)
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';

interface ClusterInstance {
    instance_pk: number;
    display_name: string;
    host: string;
    port: number;
    bootstrap_state: string;
    pg_major: number | null;
    is_primary: boolean | null;
    last_cluster_collect_at: string | null;
    last_success_at: string | null;
    consecutive_failures: number;
    open_alerts: number;
}

export default function ClusterGroupDetail() {
    const { cluster_id } = useParams<{ cluster_id: string }>();
    const { data, isLoading } = useQuery({
        queryKey: ['cluster-detail', cluster_id],
        queryFn: () => apiGet<{ cluster_id: string; instances: ClusterInstance[] }>(`/clusters/${encodeURIComponent(cluster_id!)}`),
        enabled: !!cluster_id,
        refetchInterval: 30_000,
    });

    if (isLoading) return <div className="text-[#94A3B8] py-8">Yükleniyor...</div>;
    if (!data || data.instances.length === 0) {
        return (
            <div>
                <Link to="/clusters" className="text-[#3B82F6] hover:underline text-sm">← Kümeler</Link>
                <div className="text-[#94A3B8] py-8 text-center">Küme bulunamadı.</div>
            </div>
        );
    }

    const primary = data.instances.find(i => i.is_primary);
    const replicas = data.instances.filter(i => !i.is_primary);

    return (
        <div>
            <div className="flex items-center gap-2 mb-4">
                <Link to="/clusters" className="text-[#3B82F6] hover:underline text-sm">← Kümeler</Link>
                <h1 className="text-xl font-bold ml-2">
                    Küme: {primary?.display_name || data.instances[0].display_name}
                </h1>
                <span className="text-xs text-[#94A3B8]">
                    {data.instances.length} instance · {primary ? '1 primary' : 'Primary yok'} · {replicas.length} replica
                </span>
            </div>

            <div className="text-xs text-[#64748B] mb-4 font-mono bg-[#F8FAFC] px-3 py-2 rounded">
                cluster_id: {cluster_id}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.instances.map(inst => (
                    <Link key={inst.instance_pk} to={`/instances/${inst.instance_pk}`}
                        className="bg-white rounded-lg shadow-sm p-4 hover:shadow-md transition-shadow border-2"
                        style={{ borderColor: inst.is_primary ? '#3B82F6' : '#E2E8F0' }}>
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="font-semibold text-[#1E293B] truncate">{inst.display_name}</h3>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                inst.is_primary ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                            }`}>
                                {inst.is_primary ? 'PRIMARY' : 'REPLICA'}
                            </span>
                        </div>
                        <div className="text-xs text-[#64748B] font-mono mb-2">{inst.host}:{inst.port}</div>
                        <div className="flex flex-wrap gap-2 text-[10px]">
                            <Badge value={inst.bootstrap_state} />
                            {inst.pg_major && <span className="px-1.5 py-0.5 bg-[#F1F5F9] text-[#475569] rounded">PG{inst.pg_major}</span>}
                            {inst.open_alerts > 0 && (
                                <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded">
                                    🔔 {inst.open_alerts}
                                </span>
                            )}
                            {inst.consecutive_failures > 0 && (
                                <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">
                                    ⚠ {inst.consecutive_failures} hata
                                </span>
                            )}
                        </div>
                        <div className="mt-2 text-[10px] text-[#94A3B8]">
                            Son toplama: {inst.last_cluster_collect_at
                                ? <TimeAgo date={inst.last_cluster_collect_at} />
                                : 'henüz yok'}
                        </div>
                    </Link>
                ))}
            </div>
        </div>
    );
}
