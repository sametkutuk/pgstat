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
    const cluster = useQuery({ queryKey: ['inst-cluster', id], queryFn: () => apiGet<any>(`/instances/${id}/cluster`), enabled: !!id });
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

            {/* Workload profili — her tab'da görünür, sayfa içeriğinden önce */}
            <ClusterCard cluster={cluster.data} instanceId={id!} onChange={() => cluster.refetch()} />
            <WorkloadProfile instancePk={id!} />

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
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        <CapabilityCard
                            name="pg_stat_statements"
                            desc="Sorgu istatistikleri"
                            available={cap.has_pg_stat_statements}
                        />
                        <CapabilityCard
                            name="pg_stat_statements_info"
                            desc="Reset zamanı, dealloc sayısı (PG14+)"
                            available={cap.has_pg_stat_statements_info}
                        />
                        <CapabilityCard
                            name="pg_stat_io"
                            desc="Backend tipine göre I/O (PG16+)"
                            available={cap.has_pg_stat_io}
                        />
                        <CapabilityCard
                            name="pg_stat_checkpointer"
                            desc="Checkpoint metrikleri (PG17+)"
                            available={cap.has_pg_stat_checkpointer}
                        />
                        <CapabilityCard
                            name="compute_query_id"
                            desc="Sorgu kimlik üretimi"
                            mode={cap.compute_query_id_mode}
                        />
                    </div>
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

/**
 * Capability kartı — tek bir feature için durum gösterir.
 * available=true/false ise Aktif/Yok rozetleri, mode varsa metin rozeti.
 */
function CapabilityCard({ name, desc, available, mode }: {
    name: string; desc: string; available?: boolean; mode?: string | null;
}) {
    let badge: { text: string; cls: string };
    if (mode !== undefined) {
        const m = (mode || 'off').toLowerCase();
        const cls =
            m === 'on' || m === 'auto' || m === 'regress'
                ? 'bg-green-100 text-green-700 border-green-200'
                : m === 'off'
                    ? 'bg-amber-100 text-amber-700 border-amber-200'
                    : 'bg-gray-100 text-gray-600 border-gray-200';
        badge = { text: m, cls };
    } else if (available === true) {
        badge = { text: '✓ Aktif', cls: 'bg-green-100 text-green-700 border-green-200' };
    } else if (available === false) {
        badge = { text: '✗ Yok', cls: 'bg-gray-100 text-gray-500 border-gray-200' };
    } else {
        badge = { text: '—', cls: 'bg-gray-50 text-gray-400 border-gray-200' };
    }
    return (
        <div className="border border-[#E2E8F0] rounded-lg px-3 py-2 flex items-start justify-between gap-2 bg-[#F8FAFC]">
            <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-[#1E293B] truncate" title={name}>{name}</div>
                <div className="text-[10px] text-[#94A3B8] truncate">{desc}</div>
            </div>
            <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap flex-shrink-0 ${badge.cls}`}>
                {badge.text}
            </span>
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

function DatabasesTab({ data, loading }: { data: any[] | undefined; loading: boolean; instanceId?: string }) {
    if (loading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    return (
        <div className="bg-white rounded-lg shadow-sm p-4">
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

/**
 * Küme kartı — instance'ın kümedeki rolünü gösterir.
 * cluster_kind:
 *   - manual: kullanıcı tarafından manuel grup
 *   - orphan_clone: aynı sysid ama içinde >1 primary (klon/promote sonucu) — uyarı
 *   - auto: otomatik tespit (system_identifier eşleşmesi)
 *   - standalone: bağlantı yok
 */
function ClusterCard({ cluster, instanceId, onChange }: { cluster: any; instanceId: string; onChange: () => void }) {
    const [editing, setEditing] = useState(false);
    const [groupId, setGroupId] = useState('');

    if (!cluster) return null;

    const kind = cluster.cluster_kind || 'standalone';
    const kindLabel: Record<string, { text: string; cls: string }> = {
        manual: { text: '📌 MANUEL', cls: 'bg-purple-100 text-purple-700 border-purple-200' },
        orphan_clone: { text: '⚠ KLON/PROMOTE', cls: 'bg-amber-100 text-amber-700 border-amber-300' },
        auto: { text: '🔗 OTOMATİK', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
        standalone: { text: '○ STANDALONE', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
    };

    const save = async () => {
        await fetch(`/api/instances/${instanceId}/manual-cluster`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ manual_cluster_group_id: groupId.trim() || null }),
        });
        setEditing(false);
        onChange();
    };

    return (
        <div className="mb-4 bg-white border border-[#E2E8F0] rounded-lg p-3 text-sm">
            <div className="flex items-center gap-3 flex-wrap">
                <span className={`px-2 py-1 rounded text-xs font-bold border ${kindLabel[kind].cls}`}>
                    {kindLabel[kind].text}
                </span>
                {cluster.role !== 'standalone' && (
                    <>
                        <span className={`px-2 py-1 rounded text-xs font-bold ${
                            cluster.role === 'primary' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                        }`}>
                            {cluster.role === 'primary' ? 'PRIMARY' : 'REPLICA'}
                        </span>
                        <Link to={`/clusters/${encodeURIComponent(cluster.cluster_id)}`}
                            className="text-[#3B82F6] hover:underline font-medium text-xs">
                            Tüm küme görünümü →
                        </Link>
                    </>
                )}
                <button onClick={() => { setGroupId(cluster.manual_cluster_group_id || ''); setEditing(!editing); }}
                    className="ml-auto text-xs text-[#3B82F6] hover:underline">
                    {cluster.manual_cluster_group_id ? '✏ Manuel grubu düzenle' : '📌 Manuel küme grubu ata'}
                </button>
            </div>

            {kind === 'orphan_clone' && (
                <div className="mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                    ⚠ <strong>Aynı system_identifier'da birden fazla primary tespit edildi.</strong>
                    Muhtemelen <code>pg_basebackup</code> ile alınmış sonra promote edilmiş ya da VM clone sonucu.
                    Bu instance otomatik olarak ayrı küme sayıldı. Gerçek bir replication ilişkisi varsa
                    "Manuel küme grubu ata" ile aynı grup adını verin.
                </div>
            )}

            {editing && (
                <div className="mt-2 flex gap-2 items-center">
                    <input type="text" value={groupId} onChange={e => setGroupId(e.target.value)}
                        placeholder="Örn: prod-main, etl-cluster (boş bırakılırsa kaldırılır)"
                        className="flex-1 border border-[#CBD5E1] rounded px-2 py-1 text-xs" />
                    <button onClick={save}
                        className="px-3 py-1 bg-[#3B82F6] text-white text-xs rounded hover:bg-[#2563EB]">
                        Kaydet
                    </button>
                    <button onClick={() => setEditing(false)} className="px-2 py-1 text-xs text-[#64748B]">
                        İptal
                    </button>
                </div>
            )}

            {cluster.siblings?.length > 0 && (
                <div className="mt-2 flex gap-2 flex-wrap text-[11px]">
                    <span className="text-[#94A3B8]">Diğerleri:</span>
                    {cluster.siblings.map((s: any) => (
                        <Link key={s.instance_pk} to={`/instances/${s.instance_pk}`}
                            className="text-[#3B82F6] hover:underline">
                            {s.is_primary ? '👑 ' : ''}{s.display_name}
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Workload skor çubuğu — OLTP/Analitik/Toplu için renkli stacked bar.
 * dimmed=true (uzun-vade) → kesik kesik border + diagonal stripe pattern.
 *  Solid bar = ANLIK (24h). Çizgili/dashed bar = ORTALAMA (90g).
 */
function ScoreBar({ scores, label, classifiedAt, dimmed }: {
    scores: any; label: string; classifiedAt: string | null; dimmed?: boolean;
}) {
    const oltp = Number(scores?.oltp || 0);
    const analytical = Number(scores?.analytical || 0);
    const bulk = Number(scores?.bulk || 0);
    const total = oltp + analytical + bulk;

    if (!classifiedAt) {
        return <span className="text-[#CBD5E1] text-[10px]">— hesaplanmadı —</span>;
    }
    if (label === 'idle' || total === 0) {
        return <span className="text-[#94A3B8] text-[10px]">— düşük aktivite —</span>;
    }

    return (
        <div className="flex items-center gap-2">
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold flex-shrink-0 ${
                dimmed
                    ? 'bg-[#F1F5F9] text-[#64748B] border border-dashed border-[#94A3B8]'
                    : 'bg-[#0F172A] text-white'
            }`} title={dimmed ? '90 gün ortalaması' : 'Son 24 saat'}>
                {dimmed ? '90G' : '24S'}
            </span>
            <div
                className={`flex flex-1 h-5 overflow-hidden border ${
                    dimmed ? 'border-dashed border-[#64748B] rounded-sm' : 'border-[#1E293B] rounded'
                }`}
                title={`OLTP %${oltp} · Analitik %${analytical} · Toplu %${bulk}`}
            >
                {oltp > 0 && (
                    <div style={{ width: `${oltp}%`, backgroundColor: WL_COLOR.oltp }}
                        className="text-white text-[9px] font-medium flex items-center justify-center">
                        {oltp >= 10 && `${oltp}%`}
                    </div>
                )}
                {analytical > 0 && (
                    <div style={{ width: `${analytical}%`, backgroundColor: WL_COLOR.analytical }}
                        className="text-white text-[9px] font-medium flex items-center justify-center">
                        {analytical >= 10 && `${analytical}%`}
                    </div>
                )}
                {bulk > 0 && (
                    <div style={{ width: `${bulk}%`, backgroundColor: WL_COLOR.bulk }}
                        className="text-white text-[9px] font-medium flex items-center justify-center">
                        {bulk >= 10 && `${bulk}%`}
                    </div>
                )}
            </div>
            <div className="text-[9px] text-[#94A3B8] whitespace-nowrap w-16 text-right">
                {new Date(classifiedAt).toLocaleString('tr-TR', dimmed
                    ? { day: '2-digit', month: '2-digit' }
                    : { hour: '2-digit', minute: '2-digit' })}
            </div>
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
    oltp: '#3B82F6',         // mavi — en yaygın, normal işlem yükü
    analytical: '#EAB308',   // sarı — analitik/raporlama yükü
    bulk: '#DC2626',         // kırmızı — peak/spike, dikkat
    mixed: '#F97316',        // turuncu — birden fazla profil karışık
    idle: '#10B981',         // yeşil — sorun yok, boşta
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
                <InfoTip text={
`Her DB için iki ayrı görünüm:
• Son 24 saat (anlık) — saatte 1 hesaplanır, bugünkü davranışı gösterir
• Genel (90 gün ortalaması) — günde 1 hesaplanır, DB'nin gerçek karakterini verir
İkisi farklıysa → bugün anormal aktivite. Aynıysa → tipik gün.



Hesaplanan metrikler (per-DB):
• tps        = sum(calls) / 24h          → tx yoğunluğu
• avg_ms     = avg(exec_time / calls)     → ortalama sorgu süresi
• rows/call  = sum(rows) / sum(calls)     → sorgu başına dönen/etkilenen satır

Skor formülü (gradient, her biri 0..100):
• OLTP        = (tps / 50) × 1 / (1 + avg_ms / 50)
                yüksek tps + düşük avg_ms birlikte gerek
• Analitik   = max(avg_ms / 200, rows_call / 1000)
                yavaş sorgu VEYA çok satır biri yetsin
• Toplu Yük  = rows_call / 40000  (min 10000 row eşiği şart)

Sonra 3 skor toplanıp oranlanır → yüzdeler.

Etiket kuralı:
• Hiçbir skor %60'ı geçmiyorsa → Karma (HTAP)
• Pencere içinde 100'den az calls → Boşta
• Aksi halde en yüksek skorlu sınıf

Eşikler (50, 200, 1000, 10000 vb.) control.workload_classification_config
tablosundan tunable. Sınıflandırma saatte bir collector tarafından yenilenir.

📌 işaretli etiketler manuel override (otomatik tespit ezilir).`
                } />
                <span className="text-[11px] text-[#94A3B8] ml-auto">
                    24h saatte 1 · 90g günde 1
                </span>
            </div>
            <div className="grid grid-cols-[max-content_max-content_1fr_1fr] gap-x-3 gap-y-2 text-xs items-center">
                {/* Sütun başlıkları */}
                <div className="text-[10px] uppercase tracking-wider text-[#94A3B8]">Database</div>
                <div className="text-[10px] uppercase tracking-wider text-[#94A3B8]">Etiket</div>
                <div className="text-[10px] uppercase tracking-wider text-[#94A3B8]">Son 24 saat (anlık)</div>
                <div className="text-[10px] uppercase tracking-wider text-[#94A3B8]">Genel — 90 gün ortalaması</div>

                {rows.flatMap((r: any) => {
                    const labelManual = r.workload_label;
                    const labelShort = r.workload_label_auto || 'idle';
                    const labelLong = r.workload_label_long || 'idle';
                    const finalLabel = labelManual || labelShort;

                    return [
                        <div key={`${r.dbid}-name`} className="w-40 truncate font-mono" title={r.datname}>
                            {r.datname || '?'}
                        </div>,
                        <div
                            key={`${r.dbid}-tag`}
                            className="px-2 py-0.5 rounded text-white text-[10px] font-medium w-max flex-shrink-0"
                            style={{ backgroundColor: WL_COLOR[finalLabel] || '#94A3B8' }}
                            title={labelManual ? 'Manuel etiket' : 'Otomatik (24h)'}
                        >
                            {WL_LABEL_TR[finalLabel] || finalLabel}
                            {labelManual && <span className="ml-1">📌</span>}
                        </div>,
                        <ScoreBar key={`${r.dbid}-short`} scores={r.workload_scores} label={labelShort}
                            classifiedAt={r.workload_classified_at} />,
                        <ScoreBar key={`${r.dbid}-long`} scores={r.workload_scores_long} label={labelLong}
                            classifiedAt={r.workload_classified_long_at} dimmed />,
                    ];
                })}
            </div>
            <div className="mt-3 pt-2 border-t border-[#E2E8F0] flex gap-3 text-[10px] text-[#64748B]">
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.oltp }} /> OLTP</span>
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.analytical }} /> Analitik</span>
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.bulk }} /> Toplu Yük</span>
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.mixed }} /> Karma</span>
                <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: WL_COLOR.idle }} /> Boşta</span>
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
    const statWal = data?.stat_wal || [];
    const archiver = data?.archiver || [];

    return (
        <div className="space-y-5">
            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">WAL Pozisyonu ve Disk</h3>
                {wal.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] py-4 text-center">WAL verisi yok</div>
                ) : (
                    <DataTable columns={[
                        { key: 'sample_ts', header: 'Zaman', render: (r: any) => <TimeAgo date={r.sample_ts} /> },
                        { key: 'current_wal_lsn', header: 'LSN', render: (r: any) => <span className="font-mono text-xs">{r.current_wal_lsn || '—'}</span> },
                        { key: 'current_wal_file', header: 'WAL Dosyası', render: (r: any) => <span className="font-mono text-xs">{r.current_wal_file || '—'}</span> },
                        { key: 'period_wal_size_byte', header: 'Üretilen', render: (r: any) => formatBytesCompact(Number(r.period_wal_size_byte || 0)), className: 'text-right' },
                        { key: 'wal_directory_size_byte', header: 'pg_wal/ Boyut', render: (r: any) => formatBytesCompact(Number(r.wal_directory_size_byte || 0)), className: 'text-right' },
                        { key: 'wal_file_count', header: 'Dosya', render: (r: any) => Number(r.wal_file_count || 0).toLocaleString(), className: 'text-right' },
                    ]} data={wal} />
                )}
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">pg_stat_wal (PG13+)</h3>
                {statWal.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] py-4 text-center">pg_stat_wal verisi yok (PG13 öncesi sürümlerde mevcut değildir)</div>
                ) : (
                    <DataTable columns={[
                        { key: 'sample_ts', header: 'Zaman', render: (r: any) => <TimeAgo date={r.sample_ts} /> },
                        { key: 'wal_records', header: 'Records', render: (r: any) => Number(r.wal_records || 0).toLocaleString(), className: 'text-right' },
                        { key: 'wal_bytes', header: 'Bytes', render: (r: any) => formatBytesCompact(Number(r.wal_bytes || 0)), className: 'text-right' },
                        { key: 'wal_fpi', header: 'FPI (Full Page)', render: (r: any) => Number(r.wal_fpi || 0).toLocaleString(), className: 'text-right' },
                    ]} data={statWal} />
                )}
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">Archiver Durumu</h3>
                {archiver.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] py-4 text-center">Archiver verisi yok (archive_mode kapalı olabilir)</div>
                ) : (
                    <DataTable columns={[
                        { key: 'sample_ts', header: 'Zaman', render: (r: any) => <TimeAgo date={r.sample_ts} /> },
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
