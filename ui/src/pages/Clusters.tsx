// Tum kumelerin listesi.
// Aynı system_identifier (veya manuel grup) → bir küme.
// Her satır: küme adı, primary/replica sayısı, açık alert, durum.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import DataTable from '../components/common/DataTable';
import LastUpdated from '../components/common/LastUpdated';
import InfoTip from '../components/common/InfoTip';

interface Cluster {
    cluster_id: string;
    label: string;
    cluster_kind: string;
    total_instances: number;
    primary_count: number;
    replica_count: number;
    open_alerts: number;
    critical_alerts: number;
}

const KIND_BADGE: Record<string, { text: string; cls: string }> = {
    manual: { text: '📌 Manuel', cls: 'bg-purple-100 text-purple-700' },
    orphan_clone: { text: '⚠ Klon', cls: 'bg-amber-100 text-amber-700' },
    auto: { text: '🔗 Otomatik', cls: 'bg-blue-100 text-blue-700' },
    standalone: { text: '○ Tek', cls: 'bg-gray-100 text-gray-600' },
};

export default function Clusters() {
    const { data, isLoading, dataUpdatedAt } = useQuery({
        queryKey: ['clusters'],
        queryFn: () => apiGet<Cluster[]>('/clusters'),
        refetchInterval: 60_000,
    });

    const columns = [
        {
            key: 'label', header: 'Küme', render: (r: Cluster) => (
                <div className="flex items-center gap-2">
                    <Link to={`/clusters/${encodeURIComponent(r.cluster_id)}`}
                        className="font-medium text-[#3B82F6] hover:underline">
                        {r.label || r.cluster_id.slice(0, 16)}
                    </Link>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        KIND_BADGE[r.cluster_kind || 'auto']?.cls || ''
                    }`}>
                        {KIND_BADGE[r.cluster_kind || 'auto']?.text || r.cluster_kind}
                    </span>
                </div>
            )
        },
        {
            key: 'total_instances', header: 'Toplam', className: 'text-right',
            render: (r: Cluster) => <span className="font-mono">{r.total_instances}</span>
        },
        {
            key: 'primary_count', header: 'Primary', className: 'text-right',
            render: (r: Cluster) => <span className={r.primary_count === 1 ? 'text-green-600 font-mono' : r.primary_count > 1 ? 'text-red-600 font-mono font-bold' : 'text-amber-600 font-mono'}>{r.primary_count}</span>
        },
        {
            key: 'replica_count', header: 'Replica', className: 'text-right',
            render: (r: Cluster) => <span className="font-mono text-[#64748B]">{r.replica_count}</span>
        },
        {
            key: 'open_alerts', header: 'Açık Alert', className: 'text-right',
            render: (r: Cluster) => {
                if (r.critical_alerts > 0) return <span className="text-red-600 font-mono font-bold">{r.open_alerts} ({r.critical_alerts} ⚠)</span>;
                if (r.open_alerts > 0) return <span className="text-amber-600 font-mono">{r.open_alerts}</span>;
                return <span className="text-green-600 font-mono">0</span>;
            }
        },
        {
            key: 'cluster_id', header: 'Küme ID', className: 'text-xs',
            render: (r: Cluster) => <code className="font-mono text-[10px] text-[#94A3B8]">{r.cluster_id}</code>
        },
    ];

    return (
        <div>
            <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2">
                    <h1 className="text-xl font-bold">Kümeler</h1>
                    <InfoTip text={`Aynı 'system_identifier'a sahip instance'lar bir küme oluşturur.
PostgreSQL initdb sırasında otomatik üretilir; pg_basebackup ile alınan replikalar primary'den AYNI değeri kopyalar.

Logical replication veya manuel gruplama için Instance Detail'dan
'Manuel Küme Grubu' alanı doldurularak override edilebilir.

Standalone (sibling'i olmayan) instance'lar bu listede görünmez.`} />
                </div>
                <LastUpdated dataUpdatedAt={dataUpdatedAt} />
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4">
                {isLoading
                    ? <div className="text-[#94A3B8] py-8 text-center">Yükleniyor...</div>
                    : (data && data.length === 0)
                        ? <div className="text-[#94A3B8] py-8 text-center">
                            Aktif küme yok. Aynı system_identifier'a sahip ≥2 instance gerekli.
                        </div>
                        : <DataTable columns={columns} data={data || []} />}
            </div>
        </div>
    );
}
