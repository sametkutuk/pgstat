import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import { SkeletonTable } from '../components/common/Skeleton';
import EmptyState from '../components/common/EmptyState';
import TimeRangePicker, { loadPersistedRange, type TimeRange } from '../components/common/TimeRangePicker';
import DataColumnsModal, { useDataColumns, type ColumnsMeta } from '../components/common/DataColumnsModal';
import { Area, AreaChart, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Instance {
    instance_pk: number;
    display_name: string;
    is_active: boolean;
}

type InsightTab = 'top-exec' | 'temp-spill' | 'wal-spike' | 'cache-hit' | 'vacuum-lag';

const TABS: { key: InsightTab; label: string; icon: string }[] = [
    { key: 'top-exec', label: 'Top Sorgular', icon: '⏱️' },
    { key: 'temp-spill', label: 'Temp Spill', icon: '💾' },
    { key: 'wal-spike', label: 'WAL Spike', icon: '📈' },
    { key: 'cache-hit', label: 'Cache Hit', icon: '🎯' },
    { key: 'vacuum-lag', label: 'Vacuum Lag', icon: '🧹' },
];

export default function Insights() {
    const [tab, setTab] = useState<InsightTab>('top-exec');
    const [instancePk, setInstancePk] = useState<number | null>(null);
    const [range, setRange] = useState<TimeRange>(() => loadPersistedRange('insights-range'));
    // Auto-refresh default kapali — kullanici acmak isterse 30sn'lik refetch
    // devreye girer. Tercih localStorage'a persist.
    const [autoRefresh, setAutoRefresh] = useState<boolean>(() => {
        try { return localStorage.getItem('pgstat.insights.auto-refresh') === '1'; } catch { return false; }
    });
    useEffect(() => {
        try { localStorage.setItem('pgstat.insights.auto-refresh', autoRefresh ? '1' : '0'); } catch { /* ignore */ }
    }, [autoRefresh]);

    const instances = useQuery({
        queryKey: ['instances-list-insights'],
        queryFn: () => apiGet<Instance[]>('/instances'),
        staleTime: 60_000,
        refetchInterval: false,
    });

    const activeInstances = (instances.data ?? []).filter(i => i.is_active);

    return (
        <div className="p-6">
            {/* Başlık ve seçiciler */}
            <div className="mb-4">
                <h1 className="text-2xl font-semibold text-[#1E293B] mb-1">🔍 Insights</h1>
                <p className="text-sm text-[#64748B]">Bir instance ve zaman aralığı seçin, pgstat sizin için anlamlı çıkarımlar üretir.</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] p-4 mb-4 flex flex-wrap gap-3 items-center">
                <div>
                    <label className="block text-xs text-[#64748B] mb-1">Instance</label>
                    <select
                        value={instancePk ?? ''}
                        onChange={e => setInstancePk(e.target.value ? Number(e.target.value) : null)}
                        className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[280px]"
                    >
                        <option value="">— Bir instance seçin —</option>
                        {activeInstances.map(i => (
                            <option key={i.instance_pk} value={i.instance_pk}>{i.display_name}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-xs text-[#64748B] mb-1">Tarih Aralığı</label>
                    <TimeRangePicker value={range} onChange={setRange} persistKey="insights-range" />
                </div>
                <div className="ml-auto">
                    <label className="block text-xs text-[#64748B] mb-1">Otomatik Yenile</label>
                    <button
                        onClick={() => setAutoRefresh(v => !v)}
                        title={autoRefresh ? '30 saniyede bir veriler yenileniyor — kapatmak icin tikla' : 'Veriler durağan — 30sn yenilenme istersen tikla'}
                        className={`px-3 py-1.5 text-sm rounded border transition-colors ${autoRefresh
                            ? 'border-[#10B981] text-[#047857] bg-[#ECFDF5]'
                            : 'border-[#E2E8F0] text-[#64748B] bg-white hover:bg-[#F8FAFC]'
                            }`}
                    >
                        {autoRefresh ? '🟢 Acik (30sn)' : '⏸ Kapali'}
                    </button>
                </div>
            </div>

            {/* Sekme bar */}
            <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] mb-4">
                <div className="flex border-b border-[#E2E8F0] overflow-x-auto">
                    {TABS.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${tab === t.key
                                ? 'border-[#3B82F6] text-[#2563EB]'
                                : 'border-transparent text-[#64748B] hover:text-[#1E293B] hover:bg-[#F8FAFC]'
                                }`}
                        >
                            <span className="mr-1">{t.icon}</span>{t.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Sekme içeriği — Insights TopExecTimeCard her zaman render olur,
                içinde null guard yapılır. Aksi halde Card unmount/remount olur
                ve useQuery cache resetlenir. */}
            {tab === 'top-exec' && <TopExecTimeCard instancePk={instancePk} range={range} autoRefresh={autoRefresh} instanceName={activeInstances.find(i => i.instance_pk === instancePk)?.display_name} />}
            {tab === 'temp-spill' && <PlaceholderTab title="Temp Spill" description="work_mem yetersizliği yaşayan sorgular. Yakında." />}
            {tab === 'wal-spike' && <PlaceholderTab title="WAL Spike" description="Anormal WAL üretimi olan periyotlar. Yakında." />}
            {tab === 'cache-hit' && <PlaceholderTab title="Cache Hit Drop" description="DB seviyesinde cache hit ratio düşüşleri. Yakında." />}
            {tab === 'vacuum-lag' && <PlaceholderTab title="Vacuum Lag" description="Autovacuum gerideki tablolar, dead tuple birikimi. Yakında." />}
        </div>
    );
}

function PlaceholderTab({ title, description }: { title: string; description: string }) {
    return <EmptyState icon="🚧" title={title} description={description} />;
}


// =========================================================================
// Top Exec Time Card (ilk pilot başlık)
// =========================================================================
interface TopQueryRow {
    datname: string | null;
    queryid: string | null;
    query_text_id: number | null;
    statement_series_id: number;
    query_short: string | null;
    toplam_cagri: string;
    toplam_exec_ms: string;
    toplam_dk: string;
    pct_of_total: string;
    min_ms: string;
    ort_ms: string;
    max_ms: string;
    toplam_satir: string;
}

type SortMode = 'time' | 'calls' | 'slow';

interface InsightTag {
    key: string;
    label: string;
    icon: string;
    className: string;
    title: string;
}

interface DbTimeTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    total_ms: string | number;
    total_calls: string | number;
}

interface QueryTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    calls: string | number;
    total_ms: string | number;
    min_ms: string | number | null;
    avg_ms: string | number | null;
    max_ms: string | number | null;
}

type CompareKey = '1h' | '1d' | '1w' | '1m';
type CompareMode = 'auto' | 'off';

interface TrendResponse<T> {
    current: T[];
    previous: T[];
    compare: CompareKey | null;
}

interface ChartDatum {
    label: string;
    bucket_key: string;
    [key: string]: string | number | null;
}

function toNum(value: unknown): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function loadCompareMode(): CompareMode {
    if (typeof window === 'undefined') return 'auto';
    const saved = window.localStorage.getItem('pgstat.insights.compare-mode');
    return saved === 'off' ? 'off' : 'auto';
}

function compareForRange(range: TimeRange): CompareKey {
    const windowHours = (new Date(range.toIso).getTime() - new Date(range.fromIso).getTime()) / 3_600_000;
    if (windowHours <= 6) return '1h';
    if (windowHours <= 48) return '1d';
    if (windowHours <= 7 * 24) return '1w';
    return '1m';
}

function compareLabel(compare: CompareKey | null): string {
    if (compare === '1h') return '1 saat önce';
    if (compare === '1d') return '1 gün önce';
    if (compare === '1w') return '1 hafta önce';
    if (compare === '1m') return '1 ay önce';
    return 'Geçmiş';
}

function bucketKey(value: string | undefined): string {
    if (!value) return '';
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

function deltaLabel(current: number, previous: number): string | null {
    if (!Number.isFinite(previous) || previous === 0) return null;
    const pct = (current / previous - 1) * 100;
    if (!Number.isFinite(pct)) return null;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(0)}%`;
}

function calculateTags(row: TopQueryRow): InsightTag[] {
    const pct = toNum(row.pct_of_total);
    const avg = toNum(row.ort_ms);
    const min = toNum(row.min_ms);
    const max = toNum(row.max_ms);
    const rows = toNum(row.toplam_satir);
    const calls = toNum(row.toplam_cagri);
    const tags: InsightTag[] = [];
    if (pct >= 30) tags.push({ key: 'bottleneck', label: 'DB darboğazı', icon: '🔥', className: 'bg-red-100 text-red-700', title: 'Tek başına DB zamanının çoğunu yiyor — öncelikli optimize et' });
    if (avg >= 1000) tags.push({ key: 'slow', label: 'Yavaş', icon: '🐢', className: 'bg-orange-100 text-orange-700', title: 'Ortalama 1sn+ yanıt — index/plan kontrol et' });
    if (min > 0 && max / min > 10) tags.push({ key: 'volatile', label: 'Volatil', icon: '⚡', className: 'bg-amber-100 text-amber-700', title: 'Çağrı süresi çok değişiyor — plan instability veya parametre varyasyonu' });
    if (rows === 0 && avg >= 100) tags.push({ key: 'no-work', label: 'İş yapmıyor', icon: '🌀', className: 'bg-purple-100 text-purple-700', title: 'Hiç satır dönmüyor ama yavaş — gereksiz filter/lock?' });
    if (calls >= 10000) tags.push({ key: 'hot-path', label: 'Hot Path', icon: '🔁', className: 'bg-blue-100 text-blue-700', title: 'Çok sık çalışıyor — N+1 veya ORM aşırı çağrı olabilir' });
    return tags;
}

function compactNumber(value: unknown): string {
    const n = toNum(value);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    if (Number.isInteger(n)) return n.toLocaleString('tr-TR');
    return n.toFixed(1);
}

function formatDurationMs(ms: number): string {
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} dk`;
    if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)} sn`;
    return `${ms.toFixed(0)} ms`;
}

function formatBucket(value: string): string {
    return new Date(value).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function rangeLabel(range: TimeRange): string {
    const hours = Math.max(1, Math.round((new Date(range.toIso).getTime() - new Date(range.fromIso).getTime()) / 3600_000));
    if (hours >= 24) return `son ${Math.round(hours / 24)} gün`;
    return `son ${hours} saat`;
}

function ChartTooltip({ active, payload, label }: any) {
    if (!active || !payload?.length) return null;
    const current = payload.find((p: any) => String(p.dataKey).startsWith('current_'));
    const previous = payload.find((p: any) => String(p.dataKey).startsWith('previous_'));
    if (current) {
        const currentValue = toNum(current.value);
        const previousValue = previous?.value == null ? null : toNum(previous.value);
        const delta = previousValue == null ? null : deltaLabel(currentValue, previousValue);
        return (
            <div className="bg-white border border-[#CBD5E1] shadow-sm rounded px-3 py-2 text-xs min-w-[190px]">
                <div className="font-medium text-[#1E293B] mb-1">{label}</div>
                <div className="text-[#64748B]">
                    Şu an: <b className="text-[#1E293B]">{compactNumber(currentValue)}</b>
                    <span className="mx-1 text-[#CBD5E1]">|</span>
                    Geçmiş: {previousValue == null ? <span className="text-[#94A3B8]">veri yok</span> : <b className="text-[#1E293B]">{compactNumber(previousValue)}</b>}
                    {delta && <span className={`ml-1 font-semibold ${delta.startsWith('+') ? 'text-red-600' : 'text-emerald-600'}`}>({delta})</span>}
                </div>
            </div>
        );
    }
    return (
        <div className="bg-white border border-[#CBD5E1] shadow-sm rounded px-3 py-2 text-xs">
            <div className="font-medium text-[#1E293B] mb-1">{label}</div>
            {payload.map((p: any) => (
                <div key={p.dataKey} className="flex items-center gap-2 text-[#64748B]">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
                    <span>{p.name}: <b>{compactNumber(p.value)}</b></span>
                </div>
            ))}
        </div>
    );
}

// Top Sorgular tablosu için kolon meta — DataColumnsModal ile uyumlu
function InsightChart({ title, height, children }: { title: string; height: number; children: any }) {
    return (
        <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] p-4">
            <h3 className="text-sm font-semibold text-[#64748B] mb-3">{title}</h3>
            <ResponsiveContainer width="100%" height={height}>
                {children}
            </ResponsiveContainer>
        </div>
    );
}

const TOP_QUERIES_COLUMNS_META: ColumnsMeta = {
    defaults: ['sql', 'datname', 'toplam_cagri', 'toplam_dk', 'pct', 'min_ms', 'ort_ms', 'max_ms', 'toplam_satir'],
    available: [
        { key: 'sql', label: 'SQL', since: 11 },
        { key: 'queryid', label: 'Query ID', since: 11 },
        { key: 'datname', label: 'Database', since: 11 },
        { key: 'toplam_cagri', label: 'Çağrı', since: 11 },
        { key: 'toplam_dk', label: 'Toplam (dk)', since: 11 },
        { key: 'pct', label: '% Toplam', since: 11 },
        { key: 'min_ms', label: 'Min (ms)', since: 11 },
        { key: 'ort_ms', label: 'Ort (ms)', since: 11 },
        { key: 'max_ms', label: 'Max (ms)', since: 11 },
        { key: 'toplam_satir', label: 'Satır', since: 11 },
    ],
};

function TopExecTimeCard({ instancePk, range, autoRefresh, instanceName }: { instancePk: number | null; range: TimeRange; autoRefresh: boolean; instanceName?: string }) {
    if (instancePk == null) {
        return <EmptyState icon="🖥️" title="Instance seçin" description="Yukarıdan bir aktif instance seçin." />;
    }
    return <TopExecTimeCardInner instancePk={instancePk} range={range} autoRefresh={autoRefresh} instanceName={instanceName} />;
}

function TopExecTimeCardInner({ instancePk, range, autoRefresh, instanceName }: { instancePk: number; range: TimeRange; autoRefresh: boolean; instanceName?: string }) {
    const [sort, setSort] = useState<SortMode>('time');
    const [searchInput, setSearchInput] = useState<string>('');
    const [search, setSearch] = useState<string>('');
    const [datname, setDatname] = useState<string>('');
    const [columnsModalOpen, setColumnsModalOpen] = useState(false);
    const [expandedSeriesId, setExpandedSeriesId] = useState<number | null>(null);
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns(
        'pgstat.insights.top-queries.cols',
        TOP_QUERIES_COLUMNS_META.defaults,
        TOP_QUERIES_COLUMNS_META,
    );

    const searchQp = search ? `&search=${encodeURIComponent(search)}` : '';
    const datnameQp = datname ? `&datname=${encodeURIComponent(datname)}` : '';

    // Instance'a ait DB listesi (filtre dropdown'u icin)
    const { data: databases } = useQuery({
        queryKey: ['insights-databases', instancePk],
        queryFn: () => apiGet<string[]>(`/insights/${instancePk}/databases`),
        staleTime: 60_000,
        refetchInterval: false,
    });

    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['insights-top-queries', instancePk, range.fromIso, range.toIso, sort, search, datname],
        queryFn: () => apiGet<TopQueryRow[]>(
            `/insights/${instancePk}/top-queries?sort=${sort}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}&limit=20${searchQp}${datnameQp}`,
        ),
        refetchInterval: autoRefresh ? 30_000 : false,
    });

    const { data: trendData } = useQuery({
        queryKey: ['insights-db-time-trend', instancePk, range.fromIso, range.toIso, datname],
        queryFn: () => apiGet<DbTimeTrendPoint[]>(
            `/insights/${instancePk}/db-time-trend?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${datnameQp}`,
        ),
        refetchInterval: autoRefresh ? 30_000 : false,
    });

    const sortButtons: { key: SortMode; label: string; tip: string }[] = [
        { key: 'time', label: 'Toplam Süre', tip: 'DB zamanını en çok yiyen sorgular (sum exec_time)' },
        { key: 'calls', label: 'Çağrı Sayısı', tip: 'En sık çalışan sorgular (sum calls). N+1 / ORM tespiti.' },
        { key: 'slow', label: 'Ortalama Yavaşlık', tip: 'Sürekli yavaş olan sorgular (avg mean_exec_time). Min çağrı eşiği ile tek-spike eleme.' },
    ];

    function applySearch() {
        setSearch(searchInput.trim());
    }

    function clearSearch() {
        setSearchInput('');
        setSearch('');
    }

    const rowsWithTags = useMemo(() => (data ?? []).map(row => ({ row, tags: calculateTags(row) })), [data]);
    const tagCounts = useMemo(() => {
        const counts: Record<string, { icon: string; count: number }> = {};
        for (const item of rowsWithTags) {
            for (const tag of item.tags) counts[tag.key] = { icon: tag.icon, count: (counts[tag.key]?.count ?? 0) + 1 };
        }
        return counts;
    }, [rowsWithTags]);
    const summary = useMemo(() => {
        if (!data || data.length === 0) return null;
        const totalMs = data.reduce((sum, r) => sum + toNum(r.toplam_exec_ms), 0);
        const avgMs = data.reduce((sum, r) => sum + toNum(r.ort_ms), 0) / data.length;
        return { totalMs, topPct: toNum(data[0]?.pct_of_total), avgMs };
    }, [data]);
    const chartData = useMemo(() => (trendData ?? []).map(p => ({
        label: formatBucket(String(p.bucket_start)),
        db_minutes: +(toNum(p.total_ms) / 60_000).toFixed(2),
        calls: toNum(p.total_calls),
    })), [trendData]);

    return (
        <div className="space-y-4">
            {summary && (
                <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] p-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-semibold text-[#1E293B]">📊 {instanceName || `Instance ${instancePk}`} · {rangeLabel(range)}</span>
                        {datname && <span className="text-xs px-2 py-0.5 rounded bg-[#EFF6FF] text-[#2563EB]">{datname}</span>}
                    </div>
                    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 text-xs text-[#64748B]">
                        <div>Toplam DB time: <b className="text-[#1E293B]">{formatDurationMs(summary.totalMs)}</b> · En yoğun sorgu: <b className="text-[#1E293B]">%{summary.topPct.toFixed(1)}</b></div>
                        <div>Ortalama yanıt: <b className="text-[#1E293B]">{formatDurationMs(summary.avgMs)}</b> · Etiketler: {Object.values(tagCounts).length === 0 ? <span className="text-[#94A3B8]">yok</span> : Object.values(tagCounts).map(t => <span key={t.icon} className="mr-2">{t.icon} {t.count}</span>)}</div>
                    </div>
                </div>
            )}

            {chartData.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <InsightChart title="DB Time Trend (Toplam)" height={200}>
                        <AreaChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                            <Tooltip content={<ChartTooltip />} />
                            <Area type="monotone" dataKey="db_minutes" name="DB dk" stroke="#2563EB" fill="#DBEAFE" strokeWidth={2} />
                        </AreaChart>
                    </InsightChart>
                    <InsightChart title="Throughput Trend" height={200}>
                        <AreaChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                            <Tooltip content={<ChartTooltip />} />
                            <Area type="monotone" dataKey="calls" name="Calls" stroke="#059669" fill="#D1FAE5" strokeWidth={2} />
                        </AreaChart>
                    </InsightChart>
                </div>
            )}

        <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0]">
            <div className="px-4 py-3 border-b border-[#E2E8F0] flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[200px]">
                    <h3 className="font-semibold text-[#1E293B]">Top Sorgular</h3>
                    <p className="text-xs text-[#64748B]">Bu DB'nin zamanı nereye gidiyor? Sıralamayı değiştirerek farklı açılardan bak.</p>
                </div>
                <div className="flex items-center gap-1.5">
                    <select
                        value={datname}
                        onChange={e => setDatname(e.target.value)}
                        title="Bu database'deki sorgulara filtre uygula (boş = tüm DB'ler)"
                        className="border border-[#E2E8F0] rounded px-2 py-1.5 text-xs bg-white max-w-[160px]"
                    >
                        <option value="">Tüm Database'ler</option>
                        {(databases ?? []).map(d => (
                            <option key={d} value={d}>{d}</option>
                        ))}
                    </select>
                    <input
                        type="text"
                        value={searchInput}
                        onChange={e => setSearchInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') applySearch(); }}
                        placeholder="queryid veya %select%hotel%"
                        title="QueryID (sayı) veya SQL text için ILIKE pattern (% wildcard). Enter ile uygula."
                        className="border border-[#E2E8F0] rounded px-3 py-1.5 text-xs bg-white w-56 focus:outline-none focus:border-[#3B82F6]"
                    />
                    <button onClick={applySearch}
                        className="px-3 py-1.5 text-xs text-white bg-[#3B82F6] rounded hover:bg-[#2563EB]">
                        Ara
                    </button>
                    {search && (
                        <button onClick={clearSearch} title="Aramayı temizle"
                            className="px-2 py-1.5 text-xs text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                            ✕
                        </button>
                    )}
                </div>
                <div className="flex gap-1">
                    {sortButtons.map(b => (
                        <button
                            key={b.key}
                            onClick={() => setSort(b.key)}
                            title={b.tip}
                            className={`px-3 py-1.5 text-xs rounded border transition-colors ${sort === b.key
                                ? 'border-[#3B82F6] text-[#2563EB] bg-[#EFF6FF]'
                                : 'border-[#E2E8F0] text-[#64748B] hover:bg-[#F8FAFC]'
                                }`}
                        >
                            {b.label}
                        </button>
                    ))}
                </div>
                {sort === 'slow' && search && (
                    <span className="text-[10px] text-[#94A3B8] italic" title="Arama aktif — tek-spike sorgular da gösteriliyor. Üretim hot path için 'Çağrı Sayısı' sıralamasıyla karşılaştırın.">
                        ℹ tek-spike sorgular dahil
                    </span>
                )}
                <button onClick={() => setColumnsModalOpen(true)}
                    className="px-3 py-1.5 text-xs text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                    ⚙️ Sütun ({selectedCols.length})
                </button>
                <button onClick={() => refetch()}
                    className="px-3 py-1.5 text-xs text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                    {isFetching ? '...' : 'Yenile'}
                </button>
            </div>

            {isLoading ? (
                <div className="p-4"><SkeletonTable rows={8} cols={selectedCols.length + 2} /></div>
            ) : !data || data.length === 0 ? (
                <EmptyState
                    icon="📭"
                    title="Veri yok"
                    description="Bu pencerede sorgu kaydı yok. Tarih aralığını genişletin (örn. 24sa veya 7g) ya da daha yoğun workload'lı bir instance seçin."
                />
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide w-10">#</th>
                                {selectedCols.map(col => {
                                    const meta = TOP_QUERIES_COLUMNS_META.available.find(c => c.key === col);
                                    const isRight = ['toplam_cagri', 'toplam_dk', 'pct', 'min_ms', 'ort_ms', 'max_ms', 'toplam_satir'].includes(col);
                                    return (
                                        <th key={col} className={`py-2 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide ${isRight ? 'text-right' : 'text-left'}`}>
                                            {meta?.label ?? col}
                                        </th>
                                    );
                                })}
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.map((row, i) => (
                                <TopQueryRow
                                    key={`${row.statement_series_id}-${i}`}
                                    row={row}
                                    rank={i + 1}
                                    selectedCols={selectedCols}
                                    instancePk={instancePk}
                                    range={range}
                                    autoRefresh={autoRefresh}
                                    expanded={expandedSeriesId === row.statement_series_id}
                                    onToggle={() => setExpandedSeriesId(prev => prev === row.statement_series_id ? null : row.statement_series_id)}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <DataColumnsModal
                open={columnsModalOpen}
                onClose={() => setColumnsModalOpen(false)}
                selected={selectedCols}
                onChange={setSelectedCols}
                meta={TOP_QUERIES_COLUMNS_META}
                title="⚙️ Top Sorgular Sütunları"
            />
        </div>
        </div>
    );
}

function TopQueryRow({ row, rank, selectedCols, instancePk, range, autoRefresh, expanded, onToggle }: { row: TopQueryRow; rank: number; selectedCols: string[]; instancePk: number; range: TimeRange; autoRefresh: boolean; expanded: boolean; onToggle: () => void }) {
    const pct = parseFloat(row.pct_of_total);
    const ortMs = parseFloat(row.ort_ms);
    const maxMs = parseFloat(row.max_ms);
    const minMs = parseFloat(row.min_ms);
    const pctClass = pct >= 20 ? 'bg-red-100 text-red-700' : pct >= 5 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
    const tags = calculateTags(row);

    function renderCell(col: string) {
        switch (col) {
            case 'sql':
                return (
                    <td key={col} className="py-2 px-3 max-w-md">
                        <div className="font-mono text-xs text-[#1E293B] truncate" title={row.query_short ?? ''}>
                            {row.query_short || <span className="italic text-[#94A3B8]">metin yok</span>}
                        </div>
                        {tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                                {tags.map(tag => (
                                    <span key={tag.key} title={tag.title} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${tag.className}`}>
                                        <span>{tag.icon}</span>{tag.label}
                                    </span>
                                ))}
                            </div>
                        )}
                    </td>
                );
            case 'queryid':
                return (
                    <td key={col} className="py-2 px-3 text-xs font-mono text-[#64748B] whitespace-nowrap">
                        {row.queryid || '—'}
                    </td>
                );
            case 'datname':
                return <td key={col} className="py-2 px-3 text-xs text-[#1E293B] whitespace-nowrap">{row.datname || '—'}</td>;
            case 'toplam_cagri':
                return <td key={col} className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">{Number(row.toplam_cagri).toLocaleString('tr-TR')}</td>;
            case 'toplam_dk':
                return <td key={col} className="py-2 px-3 text-xs text-right font-mono font-semibold text-[#1E293B] whitespace-nowrap">{Number(row.toplam_dk).toLocaleString('tr-TR')} dk</td>;
            case 'pct':
                return (
                    <td key={col} className="py-2 px-3 text-xs text-right whitespace-nowrap">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${pctClass}`}>%{pct}</span>
                    </td>
                );
            case 'min_ms':
                return <td key={col} className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{minMs}</td>;
            case 'ort_ms':
                return <td key={col} className="py-2 px-3 text-xs text-right font-mono font-semibold text-[#1E293B] whitespace-nowrap">{ortMs}</td>;
            case 'max_ms':
                return <td key={col} className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{maxMs}</td>;
            case 'toplam_satir':
                return <td key={col} className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{Number(row.toplam_satir).toLocaleString('tr-TR')}</td>;
            default:
                return <td key={col} className="py-2 px-3 text-xs text-[#94A3B8]">—</td>;
        }
    }

    return (
        <>
        <tr onClick={onToggle} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors cursor-pointer">
            <td className="py-2 px-3 text-xs text-[#94A3B8] font-semibold">#{rank}</td>
            {selectedCols.map(col => renderCell(col))}
            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                <button type="button" className="text-[#94A3B8] mr-3" title={expanded ? 'Grafikleri kapat' : 'Grafikleri aç'}>{expanded ? '-' : '+'}</button>
                <Link to={`/statements/${row.statement_series_id}`} onClick={e => e.stopPropagation()} className="text-[#2563EB] hover:underline">Detay</Link>
            </td>
        </tr>
        {expanded && (
            <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                <td colSpan={selectedCols.length + 2} className="p-4">
                    <QueryTrendPanel instancePk={instancePk} seriesId={row.statement_series_id} range={range} autoRefresh={autoRefresh} />
                </td>
            </tr>
        )}
        </>
    );
}

function QueryTrendPanel({ instancePk, seriesId, range, autoRefresh }: { instancePk: number; seriesId: number; range: TimeRange; autoRefresh: boolean }) {
    const { data, isLoading } = useQuery({
        queryKey: ['insights-query-trend', instancePk, seriesId, range.fromIso, range.toIso],
        queryFn: () => apiGet<QueryTrendPoint[]>(
            `/insights/${instancePk}/query-trend?series_id=${seriesId}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}`,
        ),
        enabled: Number.isFinite(instancePk) && Number.isFinite(seriesId),
        refetchInterval: autoRefresh ? 30_000 : false,
    });

    const chartData = useMemo(() => (data ?? []).map(p => {
        const min = toNum(p.min_ms);
        const max = toNum(p.max_ms);
        return {
            label: formatBucket(String(p.bucket_start)),
            calls: toNum(p.calls),
            total_ms: toNum(p.total_ms),
            min_ms: min,
            avg_ms: toNum(p.avg_ms),
            max_ms: max,
            range_ms: Math.max(0, max - min),
        };
    }), [data]);

    if (isLoading) return <SkeletonTable rows={3} cols={3} />;
    if (chartData.length === 0) return <div className="text-xs text-[#94A3B8] py-4 text-center">Bu sorgu icin trend verisi yok.</div>;

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <InsightChart title="Latency" height={150}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} />
                    <Line type="monotone" dataKey="avg_ms" name="Avg ms" stroke="#2563EB" strokeWidth={2} dot={false} />
                </LineChart>
            </InsightChart>
            <InsightChart title="Throughput" height={150}>
                <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} />
                    <Area type="monotone" dataKey="calls" name="Calls" stroke="#059669" fill="#D1FAE5" strokeWidth={2} />
                </AreaChart>
            </InsightChart>
            <InsightChart title="Min-Avg-Max Range" height={150}>
                <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} />
                    <Area type="monotone" dataKey="min_ms" stackId="range" stroke="transparent" fill="transparent" name="Min ms" />
                    <Area type="monotone" dataKey="range_ms" stackId="range" stroke="transparent" fill="#E5E7EB" name="Max-Min ms" />
                    <Line type="monotone" dataKey="avg_ms" name="Avg ms" stroke="#7C3AED" strokeWidth={2} dot={false} />
                </ComposedChart>
            </InsightChart>
        </div>
    );
}
