import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../api/client';
import { useToast } from '../components/common/Toast';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import DataTable from '../components/common/DataTable';
import InfoTip from '../components/common/InfoTip';
import Skeleton, { SkeletonTable, SkeletonCard } from '../components/common/Skeleton';
import EmptyState from '../components/common/EmptyState';
import TimeRangePicker, { loadPersistedRange } from '../components/common/TimeRangePicker';
import type { TimeRange } from '../components/common/TimeRangePicker';
import { useEffect, useMemo, useRef, useState } from 'react';
import StatementColumnsModal, { useStatementColumns, fmtStmtValue } from '../components/statements/StatementColumnsModal';
import DataColumnsModal, { useDataColumns, fmtValue, type ColumnsMeta } from '../components/common/DataColumnsModal';
import StatementSqlCell from '../components/statements/StatementSqlCell';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip as RcTooltip } from 'recharts';
import ResizableTh, { useColumnWidths, toggleSort, sortKeysToParam, type SortKey } from '../components/statements/ResizableTh';
import DataKindBanner from '../components/common/DataKindBanner';
import ViewModeToggle, { type ViewMode } from '../components/common/ViewModeToggle';

type Tab = 'overview' | 'storage' | 'statements' | 'databases' | 'tables' | 'indexes' | 'activity' | 'replication' | 'replication_slots' | 'subscriptions' | 'wal_receiver' | 'conflicts' | 'recovery_prefetch' | 'progress' | 'alerts' | 'jobruns' | 'functions' | 'sequences' | 'wal' | 'slru' | 'tps' | 'io_stats' | 'checkpointer' | 'bgwriter' | 'archiver' | 'settings' | 'settings_diff' | 'collector_footprint';

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

    const refreshSettingsMut = useMutation({
        mutationFn: () => apiPost(`/instances/${id}/refresh-settings`, {}),
        onSuccess: () => toast.success('Parametreler yenileniyor (5-10s içinde tamam)'),
        onError: () => toast.error('Komut gönderilemedi'),
    });

    // Global tarih aralığı — tüm tab'lardaki zaman-serisi sorguları bu aralığa göre çekilir.
    // Snapshot bazlı veriler (bloat oranı, son satır sayısı, son DB listesi) bu aralıktan
    // etkilenmez — onlar her zaman en son snapshot'ı kullanır.
    const [range, setRange] = useState<TimeRange>(() => loadPersistedRange(`inst-range-${id}`));
    // Kullanıcı tarih aralığı değiştirdi mi? — TPS gibi tab'lar default davranıştan ayrılmak için
    const [rangeIsCustom, setRangeIsCustom] = useState(false);
    const setRangeCustom = (r: TimeRange) => { setRangeIsCustom(true); setRange(r); };
    // Mevcut endpoint'lerin geri uyumluluğu için range'ten hours hesabı (preset bazlı kullanım)
    const rangeQp = `from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}`;

    const instance = useQuery({ queryKey: ['instance', id], queryFn: () => apiGet<any>(`/instances/${id}`) });
    const capability = useQuery({ queryKey: ['capability', id], queryFn: () => apiGet<any>(`/instances/${id}/capability`), enabled: !!id });
    const cluster = useQuery({ queryKey: ['inst-cluster', id], queryFn: () => apiGet<any>(`/instances/${id}/cluster`), enabled: !!id });
    // Snapshot-bazlı (range'den etkilenmez) — DB listesi, storage en son snapshot
    // Range'e bağlı (zaman-serisi)
    const alerts = useQuery({ queryKey: ['inst-alerts', id, range.fromIso, range.toIso], queryFn: () => apiGet<any[]>(`/alerts?instance_pk=${id}&${rangeQp}`), enabled: tab === 'alerts' });
    const jobruns = useQuery({ queryKey: ['inst-jobruns', id], queryFn: () => apiGet<any[]>(`/job-runs?limit=20`), enabled: tab === 'jobruns' });
    // TPS — default'ta günlük 7 gün + saatlik 25 saat; kullanıcı aralık değiştirirse o aralığa
    const tpsData = useQuery({ queryKey: ['inst-tps', id, range.fromIso, range.toIso, rangeIsCustom], queryFn: () => apiGet<any>(`/instances/${id}/tps?${rangeQp}&custom=${rangeIsCustom ? 1 : 0}`), enabled: tab === 'tps' });
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
        { key: 'indexes', label: 'Index İstatistikleri', tip: 'Instance genelinde veya seçilen database için index istatistikleri, invalid/unused filtreleri ve Excel export.' },
        { key: 'tps', label: 'TPS', tip: 'Transactions Per Second — günlük ve saatlik commit/rollback dağılımı. Kapasite planlaması için kritik metrik.' },
        { key: 'activity', label: 'Activity', tip: 'pg_stat_activity — anlık aktif session\'lar. State, wait event ve çalışan sorguları gösterir.' },
        { key: 'replication', label: 'Replikasyon', tip: 'Primary node üzerinden streaming replica durumu, sync state ve replay lag bilgileri.' },
        { key: 'replication_slots', label: 'Slots', tip: 'pg_replication_slots — slot durumu, lag, WAL status, PG17+ conflict/failover bilgileri.' },
        { key: 'subscriptions', label: 'Subscriptions', tip: 'pg_stat_subscription — logical replication worker durumu, PG18+ conflict detayları.' },
        { key: 'wal_receiver', label: 'WAL Receiver', tip: 'pg_stat_wal_receiver — standby WAL receiver durumu, lag, sender bilgisi.' },
        { key: 'conflicts', label: 'Conflicts', tip: 'pg_stat_database_conflicts — standby recovery conflict istatistikleri.' },
        { key: 'recovery_prefetch', label: 'Recovery Prefetch', tip: 'pg_stat_recovery_prefetch (PG15+) — standby prefetch istatistikleri.' },
        { key: 'functions', label: 'Functions', tip: 'pg_stat_user_functions — kullanıcı fonksiyonları. track_functions=all olmalı. Calls, total_time, self_time gösterir.' },
        { key: 'sequences', label: 'Sequences', tip: 'pg_statio_all_sequences — sequence I/O. Cache hit ratio düşükse shared_buffers yetersiz olabilir.' },
        { key: 'wal', label: 'WAL/Archive', tip: 'WAL üretimi ve archiver durumu. WAL bytes yüksekse checkpoint_completion_target ayarını kontrol edin. Failed archive varsa archive_command\'ı inceleyin.' },
        { key: 'slru', label: 'SLRU', tip: 'Simple LRU cache istatistikleri (PG13+). CommitTs, MultiXact, Notify, Serial, Subtrans, Xact cache\'leri. Hit ratio düşükse performans etkilenebilir.' },
        { key: 'io_stats', label: 'I/O Stats', tip: 'pg_stat_io (PG16+) — backend tipi, object ve context bazında detaylı I/O istatistikleri.' },
        { key: 'bgwriter', label: 'BgWriter', tip: 'pg_stat_bgwriter — background writer ve (PG16 öncesi) checkpoint istatistikleri.' },
        { key: 'checkpointer', label: 'Checkpointer', tip: 'pg_stat_checkpointer (PG17+) — checkpoint ve restartpoint istatistikleri.' },
        { key: 'archiver', label: 'Archiver', tip: 'pg_stat_archiver — WAL arşivleme başarı/hata sayıları ve son arşivlenen dosya.' },
        { key: 'progress', label: 'Progress', tip: 'pg_stat_progress_* — aktif vacuum/analyze/create_index/basebackup/copy/cluster operasyonları.' },
        { key: 'settings', label: 'Parametreler', tip: 'En son snapshot\'taki tüm pg_settings parametreleri. Manuel yenileme butonu ile ALTER SYSTEM sonrası hemen güncellenir. Parametre değiştiğinde otomatik PARAMETER_CHANGED INFO alert tetiklenir (bildirim kanallarına da gönderilir).' },
        { key: 'alerts', label: 'Alertler' },
        { key: 'jobruns', label: 'Son Job Run' },
        { key: 'collector_footprint', label: 'Collector Ayak Izi', tip: 'pgstat collector\'un bu instance\'ta calistirdigi sorgular ve sureleri. Veri zaten pg_stat_statements\'ten toplaniyor; collector kullanicisinin sorgulari filtrelenir. Collector gelistikce yeni/degisen sorgular otomatik gorunur.' },
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

            {/* Global tarih aralığı seçici — tüm tab'lardaki zaman serileri bu aralığa göre */}
            <div className="mb-4 bg-white border border-[#E2E8F0] rounded-lg p-3 flex items-center gap-3 flex-wrap">
                <span className="text-xs text-[#64748B] font-medium">⏱ Tarih Aralığı:</span>
                <TimeRangePicker value={range} onChange={setRangeCustom} persistKey={`inst-range-${id}`} />
                <InfoTip text={`Tüm zaman-serisi grafikleri ve sorgular bu aralığa göre çekilir
(Statements, TPS, WAL, SLRU, Functions, Sequences, Activity, Alerts).

Snapshot bazlı veriler (Bloat oranı, son tablo boyutu, son satır sayısı,
DB listesi, Sequences son değeri) bu aralıktan ETKİLENMEZ — her zaman
en son snapshot'tan okunur.

Seçim localStorage'da hatırlanır.`} />
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
            {tab === 'storage' && <StorageTab instancePk={Number(id)} pgMajor={cap?.pg_major} />}
            {tab === 'statements' && <StatementsTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'databases' && <DatabasesTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} onSelectDb={(dbid) => { setSelectedDbid(dbid); setTab('tables'); }} />}
            {tab === 'tables' && <TableStatsTab instancePk={Number(id)} initialDbid={selectedDbid} range={range} />}
            {tab === 'indexes' && <IndexStatsTab instancePk={Number(id)} initialDbid={selectedDbid} range={range} />}
            {tab === 'activity' && <ActivityTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'replication' && <ReplicationTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} isPrimary={cap?.is_primary ?? inst.is_primary} />}
            {tab === 'replication_slots' && <ReplicationSlotsTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'subscriptions' && <SubscriptionsTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'wal_receiver' && <WalReceiverTab instancePk={Number(id)} range={range} isPrimary={cap?.is_primary ?? inst.is_primary} />}
            {tab === 'conflicts' && <ConflictsTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'recovery_prefetch' && <RecoveryPrefetchTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} isPrimary={cap?.is_primary ?? inst.is_primary} />}
            {tab === 'functions' && <FunctionsTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'sequences' && <SequencesTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'wal' && <WalArchiveTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'slru' && <SlruTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'io_stats' && <IoStatsTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'bgwriter' && <BgWriterTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'checkpointer' && <CheckpointerTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'archiver' && <ArchiverTab instancePk={Number(id)} range={range} />}
            {tab === 'progress' && <ProgressTab instancePk={Number(id)} range={range} pgMajor={cap?.pg_major} />}
            {tab === 'tps' && <TpsTab data={tpsData.data} loading={tpsData.isLoading} custom={rangeIsCustom} />}
            {tab === 'settings' && <SettingsTab instanceId={id!} onRefresh={() => refreshSettingsMut.mutate()} refreshing={refreshSettingsMut.isPending} />}
            {tab === 'settings_diff' && <SettingsDiffTab data={settingsDiff.data} loading={settingsDiff.isLoading} days={settingsDiffDays} onDaysChange={setSettingsDiffDays} />}
            {tab === 'alerts' && <AlertsTab data={alerts.data} loading={alerts.isLoading} />}
            {tab === 'jobruns' && <JobRunsTab data={jobruns.data} loading={jobruns.isLoading} />}
            {tab === 'collector_footprint' && <CollectorFootprintTab instancePk={id!} />}
        </div >
    );
}

interface FootprintRow {
    queryid: string;
    datname: string | null;
    query_text: string | null;
    total_calls: string;
    total_exec_ms: string;
    mean_exec_ms: string | null;
    max_exec_ms: string | null;
    total_rows: string;
    shared_blks_read: string;
}

function CollectorFootprintTab({ instancePk }: { instancePk: string }) {
    const [hours, setHours] = useState(24);
    const { data, isLoading } = useQuery({
        queryKey: ['collector-footprint', instancePk, hours],
        queryFn: () => apiGet<{ collector_username: string; rows: FootprintRow[] }>(
            `/instances/${instancePk}/collector-footprint?hours=${hours}&limit=50`),
        enabled: !!instancePk,
    });

    const { data: summary } = useQuery({
        queryKey: ['collector-footprint-summary', instancePk, hours],
        queryFn: () => apiGet<{ collector_username: string; pgstat: { exec_ms: number; calls: number }; diger: { exec_ms: number; calls: number } }>(
            `/instances/${instancePk}/collector-footprint/summary?hours=${hours}`),
        enabled: !!instancePk,
    });

    if (isLoading) return <SkeletonTable rows={8} cols={8} />;
    const rows = data?.rows ?? [];
    const windowMinutes = hours * 60;

    // Toplam yuk + cagri (pasta yuzdeleri ve ozet icin)
    const totalExecMs = rows.reduce((s, r) => s + Number(r.total_exec_ms || 0), 0);
    const totalCalls = rows.reduce((s, r) => s + Number(r.total_calls || 0), 0);

    // Pasta: top 8 + "diger". Kisa etiket (sorgunun ilk anlamli kismi).
    const PIE_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#94A3B8'];
    function buildPie(valueOf: (r: FootprintRow) => number) {
        const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
        const top = sorted.slice(0, 8);
        const rest = sorted.slice(8);
        const slices = top.map(r => ({ name: shortLabel(r.query_text), value: valueOf(r) }));
        const restSum = rest.reduce((s, r) => s + valueOf(r), 0);
        if (restSum > 0) slices.push({ name: `Diger (${rest.length})`, value: restSum });
        return slices.filter(s => s.value > 0);
    }
    const execPie = buildPie(r => Number(r.total_exec_ms || 0));
    const callsPie = buildPie(r => Number(r.total_calls || 0));

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] px-4 py-3 text-xs text-[#1D4ED8]">
                pgstat collector'un bu instance'ta ({data?.collector_username ?? '...'}) calistirdigi sorgular.
                Veri zaten pg_stat_statements'ten toplaniyor — ek yuk yok. Collector gelistikce yeni/degisen
                sorgular otomatik yansir. Sure artisi gorursen collector tarafinda bir sorgu agirlasmis olabilir.
            </div>
            <div className="flex items-center gap-2">
                <span className="text-xs text-[#64748B]">Pencere:</span>
                {[6, 24, 168, 720].map(h => (
                    <button key={h} onClick={() => setHours(h)}
                        className={`px-3 py-1 text-xs rounded border ${hours === h ? 'border-[#3B82F6] text-[#2563EB] bg-[#EFF6FF]' : 'border-[#E2E8F0] text-[#64748B] hover:bg-[#F8FAFC]'}`}>
                        {h === 6 ? '6sa' : h === 24 ? '24sa' : h === 168 ? '7g' : '30g'}
                    </button>
                ))}
                <span className="ml-4 text-xs text-[#64748B]">
                    Toplam: <b className="text-[#1E293B]">{Math.round(totalExecMs).toLocaleString('tr-TR')} ms</b> exec,
                    {' '}<b className="text-[#1E293B]">{totalCalls.toLocaleString('tr-TR')}</b> cagri
                    {' '}(<b className="text-[#1E293B]">{(totalExecMs / windowMinutes).toFixed(0)}</b> ms/dk ort. yuk)
                </span>
            </div>

            {/* pgstat vs uygulama/diger — DB'nin toplam yukunun ne kadari pgstat */}
            {summary && (summary.pgstat.exec_ms + summary.diger.exec_ms > 0) && (() => {
                const pe = summary.pgstat.exec_ms, de = summary.diger.exec_ms;
                const pc = summary.pgstat.calls, dc = summary.diger.calls;
                const execShare = pe + de > 0 ? (pe * 100 / (pe + de)) : 0;
                const callShare = pc + dc > 0 ? (pc * 100 / (pc + dc)) : 0;
                return (
                    <div>
                        <div className="rounded-lg border border-[#E2E8F0] bg-[#FAFAFA] px-4 py-2 mb-2 text-xs text-[#334155]">
                            Bu DB'deki toplam yukun <b className="text-[#2563EB]">%{execShare.toFixed(1)}</b>'i pgstat collector
                            (exec time), <b>%{callShare.toFixed(1)}</b>'i pgstat (cagri). Kalan uygulama/diger trafik.
                            {execShare >= 20 && <span className="text-[#B91C1C]"> pgstat yuku yuksek — toplama sikligini (schedule profil) gozden gecirebilirsin.</span>}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <FootprintPie title="pgstat vs Uygulama (exec time)" colors={['#3B82F6', '#CBD5E1']} unit="ms"
                                data={[{ name: 'pgstat collector', value: pe }, { name: 'Uygulama/diger', value: de }]} />
                            <FootprintPie title="pgstat vs Uygulama (cagri)" colors={['#10B981', '#CBD5E1']} unit="cagri"
                                data={[{ name: 'pgstat collector', value: pc }, { name: 'Uygulama/diger', value: dc }]} />
                        </div>
                    </div>
                );
            })()}

            {/* Collector ic kirilim: hangi collector sorgusu yukun yuzde kaci */}
            {rows.length > 0 && (
                <div>
                    <div className="text-xs font-semibold text-[#64748B] mb-2">Collector sorgulari ic kirilim</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <FootprintPie title="Yuk dagilimi (exec time)" data={execPie} colors={PIE_COLORS} unit="ms" />
                        <FootprintPie title="Cagri dagilimi" data={callsPie} colors={PIE_COLORS} unit="cagri" />
                    </div>
                </div>
            )}

            <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                        <tr>
                            <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Sorgu</th>
                            <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">DB</th>
                            <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Cagri</th>
                            <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase" title="Ortalama cagri/dakika (pencere boyunca)">Cagri/dk</th>
                            <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase" title="Pencere boyunca toplam execution suresi">Toplam (ms)</th>
                            <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase" title="Toplam yukun yuzde kaci">Yuk %</th>
                            <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase" title="Cagri basina ortalama">Ort (ms)</th>
                            <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Max (ms)</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                        {rows.length === 0 ? (
                            <tr><td colSpan={8} className="py-8 text-center text-sm text-[#64748B]">Bu pencerede collector sorgusu yok.</td></tr>
                        ) : rows.map((r) => {
                            const execMs = Number(r.total_exec_ms || 0);
                            const calls = Number(r.total_calls || 0);
                            const loadPct = totalExecMs > 0 ? (execMs * 100 / totalExecMs) : 0;
                            const perMin = calls / windowMinutes;
                            return (
                                <tr key={r.queryid} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 font-mono text-xs text-[#1E293B] max-w-md truncate" title={r.query_text ?? ''}>{r.query_text ?? '—'}</td>
                                    <td className="py-2 px-3 text-xs text-[#64748B]">{r.datname ?? '—'}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{calls.toLocaleString('tr-TR')}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{perMin < 0.1 ? perMin.toFixed(2) : perMin.toFixed(1)}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{execMs.toLocaleString('tr-TR')}</td>
                                    <td className="py-2 px-3 text-right">
                                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${loadPct >= 25 ? 'bg-red-100 text-red-700' : loadPct >= 10 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                                            %{loadPct.toFixed(1)}
                                        </span>
                                    </td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{r.mean_exec_ms ?? '—'}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{r.max_exec_ms ?? '—'}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// Sorgu metninden kisa etiket — pasta dilim adi icin (ilk FROM/tablo veya ilk kelimeler)
function shortLabel(query: string | null): string {
    if (!query) return '?';
    const q = query.replace(/\s+/g, ' ').trim();
    // "from X" yakala
    const m = q.match(/from\s+([a-z_."]+)/i);
    if (m) return m[1].replace(/"/g, '').slice(0, 30);
    // SET komutlari
    const setM = q.match(/^set\s+(\w+)/i);
    if (setM) return 'SET ' + setM[1];
    return q.slice(0, 30);
}

function FootprintPie({ title, data, colors, unit }: {
    title: string; data: { name: string; value: number }[]; colors: string[]; unit: string;
}) {
    return (
        <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] p-3">
            <h3 className="text-xs font-semibold text-[#1E293B] mb-2">{title}</h3>
            <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                    <Pie data={data} dataKey="value" nameKey="name" cx="40%" cy="50%" outerRadius={90}
                        label={(e: any) => `%${((e.percent ?? 0) * 100).toFixed(0)}`} labelLine={false}>
                        {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
                    </Pie>
                    <RcTooltip formatter={(v: any) => [`${Number(v).toLocaleString('tr-TR')} ${unit}`, '']} />
                    <Legend layout="vertical" align="right" verticalAlign="middle"
                        wrapperStyle={{ fontSize: 10, maxWidth: '45%' }} />
                </PieChart>
            </ResponsiveContainer>
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

interface RawDeltaResponse {
    rows: any[];
    next_cursor: string | null;
}

function withSampleTsMeta(meta: ColumnsMeta | undefined, defaults: string[]): ColumnsMeta | undefined {
    if (!meta) return undefined;
    const hasSampleTs = meta.available.some(c => c.key === 'sample_ts');
    return {
        defaults,
        available: hasSampleTs
            ? meta.available
            : [{ key: 'sample_ts', label: 'Zaman', since: 11 }, ...meta.available],
    };
}

function formatRawCell(col: string, value: any) {
    if (col === 'sample_ts') return value ? <TimeAgo date={value} /> : '—';
    if (typeof value === 'boolean') return value ? '✓' : '✕';
    return fmtValue(col, value);
}

function RawDeltaTable({
    basePath,
    baseParams,
    queryKey,
    selectedCols,
    setSelectedCols,
    meta,
    pgMajor,
    storageKey,
    emptyTitle,
    requiredQueryCols = [],
    onRowClick,
}: {
    basePath: string;
    baseParams: Record<string, string>;
    queryKey: unknown[];
    selectedCols: string[];
    setSelectedCols: (cols: string[]) => void;
    meta: ColumnsMeta | undefined;
    pgMajor?: number;
    storageKey: string;
    emptyTitle: string;
    requiredQueryCols?: string[];
    onRowClick?: (row: any) => void;
}) {
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const visibleCols = selectedCols.includes('sample_ts') ? selectedCols : ['sample_ts', ...selectedCols];
    const queryCols = Array.from(new Set([...requiredQueryCols, ...visibleCols]));
    const { widths, setWidth, reset: resetWidths } = useColumnWidths(`${storageKey}.widths`);

    const rawQuery = useInfiniteQuery<RawDeltaResponse>({
        queryKey: [...queryKey, queryCols.join(',')],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) => {
            const qp = new URLSearchParams({ ...baseParams, mode: 'raw', limit: '200', columns: queryCols.join(',') });
            if (pageParam) qp.set('cursor', String(pageParam));
            return apiGet<RawDeltaResponse>(`${basePath}?${qp}`);
        },
        getNextPageParam: (lastPage) => lastPage.next_cursor || undefined,
        enabled: Boolean(basePath),
    });

    useEffect(() => {
        window.scrollTo({ top: 0, behavior: 'auto' });
    }, [basePath, baseParams.from, baseParams.to, visibleCols.join(',')]);

    useEffect(() => {
        const node = sentinelRef.current;
        if (!node) return;
        const obs = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && rawQuery.hasNextPage && !rawQuery.isFetchingNextPage && !rawQuery.isFetching) {
                rawQuery.fetchNextPage();
            }
        }, { threshold: 0.1 });
        obs.observe(node);
        return () => obs.disconnect();
    }, [rawQuery.hasNextPage, rawQuery.isFetchingNextPage, rawQuery.isFetching, rawQuery.fetchNextPage]);

    const rows = rawQuery.data?.pages.flatMap(p => p.rows) ?? [];

    return (
        <div>
            <DataKindBanner kind="delta" description="Ham Delta modunda satırlar toplanmadan, örnek zamanı ters sırada gösterilir. Aşağı indikçe 200'er satır yüklenir." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({visibleCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => rawQuery.refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{rawQuery.isFetching && !rawQuery.isFetchingNextPage ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{rows.length} ham satır</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {rawQuery.isLoading ? <SkeletonTable rows={5} cols={visibleCols.length} /> : rows.length === 0 ? (
                    <EmptyState icon="📋" title={emptyTitle} description="Bu aralıkta ham delta satırı yok." />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                            <thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                {visibleCols.map(col => {
                                    const m = meta?.available.find(c => c.key === col);
                                    return <ResizableTh key={col} colKey={col} width={widths[col] ?? (col === 'sample_ts' ? 170 : 130)} onResize={setWidth} align={col === 'sample_ts' ? 'left' : 'right'} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{m?.label ?? col}</ResizableTh>;
                                })}
                            </tr></thead>
                            <tbody>{rows.map((r: any, i: number) => (
                                <tr key={`${r.sample_ts ?? 'row'}-${i}`} onClick={() => onRowClick?.(r)}
                                    className={`border-b border-[#F1F5F9] hover:bg-[#F8FAFC] ${onRowClick ? 'cursor-pointer' : ''}`}>
                                    {visibleCols.map(col => (
                                        <td key={col} className={`py-2 px-3 text-xs whitespace-nowrap truncate ${col === 'sample_ts' ? '' : 'text-right font-mono'}`}>
                                            {formatRawCell(col, r[col])}
                                        </td>
                                    ))}
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                )}
                <div ref={sentinelRef} className="h-4" />
                {rawQuery.hasNextPage && (
                    <div className="p-3 text-center">
                        <button onClick={() => rawQuery.fetchNextPage()} disabled={rawQuery.isFetchingNextPage}
                            className="px-3 py-1.5 text-sm text-[#2563EB] border border-[#BFDBFE] rounded hover:bg-[#EFF6FF] disabled:opacity-50">
                            {rawQuery.isFetchingNextPage ? 'Yükleniyor...' : 'Daha fazla yükle'}
                        </button>
                    </div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={visibleCols} onChange={setSelectedCols} meta={meta} pgMajor={pgMajor} title="⚙️ Ham Delta Sütunları" />
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

function excelCell(value: unknown): string {
    const text = String(value ?? '');
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function safeFileName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
}

function downloadText(filename: string, content: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

const INDEX_TIME_RANGES = [
    { hours: 1, label: 'Son 1 saat', slug: '1h' },
    { hours: 6, label: 'Son 6 saat', slug: '6h' },
    { hours: 24, label: 'Son 24 saat', slug: '24h' },
    { hours: 72, label: 'Son 3 gün', slug: '3d' },
    { hours: 168, label: 'Son 1 hafta', slug: '1w' },
    { hours: 720, label: 'Son 1 ay', slug: '1m' },
    { hours: 1440, label: 'Son 2 ay', slug: '2m' },
    { hours: 2160, label: 'Son 3 ay', slug: '3m' },
    { hours: 4320, label: 'Son 6 ay', slug: '6m' },
    { hours: 8760, label: 'Son 1 yıl', slug: '1y' },
];

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

function fmtNum(n: number): string {
    if (!Number.isFinite(n)) return '-';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
}

function StatementsTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const navigate = useNavigate();
    const [mode, setMode] = useState<ViewMode>('summary');
    const [sortKeys, setSortKeys] = useState<SortKey[]>([{ col: 'total_exec_time_ms', dir: 'desc' }]);
    const orderParam = sortKeysToParam(sortKeys);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const [datname, setDatname] = useState('');
    const [rolname, setRolname] = useState('');
    const [sqlSearch, setSqlSearch] = useState('');
    const [minAvgMs, setMinAvgMs] = useState('');
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);

    const { selected: selectedCols, setSelected: setSelectedCols, meta: colsMeta } = useStatementColumns();
    const rawStmtMeta = useMemo<ColumnsMeta | undefined>(() => {
        if (!colsMeta) return undefined;
        return {
            defaults: ['sample_ts', 'datname', 'rolname', 'queryid', 'query_text_short', ...colsMeta.defaults],
            available: [
                { key: 'sample_ts', label: 'Zaman', since: 11 },
                { key: 'datname', label: 'Database', since: 11 },
                { key: 'rolname', label: 'Rol', since: 11 },
                { key: 'queryid', label: 'Query ID', since: 11 },
                { key: 'query_text_short', label: 'SQL', since: 11 },
                ...colsMeta.available,
            ],
        };
    }, [colsMeta]);
    const { selected: rawSelectedCols, setSelected: setRawSelectedCols } = useDataColumns(
        'pgstat.instance.statements.raw.cols',
        ['sample_ts', 'datname', 'rolname', 'queryid', 'query_text_short', ...((colsMeta?.defaults) ?? [])],
        rawStmtMeta
    );
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.statements.widths');

    const qp = new URLSearchParams({
        from: range.fromIso,
        to: range.toIso,
        limit: '100',
        order_by: orderParam,
        columns: selectedCols.join(','),
        ...(datname ? { datname } : {}),
        ...(rolname ? { rolname } : {}),
    });

    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-top-stmts', instancePk, range.fromIso, range.toIso, orderParam, datname, rolname, selectedCols.join(',')],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/statements?${qp}`),
        enabled: Number.isFinite(instancePk),
    });

    // Secili kolonlar degisirse sort kriterlerini temizle
    useEffect(() => {
        setSortKeys(prev => {
            const filtered = prev.filter(s => selectedCols.includes(s.col));
            if (filtered.length > 0) return filtered;
            const fallback = selectedCols.includes('total_exec_time_ms') ? 'total_exec_time_ms' : selectedCols[0];
            return [{ col: fallback, dir: 'desc' }];
        });
    }, [selectedCols]);

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
            if (q && !(r.query_text_short ?? r.query_text ?? '').toLowerCase().includes(q)) return false;
            if (minMs > 0) {
                const mean = Number(r.mean_exec_time_ms ?? r.avg_exec_time_ms ?? 0);
                if (mean < minMs) return false;
            }
            return true;
        });
    }, [data, sqlSearch, minAvgMs]);

    const hasFilter = datname || rolname || sqlSearch || minAvgMs;

    if (isLoading) return <SkeletonTable rows={5} cols={6} />;

    if (mode === 'raw') {
        const rawParams: Record<string, string> = { from: range.fromIso, to: range.toIso };
        if (datname) rawParams.datname = datname;
        if (rolname) rawParams.rolname = rolname;
        return (
            <div>
                <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                    <div className="flex flex-wrap gap-3 items-end">
                        <ViewModeToggle mode={mode} onChange={setMode} />
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
                    </div>
                </div>
                <RawDeltaTable
                    basePath={`/instances/${instancePk}/statements/raw`}
                    baseParams={rawParams}
                    queryKey={['instance-statements-raw', instancePk, range.fromIso, range.toIso, datname, rolname, mode]}
                    selectedCols={rawSelectedCols}
                    setSelectedCols={setRawSelectedCols}
                    meta={rawStmtMeta}
                    pgMajor={pgMajor}
                    storageKey="pgstat.instance.statements.raw"
                    emptyTitle="Ham statement delta satırı yok"
                />
            </div>
        );
    }

    return (
        <div>
            <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                <div className="flex flex-wrap gap-3 items-end">
                    <ViewModeToggle mode={mode} onChange={setMode} />
                    <div className="text-[10px] text-[#94A3B8]">
                        Zaman aralığı sayfanın üstündeki seçicidir.
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
                        <button onClick={() => setColumnsModalOpen(true)}
                            className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]"
                            title="Görmek istediğiniz kolonları seçin">
                            ⚙️ Sütun ({selectedCols.length})
                        </button>
                        <button onClick={resetWidths}
                            className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]"
                            title="Kolon genişliklerini varsayılana döndür">
                            ↔ Genişlik
                        </button>
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
                        <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                            <thead>
                                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                    <ResizableTh colKey="db_rol" width={widths['db_rol'] ?? 140} onResize={setWidth}
                                        className="py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">DB / Rol</ResizableTh>
                                    <ResizableTh colKey="sql" width={widths['sql'] ?? 360} onResize={setWidth}
                                        className="py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">SQL</ResizableTh>
                                    {selectedCols.map(col => {
                                        const meta = colsMeta?.available.find(c => c.key === col);
                                        return (
                                            <ResizableTh key={col} colKey={col} width={widths[col] ?? 120} onResize={setWidth} align="right"
                                                sortKeys={sortKeys} onSortToggle={sortToggle}
                                                className="py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                                {meta?.label ?? col}
                                                {meta && meta.since > 11 && (
                                                    <span className="ml-1 text-[9px] font-normal text-[#94A3B8]">PG{meta.since}+</span>
                                                )}
                                            </ResizableTh>
                                        );
                                    })}
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((r: any, i: number) => {
                                    const meanMs = Number(r.mean_exec_time_ms ?? 0);
                                    const canOpen = Boolean(r.statement_series_id);
                                    return (
                                        <tr key={r.statement_series_id ?? i}
                                            onClick={() => canOpen && navigate(`/statements/${r.statement_series_id}`)}
                                            className={`border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors ${canOpen ? 'cursor-pointer' : ''}`}>
                                            <td className="py-2.5 px-3 text-xs whitespace-nowrap">
                                                <div className="text-[#1E293B]">{r.datname ?? '-'}</div>
                                                <div className="text-[#94A3B8]">{r.rolname ?? '-'}</div>
                                            </td>
                                            <td className="py-2.5 px-3 max-w-xs">
                                                <StatementSqlCell
                                                    queryTextId={r.query_text_id ?? null}
                                                    short={r.query_text_short ?? r.query_text ?? null}
                                                />
                                            </td>
                                            {selectedCols.map(col => {
                                                const v = r[col];
                                                let cls = 'text-[#64748B]';
                                                if (col === 'mean_exec_time_ms') {
                                                    cls = meanMs >= 1000 ? 'text-red-600 font-semibold'
                                                        : meanMs >= 100 ? 'text-amber-600 font-semibold' : 'text-[#64748B]';
                                                }
                                                if (col === 'total_temp_blks_written' && Number(v) > 0) {
                                                    cls = 'text-amber-600 font-semibold';
                                                }
                                                return (
                                                    <td key={col} className={`py-2.5 px-3 text-right font-mono text-xs whitespace-nowrap ${cls}`}>
                                                        {fmtStmtValue(col, v)}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <StatementColumnsModal
                open={columnsModalOpen}
                onClose={() => setColumnsModalOpen(false)}
                selected={selectedCols}
                onChange={setSelectedCols}
                meta={colsMeta}
                pgMajor={pgMajor}
            />
        </div>
    );
}

function DatabasesTab({ instancePk, range, pgMajor, onSelectDb }: { instancePk: number; range: TimeRange; pgMajor?: number; onSelectDb?: (dbid: number) => void }) {
    const [mode, setMode] = useState<ViewMode>('summary');
    const [sortKeys, setSortKeys] = useState<SortKey[]>([{ col: 'xact_commit_delta', dir: 'desc' }]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const [search, setSearch] = useState('');
    const orderParam = sortKeysToParam(sortKeys);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const defaults = ['datname', 'xact_commit_delta', 'xact_rollback_delta', 'blks_read_delta', 'blks_hit_delta', 'deadlocks_delta', 'temp_bytes_delta'];
    const { data: colsMeta } = useQuery<ColumnsMeta>({
        queryKey: ['database-stats-cols-meta', instancePk],
        queryFn: () => apiGet(`/instances/${instancePk}/databases/stats/columns`),
        staleTime: 3600_000,
    });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns('pgstat.instance.databases.cols', defaults, colsMeta);
    const rawMeta = useMemo(() => withSampleTsMeta(colsMeta, ['sample_ts', ...defaults]), [colsMeta]);
    const { selected: rawSelectedCols, setSelected: setRawSelectedCols } = useDataColumns('pgstat.instance.databases.raw.cols', ['sample_ts', ...defaults], rawMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.databases.widths');
    const queryCols = Array.from(new Set(['dbid', 'datname', ...selectedCols]));
    const qp = new URLSearchParams({ from: range.fromIso, to: range.toIso, columns: queryCols.join(','), order_by: orderParam });
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-database-stats', instancePk, range.fromIso, range.toIso, orderParam, queryCols.join(',')],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/databases/stats?${qp}`),
        enabled: Number.isFinite(instancePk),
    });

    useEffect(() => {
        setSortKeys(prev => {
            const filtered = prev.filter(s => selectedCols.includes(s.col));
            if (filtered.length > 0) return filtered;
            const fallback = selectedCols.includes('xact_commit_delta') ? 'xact_commit_delta' : selectedCols[0];
            return [{ col: fallback, dir: 'desc' }];
        });
    }, [selectedCols]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return data ?? [];
        return (data ?? []).filter((r: any) => String(r.datname ?? '').toLowerCase().includes(q));
    }, [data, search]);

    if (mode === 'raw') {
        return (
            <div>
                <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                    <ViewModeToggle mode={mode} onChange={setMode} />
                </div>
                <RawDeltaTable
                    basePath={`/instances/${instancePk}/databases/stats`}
                    baseParams={{ from: range.fromIso, to: range.toIso }}
                    queryKey={['instance-database-stats-raw', instancePk, range.fromIso, range.toIso, mode]}
                    selectedCols={rawSelectedCols}
                    setSelectedCols={setRawSelectedCols}
                    meta={rawMeta}
                    pgMajor={pgMajor}
                    storageKey="pgstat.instance.databases.raw"
                    emptyTitle="Ham database delta satırı yok"
                    requiredQueryCols={['dbid']}
                    onRowClick={onSelectDb ? (row) => onSelectDb(Number(row.dbid)) : undefined}
                />
            </div>
        );
    }

    if (isLoading) return <SkeletonTable rows={5} cols={selectedCols.length || 7} />;

    return (
        <div>
            <DataKindBanner kind="delta" description="DELTA (periyot toplamı): seçili tarih aralığındaki pg_database_delta kayıtları database bazında toplanır. Satıra tıklayınca ilgili database için Tables tab'ına geçilir." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <ViewModeToggle mode={mode} onChange={setMode} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Database ara"
                    className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]" />
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{filtered.length} database</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {filtered.length === 0 ? <EmptyState icon="🗄️" title="Database istatistiği yok" description="Bu aralıkta pg_database_delta verisi yok." /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                            <thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                {selectedCols.map(col => {
                                    const m = colsMeta?.available.find(c => c.key === col);
                                    return <ResizableTh key={col} colKey={col} width={widths[col] ?? (col === 'datname' ? 190 : 140)} onResize={setWidth} align={col === 'datname' ? 'left' : 'right'} sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{m?.label ?? col}{m && m.since > 11 && <span className="ml-1 text-[9px] text-[#94A3B8]">PG{m.since}+</span>}</ResizableTh>;
                                })}
                            </tr></thead>
                            <tbody>{filtered.map((r: any, i: number) => (
                                <tr key={`${r.dbid ?? 'db'}-${i}`} onClick={() => onSelectDb?.(Number(r.dbid))}
                                    className={`border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors ${onSelectDb ? 'cursor-pointer' : ''}`}>
                                    {selectedCols.map(col => (
                                        <td key={col} className={`py-2 px-3 text-xs whitespace-nowrap truncate ${col === 'datname' ? '' : 'text-right font-mono'}`}>
                                            {col === 'datname' ? (r[col] ?? '—') : fmtValue(col, r[col])}
                                        </td>
                                    ))}
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ Database Sütunları" />
        </div>
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

function TableStatsTab({ instancePk, initialDbid, range }: { instancePk: number; initialDbid: number | null; range: TimeRange }) {
    const [mode, setMode] = useState<ViewMode>('summary');
    const [orderBy, setOrderBy] = useState('seq_scan');
    const [dbFilter, setDbFilter] = useState('');
    const [search, setSearch] = useState('');
    const [minValue, setMinValue] = useState('');
    const { data: colsMeta } = useQuery<ColumnsMeta>({ queryKey: ['table-stats-cols-meta', instancePk], queryFn: () => apiGet(`/instances/${instancePk}/tables/columns`), staleTime: 3600_000 });
    const rawMeta = useMemo(() => withSampleTsMeta(colsMeta, ['sample_ts', 'dbid', 'datname', 'schemaname', 'relname', 'total_seq_scan', 'total_idx_scan', 'total_inserts', 'total_updates', 'total_deletes', 'total_heap_blks_read', 'total_heap_blks_hit', 'n_live_tup', 'n_dead_tup']), [colsMeta]);
    const { selected: rawSelectedCols, setSelected: setRawSelectedCols } = useDataColumns(
        'pgstat.instance.tables.raw.cols',
        ['sample_ts', 'dbid', 'datname', 'schemaname', 'relname', 'total_seq_scan', 'total_idx_scan', 'total_inserts', 'total_updates', 'total_deletes', 'total_heap_blks_read', 'total_heap_blks_hit', 'n_live_tup', 'n_dead_tup'],
        rawMeta
    );

    useEffect(() => {
        if (initialDbid) setDbFilter(String(initialDbid));
    }, [initialDbid]);

    const tables = useQuery({
        queryKey: ['instance-tables', instancePk, range.fromIso, range.toIso],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/tables?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}`),
        enabled: Number.isFinite(instancePk),
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
                if (dbFilter && String(r.dbid) !== dbFilter) return false;
                if (q && !`${r.datname || ''}.${r.schemaname || ''}.${r.relname || ''}`.toLowerCase().includes(q)) return false;
                if (min > 0 && metricValue(r) < min) return false;
                return true;
            })
            .sort((a: any, b: any) => metricValue(b) - metricValue(a));
    }, [tables.data, dbFilter, search, minValue, orderBy]);

    const databases = useMemo(() => {
        const map = new Map<string, string>();
        for (const r of tables.data || []) map.set(String(r.dbid), r.datname || String(r.dbid));
        return Array.from(map.entries()).map(([dbid, datname]) => ({ dbid, datname })).sort((a, b) => a.datname.localeCompare(b.datname));
    }, [tables.data]);

    const hasFilter = dbFilter || search || minValue;

    if (mode === 'raw') {
        const rawBasePath = dbFilter ? `/instances/${instancePk}/databases/${dbFilter}/tables` : `/instances/${instancePk}/tables`;
        return (
            <div>
                <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                    <div className="flex flex-wrap gap-3 items-end">
                        <ViewModeToggle mode={mode} onChange={setMode} />
                        <div>
                            <label className="block text-xs text-[#64748B] mb-1">Database</label>
                            <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
                                className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[140px]">
                                <option value="">Tümü</option>
                                {databases.map(d => <option key={d.dbid} value={d.dbid}>{d.datname}</option>)}
                            </select>
                        </div>
                    </div>
                </div>
                <RawDeltaTable
                    basePath={rawBasePath}
                    baseParams={{ from: range.fromIso, to: range.toIso }}
                    queryKey={['instance-tables-raw', instancePk, dbFilter, range.fromIso, range.toIso, mode]}
                    selectedCols={rawSelectedCols}
                    setSelectedCols={setRawSelectedCols}
                    meta={rawMeta}
                    storageKey="pgstat.instance.tables.raw"
                    emptyTitle="Ham tablo delta satırı yok"
                />
            </div>
        );
    }

    return (
        <div>
            <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                <div className="flex flex-wrap gap-3 items-end">
                    <ViewModeToggle mode={mode} onChange={setMode} />
                    <div className="text-[10px] text-[#94A3B8]">
                        Zaman aralığı sayfanın üstündeki seçicidir.
                    </div>
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Database</label>
                        <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
                            className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[140px]">
                            <option value="">Tümü</option>
                            {databases.map(d => <option key={d.dbid} value={d.dbid}>{d.datname}</option>)}
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
                            <button onClick={() => { setDbFilter(''); setSearch(''); setMinValue(''); }}
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
                                        <tr key={`${r.dbid}-${r.relid}`} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors">
                                            <td className="py-2.5 px-3 text-xs">
                                                <div className="text-[#94A3B8]">{r.datname || '-'} / {r.schemaname || '-'}</div>
                                                <div className="font-medium text-[#1E293B]">{r.relname || '-'}</div>
                                            </td>
                                            <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">{fmtNum(statNumber(r.total_seq_scan))}</td>
                                            <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">{fmtNum(statNumber(r.total_idx_scan))}</td>
                                            <td className="py-2.5 px-3 text-right font-mono text-xs">
                                                <div className={writes > 0 ? 'text-[#1E293B]' : 'text-[#94A3B8]'}>{fmtNum(writes)}</div>
                                                <div className="text-[10px] text-[#94A3B8]">I {fmtNum(statNumber(r.total_inserts))} / U {fmtNum(statNumber(r.total_updates))} / D {fmtNum(statNumber(r.total_deletes))}</div>
                                            </td>
                                            <td className="py-2.5 px-3 text-right font-mono text-xs">
                                                <div title="R: diskten okunan blok / H: cache'te bulunan blok">
                                                    {fmtNum(statNumber(r.total_heap_blks_read))} <span className="text-[#94A3B8]">disk</span> /
                                                    {fmtNum(statNumber(r.total_heap_blks_hit))} <span className="text-[#94A3B8]">cache</span>
                                                </div>
                                                <div className={ratio < 95 ? 'text-amber-600' : 'text-green-600'} title="Cache hit ratio">{ratio.toFixed(1)}%</div>
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
        </div>
    );
}

function IndexStatsTab({ instancePk, initialDbid, range }: { instancePk: number; initialDbid: number | null; range: TimeRange }) {
    const [mode, setMode] = useState<ViewMode>('summary');
    const [orderBy, setOrderBy] = useState('idx_scan');
    const [dbFilter, setDbFilter] = useState('');
    const [search, setSearch] = useState('');
    const [minValue, setMinValue] = useState('');
    const [indexState, setIndexState] = useState<'all' | 'unused' | 'invalid'>('all');
    const { data: colsMeta } = useQuery<ColumnsMeta>({ queryKey: ['index-stats-cols-meta', instancePk], queryFn: () => apiGet(`/instances/${instancePk}/indexes/columns`), staleTime: 3600_000 });
    const rawMeta = useMemo(() => withSampleTsMeta(colsMeta, ['sample_ts', 'dbid', 'datname', 'schemaname', 'table_relname', 'index_relname', 'total_idx_scan', 'total_idx_tup_read', 'total_idx_tup_fetch', 'total_idx_blks_read', 'total_idx_blks_hit', 'is_valid', 'is_ready', 'is_primary', 'is_unique']), [colsMeta]);
    const { selected: rawSelectedCols, setSelected: setRawSelectedCols } = useDataColumns(
        'pgstat.instance.indexes.raw.cols',
        ['sample_ts', 'dbid', 'datname', 'schemaname', 'table_relname', 'index_relname', 'total_idx_scan', 'total_idx_tup_read', 'total_idx_tup_fetch', 'total_idx_blks_read', 'total_idx_blks_hit', 'is_valid', 'is_ready', 'is_primary', 'is_unique'],
        rawMeta
    );

    useEffect(() => {
        if (initialDbid) setDbFilter(String(initialDbid));
    }, [initialDbid]);

    const indexes = useQuery({
        queryKey: ['instance-indexes', instancePk, range.fromIso, range.toIso, indexState],
        queryFn: () => {
            const stateParam = indexState === 'unused'
                ? '&unused=true&limit=10000'
                : indexState === 'invalid'
                    ? '&invalid=true&limit=10000'
                    : '';
            return apiGet<any[]>(`/instances/${instancePk}/indexes?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${stateParam}`);
        },
        enabled: Number.isFinite(instancePk),
    });

    const isUnusedIndex = (r: any) => statNumber(r.total_idx_scan) === 0 && r.unused_window_covered === true;
    const isInvalidIndex = (r: any) => r.is_valid === false || r.is_ready === false;

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
                if (dbFilter && String(r.dbid) !== dbFilter) return false;
                if (indexState === 'unused' && !isUnusedIndex(r)) return false;
                if (indexState === 'invalid' && !isInvalidIndex(r)) return false;
                if (q && !`${r.datname || ''}.${r.schemaname || ''}.${r.table_relname || ''}.${r.index_relname || ''}`.toLowerCase().includes(q)) return false;
                if (min > 0 && metricValue(r) < min) return false;
                return true;
            })
            .sort((a: any, b: any) => metricValue(b) - metricValue(a));
    }, [indexes.data, dbFilter, search, minValue, orderBy, indexState]);

    const databases = useMemo(() => {
        const map = new Map<string, string>();
        for (const r of indexes.data || []) map.set(String(r.dbid), r.datname || String(r.dbid));
        return Array.from(map.entries()).map(([dbid, datname]) => ({ dbid, datname })).sort((a, b) => a.datname.localeCompare(b.datname));
    }, [indexes.data]);

    const hasFilter = dbFilter || search || minValue || indexState !== 'all';
    const unusedCount = useMemo(() => (indexes.data || []).filter(isUnusedIndex).length, [indexes.data]);
    const invalidCount = useMemo(() => (indexes.data || []).filter(isInvalidIndex).length, [indexes.data]);
    const selectedDatabase = databases.find(d => d.dbid === dbFilter)?.datname;
    // Range'den okunabilir label ve dosya adı slug'ı türet
    const _rangeHours = Math.max(1, Math.round((new Date(range.toIso).getTime() - new Date(range.fromIso).getTime()) / 3600_000));
    const selectedRange = INDEX_TIME_RANGES.find(r => r.hours === _rangeHours) || {
        hours: _rangeHours,
        label: _rangeHours >= 24 ? `Son ${Math.round(_rangeHours / 24)} gün` : `Son ${_rangeHours} saat`,
        slug: `${_rangeHours}h`,
    };

    if (mode === 'raw') {
        const rawBasePath = dbFilter ? `/instances/${instancePk}/databases/${dbFilter}/indexes` : `/instances/${instancePk}/indexes`;
        const rawParams: Record<string, string> = { from: range.fromIso, to: range.toIso };
        if (!dbFilter && indexState === 'unused') rawParams.unused = 'true';
        if (indexState === 'invalid') rawParams.invalid = 'true';
        return (
            <div>
                <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                    <div className="flex flex-wrap gap-3 items-end">
                        <ViewModeToggle mode={mode} onChange={setMode} />
                        <div>
                            <label className="block text-xs text-[#64748B] mb-1">Database</label>
                            <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
                                className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[140px]">
                                <option value="">Tümü</option>
                                {databases.map(d => <option key={d.dbid} value={d.dbid}>{d.datname}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs text-[#64748B] mb-1">Durum</label>
                            <select value={indexState} onChange={e => setIndexState(e.target.value as 'all' | 'unused' | 'invalid')}
                                className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[145px]">
                                <option value="all">Tüm indexler</option>
                                <option value="unused">Unused only</option>
                                <option value="invalid">Invalid / not-ready</option>
                            </select>
                        </div>
                    </div>
                </div>
                <RawDeltaTable
                    basePath={rawBasePath}
                    baseParams={rawParams}
                    queryKey={['instance-indexes-raw', instancePk, dbFilter, indexState, range.fromIso, range.toIso, mode]}
                    selectedCols={rawSelectedCols}
                    setSelectedCols={setRawSelectedCols}
                    meta={rawMeta}
                    storageKey="pgstat.instance.indexes.raw"
                    emptyTitle="Ham index delta satırı yok"
                />
            </div>
        );
    }

    const exportExcel = () => {
        const headers = ['database', 'schema', 'table', 'index', 'status', 'is_valid', 'is_ready', 'is_primary', 'is_unique', 'idx_scan', 'idx_tup_read', 'idx_tup_fetch', 'idx_blks_read', 'idx_blks_hit', 'hit_ratio_pct', 'observed_since', 'observed_until', 'observed_hours', 'unused_window_covered'];
        const rows = filtered.map((r: any) => [
            r.datname || '',
            r.schemaname || '',
            r.table_relname || '',
            r.index_relname || '',
            isInvalidIndex(r) ? 'invalid_or_not_ready' : isUnusedIndex(r) ? 'unused' : 'ok',
            r.is_valid === false ? 'no' : 'yes',
            r.is_ready === false ? 'no' : 'yes',
            r.is_primary === true ? 'yes' : 'no',
            r.is_unique === true ? 'yes' : 'no',
            statNumber(r.total_idx_scan),
            statNumber(r.total_idx_tup_read),
            statNumber(r.total_idx_tup_fetch),
            statNumber(r.total_idx_blks_read),
            statNumber(r.total_idx_blks_hit),
            hitRatio(r.total_idx_blks_read, r.total_idx_blks_hit).toFixed(2),
            r.observed_since || '',
            r.observed_until || '',
            r.observed_hours ?? '',
            r.unused_window_covered === true ? 'yes' : 'no',
        ]);
        const tableRows = [headers, ...rows]
            .map(row => `<tr>${row.map(cell => `<td>${excelCell(cell)}</td>`).join('')}</tr>`)
            .join('');
        const workbook = `<!doctype html><html><head><meta charset="utf-8" /></head><body><table>${tableRows}</table></body></html>`;
        const scope = selectedDatabase || `instance-${instancePk}`;
        const exportKind = indexState === 'invalid' ? 'invalid-indexes' : indexState === 'unused' ? 'unused-indexes' : 'indexes';
        downloadText(`pgstat-${exportKind}-${safeFileName(scope)}-${selectedRange.slug}.xls`, workbook, 'application/vnd.ms-excel;charset=utf-8');
    };

    return (
        <div>
            <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                <div className="flex flex-wrap gap-3 items-end">
                    <ViewModeToggle mode={mode} onChange={setMode} />
                    <div className="text-[10px] text-[#94A3B8]">
                        Zaman aralığı sayfanın üstündeki seçicidir.
                    </div>
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Database</label>
                        <select value={dbFilter} onChange={e => setDbFilter(e.target.value)}
                            className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[140px]">
                            <option value="">Tümü</option>
                            {databases.map(d => <option key={d.dbid} value={d.dbid}>{d.datname}</option>)}
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
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Durum</label>
                        <select value={indexState} onChange={e => setIndexState(e.target.value as 'all' | 'unused' | 'invalid')}
                            className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[145px]">
                            <option value="all">Tüm indexler</option>
                            <option value="unused">Unused only</option>
                            <option value="invalid">Invalid / not-ready</option>
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
                            <button onClick={() => { setDbFilter(''); setSearch(''); setMinValue(''); setIndexState('all'); }}
                                className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                                Temizle
                            </button>
                        )}
                        <button onClick={exportExcel} disabled={filtered.length === 0}
                            className="px-3 py-1.5 text-sm text-[#2563EB] border border-[#BFDBFE] rounded hover:bg-[#EFF6FF] disabled:opacity-50 disabled:cursor-not-allowed">
                            Excel Export
                        </button>
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
                <div className="mt-3 text-xs text-[#64748B]">
                    Unused kriteri: {selectedRange.label} içinde idx_scan = 0 ve pencereyi kapsayan yeterli gözlem datası var. Invalid kriteri son snapshot'ta indisvalid=false veya indisready=false olmasıdır. Kanıtlı unused: {unusedCount}, invalid/not-ready: {invalidCount}.
                </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {indexes.isLoading ? <SkeletonTable rows={5} cols={7} /> : filtered.length === 0 ? (
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
                                    <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Status</th>
                                    <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Hit Ratio</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((r: any) => {
                                    const ratio = hitRatio(r.total_idx_blks_read, r.total_idx_blks_hit);
                                    const invalid = isInvalidIndex(r);
                                    const unused = isUnusedIndex(r);
                                    return (
                                        <tr key={`${r.dbid}-${r.index_relid}`} className={`border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors ${invalid ? 'bg-red-50/60' : unused ? 'bg-amber-50/40' : ''}`}>
                                            <td className="py-2.5 px-3 text-xs">
                                                <div className="text-[#94A3B8]">{r.datname || '-'} / {r.schemaname || '-'}</div>
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
                                            <td className="py-2.5 px-3 text-right font-mono text-xs"
                                                title="disk: diskten okunan blok / cache: cache'te bulunan blok">
                                                <div>{fmtNum(statNumber(r.total_idx_blks_read))} <span className="text-[#94A3B8]">disk</span></div>
                                                <div className="text-[#94A3B8]">{fmtNum(statNumber(r.total_idx_blks_hit))} cache</div>
                                            </td>
                                            <td className="py-2.5 px-3 text-xs">
                                                {invalid ? (
                                                    <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700">Invalid / not-ready</span>
                                                ) : unused ? (
                                                    <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">Unused</span>
                                                ) : (
                                                    <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 font-semibold text-green-700">OK</span>
                                                )}
                                                <div className="mt-1 text-[10px] text-[#94A3B8]">
                                                    valid={r.is_valid === false ? 'no' : 'yes'} ready={r.is_ready === false ? 'no' : 'yes'}
                                                </div>
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

function isFullPackageTextCol(col: string): boolean {
    return col === 'sample_ts'
        || col === 'datname'
        || col === 'schemaname'
        || col === 'relname'
        || col === 'funcname'
        || col === 'name'
        || col === 'current_wal_lsn'
        || col === 'current_wal_file';
}

function fullPackageCell(col: string, val: any) {
    if (col === 'sample_ts') return val ? <TimeAgo date={val} /> : '-';
    if (val == null || val === '') return '-';
    return fmtValue(col, val);
}

function FullPackageTable({
    rows,
    selectedCols,
    colsMeta,
    pgMajor,
    widths,
    setWidth,
    sortKeys,
    onSortToggle,
    emptyTitle,
}: {
    rows: any[];
    selectedCols: string[];
    colsMeta: ColumnsMeta | undefined;
    pgMajor?: number;
    widths: Record<string, number>;
    setWidth: (col: string, width: number) => void;
    sortKeys: SortKey[];
    onSortToggle: (col: string, additive: boolean) => void;
    emptyTitle: string;
}) {
    if (rows.length === 0) {
        return <EmptyState icon="i" title={emptyTitle} description="Secili filtrelerle eslesen kayit bulunamadi." />;
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                <thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                    {selectedCols.map(col => {
                        const meta = colsMeta?.available.find(c => c.key === col);
                        const align = isFullPackageTextCol(col) ? 'left' : 'right';
                        return (
                            <ResizableTh
                                key={col}
                                colKey={col}
                                width={widths[col] ?? (isFullPackageTextCol(col) ? 180 : 140)}
                                onResize={setWidth}
                                align={align}
                                sortKeys={sortKeys}
                                onSortToggle={onSortToggle}
                                className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase"
                            >
                                {meta?.label ?? col}
                                {meta && pgMajor && meta.since > pgMajor && <span className="ml-1 text-[9px] text-[#94A3B8]">PG{meta.since}+</span>}
                            </ResizableTh>
                        );
                    })}
                </tr></thead>
                <tbody>{rows.map((r: any, i: number) => (
                    <tr key={`${r.sample_ts ?? r.relid ?? r.funcid ?? r.name ?? 'row'}-${i}`} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors">
                        {selectedCols.map(col => (
                            <td key={col} className={`py-2 px-3 text-xs whitespace-nowrap truncate ${isFullPackageTextCol(col) ? '' : 'text-right font-mono'}`}>
                                {fullPackageCell(col, r[col])}
                            </td>
                        ))}
                    </tr>
                ))}</tbody>
            </table>
        </div>
    );
}

function DeltaStatsFullPackageTab({
    instancePk,
    range,
    pgMajor,
    resource,
    title,
    defaults,
    storageBase,
    defaultSort,
    emptyTitle,
}: {
    instancePk: number;
    range: TimeRange;
    pgMajor?: number;
    resource: 'functions' | 'sequences' | 'slru' | 'stat-wal';
    title: string;
    defaults: string[];
    storageBase: string;
    defaultSort: SortKey;
    emptyTitle: string;
}) {
    const [mode, setMode] = useState<ViewMode>('summary');
    const [sortKeys, setSortKeys] = useState<SortKey[]>([defaultSort]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const orderParam = sortKeysToParam(sortKeys);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({
        queryKey: [`${resource}-columns-meta`, instancePk],
        queryFn: () => apiGet(`/instances/${instancePk}/${resource}/columns`),
        staleTime: 3600_000,
    });
    const rawDefaults = useMemo(() => ['sample_ts', ...defaults], [defaults]);
    const rawMeta = useMemo(() => withSampleTsMeta(colsMeta, rawDefaults), [colsMeta, rawDefaults]);
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns(`${storageBase}.cols`, defaults, colsMeta);
    const { selected: rawSelectedCols, setSelected: setRawSelectedCols } = useDataColumns(`${storageBase}.raw.cols`, rawDefaults, rawMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths(`${storageBase}.widths`);
    const qp = new URLSearchParams({ columns: selectedCols.join(','), order_by: orderParam, from: range.fromIso, to: range.toIso });
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: [`instance-${resource}`, instancePk, range.fromIso, range.toIso, selectedCols.join(','), orderParam],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/${resource}?${qp}`),
        enabled: Number.isFinite(instancePk) && mode === 'summary',
    });
    const rows = data || [];

    if (mode === 'raw') {
        return (
            <div className="space-y-3">
                <DataKindBanner kind="delta" description="Ham Delta: kayitlar sample_ts bazinda, toplama yapilmadan listelenir." />
                <div className="bg-white rounded-lg shadow-sm p-3 flex flex-wrap gap-2 items-center">
                    <ViewModeToggle mode={mode} onChange={setMode} />
                </div>
                <RawDeltaTable
                    basePath={`/instances/${instancePk}/${resource}`}
                    baseParams={{ from: range.fromIso, to: range.toIso }}
                    queryKey={[`instance-${resource}-raw`, instancePk, range.fromIso, range.toIso, mode]}
                    selectedCols={rawSelectedCols}
                    setSelectedCols={setRawSelectedCols}
                    meta={rawMeta}
                    pgMajor={pgMajor}
                    storageKey={`${storageBase}.raw`}
                    emptyTitle={`Ham ${title} delta satiri yok`}
                />
            </div>
        );
    }

    if (isLoading) return <SkeletonTable rows={5} cols={selectedCols.length || defaults.length} />;

    return (
        <div className="space-y-3">
            <DataKindBanner kind="delta" description="DELTA (periyot toplami): secili tarih araligindaki metrikler toplanarak gosterilir." />
            <div className="bg-white rounded-lg shadow-sm p-3 flex flex-wrap gap-2 items-center">
                <ViewModeToggle mode={mode} onChange={setMode} />
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">Sutun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">Genislik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{rows.length} kayit</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                <FullPackageTable rows={rows} selectedCols={selectedCols} colsMeta={colsMeta} pgMajor={pgMajor} widths={widths} setWidth={setWidth} sortKeys={sortKeys} onSortToggle={sortToggle} emptyTitle={emptyTitle} />
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title={`${title} Sutunlari`} />
        </div>
    );
}

function StorageFullPackageTab({ instancePk, pgMajor }: { instancePk: number; pgMajor?: number }) {
    const defaults = ['datname', 'schemaname', 'relname', 'total_size_bytes', 'table_size_bytes', 'index_size_bytes'];
    const [sortKeys, setSortKeys] = useState<SortKey[]>([{ col: 'total_size_bytes', dir: 'desc' }]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const orderParam = sortKeysToParam(sortKeys);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({
        queryKey: ['storage-columns-meta', instancePk],
        queryFn: () => apiGet(`/instances/${instancePk}/storage/columns`),
        staleTime: 3600_000,
    });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns('pgstat.instance.storage.cols', defaults, colsMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.storage.widths');
    const qp = new URLSearchParams({ columns: selectedCols.join(','), order_by: orderParam });
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-storage', instancePk, selectedCols.join(','), orderParam],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/storage?${qp}`),
        enabled: Number.isFinite(instancePk),
    });
    const rows = data || [];
    const totalBytes = rows.reduce((sum, r: any) => sum + Number(r.total_size_bytes || 0), 0);

    if (isLoading) return <SkeletonTable rows={5} cols={selectedCols.length || defaults.length} />;

    return (
        <div className="space-y-4">
            <DataKindBanner kind="snapshot" description="Storage satirlari collector'daki en son pg_relation_size snapshot'indan okunur. Degerler anliktir, delta degildir." />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <InfoCard label="Toplam Relation Boyutu" value={fmtBytes(totalBytes)} />
                <InfoCard label="Relation" value={rows.length.toLocaleString()} />
                <InfoCard label="Database" value={new Set(rows.map((r: any) => r.datname).filter(Boolean)).size.toLocaleString()} />
            </div>
            <div className="bg-white rounded-lg shadow-sm p-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">Sutun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">Genislik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{rows.length} relation</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                <FullPackageTable rows={rows} selectedCols={selectedCols} colsMeta={colsMeta} pgMajor={pgMajor} widths={widths} setWidth={setWidth} sortKeys={sortKeys} onSortToggle={sortToggle} emptyTitle="Storage snapshot verisi yok" />
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="Storage Sutunlari" />
        </div>
    );
}

function StorageTab({ instancePk, pgMajor }: { instancePk: number; pgMajor?: number }) {
    return <StorageFullPackageTab instancePk={instancePk} pgMajor={pgMajor} />;
}

function fmtBytes(value: any): string {
    const bytes = Number(value || 0);
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes.toLocaleString()} B`;
}

function isSnapshotNumericCol(col: string): boolean {
    return col === 'pid'
        || col === 'datid'
        || col === 'usesysid'
        || col === 'leader_pid'
        || col === 'client_port'
        || col === 'query_id'
        || col === 'sync_priority'
        || col.endsWith('_bytes');
}

function isSnapshotTimeCol(col: string): boolean {
    return col.endsWith('_time')
        || col.endsWith('_start')
        || col === 'query_start'
        || col === 'xact_start'
        || col === 'state_change'
        || col === 'backend_start';
}

function formatSnapshotCell(col: string, val: any) {
    if (val == null || val === '') return '—';
    if (isSnapshotTimeCol(col)) return <TimeAgo date={val} />;
    if (col === 'state' || col === 'sync_state') return <Badge value={String(val)} />;
    if (col === 'query') {
        return <div className="truncate font-mono text-[11px]" title={String(val)}>{String(val)}</div>;
    }
    if (typeof val === 'boolean') return val ? '✓' : '✕';
    if (typeof val === 'number' || isSnapshotNumericCol(col)) return fmtValue(col, val);
    return String(val);
}

function ActivityTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const [sortKeys, setSortKeys] = useState<SortKey[]>([{ col: 'query_start', dir: 'desc' }]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const orderParam = sortKeysToParam(sortKeys);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));

    const { data: colsMeta } = useQuery<ColumnsMeta>({
        queryKey: ['activity-columns-meta', instancePk],
        queryFn: () => apiGet(`/instances/${instancePk}/activity/columns`),
        staleTime: 3600_000,
    });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns(
        'pgstat.instance.activity.cols',
        ['pid', 'usename', 'datname', 'state', 'query_start', 'wait_event', 'query'],
        colsMeta
    );
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.activity.widths');
    const qp = new URLSearchParams({ columns: selectedCols.join(','), from: range.fromIso, to: range.toIso, order_by: orderParam });
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-activity', instancePk, range.fromIso, range.toIso, selectedCols.join(','), orderParam],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/activity?${qp}`),
        enabled: Number.isFinite(instancePk),
    });

    if (isLoading) return <SkeletonTable rows={5} cols={selectedCols.length || 7} />;

    return (
        <div>
            <DataKindBanner kind="snapshot" description="Activity satirlari secili tarih araligindaki en son pg_stat_activity snapshot'idir. Degerler anliktir, delta degildir." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{data?.length ?? 0} session</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="📋" title="Activity yok" description="Bu aralikta pg_stat_activity snapshot'i bulunmuyor." /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                            <thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                {selectedCols.map(col => {
                                    const meta = colsMeta?.available.find(c => c.key === col);
                                    return <ResizableTh key={col} colKey={col} width={widths[col] ?? (col === 'query' ? 320 : 130)} onResize={setWidth} align={isSnapshotNumericCol(col) ? 'right' : 'left'} sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{meta?.label ?? col}{meta && meta.since > 10 && <span className="ml-1 text-[9px] text-[#94A3B8]">PG{meta.since}+</span>}</ResizableTh>;
                                })}
                            </tr></thead>
                            <tbody>{data.map((r: any, i: number) => (
                                <tr key={`${r.pid ?? 'session'}-${i}`} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">
                                    {selectedCols.map(col => (
                                        <td key={col} className={`py-2 px-3 text-xs whitespace-nowrap truncate ${isSnapshotNumericCol(col) ? 'text-right font-mono' : ''}`}>
                                            {formatSnapshotCell(col, r[col])}
                                        </td>
                                    ))}
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ Activity Sütunları" />
        </div>
    );
}

function ReplicationTab({ instancePk, range, pgMajor, isPrimary }: { instancePk: number; range: TimeRange; pgMajor?: number; isPrimary: boolean | null | undefined }) {
    const [sortKeys, setSortKeys] = useState<SortKey[]>([{ col: 'replay_lag_bytes', dir: 'desc' }]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const orderParam = sortKeysToParam(sortKeys);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));

    const { data: colsMeta } = useQuery<ColumnsMeta>({
        queryKey: ['replication-columns-meta', instancePk],
        queryFn: () => apiGet(`/instances/${instancePk}/replication/columns`),
        staleTime: 3600_000,
        enabled: Number.isFinite(instancePk) && isPrimary === true,
    });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns(
        'pgstat.instance.replication.cols',
        ['usename', 'application_name', 'state', 'sync_state', 'write_lag', 'flush_lag', 'replay_lag', 'replay_lag_bytes'],
        colsMeta
    );
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.replication.widths');
    const qp = new URLSearchParams({ columns: selectedCols.join(','), from: range.fromIso, to: range.toIso, order_by: orderParam });
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-replication', instancePk, range.fromIso, range.toIso, selectedCols.join(','), orderParam],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/replication?${qp}`),
        enabled: Number.isFinite(instancePk) && isPrimary === true,
    });

    if (isPrimary !== true) {
        return <EmptyState icon="📡" title="Standby instance" description="Bu instance standby. pg_stat_replication yalnizca primary uzerinde dolar." />;
    }
    if (isLoading) return <SkeletonTable rows={5} cols={selectedCols.length || 8} />;

    return (
        <div>
            <DataKindBanner kind="snapshot" description="Replication satirlari secili tarih araligindaki en son pg_stat_replication snapshot'idir. Lag ve LSN degerleri anliktir, delta degildir." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{data?.length ?? 0} replica</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="📡" title="Replica baglantisi yok" description="Secili aralikta replication snapshot satiri bulunmuyor." /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                            <thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                {selectedCols.map(col => {
                                    const meta = colsMeta?.available.find(c => c.key === col);
                                    return <ResizableTh key={col} colKey={col} width={widths[col] ?? 140} onResize={setWidth} align={isSnapshotNumericCol(col) ? 'right' : 'left'} sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{meta?.label ?? col}{meta && meta.since > 10 && <span className="ml-1 text-[9px] text-[#94A3B8]">PG{meta.since}+</span>}</ResizableTh>;
                                })}
                            </tr></thead>
                            <tbody>{data.map((r: any, i: number) => (
                                <tr key={`${r.pid ?? 'replica'}-${i}`} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">
                                    {selectedCols.map(col => (
                                        <td key={col} className={`py-2 px-3 text-xs whitespace-nowrap truncate ${isSnapshotNumericCol(col) ? 'text-right font-mono' : ''}`}>
                                            {formatSnapshotCell(col, r[col])}
                                        </td>
                                    ))}
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ Replication Sütunları" />
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

// =========================================================================
// I/O Stats Tab (PG16+)
// =========================================================================
function IoStatsTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const [mode, setMode] = useState<ViewMode>('summary');
    const [sortKeys, setSortKeys] = useState<SortKey[]>([{ col: 'reads_delta', dir: 'desc' }]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const orderParam = sortKeysToParam(sortKeys);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));

    const { data: colsMeta } = useQuery<ColumnsMeta>({
        queryKey: ['io-stats-columns-meta', instancePk],
        queryFn: () => apiGet(`/instances/${instancePk}/io-stats/columns`),
        staleTime: 3600_000,
    });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns(
        'pgstat.instance.io-stats.cols',
        ['backend_type', 'object', 'context', 'reads_delta', 'read_time_ms_delta', 'writes_delta', 'write_time_ms_delta', 'hits_delta', 'evictions_delta'],
        colsMeta
    );
    const rawMeta = useMemo(() => withSampleTsMeta(colsMeta, ['sample_ts', 'backend_type', 'object', 'context', 'reads_delta', 'read_time_ms_delta', 'writes_delta', 'write_time_ms_delta', 'hits_delta', 'evictions_delta']), [colsMeta]);
    const { selected: rawSelectedCols, setSelected: setRawSelectedCols } = useDataColumns(
        'pgstat.instance.io-stats.raw.cols',
        ['sample_ts', 'backend_type', 'object', 'context', 'reads_delta', 'read_time_ms_delta', 'writes_delta', 'write_time_ms_delta', 'hits_delta', 'evictions_delta'],
        rawMeta
    );
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.io-stats.widths');

    const qp = new URLSearchParams({ from: range.fromIso, to: range.toIso, limit: '200', order_by: orderParam, columns: selectedCols.join(',') });
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-io-stats', instancePk, range.fromIso, range.toIso, orderParam, selectedCols.join(',')],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/io-stats?${qp}`),
        enabled: Number.isFinite(instancePk),
    });

    if (pgMajor != null && pgMajor < 16) {
        return <EmptyState icon="📊" title="PG16+ gerekli" description={`pg_stat_io PG16'da eklendi. Bu instance PG${pgMajor} çalıştırıyor.`} />;
    }
    if (mode === 'raw') {
        return (
            <div>
                <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                    <ViewModeToggle mode={mode} onChange={setMode} />
                </div>
                <RawDeltaTable
                    basePath={`/instances/${instancePk}/io-stats`}
                    baseParams={{ from: range.fromIso, to: range.toIso }}
                    queryKey={['instance-io-stats-raw', instancePk, range.fromIso, range.toIso, mode]}
                    selectedCols={rawSelectedCols}
                    setSelectedCols={setRawSelectedCols}
                    meta={rawMeta}
                    pgMajor={pgMajor}
                    storageKey="pgstat.instance.io-stats.raw"
                    emptyTitle="Ham I/O delta satırı yok"
                />
            </div>
        );
    }
    if (isLoading) return <SkeletonTable rows={5} cols={6} />;

    return (
        <div>
            <DataKindBanner kind="delta" description="Her satır, seçili tarih aralığındaki backend_type × object × context kombinasyonu için TOPLAM I/O sayılarını gösterir (delta toplaması). Sayılar olay sayısıdır — örn. 'reads = 5000' demek bu pencerede 5000 okuma operasyonu olmuş demek." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <ViewModeToggle mode={mode} onChange={setMode} />
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{data?.length ?? 0} satır</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="📊" title="I/O verisi yok" description="Bu aralıkta pg_stat_io verisi toplanmamış." /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                            <thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                {selectedCols.map(col => {
                                    const meta = colsMeta?.available.find(c => c.key === col);
                                    return <ResizableTh key={col} colKey={col} width={widths[col] ?? 120} onResize={setWidth} align={['backend_type', 'object', 'context'].includes(col) ? 'left' : 'right'} sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{meta?.label ?? col}</ResizableTh>;
                                })}
                            </tr></thead>
                            <tbody>{data.map((r: any, i: number) => (
                                <tr key={i} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">
                                    {selectedCols.map(col => (
                                        <td key={col} className={`py-2 px-3 text-xs whitespace-nowrap truncate ${['backend_type', 'object', 'context'].includes(col) ? '' : 'text-right font-mono'}`}>
                                            {['backend_type', 'object', 'context'].includes(col) ? (r[col] ?? '—') : fmtValue(col, r[col])}
                                        </td>
                                    ))}
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ I/O Stats Sütunları" />
        </div>
    );
}

// =========================================================================
// Replication Slots Tab
// =========================================================================
function ReplicationSlotsTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);

    const { data: colsMeta } = useQuery<ColumnsMeta>({
        queryKey: ['slot-columns-meta', instancePk],
        queryFn: () => apiGet(`/instances/${instancePk}/replication-slots/columns`),
        staleTime: 3600_000,
    });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns(
        'pgstat.instance.replication-slots.cols',
        ['slot_name', 'slot_type', 'database', 'active', 'wal_status', 'slot_lag_bytes', 'conflicting', 'failover'],
        colsMeta
    );
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.replication-slots.widths');

    const qp = new URLSearchParams({ columns: selectedCols.join(','), from: range.fromIso, to: range.toIso });
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-replication-slots', instancePk, range.fromIso, range.toIso, selectedCols.join(',')],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/replication-slots?${qp}`),
        enabled: Number.isFinite(instancePk),
    });

    if (isLoading) return <SkeletonTable rows={3} cols={6} />;

    const formatCell = (col: string, val: any) => {
        if (val == null) return '—';
        if (col === 'active' || col === 'temporary' || col === 'two_phase' || col === 'conflicting' || col === 'failover' || col === 'synced') {
            return val === true ? '✓' : val === false ? '✗' : '—';
        }
        if (col === 'slot_lag_bytes' || col === 'safe_wal_size' || col.endsWith('_bytes')) return fmtValue(col, val);
        return String(val);
    };

    return (
        <div>
            <DataKindBanner kind="snapshot" description="Slot listesi anlık durumdur — seçili tarih aralığındaki EN SON snapshot gösterilir. spill/stream counter'lar slot ömrü boyunca kümülatif değerdir (delta değil)." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{data?.length ?? 0} slot</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="🔌" title="Replication slot yok" description="Bu instance'ta aktif replication slot bulunmuyor." /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                            <thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                {selectedCols.map(col => {
                                    const meta = colsMeta?.available.find(c => c.key === col);
                                    return <ResizableTh key={col} colKey={col} width={widths[col] ?? 130} onResize={setWidth} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{meta?.label ?? col}{meta && meta.since > 11 && <span className="ml-1 text-[9px] text-[#94A3B8]">PG{meta.since}+</span>}</ResizableTh>;
                                })}
                            </tr></thead>
                            <tbody>{data.map((r: any, i: number) => (
                                <tr key={i} className={`border-b border-[#F1F5F9] hover:bg-[#F8FAFC] ${r.conflicting ? 'bg-red-50' : ''}`}>
                                    {selectedCols.map(col => (
                                        <td key={col} className={`py-2 px-3 text-xs whitespace-nowrap truncate ${col === 'conflicting' && r.conflicting ? 'text-red-600 font-medium' : ''}`}>
                                            {formatCell(col, r[col])}
                                        </td>
                                    ))}
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ Replication Slots Sütunları" />
        </div>
    );
}

// =========================================================================
// Checkpointer Tab (PG17+) — TAM PAKET
// =========================================================================
function CheckpointerTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const [mode, setMode] = useState<ViewMode>('summary');
    const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({ queryKey: ['checkpointer-cols-meta', instancePk], queryFn: () => apiGet(`/instances/${instancePk}/checkpointer/columns`), staleTime: 3600_000 });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns('pgstat.instance.checkpointer.cols', ['checkpoints_timed', 'checkpoints_req', 'checkpoint_write_time', 'checkpoint_sync_time', 'buffers_written'], colsMeta);
    const rawMeta = useMemo(() => withSampleTsMeta(colsMeta, ['sample_ts', 'checkpoints_timed', 'checkpoints_req', 'checkpoint_write_time', 'checkpoint_sync_time', 'buffers_written']), [colsMeta]);
    const { selected: rawSelectedCols, setSelected: setRawSelectedCols } = useDataColumns('pgstat.instance.checkpointer.raw.cols', ['sample_ts', 'checkpoints_timed', 'checkpoints_req', 'checkpoint_write_time', 'checkpoint_sync_time', 'buffers_written'], rawMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.checkpointer.widths');
    const qp = new URLSearchParams({ from: range.fromIso, to: range.toIso, columns: selectedCols.join(',') });
    const { data, isLoading, isFetching, refetch } = useQuery({ queryKey: ['inst-checkpointer', instancePk, range.fromIso, range.toIso, selectedCols.join(',')], queryFn: () => apiGet<any[]>(`/instances/${instancePk}/checkpointer?${qp}`), enabled: Number.isFinite(instancePk) });

    if (pgMajor != null && pgMajor < 17) return <EmptyState icon="🔄" title="PG17+ gerekli" description={`pg_stat_checkpointer PG17'de eklendi. Bu instance PG${pgMajor}. Checkpoint metrikleri BgWriter tab'ında.`} />;
    if (mode === 'raw') {
        return (
            <div>
                <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                    <ViewModeToggle mode={mode} onChange={setMode} />
                </div>
                <RawDeltaTable
                    basePath={`/instances/${instancePk}/checkpointer`}
                    baseParams={{ from: range.fromIso, to: range.toIso }}
                    queryKey={['inst-checkpointer-raw', instancePk, range.fromIso, range.toIso, mode]}
                    selectedCols={rawSelectedCols}
                    setSelectedCols={setRawSelectedCols}
                    meta={rawMeta}
                    pgMajor={pgMajor}
                    storageKey="pgstat.instance.checkpointer.raw"
                    emptyTitle="Ham checkpointer delta satırı yok"
                />
            </div>
        );
    }
    if (isLoading) return <SkeletonTable rows={3} cols={5} />;

    return (
        <div>
            <DataKindBanner kind="delta" description="Tek satır gösterir — seçili tarih aralığındaki checkpoint metriklerinin TOPLAMI. Örn. 'num_timed = 12' demek aralıkta 12 zamanlı checkpoint olmuş; ortalama 'write_time = 1500ms' demek toplam yazma süresi 1.5 saniye." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <ViewModeToggle mode={mode} onChange={setMode} />
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">Seçili aralık delta toplamı</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="🔄" title="Checkpointer verisi yok" description="Bu aralıkta veri toplanmamış." /> : (
                    <div className="overflow-x-auto"><table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}><thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                        {selectedCols.map(col => { const m = colsMeta?.available.find(c => c.key === col); return <ResizableTh key={col} colKey={col} width={widths[col] ?? 130} onResize={setWidth} align="right" sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{m?.label ?? col}</ResizableTh>; })}
                    </tr></thead><tbody>{data.map((r: any, i: number) => (
                        <tr key={i} className="border-b border-[#F1F5F9]">{selectedCols.map(col => <td key={col} className="py-2 px-3 text-xs text-right font-mono whitespace-nowrap">{fmtValue(col, r[col])}</td>)}</tr>
                    ))}</tbody></table></div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ Checkpointer Sütunları" />
        </div>
    );
}

// =========================================================================
// BgWriter Tab — TAM PAKET
// =========================================================================
function BgWriterTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const [mode, setMode] = useState<ViewMode>('summary');
    const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({ queryKey: ['bgwriter-cols-meta', instancePk], queryFn: () => apiGet(`/instances/${instancePk}/bgwriter/columns`), staleTime: 3600_000 });
    const defaults = pgMajor != null && pgMajor >= 17 ? ['buffers_clean', 'maxwritten_clean', 'buffers_alloc'] : ['buffers_clean', 'maxwritten_clean', 'buffers_alloc', 'checkpoints_timed', 'checkpoints_req', 'buffers_checkpoint'];
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns('pgstat.instance.bgwriter.cols', defaults, colsMeta);
    const rawMeta = useMemo(() => withSampleTsMeta(colsMeta, ['sample_ts', ...defaults]), [colsMeta, defaults.join(',')]);
    const { selected: rawSelectedCols, setSelected: setRawSelectedCols } = useDataColumns('pgstat.instance.bgwriter.raw.cols', ['sample_ts', ...defaults], rawMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.bgwriter.widths');
    const qp = new URLSearchParams({ from: range.fromIso, to: range.toIso, columns: selectedCols.join(',') });
    const { data, isLoading, isFetching, refetch } = useQuery({ queryKey: ['inst-bgwriter', instancePk, range.fromIso, range.toIso, selectedCols.join(',')], queryFn: () => apiGet<any[]>(`/instances/${instancePk}/bgwriter?${qp}`), enabled: Number.isFinite(instancePk) });

    if (mode === 'raw') {
        return (
            <div>
                <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                    <ViewModeToggle mode={mode} onChange={setMode} />
                </div>
                <RawDeltaTable
                    basePath={`/instances/${instancePk}/bgwriter`}
                    baseParams={{ from: range.fromIso, to: range.toIso }}
                    queryKey={['inst-bgwriter-raw', instancePk, range.fromIso, range.toIso, mode]}
                    selectedCols={rawSelectedCols}
                    setSelectedCols={setRawSelectedCols}
                    meta={rawMeta}
                    pgMajor={pgMajor}
                    storageKey="pgstat.instance.bgwriter.raw"
                    emptyTitle="Ham bgwriter delta satırı yok"
                />
            </div>
        );
    }
    if (isLoading) return <SkeletonTable rows={3} cols={5} />;
    const visibleCols = pgMajor != null && pgMajor >= 17 ? selectedCols.filter(c => !['checkpoints_timed', 'checkpoints_req', 'checkpoint_write_time', 'checkpoint_sync_time', 'buffers_checkpoint', 'buffers_backend', 'buffers_backend_fsync'].includes(c)) : selectedCols;

    return (
        <div>
            <DataKindBanner kind="delta" description="Tek satır — seçili tarih aralığındaki bgwriter aktivitesi TOPLAMI. PG17+ slim sürümde sadece bgwriter kolonları görünür (checkpoint metrikleri Checkpointer tab'ına taşındı)." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <ViewModeToggle mode={mode} onChange={setMode} />
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{pgMajor != null && pgMajor >= 17 ? 'PG17+ slim (checkpoint → Checkpointer)' : 'Full set'}</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="✍️" title="BgWriter verisi yok" description="Bu aralıkta veri toplanmamış." /> : (
                    <div className="overflow-x-auto"><table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}><thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                        {visibleCols.map(col => { const m = colsMeta?.available.find(c => c.key === col); return <ResizableTh key={col} colKey={col} width={widths[col] ?? 130} onResize={setWidth} align="right" sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{m?.label ?? col}</ResizableTh>; })}
                    </tr></thead><tbody>{data.map((r: any, i: number) => (
                        <tr key={i} className="border-b border-[#F1F5F9]">{visibleCols.map(col => <td key={col} className="py-2 px-3 text-xs text-right font-mono whitespace-nowrap">{fmtValue(col, r[col])}</td>)}</tr>
                    ))}</tbody></table></div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ BgWriter Sütunları" />
        </div>
    );
}

// =========================================================================
// Archiver Tab — TAM PAKET
// =========================================================================
function ArchiverTab({ instancePk, range }: { instancePk: number; range: TimeRange }) {
    const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({ queryKey: ['archiver-cols-meta', instancePk], queryFn: () => apiGet(`/instances/${instancePk}/archiver/columns`), staleTime: 3600_000 });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns('pgstat.instance.archiver.cols', ['archived_count', 'last_archived_wal', 'last_archived_time', 'failed_count'], colsMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.archiver.widths');
    const qp = new URLSearchParams({ columns: selectedCols.join(','), from: range.fromIso, to: range.toIso });
    const { data, isLoading, isFetching, refetch } = useQuery({ queryKey: ['inst-archiver', instancePk, range.fromIso, range.toIso, selectedCols.join(',')], queryFn: () => apiGet<any[]>(`/instances/${instancePk}/archiver?${qp}`), enabled: Number.isFinite(instancePk) });

    if (isLoading) return <SkeletonTable rows={3} cols={5} />;

    return (
        <div>
            <DataKindBanner kind="snapshot" description="Her satır toplama anındaki KÜMÜLATİF değerdir (stats_reset'ten bu yana). archived_count = TOPLAM arşivlenmiş WAL sayısı. İki ardışık satırın farkını bakarak periyot artışını ölçebilirsin." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{data?.length ?? 0} snapshot</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="📦" title="Archiver verisi yok" description="archive_mode kapalı olabilir." /> : (
                    <div className="overflow-x-auto"><table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}><thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                        {selectedCols.map(col => { const m = colsMeta?.available.find(c => c.key === col); return <ResizableTh key={col} colKey={col} width={widths[col] ?? 150} onResize={setWidth} sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{m?.label ?? col}</ResizableTh>; })}
                    </tr></thead><tbody>{data.map((r: any, i: number) => (
                        <tr key={i} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">{selectedCols.map(col => <td key={col} className="py-2 px-3 text-xs whitespace-nowrap truncate">{r[col] != null ? String(r[col]) : '—'}</td>)}</tr>
                    ))}</tbody></table></div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} title="⚙️ Archiver Sütunları" />
        </div>
    );
}

// =========================================================================
// Subscriptions Tab — TAM PAKET
// =========================================================================
function SubscriptionsTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({ queryKey: ['subscriptions-cols-meta', instancePk], queryFn: () => apiGet(`/instances/${instancePk}/subscriptions/columns`), staleTime: 3600_000 });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns('pgstat.instance.subscriptions.cols', ['subname', 'pid', 'worker_type', 'lag_bytes', 'apply_error_count', 'sync_error_count'], colsMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.subscriptions.widths');
    const qp = new URLSearchParams({ columns: selectedCols.join(','), from: range.fromIso, to: range.toIso });
    const { data, isLoading, isFetching, refetch } = useQuery({ queryKey: ['inst-subscriptions', instancePk, range.fromIso, range.toIso, selectedCols.join(',')], queryFn: () => apiGet<any[]>(`/instances/${instancePk}/subscriptions?${qp}`), enabled: Number.isFinite(instancePk) });

    if (isLoading) return <SkeletonTable rows={3} cols={6} />;

    return (
        <div>
            <DataKindBanner kind="snapshot" description="Subscription listesi anlık snapshot — seçili aralıktaki EN SON durum. lag_bytes anlıktır. apply_error_count / sync_error_count KÜMÜLATİF (stats_reset'ten bu yana). PG18 confl_*_delta kolonları ise periyot DELTA'sıdır." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{data?.length ?? 0} worker</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="📨" title="Subscription yok" description="Logical subscription bulunamadı." /> : (
                    <div className="overflow-x-auto"><table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}><thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                        {selectedCols.map(col => { const m = colsMeta?.available.find(c => c.key === col); return <ResizableTh key={col} colKey={col} width={widths[col] ?? 120} onResize={setWidth} sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{m?.label ?? col}{m && m.since > 11 && <span className="ml-1 text-[9px] text-[#94A3B8]">PG{m.since}+</span>}</ResizableTh>; })}
                    </tr></thead><tbody>{data.map((r: any, i: number) => (
                        <tr key={i} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">{selectedCols.map(col => <td key={col} className="py-2 px-3 text-xs whitespace-nowrap truncate">{r[col] != null ? (typeof r[col] === 'number' ? fmtValue(col, r[col]) : String(r[col])) : '—'}</td>)}</tr>
                    ))}</tbody></table></div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ Subscriptions Sütunları" />
        </div>
    );
}

// =========================================================================
// WAL Receiver Tab — TAM PAKET (standby only)
// =========================================================================
function WalReceiverTab({ instancePk, range, isPrimary }: { instancePk: number; range: TimeRange; isPrimary: boolean | null | undefined }) {
    const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({ queryKey: ['wal-receiver-cols-meta', instancePk], queryFn: () => apiGet(`/instances/${instancePk}/wal-receiver/columns`), staleTime: 3600_000 });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns('pgstat.instance.wal-receiver.cols', ['status', 'sender_host', 'flushed_lsn', 'lag_bytes', 'last_msg_receipt_time'], colsMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.wal-receiver.widths');
    const qp = new URLSearchParams({ columns: selectedCols.join(','), from: range.fromIso, to: range.toIso });
    const { data, isLoading, isFetching, refetch } = useQuery({ queryKey: ['inst-wal-receiver', instancePk, range.fromIso, range.toIso, selectedCols.join(',')], queryFn: () => apiGet<any[]>(`/instances/${instancePk}/wal-receiver?${qp}`), enabled: Number.isFinite(instancePk) && isPrimary !== true });

    if (isPrimary === true) return <EmptyState icon="📡" title="Primary instance" description="WAL Receiver sadece standby instance'larda çalışır." />;
    if (isLoading) return <SkeletonTable rows={2} cols={5} />;

    return (
        <div>
            <DataKindBanner kind="snapshot" description="Her satır toplama anındaki anlık WAL receiver durumu. flushed_lsn / lag_bytes anlık değerlerdir, delta değil. Birden çok satır = birden çok toplama cycle'ı (en yenisi üstte)." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{data?.length ?? 0} snapshot</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="📡" title="WAL Receiver verisi yok" description="Standby aktif değil veya veri toplanmamış." /> : (
                    <div className="overflow-x-auto"><table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}><thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                        {selectedCols.map(col => { const m = colsMeta?.available.find(c => c.key === col); return <ResizableTh key={col} colKey={col} width={widths[col] ?? 130} onResize={setWidth} sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{m?.label ?? col}</ResizableTh>; })}
                    </tr></thead><tbody>{data.map((r: any, i: number) => (
                        <tr key={i} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">{selectedCols.map(col => <td key={col} className="py-2 px-3 text-xs whitespace-nowrap truncate">{r[col] != null ? (typeof r[col] === 'number' ? fmtValue(col, r[col]) : String(r[col])) : '—'}</td>)}</tr>
                    ))}</tbody></table></div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} title="⚙️ WAL Receiver Sütunları" />
        </div>
    );
}

// =========================================================================
// Conflicts Tab — TAM PAKET
// =========================================================================
function ConflictsTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({ queryKey: ['conflicts-cols-meta', instancePk], queryFn: () => apiGet(`/instances/${instancePk}/conflicts/columns`), staleTime: 3600_000 });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns('pgstat.instance.conflicts.cols', ['datname', 'confl_lock', 'confl_snapshot', 'confl_bufferpin', 'confl_deadlock'], colsMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.conflicts.widths');
    const qp = new URLSearchParams({ columns: selectedCols.join(','), from: range.fromIso, to: range.toIso });
    const { data, isLoading, isFetching, refetch } = useQuery({ queryKey: ['inst-conflicts', instancePk, range.fromIso, range.toIso, selectedCols.join(',')], queryFn: () => apiGet<any[]>(`/instances/${instancePk}/conflicts?${qp}`), enabled: Number.isFinite(instancePk) });

    if (isLoading) return <SkeletonTable rows={3} cols={6} />;

    return (
        <div>
            <DataKindBanner kind="snapshot" description="Database başına standby recovery conflict sayıları — seçili aralıktaki EN SON snapshot. Her confl_* kolonu KÜMÜLATİF (stats_reset'ten beri). Primary instance'larda 0 görünür (sadece standby'da anlamlı)." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">Standby conflict istatistikleri</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="⚡" title="Conflict verisi yok" description="Standby'da conflict oluşmamış veya veri toplanmamış." /> : (
                    <div className="overflow-x-auto"><table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}><thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                        {selectedCols.map(col => { const m = colsMeta?.available.find(c => c.key === col); return <ResizableTh key={col} colKey={col} width={widths[col] ?? 120} onResize={setWidth} align={col === 'datname' ? 'left' : 'right'} sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{m?.label ?? col}{m && m.since > 11 && <span className="ml-1 text-[9px] text-[#94A3B8]">PG{m.since}+</span>}</ResizableTh>; })}
                    </tr></thead><tbody>{data.map((r: any, i: number) => (
                        <tr key={i} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">{selectedCols.map(col => <td key={col} className={`py-2 px-3 text-xs whitespace-nowrap ${col === 'datname' ? '' : 'text-right font-mono'}`}>{col === 'datname' ? (r[col] || '—') : fmtValue(col, r[col])}</td>)}</tr>
                    ))}</tbody></table></div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ Conflicts Sütunları" />
        </div>
    );
}

// =========================================================================
// Recovery Prefetch Tab (PG15+, standby only) — TAM PAKET
// =========================================================================
function RecoveryPrefetchTab({ instancePk, range, pgMajor, isPrimary }: { instancePk: number; range: TimeRange; pgMajor?: number; isPrimary: boolean | null | undefined }) {
    const [sortKeys, setSortKeys] = useState<SortKey[]>([{ col: 'prefetch', dir: 'desc' }]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const orderParam = sortKeysToParam(sortKeys);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));

    const { data: colsMeta } = useQuery<ColumnsMeta>({
        queryKey: ['recovery-prefetch-columns-meta', instancePk],
        queryFn: () => apiGet(`/instances/${instancePk}/recovery-prefetch/columns`),
        staleTime: 3600_000,
    });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns(
        'pgstat.instance.recovery-prefetch.cols',
        ['prefetch', 'hit', 'skip_fpw', 'wal_distance', 'io_depth'],
        colsMeta
    );
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.recovery-prefetch.widths');

    const qp = new URLSearchParams({ columns: selectedCols.join(','), order_by: orderParam, from: range.fromIso, to: range.toIso });
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-recovery-prefetch', instancePk, range.fromIso, range.toIso, selectedCols.join(','), orderParam],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/recovery-prefetch?${qp}`),
        enabled: Number.isFinite(instancePk) && isPrimary !== true,
    });

    if (pgMajor != null && pgMajor < 15) return <EmptyState icon="⚡" title="PG15+ gerekli" description={`pg_stat_recovery_prefetch PG15'te eklendi. Bu instance PG${pgMajor}.`} />;
    if (isPrimary === true) return <EmptyState icon="⚡" title="Standby gerekli" description="Recovery prefetch sadece standby instance'larda çalışır." />;
    if (isLoading) return <SkeletonTable rows={3} cols={5} />;

    return (
        <div>
            <DataKindBanner kind="snapshot" description="Her satır toplama anındaki KÜMÜLATİF prefetch counter'ları (stats_reset'ten beri). wal_distance / block_distance / io_depth anlık göstergedir. Periyot artışı için iki ardışık satırın farkına bak." />
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{data?.length ?? 0} satır</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {(!data || data.length === 0) ? <EmptyState icon="⚡" title="Recovery prefetch verisi yok" description="Standby aktif değil veya veri toplanmamış." /> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                            <thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                {selectedCols.map(col => {
                                    const meta = colsMeta?.available.find(c => c.key === col);
                                    return <ResizableTh key={col} colKey={col} width={widths[col] ?? 110} onResize={setWidth} align="right" sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{meta?.label ?? col}</ResizableTh>;
                                })}
                            </tr></thead>
                            <tbody>{data.map((r: any, i: number) => (
                                <tr key={i} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">
                                    {selectedCols.map(col => (
                                        <td key={col} className="py-2 px-3 text-xs text-right font-mono whitespace-nowrap">{fmtValue(col, r[col])}</td>
                                    ))}
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                )}
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="⚙️ Recovery Prefetch Sütunları" />
        </div>
    );
}

// =========================================================================
// Progress Tab — 6 alt sekme
// =========================================================================
type ProgressSub = 'vacuum' | 'analyze' | 'create_index' | 'basebackup' | 'copy' | 'cluster';

function ProgressTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const [sub, setSub] = useState<ProgressSub>('vacuum');

    const subs: { key: ProgressSub; label: string; since: number }[] = [
        { key: 'vacuum', label: 'Vacuum', since: 11 },
        { key: 'analyze', label: 'Analyze', since: 13 },
        { key: 'create_index', label: 'Create Index', since: 12 },
        { key: 'basebackup', label: 'Basebackup', since: 13 },
        { key: 'copy', label: 'Copy', since: 14 },
        { key: 'cluster', label: 'Cluster', since: 12 },
    ];

    return (
        <div>
            <DataKindBanner kind="snapshot" description="Progress view'ları ÇOK KISA ÖMÜRLÜDÜR — operasyon (vacuum/analyze/cluster/...) bittiğinde PG'den o satır kaybolur. Collector poll cycle'ı bu kısa pencereye denk gelirse satır yazılır. Yani burada gördüğün her satır = collector toplama yaparken o anda çalışıyordu. heap_blks_scanned vb. değerler O ANKİ ilerlemedir, delta değil." />
            <div className="flex gap-1 mb-3 flex-wrap">
                {subs.filter(s => pgMajor == null || s.since <= pgMajor).map(s => (
                    <button key={s.key} onClick={() => setSub(s.key)}
                        className={`px-3 py-1 text-xs rounded ${sub === s.key ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0]'}`}>
                        {s.label}
                    </button>
                ))}
            </div>
            <ProgressSubTab key={sub} instancePk={instancePk} range={range} subType={sub} />
        </div>
    );
}

function ProgressSubTab({ instancePk, range, subType }: { instancePk: number; range: TimeRange; subType: ProgressSub }) {
    const resource = `progress-${subType.replace('_', '-')}`;
    const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({ queryKey: [`${resource}-cols-meta`, instancePk], queryFn: () => apiGet(`/instances/${instancePk}/${resource}/columns`), staleTime: 3600_000 });
    const defaults = colsMeta?.defaults ?? ['pid', 'phase'];
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns(`pgstat.instance.${resource}.cols`, defaults, colsMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths(`pgstat.instance.${resource}.widths`);
    const qp = new URLSearchParams({ columns: selectedCols.join(','), from: range.fromIso, to: range.toIso });
    const { data, isLoading, isFetching, refetch } = useQuery({ queryKey: [`inst-${resource}`, instancePk, range.fromIso, range.toIso, selectedCols.join(',')], queryFn: () => apiGet<any[]>(`/instances/${instancePk}/${resource}?${qp}`), enabled: Number.isFinite(instancePk) });

    if (isLoading) return <SkeletonTable rows={3} cols={5} />;

    if (!data || data.length === 0) {
        return (
            <div className="bg-white rounded-lg shadow-sm p-4">
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC] mb-3">{isFetching ? '...' : 'Yenile'}</button>
                <EmptyState icon="⏳" title={`Çalışan ${subType} operasyonu yok`} description="Seçilen tarih aralığında bu tipte progress kaydı bulunamadı." />
            </div>
        );
    }

    return (
        <div>
            <div className="bg-white rounded-lg shadow-sm p-3 mb-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">⚙️ Sütun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">↔ Genişlik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{data.length} kayıt</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden overflow-x-auto">
                <table className="w-full text-sm stmt-resizable-table" style={{ tableLayout: 'fixed' }}>
                    <thead><tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                        {selectedCols.map(col => { const m = colsMeta?.available.find(c => c.key === col); return <ResizableTh key={col} colKey={col} width={widths[col] ?? 120} onResize={setWidth} sortKeys={sortKeys} onSortToggle={sortToggle} className="py-2 px-3 text-xs font-semibold text-[#64748B] uppercase">{m?.label ?? col}</ResizableTh>; })}
                    </tr></thead>
                    <tbody>{data.map((r: any, i: number) => (
                        <tr key={i} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">{selectedCols.map(col => <td key={col} className="py-2 px-3 text-xs whitespace-nowrap truncate">{r[col] != null ? String(r[col]) : '—'}</td>)}</tr>
                    ))}</tbody>
                </table>
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} title={`⚙️ Progress ${subType} Sütunları`} />
        </div>
    );
}

function FunctionsTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    return (
        <DeltaStatsFullPackageTab
            instancePk={instancePk}
            range={range}
            pgMajor={pgMajor}
            resource="functions"
            title="Functions"
            defaults={['datname', 'schemaname', 'funcname', 'total_calls', 'total_time_ms', 'avg_time_ms']}
            storageBase="pgstat.instance.functions"
            defaultSort={{ col: 'total_time_ms', dir: 'desc' }}
            emptyTitle="Fonksiyon verisi yok (pg_stat_user_functions)"
        />
    );
}

function SequencesTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    return (
        <DeltaStatsFullPackageTab
            instancePk={instancePk}
            range={range}
            pgMajor={pgMajor}
            resource="sequences"
            title="Sequences"
            defaults={['schemaname', 'relname', 'total_blks_read', 'total_blks_hit', 'hit_ratio']}
            storageBase="pgstat.instance.sequences"
            defaultSort={{ col: 'total_blks_read', dir: 'desc' }}
            emptyTitle="Sequence I/O verisi yok"
        />
    );
}

type WalSub = 'position' | 'stat';

function WalArchiveTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const [sub, setSub] = useState<WalSub>('position');
    const tabs: { key: WalSub; label: string; since?: number }[] = [
        { key: 'position', label: 'WAL Pozisyonu' },
        { key: 'stat', label: 'pg_stat_wal', since: 13 },
    ];

    return (
        <div>
            <div className="flex gap-1 mb-3 flex-wrap">
                {tabs.map(t => {
                    const disabled = t.since != null && pgMajor != null && pgMajor < t.since;
                    return (
                        <button key={t.key} onClick={() => !disabled && setSub(t.key)} disabled={disabled}
                            className={`px-3 py-1 text-xs rounded ${sub === t.key ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0]'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
                            {t.label}{t.since && <span className="ml-1 text-[10px] opacity-75">PG{t.since}+</span>}
                        </button>
                    );
                })}
            </div>
            {sub === 'position'
                ? <WalPositionSubTab key={sub} instancePk={instancePk} range={range} pgMajor={pgMajor} />
                : <StatWalSubTab key={sub} instancePk={instancePk} range={range} pgMajor={pgMajor} />}
        </div>
    );
}

function WalPositionSubTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    const defaults = ['sample_ts', 'current_wal_lsn', 'period_wal_size_byte', 'wal_directory_size_byte', 'wal_file_count'];
    const [sortKeys, setSortKeys] = useState<SortKey[]>([{ col: 'sample_ts', dir: 'desc' }]);
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const orderParam = sortKeysToParam(sortKeys);
    const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
    const { data: colsMeta } = useQuery<ColumnsMeta>({
        queryKey: ['wal-position-columns-meta', instancePk],
        queryFn: () => apiGet(`/instances/${instancePk}/wal-position/columns`),
        staleTime: 3600_000,
    });
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns('pgstat.instance.wal_position.cols', defaults, colsMeta);
    const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.instance.wal_position.widths');
    const qp = new URLSearchParams({ columns: selectedCols.join(','), order_by: orderParam, from: range.fromIso, to: range.toIso });
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['instance-wal-position', instancePk, range.fromIso, range.toIso, selectedCols.join(','), orderParam],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/wal-position?${qp}`),
        enabled: Number.isFinite(instancePk),
    });
    const rows = data || [];

    if (isLoading) return <SkeletonTable rows={5} cols={selectedCols.length || defaults.length} />;

    return (
        <div className="space-y-3">
            <DataKindBanner kind="snapshot" description="WAL Pozisyonu: secili tarih araligindaki pg_wal_snapshot satirlari. Degerler snapshot'tir, delta toplami degildir." />
            <div className="bg-white rounded-lg shadow-sm p-3 flex flex-wrap gap-2 items-center">
                <button onClick={() => setColumnsModalOpen(true)} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">Sutun ({selectedCols.length})</button>
                <button onClick={resetWidths} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">Genislik</button>
                <button onClick={() => refetch()} className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">{isFetching ? '...' : 'Yenile'}</button>
                <span className="text-xs text-[#94A3B8] ml-auto">{rows.length} kayit</span>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                <FullPackageTable rows={rows} selectedCols={selectedCols} colsMeta={colsMeta} pgMajor={pgMajor} widths={widths} setWidth={setWidth} sortKeys={sortKeys} onSortToggle={sortToggle} emptyTitle="WAL pozisyon verisi yok" />
            </div>
            <DataColumnsModal open={columnsModalOpen} onClose={() => setColumnsModalOpen(false)} selected={selectedCols} onChange={setSelectedCols} meta={colsMeta} pgMajor={pgMajor} title="WAL Pozisyonu Sutunlari" />
        </div>
    );
}

function StatWalSubTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    if (pgMajor != null && pgMajor < 13) {
        return <EmptyState icon="i" title="pg_stat_wal PG13+ gerektirir" description="Bu instance surumunde pg_stat_wal metrikleri toplanmaz." />;
    }
    return (
        <DeltaStatsFullPackageTab
            instancePk={instancePk}
            range={range}
            pgMajor={pgMajor}
            resource="stat-wal"
            title="pg_stat_wal"
            defaults={['wal_records', 'wal_bytes', 'wal_fpi', 'wal_buffers_full', 'wal_write_time']}
            storageBase="pgstat.instance.stat_wal"
            defaultSort={{ col: 'wal_bytes', dir: 'desc' }}
            emptyTitle="pg_stat_wal verisi yok"
        />
    );
}

function SlruTab({ instancePk, range, pgMajor }: { instancePk: number; range: TimeRange; pgMajor?: number }) {
    if (pgMajor != null && pgMajor < 13) {
        return <EmptyState icon="i" title="SLRU PG13+ gerektirir" description="pg_stat_slru PostgreSQL 13 ve sonraki surumlerde bulunur." />;
    }
    return (
        <DeltaStatsFullPackageTab
            instancePk={instancePk}
            range={range}
            pgMajor={pgMajor}
            resource="slru"
            title="SLRU"
            defaults={['name', 'total_blks_hit', 'total_blks_read', 'total_blks_written', 'hit_ratio']}
            storageBase="pgstat.instance.slru"
            defaultSort={{ col: 'total_blks_read', dir: 'desc' }}
            emptyTitle="SLRU verisi yok (PG13+)"
        />
    );
}

function TpsTab({ data, loading, custom }: { data: any | undefined; loading: boolean; custom: boolean }) {
    if (loading) return <SkeletonTable rows={5} cols={5} />;
    const daily = data?.daily || [];
    const hourly = data?.hourly || [];

    // Custom modda: tek satır toplam (seçili pencerenin tamamı). "Gün" yerine "Periyot" kolonu.
    const dailyColumns: any[] = custom
        ? [
            {
                key: 'period', header: 'Periyot', render: (r: any) => {
                    const f = new Date(r.period_start).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                    const t = new Date(r.period_end).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                    return `${f} → ${t}`;
                }
            },
        ]
        : [
            { key: 'day', header: 'Gün', render: (r: any) => new Date(r.day).toLocaleDateString('tr-TR') },
        ];
    dailyColumns.push(
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
    );

    return (
        <div className="space-y-5">
            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">Günlük TPS {custom ? '(seçili aralık toplamı)' : '(son 7 gün)'}</h3>
                {daily.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] py-4 text-center">Günlük TPS verisi yok</div>
                ) : (
                    <DataTable columns={dailyColumns} data={daily} />
                )}
            </div>
            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">
                    Saatlik TPS {custom ? (hourly[0]?.hour ? '(seçili aralık)' : '(seçili aralık toplamı)') : '(son 25 saat)'}
                </h3>
                {hourly.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] py-4 text-center">Saatlik TPS verisi yok</div>
                ) : (
                    <DataTable columns={(() => {
                        const cols: any[] = hourly[0]?.hour
                            ? [{ key: 'hour', header: 'Saat', render: (r: any) => new Date(r.hour).toLocaleString('tr-TR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }]
                            : [{
                                key: 'period', header: 'Periyot', render: (r: any) => {
                                    const f = new Date(r.period_start).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                                    const t = new Date(r.period_end).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                                    return `${f} → ${t}`;
                                }
                            }];
                        cols.push(
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
                        );
                        return cols;
                    })()} data={hourly} />
                )}
            </div>
        </div>
    );
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

function SettingsTab({ instanceId, onRefresh, refreshing }: {
    instanceId: string; onRefresh: () => void; refreshing: boolean;
}) {
    const toast = useToast();
    const [filter, setFilter] = useState('');
    const [polling, setPolling] = useState(false);
    const { data, isLoading, refetch } = useQuery({
        queryKey: ['inst-settings', instanceId],
        queryFn: () => apiGet<{ settings: any[]; last_snapshot_ts: string | null }>(`/instances/${instanceId}/settings`),
        refetchInterval: polling ? 2_000 : 30_000,
    });

    // Refresh butonuna basıldığında: command kuyruğa atılır, sonra polling moduna geç.
    // last_snapshot_ts değişene veya 30s timeout'a kadar 2s aralıkla refetch.
    const triggerRefresh = () => {
        const prevTs = data?.last_snapshot_ts;
        onRefresh();
        setPolling(true);
        const startedAt = Date.now();
        const timer = window.setInterval(async () => {
            const res = await refetch();
            const newTs = res.data?.last_snapshot_ts;
            const elapsed = Date.now() - startedAt;
            if (newTs && newTs !== prevTs) {
                clearInterval(timer);
                setPolling(false);
                toast.success('Parametreler güncellendi');
            } else if (elapsed > 30_000) {
                clearInterval(timer);
                setPolling(false);
                toast.error('Yenileme zaman aşımı — collector yanıt vermedi');
            }
        }, 2_000);
    };

    if (isLoading) return <div className="bg-white rounded-lg shadow-sm p-4"><SkeletonTable rows={10} cols={4} /></div>;
    if (!data || data.settings.length === 0) {
        return <EmptyState icon="⚙" title="Parametre snapshot'ı yok"
            description="Nightly snapshot henüz alınmamış veya pg_settings_snapshot tablosu boş. 'Şimdi Yenile' butonuyla hemen tetikleyebilirsin." />;
    }

    const filtered = filter
        ? data.settings.filter(s => s.setting_name.toLowerCase().includes(filter.toLowerCase()))
        : data.settings;
    const lastTs = data.last_snapshot_ts ? new Date(data.last_snapshot_ts) : null;
    const ageSec = lastTs ? Math.round((Date.now() - lastTs.getTime()) / 1000) : 0;
    const ageStr = ageSec < 60 ? `${ageSec}s` : ageSec < 3600 ? `${Math.round(ageSec / 60)} dk` :
        ageSec < 86400 ? `${Math.round(ageSec / 3600)} sa` : `${Math.round(ageSec / 86400)} g`;

    return (
        <div className="space-y-3">
            <div className="bg-white rounded-lg shadow-sm p-4 flex flex-wrap items-center gap-3">
                <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
                    placeholder="Filtre (örn: work_mem, vacuum)"
                    className="flex-1 min-w-[200px] border border-[#CBD5E1] rounded px-3 py-1.5 text-sm" />
                <div className="text-xs text-[#64748B]">
                    Son snapshot: <strong>{ageStr} önce</strong>
                    {lastTs && <span className="ml-1 text-[#94A3B8]">({lastTs.toLocaleString('tr-TR')})</span>}
                </div>
                <button
                    onClick={triggerRefresh}
                    disabled={refreshing || polling}
                    className="px-3 py-1.5 text-sm bg-purple-500 text-white rounded hover:bg-purple-600 disabled:opacity-50">
                    {polling ? 'Bekleniyor...' : refreshing ? 'Gönderildi...' : '🔄 Şimdi Yenile'}
                </button>
            </div>
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                <table className="w-full text-sm">
                    <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                        <tr>
                            <th className="text-left py-2 px-3 font-medium text-[#475569]">Parametre</th>
                            <th className="text-left py-2 px-3 font-medium text-[#475569]">Değer</th>
                            <th className="text-left py-2 px-3 font-medium text-[#475569]">Birim</th>
                            <th className="text-left py-2 px-3 font-medium text-[#475569]">Context</th>
                            <th className="text-left py-2 px-3 font-medium text-[#475569]">Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((s, i) => (
                            <tr key={i} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">
                                <td className="py-1.5 px-3 font-mono text-xs text-[#1E293B]">{s.setting_name}</td>
                                <td className="py-1.5 px-3 font-mono text-xs">{s.setting_value}</td>
                                <td className="py-1.5 px-3 text-xs text-[#64748B]">{s.unit || '—'}</td>
                                <td className="py-1.5 px-3 text-xs text-[#64748B]">{s.context || '—'}</td>
                                <td className="py-1.5 px-3 text-xs text-[#64748B]">{s.source || '—'}</td>
                            </tr>
                        ))}
                        {filtered.length === 0 && (
                            <tr><td colSpan={5} className="py-6 text-center text-[#94A3B8]">Filtreyle eşleşen parametre yok</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
            <p className="text-[11px] text-[#94A3B8]">
                Toplam {data.settings.length} parametre · Nightly (03:00 UTC) tüm parametreler, her 3 saatte 11 kritik parametre otomatik yenilenir.
            </p>
        </div>
    );
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
