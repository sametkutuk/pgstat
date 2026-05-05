import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../api/client';
import { useToast } from '../components/common/Toast';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import DataTable from '../components/common/DataTable';
import InfoTip from '../components/common/InfoTip';
import { useState } from 'react';

type Tab = 'overview' | 'storage' | 'statements' | 'databases' | 'activity' | 'alerts' | 'jobruns' | 'functions' | 'sequences' | 'wal' | 'slru' | 'tps';

export default function InstanceDetail() {
    const { id } = useParams();
    const [tab, setTab] = useState<Tab>('overview');
    const queryClient = useQueryClient();
    const toast = useToast();

    const retryMutation = useMutation({
        mutationFn: () => apiPatch(`/instances/${id}/retry`),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['instance', id] }); toast.success('Yeniden bağlanılıyor...'); },
    });

    const instance = useQuery({ queryKey: ['instance', id], queryFn: () => apiGet<any>(`/instances/${id}`) });
    const capability = useQuery({ queryKey: ['capability', id], queryFn: () => apiGet<any>(`/instances/${id}/capability`), enabled: !!id });
    const databases = useQuery({ queryKey: ['databases', id], queryFn: () => apiGet<any[]>(`/instances/${id}/databases`), enabled: tab === 'databases' });
    const storage = useQuery({ queryKey: ['instance-storage', id], queryFn: () => apiGet<any>(`/instances/${id}/storage`), enabled: tab === 'storage' });
    const statements = useQuery({ queryKey: ['inst-stmts', id], queryFn: () => apiGet<any[]>(`/instances/${id}/statements?hours=1&limit=30`), enabled: tab === 'statements' });
    const activity = useQuery({ queryKey: ['activity', id], queryFn: () => apiGet<any[]>(`/instances/${id}/activity`), enabled: tab === 'activity' });
    const alerts = useQuery({ queryKey: ['inst-alerts', id], queryFn: () => apiGet<any[]>(`/alerts?instance_pk=${id}`), enabled: tab === 'alerts' });
    const jobruns = useQuery({ queryKey: ['inst-jobruns', id], queryFn: () => apiGet<any[]>(`/job-runs?limit=20`), enabled: tab === 'jobruns' });
    const functions = useQuery({ queryKey: ['inst-functions', id], queryFn: () => apiGet<any[]>(`/instances/${id}/functions?hours=1`), enabled: tab === 'functions' });
    const sequences = useQuery({ queryKey: ['inst-sequences', id], queryFn: () => apiGet<any[]>(`/instances/${id}/sequences?hours=1`), enabled: tab === 'sequences' });
    const walData = useQuery({ queryKey: ['inst-wal', id], queryFn: () => apiGet<any>(`/instances/${id}/wal?hours=1`), enabled: tab === 'wal' });
    const slruData = useQuery({ queryKey: ['inst-slru', id], queryFn: () => apiGet<any[]>(`/instances/${id}/slru?hours=1`), enabled: tab === 'slru' });
    const tpsData = useQuery({ queryKey: ['inst-tps', id], queryFn: () => apiGet<any>(`/instances/${id}/tps?days=7`), enabled: tab === 'tps' });

    const inst = instance.data;
    const cap = capability.data;

    if (instance.isLoading) return <div className="py-8 text-[#94A3B8]">Yükleniyor...</div>;
    if (!inst) return <div className="py-8 text-red-500">Instance bulunamadı</div>;

    const tabs: { key: Tab; label: string; tip?: string }[] = [
        { key: 'overview', label: 'Genel' },
        { key: 'storage', label: 'Collector DB', tip: 'PgStat collector veritabanında bu instance için tutulan yaklaşık mantıksal veri boyutu ve database kırılımı.' },
        { key: 'statements', label: 'Statements', tip: 'pg_stat_statements — son 1 saatteki en yoğun sorgular. Exec time, calls, rows bazında sıralanır.' },
        { key: 'databases', label: 'Databases' },
        { key: 'tps', label: 'TPS', tip: 'Transactions Per Second — günlük ve saatlik commit/rollback dağılımı. Kapasite planlaması için kritik metrik.' },
        { key: 'activity', label: 'Activity', tip: 'pg_stat_activity — anlık aktif session\'lar. State, wait event ve çalışan sorguları gösterir.' },
        { key: 'functions', label: 'Functions', tip: 'pg_stat_user_functions — kullanıcı fonksiyonları. track_functions=all olmalı. Calls, total_time, self_time gösterir.' },
        { key: 'sequences', label: 'Sequences', tip: 'pg_statio_all_sequences — sequence I/O. Cache hit ratio düşükse shared_buffers yetersiz olabilir.' },
        { key: 'wal', label: 'WAL/Archive', tip: 'WAL üretimi ve archiver durumu. WAL bytes yüksekse checkpoint_completion_target ayarını kontrol edin. Failed archive varsa archive_command\'ı inceleyin.' },
        { key: 'slru', label: 'SLRU', tip: 'Simple LRU cache istatistikleri (PG13+). CommitTs, MultiXact, Notify, Serial, Subtrans, Xact cache\'leri. Hit ratio düşükse performans etkilenebilir.' },
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
                {(inst.bootstrap_state === 'degraded' || inst.last_error) && (
                    <button onClick={() => retryMutation.mutate()}
                        disabled={retryMutation.isPending}
                        className="px-3 py-1 text-xs rounded bg-yellow-50 text-yellow-700 hover:bg-yellow-100 border border-yellow-200">
                        {retryMutation.isPending ? 'Bekleniyor...' : '↺ Yeniden Dene'}
                    </button>
                )}
                <Link to={`/cluster/${id}/health-report`}
                    className="px-3 py-1 text-xs rounded bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200">
                    📋 Sağlık Raporu
                </Link>
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
                        className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1 ${tab === t.key ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-[#64748B] hover:text-[#1E293B]'
                            }`}>
                        {t.label}
                        {t.tip && tab === t.key && <InfoTip text={t.tip} />}
                    </button>
                ))}
            </div>

            {tab === 'overview' && <OverviewTab inst={inst} cap={cap} />}
            {tab === 'storage' && <StorageTab data={storage.data} loading={storage.isLoading} />}
            {tab === 'statements' && <StatementsTab data={statements.data} loading={statements.isLoading} />}
            {tab === 'databases' && <DatabasesTab data={databases.data} loading={databases.isLoading} instanceId={id!} />}
            {tab === 'activity' && <ActivityTab data={activity.data} loading={activity.isLoading} />}
            {tab === 'functions' && <FunctionsTab data={functions.data} loading={functions.isLoading} />}
            {tab === 'sequences' && <SequencesTab data={sequences.data} loading={sequences.isLoading} />}
            {tab === 'wal' && <WalArchiveTab data={walData.data} loading={walData.isLoading} />}
            {tab === 'slru' && <SlruTab data={slruData.data} loading={slruData.isLoading} />}
            {tab === 'tps' && <TpsTab data={tpsData.data} loading={tpsData.isLoading} />}
            {tab === 'alerts' && <AlertsTab data={alerts.data} loading={alerts.isLoading} />}
            {tab === 'jobruns' && <JobRunsTab data={jobruns.data} loading={jobruns.isLoading} />}
        </div >
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

function DatabasesTab({ data, loading, instanceId }: { data: any[] | undefined; loading: boolean; instanceId: string }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    return (
        <div className="bg-white rounded-lg shadow-sm p-4">
            <WorkloadProfile instancePk={instanceId} />
            <DataTable columns={[
                { key: 'datname', header: 'Database' },
                { key: 'dbid', header: 'OID' },
                { key: 'last_db_objects_collect_at', header: 'Son Toplama', render: (r: any) => <TimeAgo date={r.last_db_objects_collect_at} /> },
                { key: 'next_db_objects_collect_at', header: 'Sonraki', render: (r: any) => <TimeAgo date={r.next_db_objects_collect_at} /> },
                { key: 'consecutive_failures', header: 'Hatalar', render: (r: any) => (r.consecutive_failures || 0) > 0 ? <span className="text-red-600">{r.consecutive_failures}</span> : <span className="text-green-600">0</span> },
            ]} data={data || []} />
        </div>
    );
}

const WL_LABEL_TR: Record<string, string> = {
    oltp: 'OLTP',
    analytical: 'Analitik',
    bulk: 'Toplu Yük',
    mixed: 'Karma (HTAP)',
    idle: 'Boşta',
};
const WL_COLOR: Record<string, string> = {
    oltp: '#3B82F6',         // mavi
    analytical: '#8B5CF6',   // mor
    bulk: '#F97316',         // turuncu
    mixed: '#FACC15',        // sarı
    idle: '#94A3B8',         // gri
};

function WorkloadProfile({ instancePk }: { instancePk: string | number }) {
    const { data: rows, isLoading, error } = useQuery({
        queryKey: ['workload-instance', instancePk],
        queryFn: () => apiGet<any[]>(`/workload/instance/${instancePk}`),
        enabled: !!instancePk,
        refetchInterval: 60_000,
    });

    // Hata gizleme — V047 migration uygulanmadıysa veya endpoint yoksa sessizce atla
    if (error) return null;
    if (isLoading) {
        return (
            <div className="mb-5 border border-[#E2E8F0] rounded-lg p-4 text-xs text-[#94A3B8]">
                Workload profili yükleniyor...
            </div>
        );
    }
    if (!rows || rows.length === 0) {
        return (
            <div className="mb-5 border border-dashed border-[#E2E8F0] rounded-lg p-4 text-xs text-[#94A3B8]">
                Workload profili henüz hesaplanmadı. Collector başlangıcından sonra ~1 dakika içinde
                ilk sınıflandırma yapılır, sonra saatte bir güncellenir.
            </div>
        );
    }

    return (
        <div className="mb-5 border border-[#E2E8F0] rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
                <h4 className="font-semibold text-[#1E293B]">DB Workload Profilleri</h4>
                <span className="text-[11px] text-[#94A3B8]">
                    24 saatlik pgss verisinden otomatik (saatte 1 sınıflandırılır)
                </span>
            </div>
            <div className="space-y-2">
                {rows.map((r: any) => {
                    const scores = r.workload_scores || {};
                    const oltp = Number(scores.oltp || 0);
                    const analytical = Number(scores.analytical || 0);
                    const bulk = Number(scores.bulk || 0);
                    const total = oltp + analytical + bulk;
                    const labelAuto = r.workload_label_auto || (total === 0 ? 'idle' : 'mixed');
                    const labelManual = r.workload_label;
                    const finalLabel = labelManual || labelAuto;

                    return (
                        <div key={r.dbid} className="flex items-center gap-3 text-xs">
                            <div className="w-32 truncate font-mono" title={r.datname}>
                                {r.datname || '?'}
                            </div>
                            <div
                                className="px-2 py-0.5 rounded text-white text-[10px] font-medium flex-shrink-0"
                                style={{ backgroundColor: WL_COLOR[finalLabel] || '#94A3B8' }}
                                title={labelManual ? 'Manuel etiket' : 'Otomatik tespit'}
                            >
                                {WL_LABEL_TR[finalLabel] || finalLabel}
                                {labelManual && <span className="ml-1">📌</span>}
                            </div>
                            {labelAuto !== 'idle' && total > 0 && (
                                <div className="flex flex-1 h-4 rounded overflow-hidden border border-[#E2E8F0]"
                                    title={`OLTP %${oltp}  ·  Analitik %${analytical}  ·  Toplu %${bulk}`}>
                                    {oltp > 0 && (
                                        <div style={{ width: `${oltp}%`, backgroundColor: WL_COLOR.oltp }}
                                             className="text-white text-[9px] flex items-center justify-center">
                                            {oltp >= 8 && `${oltp}%`}
                                        </div>
                                    )}
                                    {analytical > 0 && (
                                        <div style={{ width: `${analytical}%`, backgroundColor: WL_COLOR.analytical }}
                                             className="text-white text-[9px] flex items-center justify-center">
                                            {analytical >= 8 && `${analytical}%`}
                                        </div>
                                    )}
                                    {bulk > 0 && (
                                        <div style={{ width: `${bulk}%`, backgroundColor: WL_COLOR.bulk }}
                                             className="text-white text-[9px] flex items-center justify-center">
                                            {bulk >= 8 && `${bulk}%`}
                                        </div>
                                    )}
                                </div>
                            )}
                            {labelAuto === 'idle' && (
                                <span className="text-[#94A3B8] flex-1">— düşük aktivite —</span>
                            )}
                            <div className="text-[10px] text-[#94A3B8] w-16 text-right">
                                {r.workload_classified_at ? new Date(r.workload_classified_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '—'}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="mt-3 pt-2 border-t border-[#E2E8F0] flex gap-3 text-[10px] text-[#64748B]">
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.oltp }} /> OLTP</span>
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.analytical }} /> Analitik</span>
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.bulk }} /> Toplu Yük</span>
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.mixed }} /> Karma</span>
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.idle }} /> Boşta</span>
                <span className="ml-auto">📌 = manuel etiket</span>
            </div>
        </div>
    );
}

function StorageTab({ data, loading }: { data: any; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const databases = data?.databases || [];
    const tables = data?.tables || [];
    const totalBytes = Number(data?.total_bytes || 0);
    const collectorDbBytes = Number(data?.collector_db_bytes || 0);
    const pct = collectorDbBytes > 0 ? totalBytes * 100 / collectorDbBytes : 0;
    const maxDbBytes = Math.max(...databases.map((d: any) => Number(d.data_bytes || 0)), 1);

    const dbColumns = [
        { key: 'datname', header: 'Database' },
        { key: 'data_bytes', header: 'Boyut', render: (r: any) => fmtBytes(r.data_bytes) },
        { key: 'row_count', header: 'Satır', render: (r: any) => Number(r.row_count || 0).toLocaleString() },
        {
            key: 'share', header: 'Pay', render: (r: any) => {
                const share = totalBytes > 0 ? Number(r.data_bytes || 0) * 100 / totalBytes : 0;
                return (
                    <div className="min-w-[160px]">
                        <div className="h-2 bg-[#E2E8F0] rounded overflow-hidden">
                            <div className="h-full bg-[#10B981]" style={{ width: `${Math.max(1, Number(r.data_bytes || 0) * 100 / maxDbBytes)}%` }} />
                        </div>
                        <div className="text-[10px] text-[#64748B] mt-1">{share.toFixed(1)}%</div>
                    </div>
                );
            }
        },
    ];
    const tableColumns = [
        { key: 'source_table', header: 'Collector Tablosu' },
        { key: 'datname', header: 'Database' },
        { key: 'data_bytes', header: 'Boyut', render: (r: any) => fmtBytes(r.data_bytes) },
        { key: 'row_count', header: 'Satır', render: (r: any) => Number(r.row_count || 0).toLocaleString() },
    ];

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <InfoCard label="Bu Instance" value={fmtBytes(totalBytes)} />
                <InfoCard label="Satır" value={Number(data?.total_rows || 0).toLocaleString()} />
                <InfoCard label="Collector DB Payı" value={`${pct.toFixed(1)}%`} />
            </div>
            <div className="bg-white rounded-lg shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-[#64748B]">Database Kırılımı</h3>
                    <span className="text-xs text-[#94A3B8]">Yaklaşık mantıksal boyut</span>
                </div>
                <DataTable columns={dbColumns} data={databases} />
            </div>
            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">Collector Tablo Kırılımı</h3>
                <DataTable columns={tableColumns} data={tables} />
            </div>
        </div>
    );
}

function fmtBytes(value: any): string {
    const bytes = Number(value || 0);
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes.toLocaleString()} B`;
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

function FunctionsTab({ data, loading }: { data: any[] | undefined; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const columns = [
        { key: 'schemaname', header: 'Schema' },
        { key: 'funcname', header: 'Fonksiyon' },
        { key: 'total_calls', header: 'Calls', render: (r: any) => Number(r.total_calls).toLocaleString(), className: 'text-right' },
        { key: 'total_time_ms', header: 'Toplam (ms)', render: (r: any) => Number(r.total_time_ms).toFixed(2), className: 'text-right' },
        { key: 'self_time_ms', header: 'Self (ms)', render: (r: any) => Number(r.self_time_ms).toFixed(2), className: 'text-right' },
        { key: 'avg_time_ms', header: 'Avg (ms)', render: (r: any) => Number(r.avg_time_ms).toFixed(3), className: 'text-right' },
    ];
    return <div className="bg-white rounded-lg shadow-sm p-4"><DataTable columns={columns} data={data || []} emptyText="Fonksiyon verisi yok (pg_stat_user_functions)" /></div>;
}

function SequencesTab({ data, loading }: { data: any[] | undefined; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const columns = [
        { key: 'schemaname', header: 'Schema' },
        { key: 'relname', header: 'Sequence' },
        { key: 'total_blks_read', header: 'Blks Read', render: (r: any) => Number(r.total_blks_read).toLocaleString(), className: 'text-right' },
        { key: 'total_blks_hit', header: 'Blks Hit', render: (r: any) => Number(r.total_blks_hit).toLocaleString(), className: 'text-right' },
        {
            key: 'hit_ratio', header: 'Hit Ratio', render: (r: any) => (
                <span className={Number(r.hit_ratio) < 90 ? 'text-red-600 font-medium' : 'text-green-600'}>
                    {Number(r.hit_ratio).toFixed(1)}%
                </span>
            ), className: 'text-right'
        },
    ];
    return <div className="bg-white rounded-lg shadow-sm p-4"><DataTable columns={columns} data={data || []} emptyText="Sequence I/O verisi yok" /></div>;
}

function WalArchiveTab({ data, loading }: { data: any | undefined; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const wal = data?.wal || [];
    const archiver = data?.archiver || [];

    return (
        <div className="space-y-5">
            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">WAL Üretimi</h3>
                {wal.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] py-4 text-center">WAL verisi yok</div>
                ) : (
                    <DataTable columns={[
                        { key: 'snapshot_ts', header: 'Zaman', render: (r: any) => <TimeAgo date={r.snapshot_ts} /> },
                        { key: 'wal_records_delta', header: 'Records', render: (r: any) => Number(r.wal_records_delta || 0).toLocaleString(), className: 'text-right' },
                        { key: 'wal_bytes_delta', header: 'Bytes', render: (r: any) => formatBytesCompact(Number(r.wal_bytes_delta || 0)), className: 'text-right' },
                        { key: 'wal_fpi_delta', header: 'FPI', render: (r: any) => Number(r.wal_fpi_delta || 0).toLocaleString(), className: 'text-right' },
                        { key: 'wal_buffers_full_delta', header: 'Buf Full', render: (r: any) => Number(r.wal_buffers_full_delta || 0).toLocaleString(), className: 'text-right' },
                        { key: 'wal_write_time_delta', header: 'Write (ms)', render: (r: any) => Number(r.wal_write_time_delta || 0).toFixed(1), className: 'text-right' },
                        { key: 'wal_sync_time_delta', header: 'Sync (ms)', render: (r: any) => Number(r.wal_sync_time_delta || 0).toFixed(1), className: 'text-right' },
                    ]} data={wal} />
                )}
            </div>
            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">Archiver Durumu</h3>
                {archiver.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] py-4 text-center">Archiver verisi yok</div>
                ) : (
                    <DataTable columns={[
                        { key: 'snapshot_ts', header: 'Zaman', render: (r: any) => <TimeAgo date={r.snapshot_ts} /> },
                        { key: 'archived_count', header: 'Arşivlenen', render: (r: any) => Number(r.archived_count || 0).toLocaleString(), className: 'text-right' },
                        { key: 'last_archived_wal', header: 'Son Arşiv WAL', render: (r: any) => <span className="font-mono text-xs">{r.last_archived_wal || '—'}</span> },
                        {
                            key: 'failed_count', header: 'Başarısız', render: (r: any) => {
                                const n = Number(r.failed_count || 0);
                                return n > 0 ? <span className="text-red-600 font-medium">{n}</span> : <span className="text-green-600">0</span>;
                            }, className: 'text-right'
                        },
                        { key: 'last_failed_wal', header: 'Son Hata WAL', render: (r: any) => <span className="font-mono text-xs">{r.last_failed_wal || '—'}</span> },
                    ]} data={archiver} />
                )}
            </div>
        </div>
    );
}

function SlruTab({ data, loading }: { data: any[] | undefined; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const columns = [
        { key: 'name', header: 'SLRU' },
        { key: 'total_blks_hit', header: 'Blks Hit', render: (r: any) => Number(r.total_blks_hit).toLocaleString(), className: 'text-right' },
        { key: 'total_blks_read', header: 'Blks Read', render: (r: any) => Number(r.total_blks_read).toLocaleString(), className: 'text-right' },
        {
            key: 'hit_ratio', header: 'Hit Ratio', render: (r: any) => (
                <span className={Number(r.hit_ratio) < 90 ? 'text-red-600 font-medium' : 'text-green-600'}>
                    {Number(r.hit_ratio).toFixed(1)}%
                </span>
            ), className: 'text-right'
        },
        { key: 'total_blks_written', header: 'Written', render: (r: any) => Number(r.total_blks_written).toLocaleString(), className: 'text-right' },
        { key: 'total_flushes', header: 'Flushes', render: (r: any) => Number(r.total_flushes).toLocaleString(), className: 'text-right' },
        { key: 'total_truncates', header: 'Truncates', render: (r: any) => Number(r.total_truncates).toLocaleString(), className: 'text-right' },
    ];
    return <div className="bg-white rounded-lg shadow-sm p-4"><DataTable columns={columns} data={data || []} emptyText="SLRU verisi yok (PG13+)" /></div>;
}

function TpsTab({ data, loading }: { data: any | undefined; loading: boolean }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    const daily = data?.daily || [];
    const hourly = data?.hourly || [];

    return (
        <div className="space-y-5">
            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">Günlük TPS (son 7 gün)</h3>
                {daily.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] py-4 text-center">Günlük TPS verisi yok</div>
                ) : (
                    <DataTable columns={[
                        { key: 'day', header: 'Gün', render: (r: any) => new Date(r.day).toLocaleDateString('tr-TR') },
                        { key: 'datname', header: 'Database' },
                        { key: 'commits', header: 'Commits', render: (r: any) => Number(r.commits).toLocaleString('tr-TR'), className: 'text-right' },
                        {
                            key: 'rollbacks', header: 'Rollbacks', render: (r: any) => {
                                const n = Number(r.rollbacks);
                                return n > 0 ? <span className="text-red-600">{n.toLocaleString('tr-TR')}</span> : <span className="text-[#94A3B8]">0</span>;
                            }, className: 'text-right'
                        },
                        { key: 'total_xact', header: 'Toplam Xact', render: (r: any) => Number(r.total_xact).toLocaleString('tr-TR'), className: 'text-right' },
                        {
                            key: 'avg_tps', header: 'Ort. TPS', render: (r: any) => (
                                <span className="font-semibold text-[#2563EB]">{Number(r.avg_tps).toLocaleString('tr-TR')}</span>
                            ), className: 'text-right'
                        },
                    ]} data={daily} />
                )}
            </div>
            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">Saatlik TPS (son 25 saat)</h3>
                {hourly.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] py-4 text-center">Saatlik TPS verisi yok</div>
                ) : (
                    <DataTable columns={[
                        { key: 'hour', header: 'Saat', render: (r: any) => new Date(r.hour).toLocaleString('tr-TR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) },
                        { key: 'datname', header: 'Database' },
                        { key: 'commits', header: 'Commits', render: (r: any) => Number(r.commits).toLocaleString('tr-TR'), className: 'text-right' },
                        {
                            key: 'rollbacks', header: 'Rollbacks', render: (r: any) => {
                                const n = Number(r.rollbacks);
                                return n > 0 ? <span className="text-red-600">{n.toLocaleString('tr-TR')}</span> : <span className="text-[#94A3B8]">0</span>;
                            }, className: 'text-right'
                        },
                        { key: 'total_xact', header: 'Toplam Xact', render: (r: any) => Number(r.total_xact).toLocaleString('tr-TR'), className: 'text-right' },
                        {
                            key: 'avg_tps', header: 'Ort. TPS', render: (r: any) => (
                                <span className="font-semibold text-[#2563EB]">{Number(r.avg_tps).toLocaleString('tr-TR')}</span>
                            ), className: 'text-right'
                        },
                    ]} data={hourly} />
                )}
            </div>
        </div>
    );
}

function formatBytesCompact(bytes: number): string {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
    return `${bytes} B`;
}
