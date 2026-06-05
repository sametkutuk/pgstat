import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import EmptyState from '../components/common/EmptyState';
import { SkeletonTable } from '../components/common/Skeleton';

type HealthStatus = 'ok' | 'warning' | 'critical' | 'stub';

interface HealthCheckRow {
    check_name: string;
    last_run_at: string;
    last_status: HealthStatus;
    detail_message: string | null;
    updated_at: string;
}

interface SystemAlertRow {
    alert_id: number;
    severity: string;
    alert_code: string;
    alert_key: string;
    occurrence_count: number;
    first_seen_at: string;
    last_seen_at: string;
    title: string | null;
    message: string | null;
}

const CHECK_META: Array<{ key: string; label: string }> = [
    { key: 'stat_collection', label: 'Stat Toplama' },
    { key: 'partition_missing', label: 'Partition Sagligi' },
    { key: 'instance_unreachable', label: 'Instance Erisimi' },
    { key: 'collector_stale', label: 'Collector Aktif' },
    { key: 'cleanup_failed', label: 'Cleanup' },
    { key: 'disk_full', label: 'Disk Doluluk' },
];

function statusIcon(status: HealthStatus): string {
    if (status === 'ok') return 'v';
    if (status === 'warning') return '!';
    if (status === 'critical') return 'X';
    return 'i';
}

function statusLabel(status: HealthStatus): string {
    if (status === 'ok') return 'OK';
    if (status === 'warning') return 'Warning';
    if (status === 'critical') return 'Critical';
    return 'Stub';
}

function statusClass(status: HealthStatus): string {
    if (status === 'ok') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    if (status === 'warning') return 'border-amber-200 bg-amber-50 text-amber-700';
    if (status === 'critical') return 'border-red-200 bg-red-50 text-red-700';
    return 'border-slate-200 bg-slate-50 text-slate-600';
}

function severityClass(severity: string): string {
    if (severity === 'critical') return 'bg-red-100 text-red-700';
    if (severity === 'warning') return 'bg-amber-100 text-amber-700';
    if (severity === 'info') return 'bg-blue-100 text-blue-700';
    return 'bg-slate-100 text-slate-700';
}

function timeAgo(value: string | null | undefined): string {
    if (!value) return 'yok';
    const ts = new Date(value).getTime();
    if (Number.isNaN(ts)) return 'yok';
    const diffMs = Date.now() - ts;
    const minutes = Math.max(0, Math.floor(diffMs / 60_000));
    if (minutes < 1) return 'simdi';
    if (minutes < 60) return `${minutes} dakika once`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} saat once`;
    const days = Math.floor(hours / 24);
    return `${days} gun once`;
}

function formatDate(value: string | null | undefined): string {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('tr-TR');
}

export default function SystemHealthDashboard() {
    const checksQuery = useQuery({
        queryKey: ['system-health-checks'],
        queryFn: () => apiGet<HealthCheckRow[]>('/system-health/checks'),
        refetchInterval: 30_000,
    });

    const alertsQuery = useQuery({
        queryKey: ['system-health-alerts'],
        queryFn: () => apiGet<SystemAlertRow[]>('/alerts?source=system&status=open&limit=100'),
        refetchInterval: 30_000,
    });

    const checksByName = useMemo(() => {
        const map = new Map<string, HealthCheckRow>();
        for (const row of checksQuery.data ?? []) {
            map.set(row.check_name, row);
        }
        return map;
    }, [checksQuery.data]);

    const alertRows = alertsQuery.data ?? [];

    return (
        <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2">
                        <h1 className="text-xl font-semibold text-[#1E293B]">System Sagligi</h1>
                        <span
                            title="Collector ve veritabani saglik kontrollerinin son durumunu gosterir."
                            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#CBD5E1] text-xs text-[#64748B] cursor-help"
                        >
                            ?
                        </span>
                    </div>
                    <p className="text-sm text-[#64748B] mt-1">Health check kartlari 30 saniyede bir yenilenir.</p>
                </div>
                <div className="text-xs text-[#94A3B8]">
                    Son yenileme: {formatDate(new Date().toISOString())}
                </div>
            </div>

            {checksQuery.isLoading ? (
                <SkeletonTable rows={2} cols={3} />
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {CHECK_META.map((meta) => {
                        const row = checksByName.get(meta.key);
                        const status = row?.last_status ?? 'stub';
                        return (
                            <div key={meta.key} className={`rounded-lg border p-4 ${statusClass(status)}`}>
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-semibold">{meta.label}</div>
                                        <div className="text-xs opacity-80 mt-1">{meta.key}</div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-semibold uppercase">{statusLabel(status)}</span>
                                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/70 font-bold">
                                            {statusIcon(status)}
                                        </span>
                                    </div>
                                </div>
                                <div className="mt-4 text-xs">
                                    Son calisma: <b>{timeAgo(row?.last_run_at)}</b>
                                </div>
                                <div className="mt-2 text-sm text-[#334155]">
                                    {row?.detail_message ?? 'state yok'}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <div className="bg-white rounded-lg border border-[#E2E8F0] shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Acik System Alertleri</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Kaynak filtresi: system</p>
                    </div>
                    <span className="text-xs text-[#64748B]">{alertRows.length} alert</span>
                </div>

                {alertsQuery.isLoading ? (
                    <div className="p-4">
                        <SkeletonTable rows={5} cols={7} />
                    </div>
                ) : alertRows.length === 0 ? (
                    <EmptyState icon="OK" title="Acik system alert yok - sistem saglikli" />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                            <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                                <tr>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Severity</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Alert Code</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Alert Key</th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Occurrence</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">First Seen</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Last Seen</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Detay</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#F1F5F9]">
                                {alertRows.map((row) => (
                                    <tr key={row.alert_id} className="hover:bg-[#F8FAFC]">
                                        <td className="py-2 px-3 whitespace-nowrap">
                                            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${severityClass(row.severity)}`}>
                                                {row.severity}
                                            </span>
                                        </td>
                                        <td className="py-2 px-3 font-mono text-xs text-[#1E293B] whitespace-nowrap">{row.alert_code}</td>
                                        <td className="py-2 px-3 font-mono text-xs text-[#64748B] min-w-64">{row.alert_key}</td>
                                        <td className="py-2 px-3 text-right font-mono text-xs text-[#1E293B]">{row.occurrence_count}</td>
                                        <td className="py-2 px-3 text-xs text-[#64748B] whitespace-nowrap">{formatDate(row.first_seen_at)}</td>
                                        <td className="py-2 px-3 text-xs text-[#64748B] whitespace-nowrap">{formatDate(row.last_seen_at)}</td>
                                        <td className="py-2 px-3 text-xs text-[#334155] min-w-80">
                                            <div className="font-semibold">{row.title ?? '-'}</div>
                                            <div className="text-[#64748B] mt-0.5">{row.message ?? '-'}</div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
