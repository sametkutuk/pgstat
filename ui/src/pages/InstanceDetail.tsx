import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../api/client';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import DataTable from '../components/common/DataTable';
import { useState } from 'react';

type Tab = 'overview' | 'statements' | 'databases' | 'activity' | 'alerts' | 'jobruns';

export default function InstanceDetail() {
    const { id } = useParams();
    const [tab, setTab] = useState<Tab>('overview');

    const instance = useQuery({ queryKey: ['instance', id], queryFn: () => apiGet<any>(`/instances/${id}`) });
    const capability = useQuery({ queryKey: ['capability', id], queryFn: () => apiGet<any>(`/instances/${id}/capability`), enabled: !!id });
    const databases = useQuery({ queryKey: ['databases', id], queryFn: () => apiGet<any[]>(`/instances/${id}/databases`), enabled: tab === 'databases' });
    const statements = useQuery({ queryKey: ['inst-stmts', id], queryFn: () => apiGet<any[]>(`/instances/${id}/statements?hours=1&limit=30`), enabled: tab === 'statements' });
    const activity = useQuery({ queryKey: ['activity', id], queryFn: () => apiGet<any[]>(`/instances/${id}/activity`), enabled: tab === 'activity' });
    const alerts = useQuery({ queryKey: ['inst-alerts', id], queryFn: () => apiGet<any[]>(`/alerts?instance_pk=${id}`), enabled: tab === 'alerts' });
    const jobruns = useQuery({ queryKey: ['inst-jobruns', id], queryFn: () => apiGet<any[]>(`/job-runs?limit=20`), enabled: tab === 'jobruns' });

    const inst = instance.data;
    const cap = capability.data;

    if (instance.isLoading) return <div className="py-8 text-[#94A3B8]">Yükleniyor...</div>;
    if (!inst) return <div className="py-8 text-red-500">Instance bulunamadı</div>;

    const tabs: { key: Tab; label: string }[] = [
        { key: 'overview', label: 'Genel' },
        { key: 'statements', label: 'Statements' },
        { key: 'databases', label: 'Databases' },
        { key: 'activity', label: 'Activity' },
        { key: 'alerts', label: 'Alertler' },
        { key: 'jobruns', label: 'Son Job Run' },
    ];

    return (
        <div>
            <Link to="/instances" className="text-sm text-[#3B82F6] hover:underline mb-3 inline-block">← Instances</Link>
            <div className="flex items-center gap-3 mb-5">
                <h1 className="text-xl font-bold">{inst.display_name}</h1>
                <Badge value={inst.bootstrap_state} />
                {inst.is_active ? <Badge value="ready" /> : <Badge value="paused" />}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
                <InfoCard label="Host" value={`${inst.host}:${inst.port}`} />
                <InfoCard label="PG Sürüm" value={cap?.pg_major ? `PG${cap.pg_major}` : '—'} />
                <InfoCard label="Rol" value={cap?.is_primary === true ? 'Primary' : cap?.is_primary === false ? 'Replica' : '—'} />
                <InfoCard label="SQL Family" value={cap?.collector_sql_family || '—'} />
            </div>

            <div className="flex gap-1 mb-4 border-b border-[#E2E8F0] overflow-x-auto">
                {tabs.map((t) => (
                    <button key={t.key} onClick={() => setTab(t.key)}
                        className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${tab === t.key ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-[#64748B] hover:text-[#1E293B]'
                            }`}>{t.label}</button>
                ))}
            </div>

            {tab === 'overview' && <OverviewTab inst={inst} cap={cap} />}
            {tab === 'statements' && <StatementsTab data={statements.data} loading={statements.isLoading} />}
            {tab === 'databases' && <DatabasesTab data={databases.data} loading={databases.isLoading} />}
            {tab === 'activity' && <ActivityTab data={activity.data} loading={activity.isLoading} />}
            {tab === 'alerts' && <AlertsTab data={alerts.data} loading={alerts.isLoading} />}
            {tab === 'jobruns' && <JobRunsTab data={jobruns.data} loading={jobruns.isLoading} />}
        </div>
    );
}

function InfoCard({ label, value }: { label: string; value: string }) {
    return (
        <div className="bg-white rounded-lg p-4 shadow-sm">
            <div className="text-xs text-[#64748B] mb-1">{label}</div>
            <div className="text-sm font-medium">{value}</div>
        </div>
    );
}

function OverviewTab({ inst, cap }: { inst: any; cap: any }) {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="bg-white rounded-lg p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">Bağlantı Bilgileri</h3>
                <dl className="space-y-2 text-sm">
                    <Row label="Instance ID" value={inst.instance_id} />
                    <Row label="Admin DB" value={inst.admin_dbname} />
                    <Row label="SSL Mode" value={inst.ssl_mode} />
                    <Row label="Ortam" value={inst.environment || '—'} />
                    <Row label="Servis Grubu" value={inst.service_group || '—'} />
                    <Row label="Collector Group" value={inst.collector_group || '—'} />
                    <Row label="System ID" value={cap?.system_identifier || '—'} />
                </dl>
            </div>
            <div className="bg-white rounded-lg p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">Toplama Durumu</h3>
                <dl className="space-y-2 text-sm">
                    <Row label="Son Cluster" value={inst.last_cluster_collect_at ? <TimeAgo date={inst.last_cluster_collect_at} /> : '—'} />
                    <Row label="Sonraki Cluster" value={inst.next_cluster_collect_at ? <TimeAgo date={inst.next_cluster_collect_at} /> : '—'} />
                    <Row label="Son Statements" value={inst.last_statements_collect_at ? <TimeAgo date={inst.last_statements_collect_at} /> : '—'} />
                    <Row label="Sonraki Statements" value={inst.next_statements_collect_at ? <TimeAgo date={inst.next_statements_collect_at} /> : '—'} />
                    <Row label="Son Rollup" value={inst.last_rollup_at ? <TimeAgo date={inst.last_rollup_at} /> : '—'} />
                    <Row label="Ardışık Hata" value={inst.consecutive_failures ?? 0} />
                    <Row label="Backoff Bitiş" value={inst.backoff_until ? <TimeAgo date={inst.backoff_until} /> : '—'} />
                    {inst.last_error && (
                        <Row label="Son Hata" value={
                            <span className="text-red-500 text-xs break-all">{inst.last_error}</span>
                        } />
                    )}
                    {inst.last_error_at && (
                        <Row label="Hata Zamanı" value={<TimeAgo date={inst.last_error_at} />} />
                    )}
                    <Row label="Epoch Key" value={inst.current_pgss_epoch_key || '—'} />
                    <Row label="Son Discovery" value={cap?.last_discovered_at ? <TimeAgo date={cap.last_discovered_at} /> : '—'} />
                </dl>
            </div>
            {cap && (
                <div className="bg-white rounded-lg p-5 shadow-sm md:col-span-2">
                    <h3 className="text-sm font-semibold text-[#64748B] mb-3">Capability</h3>
                    <dl className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                        <Row label="pg_stat_statements" value={cap.has_pg_stat_statements ? '✅' : '❌'} />
                        <Row label="pg_stat_statements_info" value={cap.has_pg_stat_statements_info ? '✅' : '❌'} />
                        <Row label="pg_stat_io" value={cap.has_pg_stat_io ? '✅' : '❌'} />
                        <Row label="pg_stat_checkpointer" value={cap.has_pg_stat_checkpointer ? '✅' : '❌'} />
                        <Row label="compute_query_id" value={cap.compute_query_id_mode || '—'} />
                        <Row label="Erişilebilir" value={cap.is_reachable === true ? '✅' : cap.is_reachable === false ? '❌' : '—'} />
                    </dl>
                </div>
            )}
        </div>
    );
}

function Row({ label, value }: { label: string; value: any }) {
    return (
        <div className="flex justify-between">
            <dt className="text-[#64748B]">{label}</dt>
            <dd className="font-medium">{value}</dd>
        </div>
    );
}

function StatementsTab({ data, loading }: { data: any[] | undefined; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const columns = [
        { key: 'datname', header: 'Database' },
        { key: 'rolname', header: 'Rol' },
        { key: 'query_text', header: 'SQL', render: (r: any) => <div className="max-w-md truncate text-xs font-mono" title={r.query_text}>{r.query_text || '—'}</div> },
        { key: 'total_calls', header: 'Calls', render: (r: any) => Number(r.total_calls).toLocaleString() },
        { key: 'total_exec_time_ms', header: 'Exec (ms)', render: (r: any) => Number(r.total_exec_time_ms).toFixed(1) },
        { key: 'avg_exec_time_ms', header: 'Avg (ms)', render: (r: any) => Number(r.avg_exec_time_ms).toFixed(2) },
        { key: 'total_rows', header: 'Rows', render: (r: any) => Number(r.total_rows).toLocaleString() },
    ];
    return <div className="bg-white rounded-lg shadow-sm p-4"><DataTable columns={columns} data={data || []} /></div>;
}

function DatabasesTab({ data, loading }: { data: any[] | undefined; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const columns = [
        { key: 'datname', header: 'Database' },
        { key: 'dbid', header: 'OID' },
        { key: 'last_db_objects_collect_at', header: 'Son Toplama', render: (r: any) => <TimeAgo date={r.last_db_objects_collect_at} /> },
        { key: 'next_db_objects_collect_at', header: 'Sonraki', render: (r: any) => <TimeAgo date={r.next_db_objects_collect_at} /> },
        { key: 'consecutive_failures', header: 'Hatalar', render: (r: any) => (r.consecutive_failures || 0) > 0 ? <span className="text-red-600">{r.consecutive_failures}</span> : <span className="text-green-600">0</span> },
    ];
    return <div className="bg-white rounded-lg shadow-sm p-4"><DataTable columns={columns} data={data || []} /></div>;
}

function ActivityTab({ data, loading }: { data: any[] | undefined; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const columns = [
        { key: 'pid', header: 'PID' },
        { key: 'datname', header: 'Database' },
        { key: 'usename', header: 'User' },
        { key: 'state', header: 'State', render: (r: any) => <Badge value={r.state || 'unknown'} /> },
        { key: 'wait_event_type', header: 'Wait', render: (r: any) => r.wait_event_type ? `${r.wait_event_type}/${r.wait_event}` : '—' },
        { key: 'query', header: 'Query', render: (r: any) => <div className="max-w-xs truncate text-xs font-mono" title={r.query}>{r.query || '—'}</div> },
        { key: 'backend_type', header: 'Backend' },
    ];
    return <div className="bg-white rounded-lg shadow-sm p-4"><DataTable columns={columns} data={data || []} /></div>;
}

function AlertsTab({ data, loading }: { data: any[] | undefined; loading: boolean }) {
    const queryClient = useQueryClient();
    const ackMutation = useMutation({
        mutationFn: (id: number) => apiPatch(`/alerts/${id}/acknowledge`),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inst-alerts'] }),
    });

    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const columns = [
        { key: 'severity', header: 'Seviye', render: (r: any) => <Badge value={r.severity} /> },
        { key: 'status', header: 'Durum', render: (r: any) => <Badge value={r.status} /> },
        { key: 'alert_code', header: 'Kod' },
        { key: 'title', header: 'Başlık' },
        { key: 'occurrence_count', header: 'Tekrar', className: 'text-right' },
        { key: 'last_seen_at', header: 'Son Görülme', render: (r: any) => <TimeAgo date={r.last_seen_at} /> },
        {
            key: 'actions', header: '', render: (r: any) => r.status === 'open' ? (
                <button onClick={() => ackMutation.mutate(r.alert_id)} className="px-2 py-1 text-xs bg-yellow-50 text-yellow-700 rounded hover:bg-yellow-100">Onayla</button>
            ) : null
        },
    ];
    return <div className="bg-white rounded-lg shadow-sm p-4"><DataTable columns={columns} data={data || []} emptyText="Bu instance için alert yok" /></div>;
}

function JobRunsTab({ data, loading }: { data: any[] | undefined; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    // job_run_instance tablosundan bu instance'a ait olanları filtrele
    // Not: API'den direkt instance bazlı endpoint olmadığı için job_run listesini gösteriyoruz
    const columns = [
        { key: 'status', header: 'Durum', render: (r: any) => <Badge value={r.status} /> },
        { key: 'job_type', header: 'Job' },
        { key: 'started_at', header: 'Başlangıç', render: (r: any) => <TimeAgo date={r.started_at} /> },
        { key: 'rows_written', header: 'Satır', className: 'text-right' },
        { key: 'instances_succeeded', header: 'Başarılı', render: (r: any) => <span className="text-green-600">{r.instances_succeeded}</span>, className: 'text-right' },
        { key: 'instances_failed', header: 'Başarısız', render: (r: any) => r.instances_failed > 0 ? <span className="text-red-600">{r.instances_failed}</span> : <span className="text-[#94A3B8]">0</span>, className: 'text-right' },
    ];
    return <div className="bg-white rounded-lg shadow-sm p-4"><DataTable columns={columns} data={data || []} emptyText="Job run kaydı yok" /></div>;
}
