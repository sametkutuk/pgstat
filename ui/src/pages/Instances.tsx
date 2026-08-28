import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { apiGet, apiPost, apiPut, apiPatch, getToken } from '../api/client';
import DataTable from '../components/common/DataTable';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import LastUpdated from '../components/common/LastUpdated';
import PrintButton from '../components/common/PrintButton';
import EmptyState from '../components/common/EmptyState';
import Skeleton, { SkeletonTable } from '../components/common/Skeleton';
import InfoTip from '../components/common/InfoTip';
import InstanceForm from '../components/forms/InstanceForm';
import type { InstanceFormData } from '../components/forms/InstanceForm';
import { useToast } from '../components/common/Toast';
import { useMemo, useState } from 'react';

interface Instance {
    instance_pk: number; instance_id: string; display_name: string;
    environment: string | null; service_group: string | null;
    host: string; port: number; is_active: boolean; bootstrap_state: string;
    pg_major: number | null; is_primary: boolean | null;
    last_cluster_collect_at: string | null; consecutive_failures: number;
    admin_dbname: string; secret_ref: string; ssl_mode: string;
    ssl_root_cert_path: string | null; collector_group: string | null;
    collector_username: string;
    schedule_profile_id: number; retention_policy_id: number; notes: string | null;
    // Retention politikasinin okunabilir hali — id yerine ad ve gun degeri
    retention_policy_code: string | null; retention_raw_days: number | null;
    retention_hourly_days: number | null; retention_daily_days: number | null;
    last_error: string | null; last_error_at: string | null;
}

interface StorageSummary {
    instance_pk: number;
    collector_rows: number | string;
    collector_bytes: number | string;
    collector_db_bytes: number | string;
}

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

/**
 * Instances Hub — 2 view modu:
 *   - liste (varsayılan): tek tek instance'lar, filtreli + aranabilir
 *   - kume: aynı system_identifier'a sahipler gruplanmış
 * URL: /instances?view=clusters ile küme view aktif olur (bookmark dostu)
 */
export default function Instances() {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const queryClient = useQueryClient();
    const toast = useToast();
    const [formMode, setFormMode] = useState<'closed' | 'add' | 'edit'>('closed');
    const [editInstance, setEditInstance] = useState<Instance | null>(null);
    const [reportMenuOpen, setReportMenuOpen] = useState(false);
    const [reportDownloading, setReportDownloading] = useState<'pdf' | 'xlsx' | null>(null);

    // View toggle: list veya clusters
    const view = searchParams.get('view') === 'clusters' ? 'clusters' : 'list';
    const setView = (v: 'list' | 'clusters') => {
        if (v === 'list') searchParams.delete('view');
        else searchParams.set('view', 'clusters');
        setSearchParams(searchParams, { replace: true });
    };

    // Filtreler — URL parametresi olarak da tutulabilir ama şimdilik state
    const [search, setSearch] = useState('');
    const [environmentFilter, setEnvironmentFilter] = useState('');
    const [serviceGroupFilter, setServiceGroupFilter] = useState('');
    const [roleFilter, setRoleFilter] = useState<'' | 'primary' | 'replica'>('');
    const [stateFilter, setStateFilter] = useState('');
    const [pgVersionFilter, setPgVersionFilter] = useState('');

    const { data, isLoading } = useQuery({
        queryKey: ['instances'],
        queryFn: () => apiGet<Instance[]>('/instances'),
    });
    const storage = useQuery({
        queryKey: ['instances-storage-summary'],
        queryFn: () => apiGet<StorageSummary[]>('/instances/storage-summary'),
    });
    const clusters = useQuery({
        queryKey: ['clusters'],
        queryFn: () => apiGet<Cluster[]>('/clusters'),
        enabled: view === 'clusters',
        refetchInterval: 60_000,
    });

    const storageMap = useMemo(() => {
        const map = new Map<number, StorageSummary>();
        (storage.data || []).forEach(s => map.set(Number(s.instance_pk), s));
        return map;
    }, [storage.data]);

    // Filtreleme için unique değerleri çıkar
    const filterOptions = useMemo(() => {
        const envs = new Set<string>();
        const groups = new Set<string>();
        const states = new Set<string>();
        const versions = new Set<number>();
        (data || []).forEach(i => {
            if (i.environment) envs.add(i.environment);
            if (i.service_group) groups.add(i.service_group);
            if (i.bootstrap_state) states.add(i.bootstrap_state);
            if (i.pg_major) versions.add(i.pg_major);
        });
        return {
            envs: Array.from(envs).sort(),
            groups: Array.from(groups).sort(),
            states: Array.from(states).sort(),
            versions: Array.from(versions).sort((a, b) => b - a),
        };
    }, [data]);

    // Filtrelenmiş data
    const filtered = useMemo(() => {
        if (!data) return [];
        const q = search.trim().toLowerCase();
        return data.filter(i => {
            if (q && !i.display_name.toLowerCase().includes(q)
                && !i.instance_id.toLowerCase().includes(q)
                && !i.host.toLowerCase().includes(q)) return false;
            if (environmentFilter && i.environment !== environmentFilter) return false;
            if (serviceGroupFilter && i.service_group !== serviceGroupFilter) return false;
            if (roleFilter === 'primary' && i.is_primary !== true) return false;
            if (roleFilter === 'replica' && i.is_primary !== false) return false;
            if (stateFilter && i.bootstrap_state !== stateFilter) return false;
            if (pgVersionFilter && String(i.pg_major) !== pgVersionFilter) return false;
            return true;
        });
    }, [data, search, environmentFilter, serviceGroupFilter, roleFilter, stateFilter, pgVersionFilter]);

    const hasActiveFilter = search || environmentFilter || serviceGroupFilter || roleFilter || stateFilter || pgVersionFilter;
    const clearFilters = () => {
        setSearch(''); setEnvironmentFilter(''); setServiceGroupFilter('');
        setRoleFilter(''); setStateFilter(''); setPgVersionFilter('');
    };

    const addMutation = useMutation({
        mutationFn: (d: InstanceFormData) => apiPost('/instances', d),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['instances'] }); setFormMode('closed'); toast.success('Instance eklendi.'); },
        onError: (e: Error) => toast.error('Eklenemedi: ' + e.message),
    });

    const editMutation = useMutation({
        mutationFn: ({ id, data }: { id: number; data: InstanceFormData }) => apiPut(`/instances/${id}`, data),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['instances'] }); setFormMode('closed'); toast.success('Instance güncellendi.'); },
        onError: (e: Error) => toast.error('Güncellenemedi: ' + e.message),
    });

    const toggleMutation = useMutation({
        mutationFn: (id: number) => apiPatch(`/instances/${id}/toggle`),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['instances'] }); toast.success('Durum değiştirildi.'); },
    });

    const retryMutation = useMutation({
        mutationFn: (id: number) => apiPatch(`/instances/${id}/retry`),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['instances'] }); toast.success('Yeniden bağlanılıyor...'); },
    });

    const openEdit = (inst: Instance) => {
        setEditInstance(inst);
        setFormMode('edit');
    };

    const downloadReport = async (format: 'pdf' | 'xlsx') => {
        setReportMenuOpen(false);
        setReportDownloading(format);
        try {
            const token = getToken();
            const res = await fetch(`/api/instances/report?format=${format}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((data as any).error || `Rapor indirilemedi: ${res.status}`);
            }
            const blob = await res.blob();
            const disposition = res.headers.get('content-disposition') || '';
            const match = /filename="?([^";]+)"?/i.exec(disposition);
            const filename = match?.[1] || `pgstat-instance-envanteri.${format}`;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            toast.success('Rapor indirildi.');
        } catch (e: any) {
            toast.error(e?.message || 'Rapor indirilemedi.');
        } finally {
            setReportDownloading(null);
        }
    };

    // Pin tercihleri
    const prefs = useQuery({
        queryKey: ['preferences'],
        queryFn: () => apiGet<{ pinned_instances: number[] }>('/preferences'),
    });
    // pinned_instances JSONB'den string gelebilir; Number()'a normalize et ki
    // pinSet.has(instance_pk: number) tutarli eslessin (yildiz dolsun).
    const pinSet = useMemo(() => new Set((prefs.data?.pinned_instances || []).map(Number)), [prefs.data]);

    const togglePinMut = useMutation({
        mutationFn: (id: number) => apiPost(`/preferences/pin/${id}`, {}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['preferences'] }),
    });

    const columns = [
        {
            key: 'pin', header: '', render: (r: Instance) => (
                <button
                    onClick={(e) => { e.stopPropagation(); togglePinMut.mutate(r.instance_pk); }}
                    title={pinSet.has(Number(r.instance_pk)) ? 'Pinden çıkar' : 'Sabitle (Dashboard\'da göster)'}
                    className="text-lg hover:scale-110 transition-transform print:hidden">
                    {pinSet.has(Number(r.instance_pk)) ? '⭐' : '☆'}
                </button>
            )
        },
        {
            key: 'display_name', header: 'Instance', render: (r: Instance) => (
                <div>
                    <div className="font-medium flex items-center gap-1">
                        {r.display_name}
                        {r.last_error && (
                            <span title={r.last_error} className="text-red-500 cursor-help">⚠</span>
                        )}
                    </div>
                    <div className="text-xs text-[#94A3B8]">{r.host}:{r.port}</div>
                    {r.last_error && (
                        <div className="text-xs text-red-500 mt-0.5 max-w-xs truncate" title={r.last_error}>{r.last_error}</div>
                    )}
                </div>
            )
        },
        { key: 'bootstrap_state', header: 'Durum', render: (r: Instance) => <Badge value={r.bootstrap_state} /> },
        { key: 'pg_major', header: 'PG', render: (r: Instance) => r.pg_major ? `PG${r.pg_major}` : '—' },
        { key: 'is_primary', header: 'Rol', render: (r: Instance) => r.is_primary === null ? '—' : r.is_primary ? 'Primary' : 'Replica' },
        { key: 'environment', header: 'Ortam', render: (r: Instance) => r.environment || '—' },
        { key: 'service_group', header: 'Servis Grubu', render: (r: Instance) => r.service_group || '—' },
        { key: 'last_cluster_collect_at', header: 'Son Cluster', render: (r: Instance) => <TimeAgo date={r.last_cluster_collect_at} /> },
        {
            // Retention, hemen yanindaki "Collector DB" kolonunun sebebi: bir
            // instance ne kadar uzun sure veri tutuyorsa o kadar yer kaplar.
            // Ayrica partition drop siniri butun instance'lar icin ortaktir
            // (en uzun KULLANILAN retention), yani tek bir instance'in uzun
            // politikasi digerlerinin diskini de mesgul eder — bu yuzden
            // hangi instance'in hangi politikada oldugu tek bakista gorulmeli.
            key: 'retention_policy_code', header: 'Retention', render: (r: Instance) => {
                if (!r.retention_policy_code) return '—';
                const days = r.retention_raw_days;
                const tip = [
                    `Ham veri: ${days ?? '?'} gun`,
                    r.retention_hourly_days != null ? `Saatlik ozet: ${r.retention_hourly_days} gun` : null,
                    r.retention_daily_days != null ? `Gunluk ozet: ${r.retention_daily_days} gun` : null,
                ].filter(Boolean).join('\n');
                return (
                    <div className="min-w-[90px]" title={tip}>
                        <div className="text-xs text-[#1E293B]">{r.retention_policy_code}</div>
                        {days != null && (
                            <div className="text-[10px] text-[#94A3B8]">{days} gun ham veri</div>
                        )}
                    </div>
                );
            }
        },
        {
            key: 'collector_bytes', header: 'Collector DB', render: (r: Instance) => {
                const s = storageMap.get(Number(r.instance_pk));
                if (!s) return storage.isLoading ? <Skeleton width="80px" height="0.875rem" /> : '—';
                const bytes = Number(s.collector_bytes || 0);
                const total = Number(s.collector_db_bytes || 0);
                const pct = total > 0 ? Math.min(100, bytes * 100 / total) : 0;
                return (
                    <div className="min-w-[120px]">
                        <div className="font-mono text-xs text-[#1E293B]">{fmtBytes(bytes)}</div>
                        <div className="h-1.5 bg-[#E2E8F0] rounded mt-1 overflow-hidden">
                            <div className="h-full bg-[#3B82F6]" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="text-[10px] text-[#94A3B8]">{pct.toFixed(1)}% collector DB</div>
                    </div>
                );
            }
        },
        { key: 'consecutive_failures', header: 'Hatalar', render: (r: Instance) => r.consecutive_failures > 0 ? <span className="text-red-600 font-medium">{r.consecutive_failures}</span> : <span className="text-green-600">0</span> },
        {
            key: 'actions', header: '', render: (r: Instance) => (
                <div className="flex gap-1">
                    <button onClick={(e) => { e.stopPropagation(); openEdit(r); }}
                        className="px-2 py-1 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100">Düzenle</button>
                    <button onClick={(e) => { e.stopPropagation(); toggleMutation.mutate(r.instance_pk); }}
                        className={`px-2 py-1 text-xs rounded ${r.is_active ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-green-50 text-green-600 hover:bg-green-100'}`}>
                        {r.is_active ? 'Durdur' : 'Başlat'}
                    </button>
                    {(r.bootstrap_state === 'degraded' || r.last_error) && (
                        <button onClick={(e) => { e.stopPropagation(); retryMutation.mutate(r.instance_pk); }}
                            className="px-2 py-1 text-xs rounded bg-yellow-50 text-yellow-700 hover:bg-yellow-100">
                            Yeniden Dene
                        </button>
                    )}
                </div>
            )
        },
    ];

    const clusterColumns = [
        {
            key: 'label', header: 'Küme', render: (r: Cluster) => (
                <div className="flex items-center gap-2">
                    <Link to={`/clusters/${encodeURIComponent(r.cluster_id)}`}
                        className="font-medium text-[#3B82F6] hover:underline">
                        {r.label || r.cluster_id.slice(0, 16)}
                    </Link>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${KIND_BADGE[r.cluster_kind || 'auto']?.cls || ''}`}>
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
                    <h1 className="text-xl font-bold">Instances</h1>
                    {view === 'clusters' && (
                        <InfoTip text="Aynı system_identifier'a sahip instance'lar bir küme oluşturur. Logical replication veya manuel gruplama için Instance Detail'dan 'Manuel Küme Grubu' alanı doldurularak override edilebilir." />
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {view === 'clusters' && <LastUpdated dataUpdatedAt={clusters.dataUpdatedAt} />}
                    <PrintButton title={view === 'clusters' ? 'Kümeler' : 'Instances'} />
                    <div className="relative print:hidden">
                        <button
                            onClick={() => setReportMenuOpen(v => !v)}
                            disabled={reportDownloading != null}
                            className="px-4 py-2 text-sm bg-white text-[#334155] border border-[#CBD5E1] rounded hover:bg-[#F8FAFC] disabled:opacity-60">
                            {reportDownloading ? 'Rapor hazırlanıyor...' : '📥 Rapor İndir'}
                        </button>
                        {reportMenuOpen && (
                            <div className="absolute right-0 z-20 mt-2 w-52 bg-white border border-[#E2E8F0] rounded shadow-lg overflow-hidden">
                                <button
                                    onClick={() => downloadReport('pdf')}
                                    className="w-full text-left px-4 py-2 text-sm text-[#334155] hover:bg-[#F8FAFC]">
                                    📄 PDF olarak indir
                                </button>
                                <button
                                    onClick={() => downloadReport('xlsx')}
                                    className="w-full text-left px-4 py-2 text-sm text-[#334155] hover:bg-[#F8FAFC]">
                                    📊 Excel (.xlsx)
                                </button>
                            </div>
                        )}
                    </div>
                    {view === 'list' && (
                        <button onClick={() => { setFormMode(formMode === 'closed' ? 'add' : 'closed'); setEditInstance(null); }}
                            className="px-4 py-2 text-sm bg-[#3B82F6] text-white rounded hover:bg-[#2563EB] print:hidden">
                            {formMode !== 'closed' ? 'Kapat' : '+ Instance Ekle'}
                        </button>
                    )}
                </div>
            </div>

            {/* View toggle */}
            <div className="flex gap-1 mb-4 print:hidden">
                <button onClick={() => setView('list')}
                    className={`px-4 py-1.5 text-sm rounded ${view === 'list' ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:bg-[#F8FAFC]'}`}>
                    🖥️ Liste
                </button>
                <button onClick={() => setView('clusters')}
                    className={`px-4 py-1.5 text-sm rounded ${view === 'clusters' ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:bg-[#F8FAFC]'}`}>
                    🗂️ Kümeler
                </button>
                <Link to="/instances/cleanup"
                    className="px-4 py-1.5 text-sm rounded bg-white text-[#64748B] border border-[#E2E8F0] hover:bg-[#F8FAFC]">
                    🗑️ Sorunlu DB'ler
                </Link>
            </div>

            {/* Yuk Guvencesi karti — sadece liste view'inda */}
            {view === 'list' && <LoadAssuranceCard />}

            {/* Form sadece liste view'ında */}
            {view === 'list' && formMode !== 'closed' && (
                <div className="bg-white rounded-lg shadow-sm p-5 mb-5">
                    <h2 className="text-sm font-semibold text-[#64748B] mb-4">
                        {formMode === 'edit' ? 'Instance Düzenle' : 'Yeni Instance'}
                    </h2>
                    <InstanceForm
                        initial={formMode === 'edit' && editInstance ? {
                            instance_id: editInstance.instance_id,
                            display_name: editInstance.display_name,
                            environment: editInstance.environment || '',
                            service_group: editInstance.service_group || '',
                            host: editInstance.host,
                            port: editInstance.port,
                            admin_dbname: editInstance.admin_dbname,
                            collector_username: editInstance.collector_username || 'pgstats_collector',
                            secret_ref: editInstance.secret_ref,
                            ssl_mode: editInstance.ssl_mode,
                            ssl_root_cert_path: editInstance.ssl_root_cert_path || '',
                            schedule_profile_id: editInstance.schedule_profile_id,
                            retention_policy_id: editInstance.retention_policy_id,
                            collector_group: editInstance.collector_group || '',
                            notes: editInstance.notes || '',
                        } : undefined}
                        isEdit={formMode === 'edit'}
                        onSubmit={(d) => {
                            if (formMode === 'edit' && editInstance) {
                                editMutation.mutate({ id: editInstance.instance_pk, data: d });
                            } else {
                                addMutation.mutate(d);
                            }
                        }}
                        onCancel={() => setFormMode('closed')}
                    />
                </div>
            )}

            {/* Liste view: filtreler + tablo */}
            {view === 'list' && (
                <>
                    <div className="bg-white rounded-lg shadow-sm p-3 mb-4 print:hidden">
                        <div className="flex flex-wrap gap-2 items-center">
                            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                                placeholder="🔍 Ad, ID veya host ara..."
                                className="border border-[#CBD5E1] rounded px-3 py-1.5 text-sm flex-1 min-w-[200px]" />
                            <select value={environmentFilter} onChange={e => setEnvironmentFilter(e.target.value)}
                                className="border border-[#CBD5E1] rounded px-2 py-1.5 text-sm">
                                <option value="">Tüm Ortamlar</option>
                                {filterOptions.envs.map(e => <option key={e} value={e}>{e}</option>)}
                            </select>
                            <select value={serviceGroupFilter} onChange={e => setServiceGroupFilter(e.target.value)}
                                className="border border-[#CBD5E1] rounded px-2 py-1.5 text-sm">
                                <option value="">Tüm Servis Grupları</option>
                                {filterOptions.groups.map(g => <option key={g} value={g}>{g}</option>)}
                            </select>
                            <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as any)}
                                className="border border-[#CBD5E1] rounded px-2 py-1.5 text-sm">
                                <option value="">Tüm Roller</option>
                                <option value="primary">Primary</option>
                                <option value="replica">Replica</option>
                            </select>
                            <select value={stateFilter} onChange={e => setStateFilter(e.target.value)}
                                className="border border-[#CBD5E1] rounded px-2 py-1.5 text-sm">
                                <option value="">Tüm Durumlar</option>
                                {filterOptions.states.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                            <select value={pgVersionFilter} onChange={e => setPgVersionFilter(e.target.value)}
                                className="border border-[#CBD5E1] rounded px-2 py-1.5 text-sm">
                                <option value="">Tüm PG Versiyonlar</option>
                                {filterOptions.versions.map(v => <option key={v} value={v}>PG{v}</option>)}
                            </select>
                            {hasActiveFilter && (
                                <button onClick={clearFilters} className="text-xs text-[#3B82F6] hover:underline">
                                    Filtreleri temizle
                                </button>
                            )}
                            <span className="text-xs text-[#64748B] ml-auto">
                                {filtered.length} / {data?.length || 0}
                            </span>
                        </div>
                    </div>

                    <div className="bg-white rounded-lg shadow-sm p-4">
                        <DataTable
                            columns={columns}
                            data={filtered}
                            loading={isLoading}
                            onRowClick={(r) => navigate(`/instances/${r.instance_pk}`)}
                            emptyState={
                                hasActiveFilter
                                    ? <EmptyState icon="🔍" title="Filtreyle eşleşme yok" description="Farklı filtre değerleri deneyin veya temizleyin." />
                                    : <EmptyState
                                        icon="🖥️"
                                        title="Henüz instance eklenmedi"
                                        description="İlk PostgreSQL instance'ını ekleyerek izlemeye başlayın."
                                        action={{
                                            label: '+ İlk Instance\'ı Ekle',
                                            onClick: () => { setFormMode('add'); setEditInstance(null); }
                                        }}
                                    />
                            }
                        />
                    </div>
                </>
            )}

            {/* Kümeler view */}
            {view === 'clusters' && (
                <div className="bg-white rounded-lg shadow-sm p-4">
                    {clusters.isLoading
                        ? <SkeletonTable rows={5} cols={5} />
                        : (clusters.data && clusters.data.length === 0)
                            ? <EmptyState icon="🗂️" title="Aktif küme yok" description="Aynı system_identifier'a sahip en az 2 instance eklenmeli." />
                            : <DataTable columns={clusterColumns} data={clusters.data || []} />}
                </div>
            )}
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

// ============================================================================
// Yuk Guvencesi karti — "pgstat DB'lerimi yorar mi?" sorusunun kanitli cevabi
// Fleet geneli pgstat sorgu yuku payi (canli) + katmanli aciklama
// (yonetici ozeti + DBA teknik detay).
// ============================================================================
interface FootprintSummary {
    hours: number;
    instance_count: number;
    counts: { healthy: number; idle_db: number; review: number };
    rows: { instance_pk: number; instance_name: string; exec_pct: number | null; buf_pct: number | null; pgstat_calls: string; pgstat_exec_ms: string; category: 'healthy' | 'idle_db' | 'review' }[];
}

function LoadAssuranceCard() {
    const [open, setOpen] = useState(false);
    const { data } = useQuery({
        queryKey: ['footprint-summary'],
        queryFn: () => apiGet<FootprintSummary>('/instances/footprint-summary?hours=24'),
    });
    if (!data || data.instance_count === 0) return null;

    // Her instance KENDI ICINDE siniflandirildi:
    //  healthy = pgstat orani dusuk (DB aktif, pgstat ihmal edilebilir)
    //  idle_db = pgstat orani yuksek ama mutlak yuk dusuk (DB bos/az kullaniliyor — pgstat sorun DEGIL)
    //  review  = yuksek oran + yuksek mutlak (gercekten pgstat yuku — incele)
    const c = data.counts;
    // Ton: review varsa kirmizi, yoksa yesil (idle_db kotu degil)
    const tone = c.review > 0 ? 'red' : 'green';
    const toneBg = tone === 'green' ? 'bg-[#ECFDF5] border-[#A7F3D0]' : 'bg-[#FEF2F2] border-[#FECACA]';
    const toneText = tone === 'green' ? 'text-[#047857]' : 'text-[#B91C1C]';

    return (
        <div className={`rounded-lg border ${toneBg} p-4 mb-4 print:hidden`}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                    {/* Yonetici ozeti — siniflandirmaya gore (her instance kendi icinde) */}
                    <div className={`text-sm font-semibold ${toneText}`}>
                        {tone === 'green'
                            ? <>✓ pgstat hicbir veritabanina kayda deger yuk getirmiyor. Izlenen {data.instance_count} DB'den <b>{c.healthy}</b>'inde pgstat payi dusuk (DB aktif, ihmal edilebilir){c.idle_db > 0 && <>, <b>{c.idle_db}</b>'inde oran yuksek ama bu DB'ler az kullaniliyor (mutlak yuk minik — pgstat sorun degil)</>}.</>
                            : <>pgstat <b>{c.review}</b> veritabaninda hem yuksek oranli hem mutlak yuku belirgin — incelenmeli. {c.healthy} DB saglikli{c.idle_db > 0 && <>, {c.idle_db} DB az kullaniliyor (oran yuksek ama mutlak dusuk)</>}.</>}
                    </div>
                    <div className="text-xs text-[#64748B] mt-1">
                        Onemli: yuksek pgstat orani <b>tek basina</b> kotu degildir — o DB az kullaniliyorsa (uygulama az sorgu calistiriyorsa)
                        pgstat'in sabit periyodik sorgulari oransal one cikar ama mutlak yuk minik kalir.
                        pgstat zarar vermez; salt-okuma, veri degistirmez, kimseyi bekletmez. (Son {data.hours} saat, pg_stat_statements.)
                    </div>
                </div>
                <button onClick={() => setOpen(v => !v)}
                    className="text-xs px-3 py-1.5 rounded border border-[#CBD5E1] bg-white text-[#475569] hover:bg-[#F8FAFC] whitespace-nowrap">
                    {open ? 'Detayi gizle' : 'Teknik detay'}
                </button>
            </div>

            {open && (
                <div className="mt-3 pt-3 border-t border-[#E2E8F0] space-y-3 text-xs text-[#334155]">
                    <div>
                        <div className="font-semibold mb-1">pgstat kaynak DB'de NE YAPAR:</div>
                        <ul className="list-disc ml-5 space-y-0.5 text-[#475569]">
                            <li><b>Sadece SELECT</b> — pg_stat_*, pg_settings, pg_class gibi sistem view'lari okur. INSERT/UPDATE/DELETE/DDL <b>YOK</b>.</li>
                            <li><b>VACUUM/ANALYZE calistirmaz</b>, istatistik reset etmez, extension kurmaz.</li>
                            <li><b>AccessShareLock</b> alir (okuma) — normal sorgulari (okuma/yazma) bekletmez. Yalnizca DDL (ACCESS EXCLUSIVE) ile kisa etkilesim olabilir.</li>
                            <li><b>statement_timeout + lock_timeout</b> korumali — yavas/kilitli durumda collector cekilir, kaynak DB'yi mesgul etmez.</li>
                            <li>Gereken yetki: <b>pg_monitor</b> rolu (superuser GEREKMEZ).</li>
                            <li>Tum sorgular kaynak DB'de <code>application_name = 'pgstat_collector'</code> ile izlenebilir.</li>
                        </ul>
                    </div>
                    <div>
                        <div className="font-semibold mb-1">Instance bazli pgstat payi (exec time, son 24sa):</div>
                        <div className="overflow-x-auto max-h-60 overflow-y-auto border border-[#E2E8F0] rounded">
                            <table className="w-full">
                                <thead className="bg-[#F8FAFC] sticky top-0">
                                    <tr>
                                        <th className="py-1.5 px-2 text-left font-semibold text-[#64748B]">Instance</th>
                                        <th className="py-1.5 px-2 text-left font-semibold text-[#64748B]">Durum</th>
                                        <th className="py-1.5 px-2 text-right font-semibold text-[#64748B]" title="Bu DB'nin kendi sorgu yukunde pgstat'in exec time payi">Exec %</th>
                                        <th className="py-1.5 px-2 text-right font-semibold text-[#64748B]">Buffer %</th>
                                        <th className="py-1.5 px-2 text-right font-semibold text-[#64748B]" title="pgstat'in mutlak yuku (24sa toplam exec ms) — asil onemli olan bu">pgstat exec (ms)</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[#F1F5F9]">
                                    {data.rows.map(r => {
                                        const ep = r.exec_pct == null ? 0 : Number(r.exec_pct);
                                        const cat = r.category === 'review'
                                            ? { label: 'Incele', cls: 'bg-red-100 text-red-700', tip: 'Yuksek oran + yuksek mutlak yuk' }
                                            : r.category === 'idle_db'
                                                ? { label: 'DB az kullaniliyor', cls: 'bg-slate-100 text-slate-600', tip: 'Oran yuksek ama mutlak yuk dusuk — pgstat sorun degil, DB bos' }
                                                : { label: 'Saglikli', cls: 'bg-emerald-100 text-emerald-700', tip: 'pgstat orani dusuk, ihmal edilebilir' };
                                        return (
                                            <tr key={r.instance_pk} className="hover:bg-[#F8FAFC]">
                                                <td className="py-1 px-2">{r.instance_name}</td>
                                                <td className="py-1 px-2">
                                                    <span title={cat.tip} className={`px-1.5 py-0.5 rounded cursor-help ${cat.cls}`}>{cat.label}</span>
                                                </td>
                                                <td className="py-1 px-2 text-right font-mono text-[#64748B]">%{ep.toFixed(1)}</td>
                                                <td className="py-1 px-2 text-right font-mono text-[#64748B]">%{r.buf_pct == null ? '0' : Number(r.buf_pct).toFixed(1)}</td>
                                                <td className="py-1 px-2 text-right font-mono text-[#64748B]">{Number(r.pgstat_exec_ms).toLocaleString('tr-TR')}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div className="text-[#94A3B8]">
                        Not: Bu degerler <b>DB sorgu isleme yuku</b> payidir (pg_stat_statements exec time/buffer).
                        Makine CPU/RAM yuzdesi degildir — onun icin isletim sistemi metrikleri gerekir.
                        Instance detayindaki "Collector Ayak Izi" sekmesinde her DB icin sorgu kirilimi gorulebilir.
                    </div>
                </div>
            )}
        </div>
    );
}
