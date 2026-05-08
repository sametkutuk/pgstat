import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../api/client';
import { useToast } from '../components/common/Toast';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import DataTable from '../components/common/DataTable';
import InfoTip from '../components/common/InfoTip';
import Skeleton, { SkeletonTable, SkeletonCard } from '../components/common/Skeleton';
import EmptyState from '../components/common/EmptyState';
import { useEffect, useMemo, useState } from 'react';

type Tab = 'overview' | 'storage' | 'statements' | 'databases' | 'tables' | 'indexes' | 'activity' | 'replication' | 'alerts' | 'jobruns' | 'functions' | 'sequences' | 'wal' | 'slru' | 'tps' | 'settings_diff';

export default function InstanceDetail() {
    const { id } = useParams();
    const [tab, setTab] = useState<Tab>('overview');
    const [selectedDbid, setSelectedDbid] = useState<number | null>(null);
    const queryClient = useQueryClient();
    const toast = useToast();

    useEffect(() => {
        setSelectedDbid(null);
    }, [id]);

    const retryMutation = useMutation({
        mutationFn: () => apiPatch(`/instances/${id}/retry`),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['instance', id] }); toast.success('Yeniden bağlanılıyor...'); },
    });

    const instance = useQuery({ queryKey: ['instance', id], queryFn: () => apiGet<any>(`/instances/${id}`) });
    const capability = useQuery({ queryKey: ['capability', id], queryFn: () => apiGet<any>(`/instances/${id}/capability`), enabled: !!id });
    const cluster = useQuery({ queryKey: ['inst-cluster', id], queryFn: () => apiGet<any>(`/instances/${id}/cluster`), enabled: !!id });
    const databases = useQuery({ queryKey: ['databases', id], queryFn: () => apiGet<any[]>(`/instances/${id}/databases`), enabled: tab === 'databases' });
    const storage = useQuery({ queryKey: ['instance-storage', id], queryFn: () => apiGet<any>(`/instances/${id}/storage`), enabled: tab === 'storage' });
    const alerts = useQuery({ queryKey: ['inst-alerts', id], queryFn: () => apiGet<any[]>(`/alerts?instance_pk=${id}`), enabled: tab === 'alerts' });
    const jobruns = useQuery({ queryKey: ['inst-jobruns', id], queryFn: () => apiGet<any[]>(`/job-runs?limit=20`), enabled: tab === 'jobruns' });
    const functions = useQuery({ queryKey: ['inst-functions', id], queryFn: () => apiGet<any[]>(`/instances/${id}/functions?hours=1`), enabled: tab === 'functions' });
    const sequences = useQuery({ queryKey: ['inst-sequences', id], queryFn: () => apiGet<any[]>(`/instances/${id}/sequences?hours=1`), enabled: tab === 'sequences' });
    const walData = useQuery({ queryKey: ['inst-wal', id], queryFn: () => apiGet<any>(`/instances/${id}/wal?hours=1`), enabled: tab === 'wal' });
    const slruData = useQuery({ queryKey: ['inst-slru', id], queryFn: () => apiGet<any[]>(`/instances/${id}/slru?hours=1`), enabled: tab === 'slru' });
    const tpsData = useQuery({ queryKey: ['inst-tps', id], queryFn: () => apiGet<any>(`/instances/${id}/tps?days=7`), enabled: tab === 'tps' });
    const [settingsDiffDays, setSettingsDiffDays] = useState(30);
    const settingsDiff = useQuery({
        queryKey: ['settings-diff', id, settingsDiffDays],
        queryFn: () => apiGet<any>(`/instances/${id}/settings/diff?days=${settingsDiffDays}`),
        enabled: tab === 'settings_diff',
    });

    const inst = instance.data;
    const cap = capability.data;

    if (instance.isLoading) return (
        <div className="space-y-4">
            <Skeleton width="40%" height="1.5rem" />
            <SkeletonCard />
            <SkeletonTable rows={6} cols={5} />
        </div>
    );
    if (!inst) return <EmptyState icon="🔍" title="Instance bulunamadı" description="Bu instance silinmiş veya erişilebilir değil." />;

    const tabs: { key: Tab; label: string; tip?: string }[] = [
        { key: 'overview', label: 'Genel' },
        { key: 'storage', label: 'Collector DB', tip: 'PgStat collector veritabanında bu instance için tutulan yaklaşık mantıksal veri boyutu ve database kırılımı.' },
        { key: 'statements', label: 'Statements', tip: 'pg_stat_statements — son 1 saatteki en yoğun sorgular. Exec time, calls, rows bazında sıralanır.' },
        { key: 'databases', label: 'Databases' },
        { key: 'tables', label: 'Tablo İstatistikleri', tip: 'Seçilen database için son 24 saatteki tablo istatistikleri.' },
        { key: 'indexes', label: 'Index İstatistikleri', tip: 'Seçilen database için son 24 saatteki index istatistikleri.' },
        { key: 'tps', label: 'TPS', tip: 'Transactions Per Second — günlük ve saatlik commit/rollback dağılımı. Kapasite planlaması için kritik metrik.' },
        { key: 'activity', label: 'Activity', tip: 'pg_stat_activity — anlık aktif session\'lar. State, wait event ve çalışan sorguları gösterir.' },
        { key: 'replication', label: 'Replikasyon', tip: 'Primary node üzerinden streaming replica durumu, sync state ve replay lag bilgileri.' },
        { key: 'functions', label: 'Functions', tip: 'pg_stat_user_functions — kullanıcı fonksiyonları. track_functions=all olmalı. Calls, total_time, self_time gösterir.' },
        { key: 'sequences', label: 'Sequences', tip: 'pg_statio_all_sequences — sequence I/O. Cache hit ratio düşükse shared_buffers yetersiz olabilir.' },
        { key: 'wal', label: 'WAL/Archive', tip: 'WAL üretimi ve archiver durumu. WAL bytes yüksekse checkpoint_completion_target ayarını kontrol edin. Failed archive varsa archive_command\'ı inceleyin.' },
        { key: 'slru', label: 'SLRU', tip: 'Simple LRU cache istatistikleri (PG13+). CommitTs, MultiXact, Notify, Serial, Subtrans, Xact cache\'leri. Hit ratio düşükse performans etkilenebilir.' },
        { key: 'settings_diff', label: 'Yapılandırma Değişiklikleri', tip: 'pg_settings_snapshot tablosundan ardışık snapshot\'lar arasında değişen postgresql.conf parametreleri. shared_buffers, work_mem gibi önemli parametreler vurgulanır.' },
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

            <BootstrapBanner inst={inst} cap={cap} instanceId={id!} />

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
            {tab === 'statements' && <StatementsTab instancePk={Number(id)} />}
            {tab === 'databases' && <DatabasesTab data={databases.data} loading={databases.isLoading} instanceId={id!} onSelectDb={(dbid) => { setSelectedDbid(dbid); setTab('tables'); }} />}
            {tab === 'tables' && <TableStatsTab instancePk={Number(id)} selectedDbid={selectedDbid} onSelectDb={setSelectedDbid} />}
            {tab === 'indexes' && <IndexStatsTab instancePk={Number(id)} selectedDbid={selectedDbid} onSelectDb={setSelectedDbid} />}
            {tab === 'activity' && <ActivityTab instancePk={Number(id)} />}
            {tab === 'replication' && <ReplicationTab instancePk={Number(id)} isPrimary={cap?.is_primary ?? inst.is_primary} />}
            {tab === 'functions' && <FunctionsTab data={functions.data} loading={functions.isLoading} />}
            {tab === 'sequences' && <SequencesTab data={sequences.data} loading={sequences.isLoading} />}
            {tab === 'wal' && <WalArchiveTab data={walData.data} loading={walData.isLoading} />}
            {tab === 'slru' && <SlruTab data={slruData.data} loading={slruData.isLoading} />}
            {tab === 'tps' && <TpsTab data={tpsData.data} loading={tpsData.isLoading} />}
            {tab === 'settings_diff' && <SettingsDiffTab data={settingsDiff.data} loading={settingsDiff.isLoading} days={settingsDiffDays} onDaysChange={setSettingsDiffDays} />}
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

function fmtMs(ms: number): string {
    if (!Number.isFinite(ms)) return '-';
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}dk`;
    if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`;
    return `${ms.toFixed(1)}ms`;
}

function fmtNum(n: number): string {
    if (!Number.isFinite(n)) return '-';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
}

function StatementsTab({ instancePk }: { instancePk: number }) {
    const navigate = useNavigate();
    const [hours, setHours] = useState(24);
    const [orderBy, setOrderBy] = useState('exec_time');
    const [datname, setDatname] = useState('');
    const [rolname, setRolname] = useState('');
    const [sqlSearch, setSqlSearch] = useState('');
    const [minAvgMs, setMinAvgMs] = useState('');

    const qp = new URLSearchParams({
        hours: String(hours),
        limit: '100',
        order_by: orderBy,
        ...(datname ? { datname } : {}),
        ...(rolname ? { rolname } : {}),
    });

    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-top-stmts', instancePk, hours, orderBy, datname, rolname],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/statements?${qp}`),
        enabled: Number.isFinite(instancePk),
    });

    const datnames = useMemo(() => {
        const s = new Set((data ?? []).map((r: any) => r.datname).filter(Boolean));
        return Array.from(s).sort() as string[];
    }, [data]);

    const rolnames = useMemo(() => {
        const s = new Set((data ?? []).map((r: any) => r.rolname).filter(Boolean));
        return Array.from(s).sort() as string[];
    }, [data]);

    const filtered = useMemo(() => {
        const minMs = parseFloat(minAvgMs) || 0;
        const q = sqlSearch.trim().toLowerCase();
        return (data ?? []).filter((r: any) => {
            if (q && !(r.query_text ?? '').toLowerCase().includes(q)) return false;
            if (minMs > 0 && Number(r.avg_exec_time_ms) < minMs) return false;
            return true;
        });
    }, [data, sqlSearch, minAvgMs]);

    const hasFilter = datname || rolname || sqlSearch || minAvgMs;

    if (isLoading) return <SkeletonTable rows={5} cols={6} />;

    return (
        <div>
            <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                <div className="flex flex-wrap gap-3 items-end">
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Zaman</label>
                        <select value={hours} onChange={e => setHours(Number(e.target.value))}
                            className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white">
                            <option value={1}>Son 1 saat</option>
                            <option value={6}>Son 6 saat</option>
                            <option value={24}>Son 24 saat</option>
                            <option value={72}>Son 3 gün</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Sıralama</label>
                        <select value={orderBy} onChange={e => setOrderBy(e.target.value)}
                            className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white">
                            <option value="exec_time">Toplam Süre</option>
                            <option value="avg_time">Ort. Süre</option>
                            <option value="calls">Çağrı Sayısı</option>
                            <option value="rows">Satır Sayısı</option>
                            <option value="blks_read">Blok Okuma</option>
                            <option value="temp_blks">Temp Blok</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Database</label>
                        <select value={datname} onChange={e => setDatname(e.target.value)}
                            className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[130px]">
                            <option value="">Tümü</option>
                            {datnames.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Rol</label>
                        <select value={rolname} onChange={e => setRolname(e.target.value)}
                            className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[110px]">
                            <option value="">Tümü</option>
                            {rolnames.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                    </div>
                    <div className="flex-1 min-w-[160px]">
                        <label className="block text-xs text-[#64748B] mb-1">SQL Ara</label>
                        <input type="text" placeholder="SELECT, update..." value={sqlSearch}
                            onChange={e => setSqlSearch(e.target.value)}
                            className="w-full border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]" />
                    </div>
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Min Ort. (ms)</label>
                        <input type="number" placeholder="0" value={minAvgMs} min={0}
                            onChange={e => setMinAvgMs(e.target.value)}
                            className="w-24 border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]" />
                    </div>
                    <div className="flex items-end gap-2 pb-0.5">
                        {hasFilter && (
                            <button onClick={() => { setDatname(''); setRolname(''); setSqlSearch(''); setMinAvgMs(''); }}
                                className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                                Temizle
                            </button>
                        )}
                        <button onClick={() => refetch()}
                            className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                            {isFetching ? 'Yenileniyor...' : 'Yenile'}
                        </button>
                        <span className="text-xs text-[#94A3B8]">
                            {hasFilter && filtered.length !== (data?.length ?? 0)
                                ? `${filtered.length} / ${data?.length ?? 0}`
                                : `${filtered.length} sorgu`}
                        </span>
                    </div>
                </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {filtered.length === 0 ? (
                    <EmptyState icon="📝" title="Sorgu kaydı yok" description={data?.length === 0 ? "Bu aralıkta statement verisi yok." : "Filtreyle eşleşen sorgu bulunamadı."} />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                    <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">DB / Rol</th>
                                    <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">SQL</th>
                                    <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Calls</th>
                                    <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Toplam</th>
                                    <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Ort.</th>
                                    <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Rows</th>
                                    <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Blks R</th>
                                    <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Temp</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((r: any, i: number) => {
                                    const avgMs = Number(r.avg_exec_time_ms);
                                    const avgColor = avgMs >= 1000 ? 'text-red-600 font-semibold'
                                        : avgMs >= 100 ? 'text-amber-600 font-semibold' : 'text-[#64748B]';
                                    const canOpen = Boolean(r.statement_series_id);
                                    return (
                                        <tr key={r.statement_series_id ?? i}
                                            onClick={() => canOpen && navigate(`/statements/${r.statement_series_id}`)}
                                            className={`border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors ${canOpen ? 'cursor-pointer' : ''}`}>
                                            <td className="py-2.5 px-3 text-xs">
                                                <div className="text-[#1E293B]">{r.datname ?? '-'}</div>
                                                <div className="text-[#94A3B8]">{r.rolname ?? '-'}</div>
                                            </td>
                                            <td className="py-2.5 px-3 max-w-xs">
                                                <div className="truncate text-xs font-mono text-[#1E293B]" title={r.query_text}>
                                                    {r.query_text || <span className="text-[#94A3B8] italic not-italic">metin yok</span>}
                                                </div>
                                            </td>
                                            <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">{fmtNum(Number(r.total_calls))}</td>
                                            <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">{fmtMs(Number(r.total_exec_time_ms))}</td>
                                            <td className={`py-2.5 px-3 text-right font-mono text-xs ${avgColor}`}>{fmtMs(avgMs)}</td>
                                            <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">{fmtNum(Number(r.total_rows))}</td>
                                            <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">{fmtNum(Number(r.total_shared_blks_read))}</td>
                                            <td className="py-2.5 px-3 text-right font-mono text-xs">
                                                {Number(r.total_temp_blks_written) > 0
                                                    ? <span className="text-amber-600 font-semibold">{fmtNum(Number(r.total_temp_blks_written))}</span>
                                                    : <span className="text-[#94A3B8]">0</span>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

function DatabasesTab({ data, loading, onSelectDb }: { data: any[] | undefined; loading: boolean; instanceId?: string; onSelectDb?: (dbid: number) => void }) {
    if (loading) return <SkeletonTable rows={5} cols={4} />;
    return (
        <div className="bg-white rounded-lg shadow-sm p-4">
            <DataTable columns={[
                { key: 'datname', header: 'Database' },
                { key: 'dbid', header: 'OID' },
                { key: 'last_db_objects_collect_at', header: 'Son Toplama', render: (r: any) => <TimeAgo date={r.last_db_objects_collect_at} /> },
                { key: 'next_db_objects_collect_at', header: 'Sonraki', render: (r: any) => <TimeAgo date={r.next_db_objects_collect_at} /> },
                { key: 'consecutive_failures', header: 'Hatalar', render: (r: any) => (r.consecutive_failures || 0) > 0 ? <span className="text-red-600">{r.consecutive_failures}</span> : <span className="text-green-600">0</span> },
            ]} data={data || []} onRowClick={onSelectDb ? (r: any) => onSelectDb(r.dbid) : undefined} />
        </div>
    );
}

function ObjectDatabaseSelect({ instancePk, selectedDbid, onSelectDb, hint }: { instancePk: number; selectedDbid: number | null; onSelectDb: (dbid: number | null) => void; hint: string }) {
    const dbs = useQuery({
        queryKey: ['instance-dbs-for-objects', instancePk],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/databases`),
        enabled: Number.isFinite(instancePk),
    });

    return (
        <>
            <div className="mb-4">
                <label className="block text-xs text-[#64748B] mb-1">Database Seçin</label>
                <select value={selectedDbid ?? ''} onChange={(e) => onSelectDb(parseInt(e.target.value) || null)}
                    className="border border-[#E2E8F0] rounded px-3 py-2 text-sm bg-white min-w-[200px]" aria-label="Database seçimi">
                    <option value="">Seçiniz...</option>
                    {(dbs.data || []).map((d: any) => <option key={d.dbid} value={d.dbid}>{d.datname}</option>)}
                </select>
                {dbs.isLoading && <span className="ml-2 text-xs text-[#94A3B8]">Database listesi yükleniyor...</span>}
            </div>

            {!selectedDbid && <div className="text-[#94A3B8] py-4 text-center">{hint}</div>}
        </>
    );
}

function statNumber(value: any): number {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
}

function hitRatio(read: any, hit: any): number {
    const r = statNumber(read);
    const h = statNumber(hit);
    return r + h > 0 ? (100 * h) / (r + h) : 100;
}

function TableStatsTab({ instancePk, selectedDbid, onSelectDb }: { instancePk: number; selectedDbid: number | null; onSelectDb: (dbid: number | null) => void }) {
    const [hours, setHours] = useState(24);
    const [orderBy, setOrderBy] = useState('seq_scan');
    const [search, setSearch] = useState('');
    const [minValue, setMinValue] = useState('');

    const tables = useQuery({
        queryKey: ['instance-tables', instancePk, selectedDbid, hours],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/databases/${selectedDbid}/tables?hours=${hours}`),
        enabled: Number.isFinite(instancePk) && !!selectedDbid,
    });

    const metricValue = (r: any) => {
        if (orderBy === 'idx_scan') return statNumber(r.total_idx_scan);
        if (orderBy === 'writes') return statNumber(r.total_inserts) + statNumber(r.total_updates) + statNumber(r.total_deletes);
        if (orderBy === 'dead_tup') return statNumber(r.n_dead_tup);
        if (orderBy === 'heap_read') return statNumber(r.total_heap_blks_read);
        return statNumber(r.total_seq_scan);
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        const min = parseFloat(minValue) || 0;
        return (tables.data || [])
            .filter((r: any) => {
                if (q && !`${r.schemaname || ''}.${r.relname || ''}`.toLowerCase().includes(q)) return false;
                if (min > 0 && metricValue(r) < min) return false;
                return true;
            })
            .sort((a: any, b: any) => metricValue(b) - metricValue(a));
    }, [tables.data, search, minValue, orderBy]);

    const hasFilter = search || minValue;

    return (
        <div>
            <ObjectDatabaseSelect
                instancePk={instancePk}
                selectedDbid={selectedDbid}
                onSelectDb={onSelectDb}
                hint="Tablo istatistiklerini görmek için bir database seçin. Databases sekmesinde satıra tıklayarak da bu sekmeye gelebilirsiniz."
            />

            {selectedDbid && (
                <>
                    <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                        <div className="flex flex-wrap gap-3 items-end">
                            <div>
                                <label className="block text-xs text-[#64748B] mb-1">Zaman</label>
                                <select value={hours} onChange={e => setHours(Number(e.target.value))}
                                    className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white">
                                    <option value={1}>Son 1 saat</option>
                                    <option value={6}>Son 6 saat</option>
                                    <option value={24}>Son 24 saat</option>
                                    <option value={72}>Son 3 gün</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs text-[#64748B] mb-1">Sıralama</label>
                                <select value={orderBy} onChange={e => setOrderBy(e.target.value)}
                                    className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white">
                                    <option value="seq_scan">Seq Scan</option>
                                    <option value="idx_scan">Idx Scan</option>
                                    <option value="writes">Write Toplamı</option>
                                    <option value="dead_tup">Dead Tuple</option>
                                    <option value="heap_read">Heap Read</option>
                                </select>
                            </div>
                            <div className="flex-1 min-w-[180px]">
                                <label className="block text-xs text-[#64748B] mb-1">Tablo Ara</label>
                                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="schema veya tablo"
                                    className="w-full border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]" />
                            </div>
                            <div>
                                <label className="block text-xs text-[#64748B] mb-1">Min Değer</label>
                                <input type="number" min={0} value={minValue} onChange={e => setMinValue(e.target.value)}
                                    className="w-24 border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]" />
                            </div>
                            <div className="flex items-end gap-2 pb-0.5">
                                {hasFilter && (
                                    <button onClick={() => { setSearch(''); setMinValue(''); }}
                                        className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                                        Temizle
                                    </button>
                                )}
                                <button onClick={() => tables.refetch()}
                                    className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                                    {tables.isFetching ? 'Yenileniyor...' : 'Yenile'}
                                </button>
                                <span className="text-xs text-[#94A3B8]">
                                    {hasFilter && filtered.length !== (tables.data?.length ?? 0)
                                        ? `${filtered.length} / ${tables.data?.length ?? 0}`
                                        : `${filtered.length} tablo`}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                        {tables.isLoading ? <SkeletonTable rows={5} cols={6} /> : filtered.length === 0 ? (
                            <div className="text-[#94A3B8] py-8 text-center text-sm">Tablo istatistiği yok veya filtreyle eşleşen tablo bulunamadı.</div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                            <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Schema / Tablo</th>
                                            <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Seq Scan</th>
                                            <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Idx Scan</th>
                                            <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Write</th>
                                            <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Heap I/O</th>
                                            <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Tuple</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filtered.map((r: any) => {
                                            const writes = statNumber(r.total_inserts) + statNumber(r.total_updates) + statNumber(r.total_deletes);
                                            const ratio = hitRatio(r.total_heap_blks_read, r.total_heap_blks_hit);
                                            const dead = statNumber(r.n_dead_tup);
                                            return (
                                                <tr key={r.relid} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors">
                                                    <td className="py-2.5 px-3 text-xs">
                                                        <div className="text-[#94A3B8]">{r.schemaname || '-'}</div>
                                                        <div className="font-medium text-[#1E293B]">{r.relname || '-'}</div>
                                                    </td>
                                                    <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">{fmtNum(statNumber(r.total_seq_scan))}</td>
                                                    <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">{fmtNum(statNumber(r.total_idx_scan))}</td>
                                                    <td className="py-2.5 px-3 text-right font-mono text-xs">
                                                        <div className={writes > 0 ? 'text-[#1E293B]' : 'text-[#94A3B8]'}>{fmtNum(writes)}</div>
                                                        <div className="text-[10px] text-[#94A3B8]">I {fmtNum(statNumber(r.total_inserts))} / U {fmtNum(statNumber(r.total_updates))} / D {fmtNum(statNumber(r.total_deletes))}</div>
                                                    </td>
                                                    <td className="py-2.5 px-3 text-right font-mono text-xs">
                                                        <div>{fmtNum(statNumber(r.total_heap_blks_read))} R / {fmtNum(statNumber(r.total_heap_blks_hit))} H</div>
                                                        <div className={ratio < 95 ? 'text-amber-600' : 'text-green-600'}>{ratio.toFixed(1)}%</div>
                                                    </td>
                                                    <td className="py-2.5 px-3 text-right font-mono text-xs">
                                                        <div>Live {fmtNum(statNumber(r.n_live_tup))}</div>
                                                        <div className={dead > 0 ? 'text-red-600 font-semibold' : 'text-[#94A3B8]'}>Dead {fmtNum(dead)}</div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

function IndexStatsTab({ instancePk, selectedDbid, onSelectDb }: { instancePk: number; selectedDbid: number | null; onSelectDb: (dbid: number | null) => void }) {
    const [hours, setHours] = useState(24);
    const [orderBy, setOrderBy] = useState('idx_scan');
    const [search, setSearch] = useState('');
    const [minValue, setMinValue] = useState('');

    const indexes = useQuery({
        queryKey: ['instance-indexes', instancePk, selectedDbid, hours],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/databases/${selectedDbid}/indexes?hours=${hours}`),
        enabled: Number.isFinite(instancePk) && !!selectedDbid,
    });

    const metricValue = (r: any) => {
        if (orderBy === 'tup_read') return statNumber(r.total_idx_tup_read);
        if (orderBy === 'tup_fetch') return statNumber(r.total_idx_tup_fetch);
        if (orderBy === 'blks_read') return statNumber(r.total_idx_blks_read);
        if (orderBy === 'hit_ratio_low') return 100 - hitRatio(r.total_idx_blks_read, r.total_idx_blks_hit);
        return statNumber(r.total_idx_scan);
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        const min = parseFloat(minValue) || 0;
        return (indexes.data || [])
            .filter((r: any) => {
                if (q && !`${r.schemaname || ''}.${r.table_relname || ''}.${r.index_relname || ''}`.toLowerCase().includes(q)) return false;
                if (min > 0 && metricValue(r) < min) return false;
                return true;
            })
            .sort((a: any, b: any) => metricValue(b) - metricValue(a));
    }, [indexes.data, search, minValue, orderBy]);

    const hasFilter = search || minValue;

    return (
        <div>
            <ObjectDatabaseSelect
                instancePk={instancePk}
                selectedDbid={selectedDbid}
                onSelectDb={onSelectDb}
                hint="Index istatistiklerini görmek için bir database seçin. Databases sekmesinde satıra tıklayarak tablo sekmesine geçip aynı seçimi kullanabilirsiniz."
            />

            {selectedDbid && (
                <>
                    <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                        <div className="flex flex-wrap gap-3 items-end">
                            <div>
                                <label className="block text-xs text-[#64748B] mb-1">Zaman</label>
                                <select value={hours} onChange={e => setHours(Number(e.target.value))}
                                    className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white">
                                    <option value={1}>Son 1 saat</option>
                                    <option value={6}>Son 6 saat</option>
                                    <option value={24}>Son 24 saat</option>
                                    <option value={72}>Son 3 gün</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs text-[#64748B] mb-1">Sıralama</label>
                                <select value={orderBy} onChange={e => setOrderBy(e.target.value)}
                                    className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white">
                                    <option value="idx_scan">Idx Scan</option>
                                    <option value="tup_read">Tuple Read</option>
                                    <option value="tup_fetch">Tuple Fetch</option>
                                    <option value="blks_read">Block Read</option>
                                    <option value="hit_ratio_low">Düşük Hit Ratio</option>
                                </select>
                            </div>
                            <div className="flex-1 min-w-[180px]">
                                <label className="block text-xs text-[#64748B] mb-1">Index Ara</label>
                                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="schema, tablo veya index"
                                    className="w-full border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]" />
                            </div>
                            <div>
                                <label className="block text-xs text-[#64748B] mb-1">Min Değer</label>
                                <input type="number" min={0} value={minValue} onChange={e => setMinValue(e.target.value)}
                                    className="w-24 border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]" />
                            </div>
                            <div className="flex items-end gap-2 pb-0.5">
                                {hasFilter && (
                                    <button onClick={() => { setSearch(''); setMinValue(''); }}
                                        className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                                        Temizle
                                    </button>
                                )}
                                <button onClick={() => indexes.refetch()}
                                    className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                                    {indexes.isFetching ? 'Yenileniyor...' : 'Yenile'}
                                </button>
                                <span className="text-xs text-[#94A3B8]">
                                    {hasFilter && filtered.length !== (indexes.data?.length ?? 0)
                                        ? `${filtered.length} / ${indexes.data?.length ?? 0}`
                                        : `${filtered.length} index`}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                        {indexes.isLoading ? <SkeletonTable rows={5} cols={6} /> : filtered.length === 0 ? (
                            <div className="text-[#94A3B8] py-8 text-center text-sm">Index istatistiği yok veya filtreyle eşleşen index bulunamadı.</div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                            <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Schema / Tablo</th>
                                            <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Index</th>
                                            <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Idx Scan</th>
                                            <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Tuples</th>
                                            <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Blocks</th>
                                            <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Hit Ratio</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filtered.map((r: any) => {
                                            const ratio = hitRatio(r.total_idx_blks_read, r.total_idx_blks_hit);
                                            return (
                                                <tr key={r.index_relid} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors">
                                                    <td className="py-2.5 px-3 text-xs">
                                                        <div className="text-[#94A3B8]">{r.schemaname || '-'}</div>
                                                        <div className="font-medium text-[#1E293B]">{r.table_relname || '-'}</div>
                                                    </td>
                                                    <td className="py-2.5 px-3 max-w-xs">
                                                        <div className="truncate text-xs font-mono text-[#1E293B]" title={r.index_relname}>{r.index_relname || '-'}</div>
                                                    </td>
                                                    <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">{fmtNum(statNumber(r.total_idx_scan))}</td>
                                                    <td className="py-2.5 px-3 text-right font-mono text-xs">
                                                        <div>Read {fmtNum(statNumber(r.total_idx_tup_read))}</div>
                                                        <div className="text-[#94A3B8]">Fetch {fmtNum(statNumber(r.total_idx_tup_fetch))}</div>
                                                    </td>
                                                    <td className="py-2.5 px-3 text-right font-mono text-xs">
                                                        <div>{fmtNum(statNumber(r.total_idx_blks_read))} R</div>
                                                        <div className="text-[#94A3B8]">{fmtNum(statNumber(r.total_idx_blks_hit))} H</div>
                                                    </td>
                                                    <td className={`py-2.5 px-3 text-right font-mono text-xs ${ratio < 95 ? 'text-amber-600 font-semibold' : 'text-green-600'}`}>
                                                        {ratio.toFixed(1)}%
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </>
            )}
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
/**
 * Bootstrap sorunu banner'ı — degraded instance için açık alert'lerden
 * EXTENSION_MISSING / BOOTSTRAP_FAILED / SECRET_REF_ERROR / AUTHENTICATION_FAILURE
 * / PERMISSION_DENIED yakalar, mesajını + çözümünü görünür şekilde gösterir.
 */
function BootstrapBanner({ inst, cap, instanceId }: { inst: any; cap: any; instanceId: string }) {
    const alertsQ = useQuery({
        queryKey: ['inst-bootstrap-alerts', instanceId],
        queryFn: () => apiGet<any[]>(`/alerts?status=open&instance_pk=${instanceId}&limit=20`),
        enabled: inst?.bootstrap_state === 'degraded',
    });

    if (inst?.bootstrap_state !== 'degraded') return null;

    const bootstrapCodes = ['extension_missing', 'bootstrap_failed', 'secret_ref_error',
        'authentication_failure', 'permission_denied', 'connection_failure'];
    const issue = (alertsQ.data || []).find((a: any) => bootstrapCodes.includes(a.alert_code));

    // Alert yoksa generic uyarı (örn. capability flag'lere göre)
    const noPgss = cap && cap.has_pg_stat_statements === false;

    if (!issue && !noPgss) return null;

    return (
        <div className="mb-4 bg-amber-50 border-2 border-amber-300 rounded-lg p-4">
            <div className="flex items-start gap-3">
                <span className="text-2xl">⚠️</span>
                <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-amber-900">
                        {issue ? issue.title : 'pg_stat_statements extension yüklü değil'}
                    </h3>
                    {issue?.message && (
                        <pre className="mt-2 text-xs whitespace-pre-wrap text-amber-900 font-sans bg-white/50 rounded px-3 py-2">
                            {issue.message}
                        </pre>
                    )}
                    {!issue && noPgss && (
                        <div className="mt-2 text-sm text-amber-900 space-y-1">
                            <p>Bu instance <strong>degraded</strong> durumda — istatistik toplama yapılamıyor.</p>
                            <p className="font-semibold mt-2">Çözüm:</p>
                            <ol className="list-decimal ml-5 space-y-1">
                                <li>postgresql.conf'a ekle: <code className="bg-amber-100 px-1 rounded">shared_preload_libraries = 'pg_stat_statements'</code></li>
                                <li>PostgreSQL'i restart et</li>
                                <li>Veritabanına bağlan ve çalıştır: <code className="bg-amber-100 px-1 rounded">CREATE EXTENSION pg_stat_statements;</code></li>
                                <li>Instance'da "↺ Yeniden Dene" butonuna tıkla</li>
                            </ol>
                        </div>
                    )}
                    {issue && (
                        <Link to={`/alerts/${issue.alert_id}`}
                            className="inline-block mt-2 text-xs text-amber-700 hover:underline">
                            Tam alert detayına git →
                        </Link>
                    )}
                </div>
            </div>
        </div>
    );
}

function ClusterCard({ cluster, instanceId, onChange }: { cluster: any; instanceId: string; onChange: () => void }) {
    const [editing, setEditing] = useState(false);
    const [groupId, setGroupId] = useState('');
    const [mode, setMode] = useState<'existing' | 'custom' | 'remove'>('existing');

    // Mevcut kümeleri çek (sadece editing modunda)
    const clustersList = useQuery({
        queryKey: ['all-clusters'],
        queryFn: () => apiGet<any[]>('/clusters'),
        enabled: editing,
    });

    if (!cluster) return null;

    const kind = cluster.cluster_kind || 'standalone';
    const kindLabel: Record<string, { text: string; cls: string }> = {
        manual: { text: '📌 MANUEL', cls: 'bg-purple-100 text-purple-700 border-purple-200' },
        orphan_clone: { text: '⚠ KLON/PROMOTE', cls: 'bg-amber-100 text-amber-700 border-amber-300' },
        auto: { text: '🔗 OTOMATİK', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
        standalone: { text: '○ STANDALONE', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
    };

    const save = async () => {
        const value = mode === 'remove' ? null : (groupId.trim() || null);
        try {
            await apiPatch(`/instances/${instanceId}/manual-cluster`, {
                manual_cluster_group_id: value,
            });
            setEditing(false);
            onChange();
        } catch (e: any) {
            alert('Kaydetme başarısız: ' + (e?.message || 'bilinmeyen hata'));
        }
    };

    return (
        <div className="mb-4 bg-white border border-[#E2E8F0] rounded-lg p-3 text-sm">
            <div className="flex items-center gap-3 flex-wrap">
                <span className={`px-2 py-1 rounded text-xs font-bold border ${kindLabel[kind].cls}`}>
                    {kindLabel[kind].text}
                </span>
                {cluster.role !== 'standalone' && (
                    <>
                        <span className={`px-2 py-1 rounded text-xs font-bold ${cluster.role === 'primary' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
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
                <div className="mt-3 p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded space-y-2">
                    {/* Mod seçici */}
                    <div className="flex gap-1">
                        {[
                            { k: 'existing' as const, label: 'Mevcut kümeye katıl' },
                            { k: 'custom' as const, label: 'Yeni grup oluştur' },
                            { k: 'remove' as const, label: 'Manuel grubu kaldır' },
                        ].map(opt => (
                            <button key={opt.k} onClick={() => { setMode(opt.k); setGroupId(''); }}
                                className={`px-2 py-1 text-[11px] rounded ${mode === opt.k
                                    ? 'bg-[#3B82F6] text-white'
                                    : 'bg-white text-[#475569] border border-[#E2E8F0]'
                                    }`}>
                                {opt.label}
                            </button>
                        ))}
                    </div>

                    {mode === 'existing' && (
                        <select value={groupId} onChange={e => setGroupId(e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded px-2 py-1.5 text-xs">
                            <option value="">— Küme seç —</option>
                            {(clustersList.data || [])
                                .filter((c: any) => c.cluster_id !== cluster.cluster_id)
                                .map((c: any) => (
                                    <option key={c.cluster_id} value={c.cluster_id}>
                                        {c.label} ({c.total_instances} instance · {c.cluster_kind})
                                    </option>
                                ))}
                        </select>
                    )}

                    {mode === 'custom' && (
                        <input type="text" value={groupId} onChange={e => setGroupId(e.target.value)}
                            placeholder="Örn: prod-main, etl-cluster (max 50 karakter)"
                            maxLength={50}
                            className="w-full border border-[#CBD5E1] rounded px-2 py-1.5 text-xs" />
                    )}

                    {mode === 'remove' && (
                        <p className="text-[11px] text-[#64748B]">
                            Manuel grup kaldırılacak — instance otomatik tespit (system_identifier)
                            ile sınıflandırılacak.
                        </p>
                    )}

                    <div className="flex gap-2 justify-end">
                        <button onClick={() => setEditing(false)}
                            className="px-3 py-1 text-xs text-[#64748B]">
                            İptal
                        </button>
                        <button onClick={save}
                            disabled={mode !== 'remove' && !groupId.trim()}
                            className="px-3 py-1 bg-[#3B82F6] text-white text-xs rounded hover:bg-[#2563EB] disabled:opacity-50">
                            Kaydet
                        </button>
                    </div>

                    <p className="text-[10px] text-[#94A3B8]">
                        💡 İpucu: aynı grubu paylaşan instance'lar tek kümede görünür. Mevcut bir kümenin
                        cluster_id'sini seçerek bu instance'ı oraya ekleyebilirsin.
                    </p>
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
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold flex-shrink-0 ${dimmed
                ? 'bg-[#F1F5F9] text-[#64748B] border border-dashed border-[#94A3B8]'
                : 'bg-[#0F172A] text-white'
                }`} title={dimmed ? '90 gün ortalaması' : 'Son 24 saat'}>
                {dimmed ? '90G' : '24S'}
            </span>
            <div
                className={`flex flex-1 h-5 overflow-hidden border ${dimmed ? 'border-dashed border-[#64748B] rounded-sm' : 'border-[#1E293B] rounded'
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
            <div className="mb-5 border border-[#E2E8F0] rounded-lg p-4">
                <Skeleton width="40%" height="0.875rem" />
                <div className="mt-2 grid grid-cols-3 gap-2">
                    <Skeleton height="1.5rem" />
                    <Skeleton height="1.5rem" />
                    <Skeleton height="1.5rem" />
                </div>
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
    if (loading) return <SkeletonTable rows={5} cols={5} />;
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

function ActivityTab({ instancePk }: { instancePk: number }) {
    const [view, setView] = useState<'summary' | 'detail'>('summary');
    const [filter, setFilter] = useState('all');
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-activity', instancePk],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/activity`),
        enabled: Number.isFinite(instancePk),
    });

    const snapshotDate = data?.[0]?.snapshot_ts ? new Date(data[0].snapshot_ts) : null;
    const snapshotAgo = snapshotDate
        ? Math.round((Date.now() - snapshotDate.getTime()) / 1000)
        : null;

    const clientSessions = (data || []).filter((r: any) => r.backend_type === 'client backend');
    const hotWindowMs = 1000;
    const isJustBecameIdle = (r: any) => {
        if (r.state !== 'idle' || !r.state_change || !snapshotDate) return false;
        const stateChangeMs = new Date(r.state_change).getTime();
        return (snapshotDate.getTime() - stateChangeMs) <= hotWindowMs;
    };

    const summaryMap = new Map<string, {
        datname: string; client_addr: string; usename: string;
        open: number; active_now: number; idle_in_trans_now: number;
        idle_now: number; just_became_idle: number;
    }>();
    for (const r of clientSessions) {
        const key = `${r.datname || ''}|${r.client_addr || ''}|${r.usename || ''}`;
        let row = summaryMap.get(key);
        if (!row) {
            row = {
                datname: r.datname || '-', client_addr: r.client_addr || '-', usename: r.usename || '-',
                open: 0, active_now: 0, idle_in_trans_now: 0, idle_now: 0, just_became_idle: 0
            };
            summaryMap.set(key, row);
        }
        row.open++;
        if (r.state === 'active') row.active_now++;
        else if (r.state === 'idle in transaction') row.idle_in_trans_now++;
        else if (r.state === 'idle') {
            if (isJustBecameIdle(r)) row.just_became_idle++;
            else row.idle_now++;
        }
    }
    const summaryRows = [...summaryMap.values()].sort((a, b) => b.active_now - a.active_now || b.open - a.open);
    const totals = summaryRows.reduce((t, r) => ({
        open: t.open + r.open, active_now: t.active_now + r.active_now,
        idle_in_trans_now: t.idle_in_trans_now + r.idle_in_trans_now,
        idle_now: t.idle_now + r.idle_now, just_became_idle: t.just_became_idle + r.just_became_idle,
    }), { open: 0, active_now: 0, idle_in_trans_now: 0, idle_now: 0, just_became_idle: 0 });

    const idleWaitTypes = new Set(['Activity', 'Client']);
    const detailFiltered = (data || []).filter((r: any) => {
        if (filter === 'client') return r.backend_type === 'client backend';
        if (filter === 'active') return r.state === 'active' || isJustBecameIdle(r);
        if (filter === 'idle') return r.state === 'idle' && !isJustBecameIdle(r);
        if (filter === 'idle_tx') return r.state === 'idle in transaction';
        if (filter === 'waiting') return r.wait_event_type && !idleWaitTypes.has(r.wait_event_type);
        return true;
    });
    const detailCounts = {
        all: (data || []).length,
        client: clientSessions.length,
        active: (data || []).filter((r: any) => r.state === 'active' || isJustBecameIdle(r)).length,
        idle: clientSessions.filter((r: any) => r.state === 'idle' && !isJustBecameIdle(r)).length,
        idle_tx: (data || []).filter((r: any) => r.state === 'idle in transaction').length,
        waiting: (data || []).filter((r: any) => r.wait_event_type && !idleWaitTypes.has(r.wait_event_type)).length,
    };

    const detailColumns = [
        { key: 'pid', header: 'PID' },
        { key: 'datname', header: 'Database' },
        { key: 'usename', header: 'User' },
        { key: 'application_name', header: 'Uygulama' },
        {
            key: 'state', header: 'Durum', render: (r: any) => {
                const jbi = isJustBecameIdle(r);
                const color = r.state === 'active' ? 'text-green-600' : jbi ? 'text-green-500' : r.state === 'idle in transaction' ? 'text-yellow-600' : r.state === 'idle' ? 'text-[#94A3B8]' : 'text-[#CBD5E1]';
                const label = jbi ? 'idle (aktifti)' : r.state || '-';
                return <span className={`font-medium ${color}`}>{label}</span>;
            }
        },
        { key: 'wait_event_type', header: 'Wait', render: (r: any) => r.wait_event_type ? `${r.wait_event_type}/${r.wait_event}` : '-' },
        { key: 'query', header: 'Sorgu', render: (r: any) => <div className="max-w-xs truncate text-xs font-mono" title={r.query}>{r.query ? r.query.substring(0, 120) : '-'}</div> },
        { key: 'backend_type', header: 'Backend' },
    ];

    if (isLoading) return <SkeletonTable rows={5} cols={5} />;

    const summaryColumns = [
        { key: 'datname', header: 'Database' },
        { key: 'client_addr', header: 'Client' },
        { key: 'usename', header: 'User' },
        { key: 'open', header: 'Open', className: 'text-right' },
        { key: 'active_now', header: 'Active', render: (r: any) => <span className={r.active_now > 0 ? 'text-green-600 font-medium' : ''}>{r.active_now}</span>, className: 'text-right' },
        { key: 'idle_in_trans_now', header: 'Idle in TX', render: (r: any) => <span className={r.idle_in_trans_now > 0 ? 'text-yellow-600 font-medium' : ''}>{r.idle_in_trans_now}</span>, className: 'text-right' },
        { key: 'idle_now', header: 'Idle', className: 'text-right' },
        { key: 'just_became_idle', header: 'Just Idle', render: (r: any) => <span className={r.just_became_idle > 0 ? 'text-green-500' : ''} title="Snapshot anından <1s önce idle olmuş session">{r.just_became_idle}</span>, className: 'text-right' },
    ];

    return (
        <div>
            <div className="flex gap-1 mb-3 items-center">
                <button onClick={() => setView('summary')}
                    className={`px-3 py-1 text-xs rounded ${view === 'summary' ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0]'}`}>
                    Özet
                </button>
                <button onClick={() => setView('detail')}
                    className={`px-3 py-1 text-xs rounded ${view === 'detail' ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0]'}`}>
                    Detay
                </button>
                {snapshotDate && (
                    <span className="ml-auto text-xs text-[#64748B]">
                        Snapshot: {snapshotDate.toLocaleTimeString()}
                        <span className="text-[#94A3B8] ml-1">
                            ({snapshotAgo! < 60 ? `${snapshotAgo}s` : `${Math.floor(snapshotAgo! / 60)}dk`} önce)
                        </span>
                    </span>
                )}
                <button onClick={() => refetch()} disabled={isFetching}
                    className={`px-3 py-1 text-xs rounded border border-[#E2E8F0] hover:bg-[#F1F5F9] ${isFetching ? 'bg-[#F1F5F9] text-[#94A3B8]' : 'bg-white text-[#64748B]'}`}>
                    {isFetching ? 'Yenileniyor...' : 'Yenile'}
                </button>
            </div>

            {view === 'summary' && (
                <div className="bg-white rounded-lg shadow-sm p-4">
                    <DataTable columns={summaryColumns} data={summaryRows} emptyText="Client session yok" />
                    {summaryRows.length > 0 && (
                        <div className="border-t border-[#E2E8F0] mt-1 pt-2 flex gap-6 text-xs flex-wrap">
                            <span className="text-[#64748B] font-medium">TOPLAM</span>
                            <span>Open: <strong>{totals.open}</strong></span>
                            <span className={totals.active_now > 0 ? 'text-green-600' : ''}>Active: <strong>{totals.active_now}</strong></span>
                            <span className={totals.idle_in_trans_now > 0 ? 'text-yellow-600' : ''}>Idle in TX: <strong>{totals.idle_in_trans_now}</strong></span>
                            <span>Idle: <strong>{totals.idle_now}</strong></span>
                            <span className={totals.just_became_idle > 0 ? 'text-green-500' : ''}>Just Idle: <strong>{totals.just_became_idle}</strong></span>
                        </div>
                    )}
                    <p className="text-[10px] text-[#94A3B8] mt-2">
                        Just Idle = snapshot anından &lt;1s önce idle olmuş session. Sadece client backend session'ları gösterilir.
                    </p>
                </div>
            )}

            {view === 'detail' && (
                <div>
                    <div className="flex gap-1 mb-3 flex-wrap">
                        {([
                            { k: 'all', l: 'Tümü' },
                            { k: 'client', l: 'Client' },
                            { k: 'active', l: 'Active + Just Idle' },
                            { k: 'idle', l: 'Idle' },
                            { k: 'idle_tx', l: 'Idle in TX' },
                            { k: 'waiting', l: 'Bekleyen' },
                        ] as { k: keyof typeof detailCounts; l: string }[]).map((f) => (
                            <button key={f.k} onClick={() => setFilter(f.k)}
                                className={`px-3 py-1 text-xs rounded ${filter === f.k ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0]'}`}>
                                {f.l} ({detailCounts[f.k]})
                            </button>
                        ))}
                    </div>
                    <div className="bg-white rounded-lg shadow-sm p-4">
                        <DataTable columns={detailColumns} data={detailFiltered} emptyText="Bu filtrede session yok" />
                    </div>
                </div>
            )}
        </div>
    );
}

function ReplicationTab({ instancePk, isPrimary }: { instancePk: number; isPrimary: boolean | null | undefined }) {
    const { data, isLoading } = useQuery({
        queryKey: ['instance-replication', instancePk],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/replication`),
        enabled: Number.isFinite(instancePk) && isPrimary === true,
    });

    if (isPrimary !== true) {
        return <div className="text-[#94A3B8] py-8 text-center">Bu node primary değil. Replikasyon bilgisi yalnızca primary node'larda gösterilir.</div>;
    }

    if (isLoading) return <SkeletonTable rows={5} cols={5} />;

    const formatBytes = (b: number) => {
        if (b > 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
        if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
        if (b > 1024) return (b / 1024).toFixed(1) + ' KB';
        return b + ' B';
    };

    const columns = [
        { key: 'application_name', header: 'Replica' },
        { key: 'client_addr', header: 'Adres' },
        { key: 'state', header: 'Durum', render: (r: any) => <Badge value={r.state || 'unknown'} /> },
        { key: 'sync_state', header: 'Sync' },
        { key: 'replay_lag', header: 'Replay Lag' },
        {
            key: 'replay_lag_bytes', header: 'Lag (byte)', render: (r: any) => {
                const bytes = Number(r.replay_lag_bytes);
                const cls = bytes > 1073741824 ? 'text-red-600 font-medium' : bytes > 314572800 ? 'text-yellow-600' : '';
                return <span className={cls}>{formatBytes(bytes)}</span>;
            }
        },
        { key: 'flush_lag', header: 'Flush Lag' },
    ];

    return (
        <div className="bg-white rounded-lg shadow-sm p-4">
            <DataTable columns={columns} data={data || []} emptyText="Replica bağlantısı yok" />
        </div>
    );
}

function AlertsTab({ data, loading }: { data: any[] | undefined; loading: boolean }) {
    const queryClient = useQueryClient();
    const ackMutation = useMutation({
        mutationFn: (id: number) => apiPatch(`/alerts/${id}/acknowledge`),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inst-alerts'] }),
    });

    if (loading) return <SkeletonTable rows={5} cols={5} />;
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
    if (loading) return <SkeletonTable rows={5} cols={5} />;
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
    if (loading) return <SkeletonTable rows={5} cols={5} />;
    const columns = [
        { key: 'datname', header: 'Database' },
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
    if (loading) return <SkeletonTable rows={5} cols={5} />;
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
    if (loading) return <SkeletonTable rows={5} cols={5} />;
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
    if (loading) return <SkeletonTable rows={5} cols={5} />;
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
    if (loading) return <SkeletonTable rows={5} cols={5} />;
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


// =========================================================================
// Yapılandırma Değişiklikleri Tab — pg_settings snapshot diff
// =========================================================================

interface SettingChange {
    setting_name: string;
    prev_value: string;
    new_value: string;
    prev_ts: string;
    changed_at: string;
    unit: string | null;
    is_important: boolean;
}

interface SettingsDiffData {
    instance_pk: number;
    period_days: number;
    total_changes: number;
    changes: SettingChange[];
}

function SettingsDiffTab({ data, loading, days, onDaysChange }: {
    data: SettingsDiffData | undefined;
    loading: boolean;
    days: number;
    onDaysChange: (d: number) => void;
}) {
    const [importantOnly, setImportantOnly] = useState(false);

    const filtered = data?.changes.filter(c => !importantOnly || c.is_important) || [];

    return (
        <div>
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <div className="flex items-center gap-3">
                    <select value={days} onChange={e => onDaysChange(Number(e.target.value))}
                        className="border border-[#CBD5E1] rounded px-3 py-1.5 text-sm">
                        <option value={7}>Son 7 gün</option>
                        <option value={30}>Son 30 gün</option>
                        <option value={90}>Son 90 gün</option>
                    </select>
                    <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={importantOnly}
                            onChange={e => setImportantOnly(e.target.checked)}
                            className="accent-[#3B82F6]" />
                        <span>Sadece önemli parametreler</span>
                    </label>
                </div>
                {data && (
                    <div className="text-sm text-[#64748B]">
                        Toplam değişiklik: <span className="font-mono font-semibold text-[#1E293B]">{filtered.length}</span>
                        {data.total_changes !== filtered.length && (
                            <span className="text-[#94A3B8]"> (filtrelenmemiş: {data.total_changes})</span>
                        )}
                    </div>
                )}
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4">
                {loading ? (
                    <SkeletonTable rows={5} cols={4} />
                ) : filtered.length === 0 ? (
                    <EmptyState icon="✅" title="Yapılandırma değişikliği yok" description="Bu dönemde postgresql.conf parametrelerinde değişiklik tespit edilmedi." />
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-[#E2E8F0] text-[#64748B] text-xs uppercase">
                                <th className="text-left py-2 px-2">Parametre</th>
                                <th className="text-left py-2 px-2">Önceki Değer</th>
                                <th className="text-left py-2 px-2">Yeni Değer</th>
                                <th className="text-right py-2 px-2">Değişim Zamanı</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((c, i) => (
                                <tr key={i} className={`border-b border-[#F1F5F9] hover:bg-[#F8FAFC] ${c.is_important ? 'bg-amber-50/30' : ''}`}>
                                    <td className="py-2 px-2 font-mono text-xs">
                                        {c.is_important && <span title="Önemli parametre" className="mr-1">⭐</span>}
                                        <span className="font-semibold">{c.setting_name}</span>
                                        {c.unit && <span className="text-[#94A3B8] ml-1">({c.unit})</span>}
                                    </td>
                                    <td className="py-2 px-2 font-mono text-xs text-red-700">
                                        <span className="bg-red-50 px-1.5 py-0.5 rounded">{c.prev_value}</span>
                                    </td>
                                    <td className="py-2 px-2 font-mono text-xs text-green-700">
                                        <span className="bg-green-50 px-1.5 py-0.5 rounded">{c.new_value}</span>
                                    </td>
                                    <td className="py-2 px-2 text-right text-xs text-[#64748B] font-mono whitespace-nowrap">
                                        {new Date(c.changed_at).toLocaleString('tr-TR')}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            <div className="mt-3 text-xs text-[#94A3B8]">
                ⭐ ile işaretli parametreler tuning veya restart gerektiren önemli ayarlardır.
                Snapshot'lar geceleri alındığı için değişim zamanı snapshot zamanını gösterir, gerçek değişim daha önce olabilir.
            </div>
        </div>
    );
}
