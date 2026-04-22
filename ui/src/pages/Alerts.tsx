import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../api/client';
import DataTable from '../components/common/DataTable';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import LastUpdated from '../components/common/LastUpdated';
import { useToast } from '../components/common/Toast';
import { useState } from 'react';

interface Alert {
    alert_id: number; alert_key: string; alert_code: string; severity: string;
    status: string; source_component: string; instance_pk: number | null;
    display_name: string | null; instance_id: string | null; host: string | null;
    title: string; message: string; occurrence_count: number;
    first_seen_at: string; last_seen_at: string; resolved_at: string | null;
    details_json: any;
}

export default function Alerts() {
    const [statusFilter, setStatusFilter] = useState('open');
    const [severityFilter, setSeverityFilter] = useState('');
    const queryClient = useQueryClient();
    const toast = useToast();

    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (severityFilter) params.set('severity', severityFilter);

    const { data, isLoading, dataUpdatedAt } = useQuery({
        queryKey: ['alerts', statusFilter, severityFilter],
        queryFn: () => apiGet<Alert[]>(`/alerts?${params.toString()}`),
    });

    const ackMutation = useMutation({
        mutationFn: (id: number) => apiPatch(`/alerts/${id}/acknowledge`),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['alerts'] }); toast.success('Alert onaylandı.'); },
    });

    const resolveMutation = useMutation({
        mutationFn: (id: number) => apiPatch(`/alerts/${id}/resolve`),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['alerts'] }); toast.success('Alert çözüldü.'); },
    });

    const [expandedId, setExpandedId] = useState<number | null>(null);

    const columns = [
        { key: 'severity', header: 'Seviye', render: (r: Alert) => <Badge value={r.severity} /> },
        { key: 'status', header: 'Durum', render: (r: Alert) => <Badge value={r.status} /> },
        { key: 'alert_code', header: 'Kod' },
        { key: 'title', header: 'Başlık' },
        { key: 'display_name', header: 'Instance', render: (r: Alert) => r.display_name || '—' },
        { key: 'occurrence_count', header: 'Tekrar', className: 'text-right' },
        { key: 'first_seen_at', header: 'İlk Görülme', render: (r: Alert) => <TimeAgo date={r.first_seen_at} /> },
        { key: 'last_seen_at', header: 'Son Görülme', render: (r: Alert) => <TimeAgo date={r.last_seen_at} /> },
        {
            key: 'actions', header: '', render: (r: Alert) => (
                <div className="flex gap-1">
                    {r.status === 'open' && <button onClick={(e) => { e.stopPropagation(); ackMutation.mutate(r.alert_id); }} className="px-2 py-1 text-xs bg-yellow-50 text-yellow-700 rounded hover:bg-yellow-100">Onayla</button>}
                    {r.status !== 'resolved' && <button onClick={(e) => { e.stopPropagation(); resolveMutation.mutate(r.alert_id); }} className="px-2 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100">Çöz</button>}
                </div>
            )
        },
    ];

    return (
        <div>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold">Alerts</h1>
                <LastUpdated dataUpdatedAt={dataUpdatedAt} />
            </div>

            <div className="flex gap-4 mb-4 flex-wrap">
                <div className="flex gap-1">
                    {['open', 'acknowledged', 'resolved', ''].map((s) => (
                        <button key={s} onClick={() => setStatusFilter(s)}
                            className={`px-3 py-1.5 text-sm rounded ${statusFilter === s ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:bg-[#F8FAFC]'}`}>
                            {s || 'Tümü'}
                        </button>
                    ))}
                </div>
                <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}
                    className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white" aria-label="Severity filtresi">
                    <option value="">Tüm Seviyeler</option>
                    <option value="critical">Critical</option>
                    <option value="error">Error</option>
                    <option value="warning">Warning</option>
                    <option value="info">Info</option>
                </select>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4">
                {isLoading ? <div className="text-[#94A3B8] py-8 text-center">Yükleniyor...</div> : (
                    <DataTable columns={columns} data={data || []}
                        onRowClick={(r) => setExpandedId(expandedId === r.alert_id ? null : r.alert_id)} />
                )}
            </div>

            {expandedId && data && (() => {
                const alert = data.find((a) => a.alert_id === expandedId);
                if (!alert) return null;
                return (
                    <div className="mt-4 bg-white rounded-lg shadow-sm p-5">
                        <h3 className="text-sm font-semibold text-[#64748B] mb-2">Alert Detayı</h3>
                        <div className="text-sm space-y-1">
                            <div><span className="text-[#64748B]">Key:</span> {alert.alert_key}</div>
                            <div><span className="text-[#64748B]">Mesaj:</span> {alert.message}</div>
                            {alert.details_json && (
                                <pre className="text-xs bg-[#F8FAFC] p-3 rounded mt-2 overflow-x-auto">
                                    {typeof alert.details_json === 'string' ? alert.details_json : JSON.stringify(alert.details_json, null, 2)}
                                </pre>
                            )}
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}
