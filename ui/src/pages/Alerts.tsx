import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../api/client';
import DataTable from '../components/common/DataTable';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import LastUpdated from '../components/common/LastUpdated';
import InfoTip from '../components/common/InfoTip';
import { useToast } from '../components/common/Toast';
import { useState } from 'react';

interface Alert {
    alert_id: number; alert_key: string; alert_code: string; severity: string;
    status: string; source_component: string; instance_pk: number | null;
    display_name: string | null; instance_id: string | null; host: string | null;
    title: string; message: string; occurrence_count: number;
    first_seen_at: string; last_seen_at: string; resolved_at: string | null;
    acknowledged_at: string | null; acknowledge_note: string | null;
    details_json: any;
    rule_id: number | null; rule_name: string | null; evaluation_type: string | null;
}

const EVAL_TYPE_LABELS: Record<string, string> = {
    threshold: 'Sabit Eşik',
    alltime_high: 'Tüm Zamanlar En Yüksek',
    alltime_low: 'Tüm Zamanlar En Düşük',
    day_over_day: 'Günlük Değişim',
    week_over_week: 'Haftalık Değişim',
};

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

    // Acknowledge modal state
    const [ackModal, setAckModal] = useState<{ id: number; title: string } | null>(null);
    const [ackNote, setAckNote] = useState('');

    const ackMutation = useMutation({
        mutationFn: ({ id, note }: { id: number; note: string }) =>
            apiPatch(`/alerts/${id}/acknowledge`, { note: note || null }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['alerts'] });
            toast.success('Alert onaylandı.');
            setAckModal(null);
            setAckNote('');
        },
        onError: () => toast.error('Onaylama başarısız.'),
    });

    const resolveMutation = useMutation({
        mutationFn: (id: number) => apiPatch(`/alerts/${id}/resolve`),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['alerts'] }); toast.success('Alert çözüldü.'); },
    });

    const [expandedId, setExpandedId] = useState<number | null>(null);

    const columns = [
        { key: 'severity', header: 'Seviye', render: (r: Alert) => <Badge value={r.severity} /> },
        { key: 'status', header: 'Durum', render: (r: Alert) => <Badge value={r.status} /> },
        {
            key: 'title', header: 'Alert',
            render: (r: Alert) => (
                <div>
                    <div className="font-medium text-sm text-[#1E293B]">{r.title}</div>
                    {r.rule_name && (
                        <div className="text-xs text-[#64748B] mt-0.5 flex items-center gap-1">
                            <span>📋</span>
                            <span>{r.rule_name}</span>
                            {r.evaluation_type && r.evaluation_type !== 'threshold' && (
                                <span className="bg-[#F1F5F9] px-1.5 py-0.5 rounded text-[10px]">
                                    {EVAL_TYPE_LABELS[r.evaluation_type] || r.evaluation_type}
                                </span>
                            )}
                        </div>
                    )}
                </div>
            )
        },
        { key: 'display_name', header: 'Instance', render: (r: Alert) => r.display_name || '—' },
        { key: 'occurrence_count', header: 'Tekrar', className: 'text-right' },
        { key: 'last_seen_at', header: 'Son Görülme', render: (r: Alert) => <TimeAgo date={r.last_seen_at} /> },
        {
            key: 'actions', header: '', render: (r: Alert) => (
                <div className="flex gap-1">
                    {r.status === 'open' && (
                        <button
                            onClick={(e) => { e.stopPropagation(); setAckModal({ id: r.alert_id, title: r.title }); setAckNote(''); }}
                            className="px-2 py-1 text-xs bg-yellow-50 text-yellow-700 rounded hover:bg-yellow-100">
                            Onayla
                        </button>
                    )}
                    {r.status !== 'resolved' && (
                        <button
                            onClick={(e) => { e.stopPropagation(); resolveMutation.mutate(r.alert_id); }}
                            className="px-2 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100">
                            Çöz
                        </button>
                    )}
                </div>
            )
        },
    ];

    return (
        <div>
            <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2">
                    <h1 className="text-xl font-bold">Alerts</h1>
                    <InfoTip text="Collector her 5 saniyede alert kurallarını değerlendirir. Açık alert'ler otomatik tekrar sayısı artar. Onayla = farkındayım, Çöz = sorun giderildi. Snooze ve bakım penceresi ayarları Adaptive Alerting sayfasından yapılır." />
                </div>
                <LastUpdated dataUpdatedAt={dataUpdatedAt} />
            </div>

            <div className="flex gap-4 mb-4 flex-wrap">
                <div className="flex gap-1">
                    {['open', 'acknowledged', 'resolved', ''].map((s) => (
                        <button key={s} onClick={() => setStatusFilter(s)}
                            className={`px-3 py-1.5 text-sm rounded ${statusFilter === s ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:bg-[#F8FAFC]'}`}>
                            {s === 'open' ? 'Açık' : s === 'acknowledged' ? 'Onaylandı' : s === 'resolved' ? 'Çözüldü' : 'Tümü'}
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

            {/* Detay paneli */}
            {expandedId && data && (() => {
                const alert = data.find((a) => a.alert_id === expandedId);
                if (!alert) return null;
                return (
                    <div className="mt-4 bg-white rounded-lg shadow-sm p-5 space-y-3">
                        <h3 className="text-sm font-semibold text-[#64748B]">Alert Detayı</h3>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                            <div><span className="text-[#64748B]">Alert Key:</span> <span className="font-mono text-xs">{alert.alert_key}</span></div>
                            <div><span className="text-[#64748B]">İlk Görülme:</span> <TimeAgo date={alert.first_seen_at} /></div>
                            {alert.rule_name && (
                                <div><span className="text-[#64748B]">Kaynak Kural:</span> {alert.rule_name}
                                    {alert.evaluation_type && (
                                        <span className="ml-1 text-xs text-[#94A3B8]">({EVAL_TYPE_LABELS[alert.evaluation_type] || alert.evaluation_type})</span>
                                    )}
                                </div>
                            )}
                            {alert.acknowledged_at && (
                                <div><span className="text-[#64748B]">Onaylanma:</span> <TimeAgo date={alert.acknowledged_at} /></div>
                            )}
                        </div>
                        <div className="text-sm">
                            <span className="text-[#64748B]">Mesaj:</span>
                            <p className="mt-1 bg-[#F8FAFC] rounded px-3 py-2 text-[#334155]">{alert.message}</p>
                        </div>
                        {alert.acknowledge_note && (
                            <div className="text-sm">
                                <span className="text-[#64748B]">Onay Notu:</span>
                                <p className="mt-1 bg-[#FFFBEB] border border-[#FDE68A] rounded px-3 py-2 text-[#92400E]">{alert.acknowledge_note}</p>
                            </div>
                        )}
                        {alert.details_json && (
                            <AlertDetails details={typeof alert.details_json === 'string' ? JSON.parse(alert.details_json) : alert.details_json} />
                        )}
                    </div>
                );
            })()}

            {/* Acknowledge modal */}
            {ackModal && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
                        <div className="px-6 py-4 border-b border-[#E2E8F0]">
                            <h2 className="font-semibold text-[#1E293B]">Alert Onayla</h2>
                            <p className="text-sm text-[#64748B] mt-1">{ackModal.title}</p>
                        </div>
                        <div className="px-6 py-4">
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Not (opsiyonel)
                            </label>
                            <textarea
                                value={ackNote}
                                onChange={e => setAckNote(e.target.value)}
                                rows={3}
                                placeholder="Örn: İncelendi, kapasite artışı planlandı..."
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6] resize-none"
                            />
                        </div>
                        <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-end gap-2">
                            <button onClick={() => setAckModal(null)}
                                className="px-4 py-2 text-sm text-[#475569] hover:text-[#1E293B]">
                                İptal
                            </button>
                            <button
                                onClick={() => ackMutation.mutate({ id: ackModal.id, note: ackNote })}
                                disabled={ackMutation.isPending}
                                className="px-5 py-2 bg-[#F59E0B] text-white text-sm rounded-md hover:bg-[#D97706] disabled:opacity-50">
                                {ackMutation.isPending ? 'Onaylanıyor...' : 'Onayla'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}


function AlertDetails({ details }: { details: any }) {
    if (!details) return null;

    const hasTopQueries = details.top_queries && details.top_queries.length > 0;

    return (
        <div className="space-y-3 mt-2">
            {/* Baseline bilgisi */}
            {details.baseline_avg != null && (
                <div className="bg-[#F0F9FF] border border-[#BAE6FD] rounded-lg p-3">
                    <div className="text-xs font-semibold text-[#0369A1] mb-2">Baseline Bilgisi</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                        <div>
                            <span className="text-[#64748B]">Saat: </span>
                            <span className="font-mono text-[#1E293B]">{String(details.baseline_hour).padStart(2, '0')}:00 UTC</span>
                        </div>
                        <div>
                            <span className="text-[#64748B]">Ortalama: </span>
                            <span className="font-mono text-[#1E293B]">{Number(details.baseline_avg).toLocaleString()}</span>
                        </div>
                        <div>
                            <span className="text-[#64748B]">Warning Eşik: </span>
                            <span className="font-mono text-[#D97706]">{Number(details.warning_threshold).toLocaleString()}</span>
                        </div>
                        <div>
                            <span className="text-[#64748B]">Critical Eşik: </span>
                            <span className="font-mono text-[#DC2626]">{Number(details.critical_threshold).toLocaleString()}</span>
                        </div>
                        <div>
                            <span className="text-[#64748B]">Sensitivity: </span>
                            <span className="font-mono text-[#1E293B]">{details.sensitivity}</span>
                        </div>
                        <div>
                            <span className="text-[#64748B]">Pencere: </span>
                            <span className="font-mono text-[#1E293B]">{details.window_minutes} dk</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Top queries */}
            {hasTopQueries && (
                <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                    <div className="px-3 py-2 bg-[#F8FAFC] border-b border-[#E2E8F0]">
                        <span className="text-xs font-semibold text-[#475569]">En Çok Katkı Yapan Sorgular</span>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="border-b border-[#F1F5F9]">
                                    <th className="text-left py-2 px-3 text-[#64748B] font-medium">Query</th>
                                    <th className="text-left py-2 px-3 text-[#64748B] font-medium">DB / Rol</th>
                                    <th className="text-right py-2 px-3 text-[#64748B] font-medium">Değer</th>
                                    <th className="text-right py-2 px-3 text-[#64748B] font-medium">Calls</th>
                                    <th className="text-right py-2 px-3 text-[#64748B] font-medium">Exec Time</th>
                                </tr>
                            </thead>
                            <tbody>
                                {details.top_queries.map((q: any, i: number) => (
                                    <tr key={i} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">
                                        <td className="py-2 px-3 max-w-xs">
                                            <div className="truncate font-mono text-[#1E293B]" title={q.query_text}>
                                                {q.query_text || '—'}
                                            </div>
                                            <div className="text-[#94A3B8] mt-0.5">qid: {q.queryid}</div>
                                        </td>
                                        <td className="py-2 px-3 text-[#64748B]">
                                            <div>{q.datname || '—'}</div>
                                            <div className="text-[#94A3B8]">{q.rolname || '—'}</div>
                                        </td>
                                        <td className="py-2 px-3 text-right font-mono text-[#1E293B]">
                                            {Number(q.metric_value).toLocaleString()}
                                        </td>
                                        <td className="py-2 px-3 text-right font-mono text-[#64748B]">
                                            {Number(q.total_calls).toLocaleString()}
                                        </td>
                                        <td className="py-2 px-3 text-right font-mono text-[#64748B]">
                                            {Number(q.total_exec_time_ms) >= 1000
                                                ? (Number(q.total_exec_time_ms) / 1000).toFixed(1) + 's'
                                                : Number(q.total_exec_time_ms).toFixed(0) + 'ms'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Fallback: top_queries yoksa ham JSON göster */}
            {!hasTopQueries && !details.baseline_avg && (
                <pre className="text-xs bg-[#F8FAFC] p-3 rounded overflow-x-auto">
                    {JSON.stringify(details, null, 2)}
                </pre>
            )}
        </div>
    );
}
