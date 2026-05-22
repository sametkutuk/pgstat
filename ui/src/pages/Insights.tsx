import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import { SkeletonTable } from '../components/common/Skeleton';
import EmptyState from '../components/common/EmptyState';
import TimeRangePicker, { loadPersistedRange, type TimeRange } from '../components/common/TimeRangePicker';
import DataColumnsModal, { useDataColumns, type ColumnsMeta } from '../components/common/DataColumnsModal';
import { useToast } from '../components/common/Toast';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

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
            {tab === 'temp-spill' && <TempSpillCard instancePk={instancePk} range={range} onRangeChange={setRange} autoRefresh={autoRefresh} instanceName={activeInstances.find(i => i.instance_pk === instancePk)?.display_name} />}
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
    query_full: string | null;
    toplam_cagri: string;
    toplam_exec_ms: string;
    toplam_dk: string;
    pct_of_total: string;
    min_ms: string;
    ort_ms: string;
    max_ms: string;
    toplam_satir: string;
    cache_hit_pct: string | null;
    ort_plan_ms: string | null;
    wal_mb: string | null;
    satir_per_cagri: string | null;
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
    // db-time-trend ?include_baseline=1 ile gelir. Search filtresi varken
    // foreground'a karsi arka planda gosterilen "instance/DB toplami"
    // serisi. Yoksa null.
    baseline?: T[] | null;
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

function calculateTempTags(row: TempSpillRow): InsightTag[] {
    const tempMb = toNum(row.temp_written_mb);
    const mbPerCall = toNum(row.temp_written_mb_per_call);
    const calls = toNum(row.toplam_cagri);
    const rowsPerTempMb = row.rows_per_temp_mb == null ? null : toNum(row.rows_per_temp_mb);
    const queryLower = (row.query_full || '').toLowerCase();
    const hasOrderBy = /\border\s+by\b/.test(queryLower);
    const hasGroupBy = /\bgroup\s+by\b/.test(queryLower);
    const hasDistinct = /\bdistinct\b/.test(queryLower);
    const hasLimit = /\blimit\b/.test(queryLower);
    const hasJoin = /\sjoin\s/.test(queryLower);
    const tags: InsightTag[] = [];

    if (mbPerCall >= 100) tags.push({ key: 'mega-spill', label: 'Mega Spill', icon: '💥', className: 'bg-red-100 text-red-700', title: 'Tek çağrıda 100MB+ temp yazıyor — work_mem ciddi yetersiz' });
    if (calls >= 1000 && mbPerCall >= 1) tags.push({ key: 'frequent-spill', label: 'Sürekli Spill', icon: '🔁', className: 'bg-orange-100 text-orange-700', title: 'Sık çağrılıyor ve her çağrıda temp yazıyor — toplu kazanç fırsatı' });
    if (rowsPerTempMb != null && rowsPerTempMb < 1000 && tempMb >= 10) tags.push({ key: 'inefficient', label: 'Verimsiz', icon: '🐌', className: 'bg-amber-100 text-amber-700', title: "1MB temp başına 1000'den az satır — ya filter çok geç çalışıyor ya da gereksiz sort" });
    if (hasOrderBy || hasGroupBy || hasDistinct) {
        const reasons: string[] = [];
        if (hasOrderBy) reasons.push('ORDER BY');
        if (hasGroupBy) reasons.push('GROUP BY');
        if (hasDistinct) reasons.push('DISTINCT');
        const reasonText = reasons.join(' + ');
        const limitHint = hasOrderBy && !hasLimit ? ' - LIMIT eksik, tum sonuc sort ediliyor olabilir' : '';
        tags.push({
            key: 'sort-spill',
            label: 'Sort Spill',
            icon: '📊',
            className: 'bg-blue-100 text-blue-700',
            title: `${reasonText} ile sort spill olasi.${limitHint} EXPLAIN ile dogrula.`,
        });
    }
    if (hasJoin && mbPerCall >= 10) {
        const joinCount = (queryLower.match(/\sjoin\s/g) || []).length;
        const countText = joinCount > 1 ? `${joinCount} JOIN var` : 'JOIN var';
        tags.push({
            key: 'hash-spill',
            label: 'Hash Spill',
            icon: '🔗',
            className: 'bg-purple-100 text-purple-700',
            title: `${countText} ve buyuk temp spill - hash join work_mem asiyor olabilir. EXPLAIN gerekli.`,
        });
    }
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

function formatDurationSec(sec: number): string {
    if (sec >= 3600) {
        const hours = Math.floor(sec / 3600);
        const minutes = Math.floor((sec % 3600) / 60);
        return `${hours} sa ${minutes} dk`;
    }
    if (sec >= 60) {
        const minutes = Math.floor(sec / 60);
        const seconds = Math.round(sec % 60);
        return `${minutes} dk ${seconds} sn`;
    }
    return `${Math.round(sec)} sn`;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
}

// Eksen tick'leri icin kisa label. Uzun pencerede gun ekle.
function formatBucket(value: string, windowHours: number): string {
    const d = new Date(value);
    if (windowHours <= 24) {
        return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    }
    if (windowHours <= 7 * 24) {
        // 7 gune kadar: "21.05 14:00"
        return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    // 30 gun+: "21 May 12:00" (saat dahil cunku 6sa bucket)
    return d.toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Tooltip basligi icin tam tarih
function formatBucketFull(value: string): string {
    return new Date(value).toLocaleString('tr-TR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

// Pencere uzunluguna gore gun ayraci ReferenceLine cizilecek mi?
function shouldShowDaySeparators(windowHours: number): boolean {
    return windowHours > 24;
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
    const hasPreviousSeries = payload.some((p: any) => String(p.dataKey).startsWith('previous_'));
    if (current && hasPreviousSeries) {
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

function CopyIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"
            viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
    );
}

// HTTP+IP (secure context degil) ortamlarda navigator.clipboard.writeText
// engellenir. Bu durumda gizli textarea + execCommand('copy') fallback'i.
function copyTextFallback(value: string): boolean {
    try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

function CopyButton({ value, message, disabled }: { value: string; message: string; disabled?: boolean }) {
    const toast = useToast();
    async function copy(e: MouseEvent<HTMLButtonElement>) {
        e.stopPropagation();
        if (disabled || !value) return;
        // Once modern API'yi dene, secure context degilse fallback
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(value);
                toast.success(message);
                return;
            }
        } catch { /* fallback'e dus */ }
        if (copyTextFallback(value)) {
            toast.success(message);
        } else {
            toast.error('Kopyalama başarısız');
        }
    }
    return (
        <button
            type="button"
            onClick={copy}
            disabled={disabled || !value}
            title="Kopyala"
            className="inline-flex items-center justify-center p-1 rounded text-[#94A3B8] opacity-50 transition hover:opacity-100 hover:text-[#2563EB] hover:bg-[#F1F5F9] disabled:cursor-not-allowed disabled:opacity-20"
        >
            <CopyIcon />
        </button>
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
        { key: 'cache_hit_pct', label: 'Cache Hit %', since: 11 },
        { key: 'ort_plan_ms', label: 'Plan (ms)', since: 11 },
        { key: 'wal_mb', label: 'WAL (MB)', since: 13 },
        { key: 'satir_per_cagri', label: 'Satır/Çağrı', since: 11 },
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
    const [compareMode, setCompareModeState] = useState<CompareMode>(() => loadCompareMode());
    const { selected: selectedCols, setSelected: setSelectedCols } = useDataColumns(
        'pgstat.insights.top-queries.cols',
        TOP_QUERIES_COLUMNS_META.defaults,
        TOP_QUERIES_COLUMNS_META,
    );

    const searchQp = search ? `&search=${encodeURIComponent(search)}` : '';
    const datnameQp = datname ? `&datname=${encodeURIComponent(datname)}` : '';
    const compareKey = compareMode === 'auto' ? compareForRange(range) : null;
    const compareQp = compareKey ? `&compare=${compareKey}` : '';

    function setCompareMode(mode: CompareMode) {
        setCompareModeState(mode);
        window.localStorage.setItem('pgstat.insights.compare-mode', mode);
    }

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

    // Search aktifken backend baseline (search'siz, ayni datname) ekstra serisi de
    // doner — grafikte arka planda gri alan olarak goruntulenir.
    const baselineQp = search ? `&include_baseline=1` : '';
    const { data: trendData } = useQuery({
        queryKey: ['insights-db-time-trend', instancePk, range.fromIso, range.toIso, datname, search, compareKey],
        queryFn: () => apiGet<TrendResponse<DbTimeTrendPoint>>(
            `/insights/${instancePk}/db-time-trend?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${searchQp}${datnameQp}${compareQp}${baselineQp}`,
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
    const windowHours = useMemo(
        () => (new Date(range.toIso).getTime() - new Date(range.fromIso).getTime()) / 3_600_000,
        [range.fromIso, range.toIso],
    );
    const chartData = useMemo<ChartDatum[]>(() => {
        const previousByBucket = new Map((trendData?.previous ?? []).map(p => [bucketKey(p.bucket_aligned ?? p.bucket_start), p]));
        const baselineByBucket = new Map((trendData?.baseline ?? []).map(p => [bucketKey(p.bucket_start), p]));
        return (trendData?.current ?? []).map(p => {
            const key = bucketKey(p.bucket_start);
            const previous = previousByBucket.get(key);
            const baseline = baselineByBucket.get(key);
            const currentMin = +(toNum(p.total_ms) / 60_000).toFixed(2);
            const baselineMin = baseline ? +(toNum(baseline.total_ms) / 60_000).toFixed(2) : null;
            const currentCalls = toNum(p.total_calls);
            const baselineCalls = baseline ? toNum(baseline.total_calls) : null;
            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_db_minutes: currentMin,
                previous_db_minutes: previous ? +(toNum(previous.total_ms) / 60_000).toFixed(2) : null,
                baseline_db_minutes: baselineMin,
                // Stacked area icin "rest": baseline'dan current cikartilmis kalan
                rest_db_minutes: baselineMin == null ? null : Math.max(0, +(baselineMin - currentMin).toFixed(2)),
                current_calls: currentCalls,
                previous_calls: previous ? toNum(previous.total_calls) : null,
                baseline_calls: baselineCalls,
                rest_calls: baselineCalls == null ? null : Math.max(0, baselineCalls - currentCalls),
            };
        });
    }, [trendData, windowHours]);
    const hasBaseline = useMemo(() => {
        const b = trendData?.baseline;
        return Array.isArray(b) && b.length > 0;
    }, [trendData]);
    // Y-domain hesabi: filtreli max'i kuvvetli, baseline'in p70'i sinirli
    // gosterilsin. max(filtreli*1.5, baseline_p70). Boylece filtreli alan
    // ezilmez ama baseline'in cogu icerde kalir; sadece outlier zirveler
    // dısarı tasar. P70 percentile aritmetik ortalamadan daha stabil.
    function percentile(values: number[], p: number): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
        return sorted[idx];
    }
    const yDomainDbMinutes = useMemo<[number, number] | undefined>(() => {
        if (!hasBaseline) return undefined;
        const currentMax = chartData.reduce((m, d) => Math.max(m, toNum(d.current_db_minutes)), 0);
        const baselineP70 = percentile(chartData.map(d => toNum(d.baseline_db_minutes)).filter(v => v > 0), 0.70);
        const upper = Math.max(currentMax * 1.5, baselineP70);
        return upper > 0 ? [0, +(upper * 1.05).toFixed(2)] : undefined;
    }, [chartData, hasBaseline]);
    const yDomainCalls = useMemo<[number, number] | undefined>(() => {
        if (!hasBaseline) return undefined;
        const currentMax = chartData.reduce((m, d) => Math.max(m, toNum(d.current_calls)), 0);
        const baselineP70 = percentile(chartData.map(d => toNum(d.baseline_calls)).filter(v => v > 0), 0.70);
        const upper = Math.max(currentMax * 1.5, baselineP70);
        return upper > 0 ? [0, Math.ceil(upper * 1.05)] : undefined;
    }, [chartData, hasBaseline]);

    // Gun ayraci ReferenceLine'lari: 00:00'a denk gelen bucket label'lari.
    // Her bir local-day icin sadece bir tane (ilk denk gelen bucket) tut.
    const daySeparatorLabels = useMemo<string[]>(() => {
        if (!shouldShowDaySeparators(windowHours)) return [];
        const seen = new Set<string>();
        const labels: string[] = [];
        for (const d of chartData) {
            if (!d.bucket_iso || typeof d.bucket_iso !== 'string') continue;
            const dt = new Date(d.bucket_iso);
            const dayKey = dt.toLocaleDateString('tr-TR');
            if (!seen.has(dayKey) && dt.getHours() < 6) {
                // Gun basina yakin ilk bucket (24sa+ pencerede saat granul. 1-6 arasi)
                seen.add(dayKey);
                labels.push(d.label);
            }
        }
        return labels;
    }, [chartData, windowHours]);

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

            <div className="flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
                <span>Karşılaştırma:</span>
                <div className="inline-flex rounded border border-[#E2E8F0] bg-white overflow-hidden">
                    <button
                        type="button"
                        onClick={() => setCompareMode('auto')}
                        className={`px-3 py-1.5 ${compareMode === 'auto' ? 'bg-[#EFF6FF] text-[#2563EB]' : 'hover:bg-[#F8FAFC]'}`}
                    >
                        Otomatik
                    </button>
                    <button
                        type="button"
                        onClick={() => setCompareMode('off')}
                        className={`px-3 py-1.5 border-l border-[#E2E8F0] ${compareMode === 'off' ? 'bg-[#EFF6FF] text-[#2563EB]' : 'hover:bg-[#F8FAFC]'}`}
                    >
                        Kapalı
                    </button>
                </div>
                {compareKey && <span className="text-[#94A3B8]">{compareLabel(compareKey)}</span>}
            </div>

            {chartData.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <InsightChart title="DB Time Trend (Toplam)" height={360}>
                        <AreaChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                            {/* Y-axis filtreli serinin max'ina gore; baseline asarsa grafik disina taşar (clipped) */}
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} domain={yDomainDbMinutes as any} allowDataOverflow={hasBaseline} />
                            <Tooltip content={<ChartTooltip />} labelFormatter={(_l, p) => formatBucketFull(String((p?.[0]?.payload as any)?.bucket_iso ?? _l))} />
                            {daySeparatorLabels.map(lbl => (
                                <ReferenceLine key={`db-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                            ))}
                            {hasBaseline && <Area type="monotone" dataKey="baseline_db_minutes" name={datname ? `${datname} toplam` : 'Instance toplam'} stroke="#94A3B8" fill="#E2E8F0" fillOpacity={0.5} strokeWidth={1} connectNulls />}
                            {compareKey && <Area type="monotone" dataKey="previous_db_minutes" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                            <Area type="monotone" dataKey="current_db_minutes" name={search ? 'Filtreli' : 'Şu an'} stroke="#2563EB" fill="#3B82F6" fillOpacity={0.7} strokeWidth={2} />
                        </AreaChart>
                    </InsightChart>
                    <InsightChart title="Throughput Trend" height={360}>
                        <AreaChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} domain={yDomainCalls as any} allowDataOverflow={hasBaseline} />
                            <Tooltip content={<ChartTooltip />} labelFormatter={(_l, p) => formatBucketFull(String((p?.[0]?.payload as any)?.bucket_iso ?? _l))} />
                            {daySeparatorLabels.map(lbl => (
                                <ReferenceLine key={`tp-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                            ))}
                            {hasBaseline && <Area type="monotone" dataKey="baseline_calls" name={datname ? `${datname} toplam` : 'Instance toplam'} stroke="#94A3B8" fill="#E2E8F0" fillOpacity={0.5} strokeWidth={1} connectNulls />}
                            {compareKey && <Area type="monotone" dataKey="previous_calls" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                            <Area type="monotone" dataKey="current_calls" name={search ? 'Filtreli' : 'Şu an'} stroke="#059669" fill="#10B981" fillOpacity={0.7} strokeWidth={2} />
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
                                    const isRight = ['toplam_cagri', 'toplam_dk', 'pct', 'min_ms', 'ort_ms', 'max_ms', 'toplam_satir', 'cache_hit_pct', 'ort_plan_ms', 'wal_mb', 'satir_per_cagri'].includes(col);
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
                                    compareKey={compareKey}
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

function TopQueryRow({ row, rank, selectedCols, instancePk, range, autoRefresh, compareKey, expanded, onToggle }: { row: TopQueryRow; rank: number; selectedCols: string[]; instancePk: number; range: TimeRange; autoRefresh: boolean; compareKey: CompareKey | null; expanded: boolean; onToggle: () => void }) {
    const pct = parseFloat(row.pct_of_total);
    const ortMs = parseFloat(row.ort_ms);
    const maxMs = parseFloat(row.max_ms);
    const minMs = parseFloat(row.min_ms);
    const pctClass = pct >= 20 ? 'bg-red-100 text-red-700' : pct >= 5 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
    const tags = calculateTags(row);

    function renderCell(col: string) {
        if (col === 'queryid') {
            return (
                <td key={col} className="py-2 px-3 text-xs font-mono text-[#64748B] whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                        <span>{row.queryid || 'â€”'}</span>
                        <CopyButton value={row.queryid ?? ''} message="Query ID kopyalandı" disabled={!row.queryid} />
                    </span>
                </td>
            );
        }
        switch (col) {
            case 'sql':
                return (
                    <td key={col} className="py-2 px-3 max-w-md">
                        <div className="flex items-start gap-1">
                            <div className="font-mono text-xs text-[#1E293B] truncate flex-1" title={row.query_full ?? row.query_short ?? ''}>
                                {row.query_short || <span className="italic text-[#94A3B8]">metin yok</span>}
                            </div>
                            <CopyButton value={row.query_full ?? ''} message="SQL kopyalandı" disabled={!row.query_full} />
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
            case 'cache_hit_pct': {
                if (row.cache_hit_pct == null) {
                    return <td key={col} className="py-2 px-3 text-xs text-right text-[#94A3B8]">—</td>;
                }
                const hit = parseFloat(row.cache_hit_pct);
                // < 90: kirmizi (disk-bound), < 99: sari, >= 99: yesil
                const hitClass = hit < 90 ? 'bg-red-100 text-red-700' : hit < 99 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700';
                return (
                    <td key={col} className="py-2 px-3 text-xs text-right whitespace-nowrap">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${hitClass}`}>%{hit}</span>
                    </td>
                );
            }
            case 'ort_plan_ms':
                return <td key={col} className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{row.ort_plan_ms == null ? '—' : Number(row.ort_plan_ms).toLocaleString('tr-TR')}</td>;
            case 'wal_mb':
                return <td key={col} className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{row.wal_mb == null ? '—' : Number(row.wal_mb).toLocaleString('tr-TR')}</td>;
            case 'satir_per_cagri':
                return <td key={col} className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{row.satir_per_cagri == null ? '—' : Number(row.satir_per_cagri).toLocaleString('tr-TR')}</td>;
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
                    <QueryTrendPanel instancePk={instancePk} seriesId={row.statement_series_id} range={range} autoRefresh={autoRefresh} compareKey={compareKey} />
                </td>
            </tr>
        )}
        </>
    );
}

function QueryTrendPanel({ instancePk, seriesId, range, autoRefresh, compareKey }: { instancePk: number; seriesId: number | string; range: TimeRange; autoRefresh: boolean; compareKey: CompareKey | null }) {
    const compareQp = compareKey ? `&compare=${compareKey}` : '';
    const { data, isLoading } = useQuery({
        queryKey: ['insights-query-trend', instancePk, seriesId, range.fromIso, range.toIso, compareKey],
        queryFn: () => apiGet<TrendResponse<QueryTrendPoint>>(
            `/insights/${instancePk}/query-trend?series_id=${seriesId}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${compareQp}`,
        ),
        // seriesId PG'den bigint donduğu icin string gelebilir; truthy check yeterli
        enabled: instancePk != null && seriesId != null && String(seriesId).length > 0,
        refetchInterval: autoRefresh ? 30_000 : false,
    });

    const windowHours = useMemo(
        () => (new Date(range.toIso).getTime() - new Date(range.fromIso).getTime()) / 3_600_000,
        [range.fromIso, range.toIso],
    );
    const chartData = useMemo<ChartDatum[]>(() => {
        const previousByBucket = new Map((data?.previous ?? []).map(p => [bucketKey(p.bucket_aligned ?? p.bucket_start), p]));
        return (data?.current ?? []).map(p => {
            const key = bucketKey(p.bucket_start);
            const previous = previousByBucket.get(key);
            // min/avg/max null kalir ki veri olmayan bucket'larda grafik 0'a inmesin
            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_calls: toNum(p.calls),
                previous_calls: previous ? toNum(previous.calls) : null,
                total_ms: toNum(p.total_ms),
                min_ms: p.min_ms == null ? null : toNum(p.min_ms),
                current_avg_ms: p.avg_ms == null ? null : toNum(p.avg_ms),
                previous_avg_ms: previous?.avg_ms == null ? null : toNum(previous.avg_ms),
                max_ms: p.max_ms == null ? null : toNum(p.max_ms),
            };
        });
    }, [data, windowHours]);

    const daySeparatorLabels = useMemo<string[]>(() => {
        if (!shouldShowDaySeparators(windowHours)) return [];
        const seen = new Set<string>();
        const labels: string[] = [];
        for (const d of chartData) {
            if (!d.bucket_iso || typeof d.bucket_iso !== 'string') continue;
            const dt = new Date(d.bucket_iso);
            const dayKey = dt.toLocaleDateString('tr-TR');
            if (!seen.has(dayKey) && dt.getHours() < 6) {
                seen.add(dayKey);
                labels.push(d.label);
            }
        }
        return labels;
    }, [chartData, windowHours]);

    if (isLoading) return <SkeletonTable rows={3} cols={3} />;
    if (chartData.length === 0) return <div className="text-xs text-[#94A3B8] py-4 text-center">Bu sorgu icin trend verisi yok.</div>;

    const tooltipLabelFmt = (_l: any, p: any) => formatBucketFull(String((p?.[0]?.payload as any)?.bucket_iso ?? _l));

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <InsightChart title="Latency" height={150}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`lat-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Line type="monotone" dataKey="previous_avg_ms" name={compareLabel(compareKey)} stroke="#94A3B8" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />}
                    <Line type="monotone" dataKey="current_avg_ms" name="Şu an" stroke="#2563EB" strokeWidth={2} dot={false} />
                </LineChart>
            </InsightChart>
            <InsightChart title="Throughput" height={150}>
                <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`q-tp-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Area type="monotone" dataKey="previous_calls" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                    <Area type="monotone" dataKey="current_calls" name="Şu an" stroke="#059669" fill="#D1FAE5" strokeWidth={2} />
                </AreaChart>
            </InsightChart>
            <InsightChart title="Min / Avg / Max" height={150}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`mam-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    <Line type="monotone" dataKey="min_ms" name="Min ms" stroke="#059669" strokeWidth={1.5} dot={false} connectNulls />
                    <Line type="monotone" dataKey="current_avg_ms" name="Avg ms" stroke="#2563EB" strokeWidth={2} dot={false} connectNulls />
                    <Line type="monotone" dataKey="max_ms" name="Max ms" stroke="#DC2626" strokeWidth={1.5} dot={false} connectNulls />
                </LineChart>
            </InsightChart>
        </div>
    );
}

// =========================================================================
// TEMP SPILL sekmesi
// =========================================================================
interface TempSpillRow {
    datname: string | null;
    queryid: string | null;
    query_text_id: number | null;
    statement_series_id: number;
    query_short: string | null;
    query_full: string | null;
    toplam_cagri: string;
    toplam_temp_written_blks: string;
    toplam_temp_read_blks: string;
    temp_written_mb: string;
    temp_read_mb: string;
    temp_written_mb_per_call: string | null;
    max_temp_mb_per_call: string | null;
    avg_parallel_workers: string;
    recommended_work_mem_mb_min: string | null;
    temp_write_time_sec: string | null;
    rows_per_temp_mb: string | null;
    pct_of_total_temp: string | null;
    toplam_exec_ms: string;
    toplam_dk: string;
    ort_ms: string;
    toplam_satir: string;
}

interface TempSpillTotals {
    total_temp_write_time_sec: number;
    top_datname: { datname: string | null; mb: number; pct: number } | null;
    peak: { bucket_start: string; mb: number } | null;
    work_mem_kb: number | null;
}

interface TempSpillResponse {
    rows: TempSpillRow[];
    totals: TempSpillTotals;
}

type TempSortMode = 'temp_written' | 'temp_read';

interface TempTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    temp_blks_written: string | number;
    temp_blks_read: string | number;
    calls: string | number;
}

function TempSpillCard({ instancePk, range, onRangeChange, autoRefresh, instanceName }: { instancePk: number | null; range: TimeRange; onRangeChange: (range: TimeRange) => void; autoRefresh: boolean; instanceName?: string }) {
    if (instancePk == null) {
        return <EmptyState icon="🖥️" title="Instance seçin" description="Yukarıdan bir aktif instance seçin." />;
    }
    return <TempSpillCardInner instancePk={instancePk} range={range} onRangeChange={onRangeChange} autoRefresh={autoRefresh} instanceName={instanceName} />;
}

function TempSpillCardInner({ instancePk, range, onRangeChange, autoRefresh, instanceName }: { instancePk: number; range: TimeRange; onRangeChange: (range: TimeRange) => void; autoRefresh: boolean; instanceName?: string }) {
    const [sort, setSort] = useState<TempSortMode>('temp_written');
    const [searchInput, setSearchInput] = useState<string>('');
    const [search, setSearch] = useState<string>('');
    const [datname, setDatname] = useState<string>('');
    const [compareMode, setCompareMode] = useState<CompareMode>(() => loadCompareMode());
    useEffect(() => {
        try { window.localStorage.setItem('pgstat.insights.compare-mode', compareMode); } catch { /* ignore */ }
    }, [compareMode]);

    const searchQp = search ? `&search=${encodeURIComponent(search)}` : '';
    const datnameQp = datname ? `&datname=${encodeURIComponent(datname)}` : '';
    const compareKey = compareMode === 'off' ? null : compareForRange(range);
    const compareQp = compareKey ? `&compare=${compareKey}` : '';

    const { data: databases } = useQuery({
        queryKey: ['insights-databases', instancePk],
        queryFn: () => apiGet<string[]>(`/insights/${instancePk}/databases`),
        staleTime: 60_000,
        refetchInterval: false,
    });

    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['insights-temp-spill', instancePk, range.fromIso, range.toIso, sort, search, datname],
        queryFn: () => apiGet<TempSpillResponse>(
            `/insights/${instancePk}/temp-spill?sort=${sort}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}&limit=20${searchQp}${datnameQp}`,
        ),
        refetchInterval: autoRefresh ? 30_000 : false,
        staleTime: 0,
    });
    const rows = data?.rows ?? [];
    const totals = data?.totals;

    const baselineQp = search ? `&include_baseline=1` : '';
    const { data: trendData } = useQuery({
        queryKey: ['insights-temp-trend', instancePk, range.fromIso, range.toIso, datname, search, compareKey],
        queryFn: () => apiGet<TrendResponse<TempTrendPoint>>(
            `/insights/${instancePk}/temp-trend?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${searchQp}${datnameQp}${compareQp}${baselineQp}`,
        ),
        refetchInterval: autoRefresh ? 30_000 : false,
    });

    const windowHours = useMemo(
        () => (new Date(range.toIso).getTime() - new Date(range.fromIso).getTime()) / 3_600_000,
        [range.fromIso, range.toIso],
    );
    const chartData = useMemo<ChartDatum[]>(() => {
        const previousByBucket = new Map((trendData?.previous ?? []).map(p => [bucketKey(p.bucket_aligned ?? p.bucket_start), p]));
        const baselineByBucket = new Map((trendData?.baseline ?? []).map(p => [bucketKey(p.bucket_start), p]));
        return (trendData?.current ?? []).map(p => {
            const key = bucketKey(p.bucket_start);
            const previous = previousByBucket.get(key);
            const baseline = baselineByBucket.get(key);
            const currentMb = +(toNum(p.temp_blks_written) / 128.0).toFixed(2);
            const baselineMb = baseline ? +(toNum(baseline.temp_blks_written) / 128.0).toFixed(2) : null;
            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_temp_mb: currentMb,
                previous_temp_mb: previous ? +(toNum(previous.temp_blks_written) / 128.0).toFixed(2) : null,
                baseline_temp_mb: baselineMb,
                current_calls: toNum(p.calls),
            };
        });
    }, [trendData, windowHours]);
    const hasBaseline = useMemo(() => {
        const b = trendData?.baseline;
        return Array.isArray(b) && b.length > 0;
    }, [trendData]);
    const yDomainTempMb = useMemo<[number, number] | undefined>(() => {
        if (!hasBaseline) return undefined;
        const currentMax = chartData.reduce((m, d) => Math.max(m, toNum(d.current_temp_mb)), 0);
        const baselineP70 = (() => {
            const vals = chartData.map(d => toNum(d.baseline_temp_mb)).filter(v => v > 0);
            if (vals.length === 0) return 0;
            const sorted = [...vals].sort((a, b) => a - b);
            return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.70))];
        })();
        const upper = Math.max(currentMax * 1.5, baselineP70);
        return upper > 0 ? [0, +(upper * 1.05).toFixed(2)] : undefined;
    }, [chartData, hasBaseline]);
    const daySeparatorLabels = useMemo<string[]>(() => {
        if (!shouldShowDaySeparators(windowHours)) return [];
        const seen = new Set<string>();
        const labels: string[] = [];
        for (const d of chartData) {
            if (!d.bucket_iso || typeof d.bucket_iso !== 'string') continue;
            const dt = new Date(d.bucket_iso);
            const dayKey = dt.toLocaleDateString('tr-TR');
            if (!seen.has(dayKey) && dt.getHours() < 6) {
                seen.add(dayKey);
                labels.push(d.label);
            }
        }
        return labels;
    }, [chartData, windowHours]);

    const summary = useMemo(() => {
        if (rows.length === 0) return null;
        const totalMb = rows.reduce((sum, r) => sum + toNum(r.temp_written_mb), 0);
        const topShare = totalMb > 0 ? (toNum(rows[0]?.temp_written_mb) / totalMb) * 100 : 0;
        const overHundred = rows.filter(r => toNum(r.temp_written_mb) > 100).length;
        return { totalMb, topShare, overHundred };
    }, [rows]);
    const tagCounts = useMemo(() => {
        const counts: Record<string, { icon: string; count: number }> = {};
        for (const row of rows) {
            for (const tag of calculateTempTags(row)) {
                counts[tag.key] = { icon: tag.icon, count: (counts[tag.key]?.count ?? 0) + 1 };
            }
        }
        return counts;
    }, [rows]);

    const sortButtons: { key: TempSortMode; label: string; tip: string }[] = [
        { key: 'temp_written', label: 'Yazılan Temp', tip: 'sum(temp_blks_written) — work_mem yetmediginde diske yazilan' },
        { key: 'temp_read', label: 'Okunan Temp', tip: 'sum(temp_blks_read) — disk\'ten geri okunan temp veri' },
    ];

    function applySearch() { setSearch(searchInput.trim()); }
    function clearSearch() { setSearchInput(''); setSearch(''); }
    function zoomToPeak() {
        if (!totals?.peak) return;
        const start = new Date(totals.peak.bucket_start);
        const end = new Date(start.getTime() + 3600_000);
        const nextRange = { fromIso: start.toISOString(), toIso: end.toISOString() };
        onRangeChange(nextRange);
        try { window.localStorage.setItem('insights-range', JSON.stringify(nextRange)); } catch { /* ignore */ }
    }
    const datnameIsActive = datname === totals?.top_datname?.datname;

    return (
        <div className="space-y-4">
            {summary && (
                <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] p-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-semibold text-[#1E293B]">💾 {instanceName || `Instance ${instancePk}`} · {rangeLabel(range)}</span>
                        {datname && <span className="text-xs px-2 py-0.5 rounded bg-[#EFF6FF] text-[#2563EB]">{datname}</span>}
                    </div>
                    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 text-xs text-[#64748B]">
                        <div>Toplam temp: <b className="text-[#1E293B]">{summary.totalMb.toLocaleString('tr-TR')} MB</b> · En yüksek sorgu: <b className="text-[#1E293B]">%{summary.topShare.toFixed(1)}</b></div>
                        <div>
                            {'>'}100MB yazan sorgu: <b className={summary.overHundred > 0 ? 'text-orange-700' : 'text-[#1E293B]'}>{summary.overHundred}</b>
                            <span className="mx-1">·</span>
                            Etiketler: {Object.values(tagCounts).length === 0 ? <span className="text-[#94A3B8]">yok</span> : Object.values(tagCounts).map(t => <span key={t.icon} className="mr-2">{t.icon} {t.count}</span>)}
                        </div>
                        <div className="md:col-span-2">
                            Disk I/O süresi: <b className="text-[#1E293B]">{totals ? formatDurationSec(totals.total_temp_write_time_sec) : '\u2014'}</b>
                            <span className="mx-1">·</span>
                            En çok yazan DB: <b className="text-[#1E293B]">{totals?.top_datname ? (
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!datnameIsActive && totals.top_datname?.datname) setDatname(totals.top_datname.datname);
                                    }}
                                    title="Tikla - bu DB'yi filtre olarak uygula"
                                    className="underline decoration-dotted hover:text-[#2563EB] hover:decoration-solid"
                                >
                                    {totals.top_datname.datname ?? '\u2014'} (%{totals.top_datname.pct.toFixed(1)})
                                </button>
                            ) : '\u2014'}</b>
                            <span className="mx-1">·</span>
                            Pik anı: <b className="text-[#1E293B]">{totals?.peak ? (
                                <button
                                    type="button"
                                    onClick={zoomToPeak}
                                    title="Tikla - date range pik saate daralsin"
                                    className="underline decoration-dotted hover:text-[#2563EB] hover:decoration-solid"
                                >
                                    {formatBucketFull(totals.peak.bucket_start)} — {totals.peak.mb.toFixed(1)} MB
                                </button>
                            ) : '\u2014'}</b>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
                <span>Karşılaştırma:</span>
                <div className="inline-flex rounded border border-[#E2E8F0] bg-white overflow-hidden">
                    <button type="button" onClick={() => setCompareMode('auto')}
                        className={`px-3 py-1.5 ${compareMode === 'auto' ? 'bg-[#EFF6FF] text-[#2563EB]' : 'hover:bg-[#F8FAFC]'}`}>Otomatik</button>
                    <button type="button" onClick={() => setCompareMode('off')}
                        className={`px-3 py-1.5 border-l border-[#E2E8F0] ${compareMode === 'off' ? 'bg-[#EFF6FF] text-[#2563EB]' : 'hover:bg-[#F8FAFC]'}`}>Kapalı</button>
                </div>
                {compareKey && <span className="text-[#94A3B8]">{compareLabel(compareKey)}</span>}
            </div>

            {chartData.length > 0 && (
                <InsightChart title="Temp Spill Trend (MB)" height={300}>
                    <AreaChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} domain={yDomainTempMb as any} allowDataOverflow={hasBaseline} />
                        <Tooltip content={<ChartTooltip />} labelFormatter={(_l, p) => formatBucketFull(String((p?.[0]?.payload as any)?.bucket_iso ?? _l))} />
                        {daySeparatorLabels.map(lbl => (
                            <ReferenceLine key={`tmp-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                        ))}
                        {hasBaseline && <Area type="monotone" dataKey="baseline_temp_mb" name={datname ? `${datname} toplam` : 'Instance toplam'} stroke="#94A3B8" fill="#E2E8F0" fillOpacity={0.5} strokeWidth={1} connectNulls />}
                        {compareKey && <Area type="monotone" dataKey="previous_temp_mb" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                        <Area type="monotone" dataKey="current_temp_mb" name={search ? 'Filtreli' : 'Şu an'} stroke="#D97706" fill="#FBBF24" fillOpacity={0.6} strokeWidth={2} />
                    </AreaChart>
                </InsightChart>
            )}

            <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0]">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="font-semibold text-[#1E293B]">Temp Spill Sorgular</h3>
                        <p className="text-xs text-[#64748B]">work_mem yetmeyen ve disk'e temp dosyalar yazan sorgular. Sadece temp yazımı olanlar listelenir.</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <select value={datname} onChange={e => setDatname(e.target.value)}
                            title="Database filtresi" className="border border-[#E2E8F0] rounded px-2 py-1.5 text-xs bg-white max-w-[160px]">
                            <option value="">Tüm Database'ler</option>
                            {(databases ?? []).map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') applySearch(); }}
                            placeholder="queryid veya %select%" className="border border-[#E2E8F0] rounded px-3 py-1.5 text-xs bg-white w-56 focus:outline-none focus:border-[#3B82F6]" />
                        <button onClick={applySearch} className="px-3 py-1.5 text-xs text-white bg-[#3B82F6] rounded hover:bg-[#2563EB]">Ara</button>
                        {search && (
                            <button onClick={clearSearch} className="px-2 py-1.5 text-xs text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">✕</button>
                        )}
                    </div>
                    <div className="flex gap-1">
                        {sortButtons.map(b => (
                            <button key={b.key} onClick={() => setSort(b.key)} title={b.tip}
                                className={`px-3 py-1.5 text-xs rounded border transition-colors ${sort === b.key ? 'border-[#3B82F6] text-[#2563EB] bg-[#EFF6FF]' : 'border-[#E2E8F0] text-[#64748B] hover:bg-[#F8FAFC]'}`}>
                                {b.label}
                            </button>
                        ))}
                    </div>
                    <button onClick={() => refetch()} className="px-3 py-1.5 text-xs text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                        {isFetching ? '...' : 'Yenile'}
                    </button>
                </div>

                {isLoading ? (
                    <div className="p-4"><SkeletonTable rows={8} cols={16} /></div>
                ) : rows.length === 0 ? (
                    <EmptyState icon="📭" title="Temp spill yok"
                        description={totals?.work_mem_kb != null
                            ? `Mevcut work_mem: ${formatBytes(totals.work_mem_kb * 1024)} - yeterli görünüyor.`
                            : "Bu pencerede disk'e temp dosya yazan sorgu yok."} />
                ) : (
                    <div className="overflow-x-auto" key={`${sort}-${rows[0]?.statement_series_id ?? ''}`}>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide w-10">#</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">SQL</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">DB</th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="sum(temp_blks_written) × 8KB. work_mem yetmediğinde diske yazılan veri." className="cursor-help border-b border-dotted border-[#94A3B8]">Temp Yazılan (MB)</span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="Tek cagri basina ortalama temp yazimi. Yuksekse work_mem ciddi yetersiz." className="cursor-help border-b border-dotted border-[#94A3B8]">{'MB/\u00c7a\u011fr\u0131'}</span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="Tek sample periyodunda goruldugu en yuksek MB/cagri. Ortalama yerine outlier sinyali - en kotu durumu temsil eder." className="cursor-help border-b border-dotted border-[#94A3B8]">
                                            Max MB/Cagri
                                        </span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="Tek cagrida diske yazilan max temp'in worker basina dustugu MB. work_mem ayarini en az bu deger yapmak gerekir; sorgu birden fazla sort/hash icerirse daha fazla gerekebilir." className="cursor-help border-b border-dotted border-[#94A3B8]">
                                            work_mem &ge; (MB)
                                        </span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="Bu sorgu, instance'ın toplam temp yazımının % kaçı." className="cursor-help border-b border-dotted border-[#94A3B8]">% Toplam Temp</span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="temp_blk_write_time + temp_blk_read_time toplamı (saniye). Exec time'ın ne kadarı disk temp I/O." className="cursor-help border-b border-dotted border-[#94A3B8]">Temp I/O (sn)</span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="1MB temp basina dondurulen satir sayisi. Yuksek = verimli (filter erken calismis), dusuk = bosa temp yazimi." className="cursor-help border-b border-dotted border-[#94A3B8]">{'Sat\u0131r/Temp MB'}</span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="Daha önce yazılan temp dosyaların geri okunması (genelde sort/hash sonrası)." className="cursor-help border-b border-dotted border-[#94A3B8]">Temp Okunan (MB)</span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="sum(calls). Bu sorgu pencerede toplam kaç defa çağrıldı." className="cursor-help border-b border-dotted border-[#94A3B8]">Çağrı</span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="sum(total_exec_time) dakika cinsinden. Bu sorgunun toplam DB zamanı." className="cursor-help border-b border-dotted border-[#94A3B8]">Toplam (dk)</span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                                        <span title="avg(mean_exec_time_ms). Çağrı başına ortalama yanıt süresi." className="cursor-help border-b border-dotted border-[#94A3B8]">Ort (ms)</span>
                                    </th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">Query ID</th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row, i) => {
                                    const writtenMb = toNum(row.temp_written_mb);
                                    const writtenClass = writtenMb > 1000 ? 'bg-red-100 text-red-700' : writtenMb > 100 ? 'bg-orange-100 text-orange-700' : 'bg-amber-100 text-amber-700';
                                    const mbPerCall = row.temp_written_mb_per_call == null ? 0 : toNum(row.temp_written_mb_per_call);
                                    const pctTemp = row.pct_of_total_temp == null ? null : toNum(row.pct_of_total_temp);
                                    const pctClass = pctTemp == null ? 'bg-slate-100 text-slate-600' : pctTemp >= 20 ? 'bg-red-100 text-red-700' : pctTemp >= 5 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
                                    const tempWriteSec = row.temp_write_time_sec == null ? 0 : toNum(row.temp_write_time_sec);
                                    const rowsPerTempMb = row.rows_per_temp_mb == null ? null : toNum(row.rows_per_temp_mb);
                                    const rowsPerTempClass = rowsPerTempMb == null ? 'text-[#64748B]' : rowsPerTempMb >= 10000 ? 'text-emerald-700' : rowsPerTempMb >= 1000 ? 'text-[#64748B]' : 'text-orange-700';
                                    const tags = calculateTempTags(row);
                                    return (
                                        <tr key={`${row.statement_series_id}-${i}`} className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">
                                            <td className="py-2 px-3 text-xs text-[#94A3B8] font-semibold">#{i + 1}</td>
                                            <td className="py-2 px-3 max-w-md">
                                                <div className="flex items-start gap-2">
                                                    <div className="font-mono text-xs text-[#1E293B] truncate flex-1" title={row.query_short ?? ''}>
                                                        {row.query_short || <span className="italic text-[#94A3B8]">metin yok</span>}
                                                    </div>
                                                    <CopyButton value={row.query_full ?? ''} message="SQL kopyalandı" disabled={!row.query_full} />
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
                                            <td className="py-2 px-3 text-xs text-[#1E293B] whitespace-nowrap">{row.datname || '—'}</td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                                                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${writtenClass}`}>
                                                    {Number(row.temp_written_mb).toLocaleString('tr-TR')}
                                                </span>
                                            </td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">
                                                {mbPerCall > 0 ? mbPerCall.toLocaleString('tr-TR', { maximumFractionDigits: 2 }) : '\u2014'}
                                            </td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">
                                                {row.max_temp_mb_per_call == null
                                                    ? '\u2014'
                                                    : Number(row.max_temp_mb_per_call).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}
                                            </td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">
                                                {row.recommended_work_mem_mb_min == null
                                                    ? '\u2014'
                                                    : (
                                                        <span title={`Hesap: max temp/cagri (${Number(row.temp_written_mb_per_call ?? 0).toFixed(2)} MB) / ortalama paralel worker (${row.avg_parallel_workers}). Paralel yoksa bolucu=1.`}>
                                                            {Number(row.recommended_work_mem_mb_min).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}
                                                        </span>
                                                    )}
                                            </td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                                                {pctTemp == null ? '\u2014' : (
                                                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${pctClass}`}>
                                                        %{pctTemp.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">
                                                {tempWriteSec > 0 ? tempWriteSec.toLocaleString('tr-TR', { maximumFractionDigits: 2 }) : '\u2014'}
                                            </td>
                                            <td className={`py-2 px-3 text-xs text-right font-mono whitespace-nowrap ${rowsPerTempClass}`}>
                                                {rowsPerTempMb == null ? '\u2014' : rowsPerTempMb.toLocaleString('tr-TR', { maximumFractionDigits: 0 })}
                                            </td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{Number(row.temp_read_mb).toLocaleString('tr-TR')}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">{Number(row.toplam_cagri).toLocaleString('tr-TR')}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono font-semibold text-[#1E293B] whitespace-nowrap">{Number(row.toplam_dk).toLocaleString('tr-TR')} dk</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{Number(row.ort_ms).toLocaleString('tr-TR')}</td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                                                <span className="inline-flex items-center gap-1">
                                                    <span className="font-mono text-[#64748B]">{row.queryid || '—'}</span>
                                                    <CopyButton value={row.queryid ?? ''} message="Query ID kopyalandı" disabled={!row.queryid} />
                                                </span>
                                            </td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                                                <Link to={`/statements/${row.statement_series_id}`} className="text-[#2563EB] hover:underline">Detay</Link>
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
