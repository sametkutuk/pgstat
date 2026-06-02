import { Fragment, useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import { SkeletonTable } from '../components/common/Skeleton';
import EmptyState from '../components/common/EmptyState';
import TimeRangePicker, { loadPersistedRange, defaultRange, type TimeRange } from '../components/common/TimeRangePicker';
import DataColumnsModal, { useDataColumns, type ColumnsMeta } from '../components/common/DataColumnsModal';
import { useToast } from '../components/common/Toast';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Instance {
    instance_pk: number;
    display_name: string;
    is_active: boolean;
}

type InsightTab = 'top-exec' | 'temp-spill' | 'wal-spike' | 'cache-hit' | 'vacuum-lag';
type QueryCrossLinkTarget = Extract<InsightTab, 'temp-spill' | 'wal-spike' | 'cache-hit'>;
type TopCrossLinkHandler = (targetTab: QueryCrossLinkTarget, queryid: string) => void;

const PENDING_INSIGHTS_SEARCH_KEY = 'pgstat.insights.pending-search';
const HEADER_HELP_CLASS = 'cursor-help border-b border-dotted border-[#94A3B8]';

const TABS: { key: InsightTab; label: string; icon: string }[] = [
    { key: 'top-exec', label: 'Top Sorgular', icon: '⏱️' },
    { key: 'temp-spill', label: 'Temp Spill', icon: '💾' },
    { key: 'wal-spike', label: 'WAL Spike', icon: '📈' },
    { key: 'cache-hit', label: 'Cache Hit', icon: '🎯' },
    { key: 'vacuum-lag', label: 'Vacuum Lag', icon: '🧹' },
];

void PlaceholderTab;
void Bar;
void BarChart;

function HeaderHelp({ title, label }: { title: string; label: string }) {
    return <span title={title} className={HEADER_HELP_CLASS}>{label}</span>;
}

function consumePendingSearch(): string {
    if (typeof window === 'undefined') return '';
    try {
        const pending = window.sessionStorage.getItem(PENDING_INSIGHTS_SEARCH_KEY);
        if (pending) {
            window.sessionStorage.removeItem(PENDING_INSIGHTS_SEARCH_KEY);
            return pending;
        }
    } catch { /* ignore */ }
    return '';
}

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
    function handleTopCrossLinkClick(targetTab: QueryCrossLinkTarget, queryid: string) {
        try {
            window.sessionStorage.setItem(PENDING_INSIGHTS_SEARCH_KEY, queryid);
        } catch { /* ignore */ }
        setTab(targetTab);
    }

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
                        onChange={e => {
                            const newPk = e.target.value ? Number(e.target.value) : null;
                            setInstancePk(newPk);
                            if (newPk != null && newPk !== instancePk) {
                                // Instance degisti — range 24 saate sifirlanir
                                const fresh = defaultRange(24);
                                setRange(fresh);
                                try {
                                    window.localStorage.setItem('insights-range', JSON.stringify({
                                        fromIso: fresh.fromIso,
                                        toIso: fresh.toIso,
                                        preset: 24,
                                    }));
                                } catch { /* ignore */ }
                            }
                        }}
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
            {tab === 'top-exec' && <TopExecTimeCard instancePk={instancePk} range={range} autoRefresh={autoRefresh} instanceName={activeInstances.find(i => i.instance_pk === instancePk)?.display_name} onCrossLinkClick={handleTopCrossLinkClick} />}
            {tab === 'temp-spill' && <TempSpillCard instancePk={instancePk} range={range} onRangeChange={setRange} autoRefresh={autoRefresh} instanceName={activeInstances.find(i => i.instance_pk === instancePk)?.display_name} />}
            {tab === 'wal-spike' && <WALSpikeCard instancePk={instancePk} range={range} onRangeChange={setRange} autoRefresh={autoRefresh} instanceName={activeInstances.find(i => i.instance_pk === instancePk)?.display_name} />}
            {tab === 'cache-hit' && <CacheHitCard instancePk={instancePk} range={range} onRangeChange={setRange} autoRefresh={autoRefresh} instanceName={activeInstances.find(i => i.instance_pk === instancePk)?.display_name} />}
            {tab === 'vacuum-lag' && <VacuumLagCard instancePk={instancePk} range={range} onRangeChange={setRange} autoRefresh={autoRefresh} instanceName={activeInstances.find(i => i.instance_pk === instancePk)?.display_name} />}
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
    has_temp_spill: boolean;
    has_wal_writes: boolean;
    has_cache_miss: boolean;
}

type SortMode = 'time' | 'calls' | 'slow';

interface InsightTag {
    key: string;
    label: string;
    icon: string;
    className: string;
    title: string;
}

interface QueryCrossLink {
    key: string;
    label: string;
    icon: string;
    className: string;
    title: string;
    targetTab: QueryCrossLinkTarget;
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

interface QueryTempTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    calls: string | number;
    temp_written_blks: string | number;
    temp_read_blks: string | number;
}

type CompareKey = '1h' | '1d' | '1w' | '1m';
type CompareMode = 'auto' | 'off';
type TrendDataSource = 'pgss_delta' | 'pgss_hourly' | 'pgss_daily' | 'pg_table_stat_delta' | 'pg_table_stat_hourly';
const WEEK_WINDOW_HOURS = 168;

interface TrendResponse<T> {
    current: T[];
    previous: T[];
    compare: CompareKey | null;
    data_source?: TrendDataSource;
    raw_retention_days?: number;
    hourly_retention_days?: number;
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
    if (windowHours <= WEEK_WINDOW_HOURS) return '1w';
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

function buildCrossLinks(row: TopQueryRow): QueryCrossLink[] {
    if (!row.queryid) return [];
    const links: QueryCrossLink[] = [];
    if (row.has_temp_spill) {
        links.push({
            key: 'cross-temp',
            label: 'Temp Spill',
            icon: 'TMP',
            className: 'bg-amber-50 text-amber-700 border border-amber-200',
            title: 'Bu sorgu temp dosya yaziyor. Temp Spill sekmesinde detayli analiz.',
            targetTab: 'temp-spill',
        });
    }
    if (row.has_wal_writes) {
        links.push({
            key: 'cross-wal',
            label: 'WAL Heavy',
            icon: 'WAL',
            className: 'bg-purple-50 text-purple-700 border border-purple-200',
            title: '1MB+ WAL uretiyor. WAL Spike sekmesinde detay.',
            targetTab: 'wal-spike',
        });
    }
    if (row.has_cache_miss) {
        links.push({
            key: 'cross-cache',
            label: 'Cache Miss',
            icon: 'BUF',
            className: 'bg-red-50 text-red-700 border border-red-200',
            title: 'Cache hit %90 alti. Cache Hit sekmesinde detay.',
            targetTab: 'cache-hit',
        });
    }
    return links;
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

function calculateWALTags(row: WALSpikeRow): InsightTag[] {
    const pct = toNum(row.pct_of_total_wal);
    const fpiRatio = row.fpi_ratio == null ? null : toNum(row.fpi_ratio);
    const walRecords = toNum(row.toplam_wal_records);
    const walBytesPerRow = row.wal_bytes_per_row == null ? null : toNum(row.wal_bytes_per_row);
    const walMb = toNum(row.wal_mb);
    const calls = toNum(row.toplam_cagri);
    const walMbPerCall = row.wal_mb_per_call == null ? null : toNum(row.wal_mb_per_call);
    const q = (row.query_full || '').toLowerCase();
    const isDML = /^\s*(update|delete|insert)\b/.test(q);
    const tags: InsightTag[] = [];

    if (pct >= 30) tags.push({ key: 'wal-champion', label: 'WAL Sampiyonu', icon: '🔥', className: 'bg-red-100 text-red-700', title: 'Bu sorgu tek basina toplam WAL uretiminin %30+ kismini uretiyor. Replication lag in birincil kaynagi.' });
    if (fpiRatio != null && fpiRatio > 0.5 && walRecords >= 100) tags.push({ key: 'fpi-heavy', label: 'FPI Heavy', icon: '📸', className: 'bg-orange-100 text-orange-700', title: 'Kayitlarin yaridan cogu full-page-image. Checkpoint sonrasi burst - checkpoint_timeout artirilabilir.' });
    if (walBytesPerRow != null && walBytesPerRow >= 1024 && walMb >= 100) tags.push({ key: 'burst-writer', label: 'Burst Writer', icon: '📈', className: 'bg-amber-100 text-amber-700', title: 'Satir basina 1KB+ WAL - buyuk row, TOAST, ya da update wave-of-pain. TOAST compression veya selective update dusun.' });
    if (calls >= 1000 && walMbPerCall != null && walMbPerCall >= 0.1) tags.push({ key: 'frequent-writer', label: 'Frequent Writer', icon: '🔁', className: 'bg-blue-100 text-blue-700', title: 'Sik calisiyor ve her cagrida WAL uretiyor - batch update e cevirmek bilesik kazanc.' });
    if (isDML) tags.push({ key: 'update-heavy', label: 'Update Heavy', icon: '✏️', className: 'bg-purple-100 text-purple-700', title: 'UPDATE/DELETE/INSERT - yazma operasyonu WAL uretimi normaldir, ama hacim asiriysa optimize gerekli.' });
    return tags;
}

function calculateCacheHitTags(row: CacheHitRow): InsightTag[] {
    const hitPct = row.cache_hit_pct == null ? null : toNum(row.cache_hit_pct);
    const diskReadMb = toNum(row.disk_read_mb);
    const ioBoundPct = row.io_bound_pct == null ? null : toNum(row.io_bound_pct);
    const calls = toNum(row.toplam_cagri);
    const readBlksPerCall = row.read_blks_per_call == null ? null : toNum(row.read_blks_per_call);
    const tags: InsightTag[] = [];

    if (hitPct != null && hitPct < 50 && diskReadMb >= 100) tags.push({ key: 'cache-disaster', label: 'Cache Disaster', icon: '🔴', className: 'bg-red-100 text-red-700', title: "Cache hit %50 alti ve 100MB+ disk read. Bu sorgu shared_buffers'i resmen bypass ediyor." });
    if (diskReadMb >= 1024) tags.push({ key: 'disk-heavy', label: 'Disk Heavy', icon: '🟠', className: 'bg-orange-100 text-orange-700', title: '1GB+ disk read - buyuk veri okuyor. Index ile selective scan veya partition pruning dusun.' });
    if (ioBoundPct != null && ioBoundPct > 50) tags.push({ key: 'io-bound', label: 'I/O Bound', icon: '🐢', className: 'bg-amber-100 text-amber-700', title: 'Sorgu cogu zamani disk I/O bekledi (>%50 io_bound). PG15+ olmali; faster storage veya cache iyilestirme.' });
    if (calls >= 1000 && hitPct != null && hitPct < 90) tags.push({ key: 'frequent-miss', label: 'Frequent Miss', icon: '🔁', className: 'bg-blue-100 text-blue-700', title: 'Sik calisiyor ama her cagrida cache miss yapiyor. shared_buffers buyutmek veya prepared cache stratejisi.' });
    if (readBlksPerCall != null && readBlksPerCall >= 10000) tags.push({ key: 'big-reader', label: 'Big Reader', icon: '📦', className: 'bg-purple-100 text-purple-700', title: 'Tek cagrida 10K+ blok (80MB+) okuyor - full table scan veya buyuk range scan.' });
    return tags;
}

function calculateVacuumLagTags(row: VacuumLagRow): InsightTag[] {
    const deadPct = row.dead_pct == null ? null : toNum(row.dead_pct);
    const nLiveTup = toNum(row.n_live_tup);
    const nDeadTup = toNum(row.n_dead_tup);
    const daysSinceVacuum = row.days_since_vacuum == null ? null : toNum(row.days_since_vacuum);
    const updatePerSec = row.update_per_sec == null ? null : toNum(row.update_per_sec);
    const nModSinceAnalyze = toNum(row.n_mod_since_analyze);
    const hotUpdPct = row.hot_upd_pct == null ? null : toNum(row.hot_upd_pct);
    const nTupUpd = toNum(row.n_tup_upd);
    const tags: InsightTag[] = [];

    if (deadPct != null && deadPct > 20 && nLiveTup > 1000) tags.push({ key: 'bloated', label: 'Bloated', icon: '💀', className: 'bg-red-100 text-red-700', title: 'Dead tuple %20+ ve canli satir 1K+ - ciddi bloat, autovacuum tetiklenmiyor olabilir.' });
    if (daysSinceVacuum != null && daysSinceVacuum > 7 && nDeadTup > 1000) tags.push({ key: 'stale-vacuum', label: 'Stale Vacuum', icon: '⏰', className: 'bg-orange-100 text-orange-700', title: 'Son vacuum 7+ gun once ve 1K+ dead tuple. autovacuum_vacuum_scale_factor dusurulebilir.' });
    if (updatePerSec != null && updatePerSec > 10 && nDeadTup > 5000) tags.push({ key: 'hot-updater', label: 'Hot Updater', icon: '🔥', className: 'bg-amber-100 text-amber-700', title: 'Saniyede 10+ update aliyor ve dead tuple birikiyor. fillfactor azaltmak HOT updatei artirir.' });
    if (nLiveTup > 1000 && nModSinceAnalyze > nLiveTup * 0.1) tags.push({ key: 'stale-stats', label: 'Stale Stats', icon: '📊', className: 'bg-blue-100 text-blue-700', title: 'Live satirin %10+ kadari analyze sonrasi degismis - istatistik eski, plan kalitesi dusuyor.' });
    if (hotUpdPct != null && hotUpdPct < 50 && nTupUpd > 1000) tags.push({ key: 'slow-hot', label: 'Slow HOT', icon: '🐌', className: 'bg-purple-100 text-purple-700', title: "Update'lerin yarisi HOT degil - index bloat olusuyor. fillfactor 70-80 dusur." });
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

function formatKb(kb: number | null | undefined): string {
    return kb == null ? '\u2014' : formatBytes(kb * 1024);
}

function formatMinutes(sec: number | null | undefined): string {
    return sec == null ? '\u2014' : `${(sec / 60).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} dk`;
}

// Eksen tick'leri icin kisa label. Uzun pencerede gun ekle.
function formatBucket(value: string, windowHours: number): string {
    const d = new Date(value);
    if (windowHours <= 24) {
        return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    }
    if (windowHours <= WEEK_WINDOW_HOURS) {
        // Haftalik pencereye kadar: "21.05 14:00"
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

const TOP_QUERIES_HEADER_TITLES: Record<string, string> = {
    toplam_cagri: 'sum(calls). Bu sorgu pencerede toplam kac defa cagrildi.',
    toplam_dk: 'sum(total_exec_time) dakika cinsinden. DB time.',
    pct: "Bu sorgu instance'in toplam exec time'inin yuzde kaci.",
    min_ms: 'min(min_exec_time). Pencerede gorulen en kisa cagri.',
    ort_ms: 'avg(mean_exec_time). Cagri basina ortalama yanit.',
    max_ms: 'max(max_exec_time). En uzun cagri (outlier sinyali).',
    toplam_satir: 'sum(rows). Toplam dondurulen satir sayisi.',
    queryid: 'PostgreSQL queryid (bigint). Plan ailesi icin esleme anahtari.',
};

function TopExecTimeCard({ instancePk, range, autoRefresh, instanceName, onCrossLinkClick }: { instancePk: number | null; range: TimeRange; autoRefresh: boolean; instanceName?: string; onCrossLinkClick: TopCrossLinkHandler }) {
    if (instancePk == null) {
        return <EmptyState icon="🖥️" title="Instance seçin" description="Yukarıdan bir aktif instance seçin." />;
    }
    return <TopExecTimeCardInner instancePk={instancePk} range={range} autoRefresh={autoRefresh} instanceName={instanceName} onCrossLinkClick={onCrossLinkClick} />;
}

function TopExecTimeCardInner({ instancePk, range, autoRefresh, instanceName, onCrossLinkClick }: { instancePk: number; range: TimeRange; autoRefresh: boolean; instanceName?: string; onCrossLinkClick: TopCrossLinkHandler }) {
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
                    description={
                        data && data.length === 0 && search
                            ? `'${search}' filtresine uyan sorgu yok. Aramayi temizleyin veya pencereyi genisletin.`
                            : "Bu pencerede sorgu kaydi yok. Tarih araligini genisletin (orn. 24sa veya daha uzun) ya da daha yogun workload'li bir instance secin."
                    }
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
                                    const title = TOP_QUERIES_HEADER_TITLES[col];
                                    const label = meta?.label ?? col;
                                    return (
                                        <th key={col} className={`py-2 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide ${isRight ? 'text-right' : 'text-left'}`}>
                                            {title ? <HeaderHelp title={title} label={label} /> : label}
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
                                    onCrossLinkClick={onCrossLinkClick}
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

function TopQueryRow({ row, rank, selectedCols, instancePk, range, autoRefresh, compareKey, expanded, onToggle, onCrossLinkClick }: { row: TopQueryRow; rank: number; selectedCols: string[]; instancePk: number; range: TimeRange; autoRefresh: boolean; compareKey: CompareKey | null; expanded: boolean; onToggle: () => void; onCrossLinkClick: TopCrossLinkHandler }) {
    const pct = parseFloat(row.pct_of_total);
    const ortMs = parseFloat(row.ort_ms);
    const maxMs = parseFloat(row.max_ms);
    const minMs = parseFloat(row.min_ms);
    const pctClass = pct >= 20 ? 'bg-red-100 text-red-700' : pct >= 5 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
    const tags = calculateTags(row);
    const crossLinks = buildCrossLinks(row);

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
                        {crossLinks.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                                {crossLinks.map(link => (
                                    <button
                                        key={link.key}
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (row.queryid) onCrossLinkClick(link.targetTab, row.queryid);
                                        }}
                                        title={link.title}
                                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${link.className} hover:opacity-80 cursor-pointer`}
                                    >
                                        <span>{link.icon}</span>{link.label} -&gt;
                                    </button>
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

function QueryTempTrendPanel({ instancePk, seriesId, range, autoRefresh, compareKey }: { instancePk: number; seriesId: number | string; range: TimeRange; autoRefresh: boolean; compareKey: CompareKey | null }) {
    const compareQp = compareKey ? `&compare=${compareKey}` : '';
    const { data, isLoading } = useQuery({
        queryKey: ['insights-query-temp-trend', instancePk, seriesId, range.fromIso, range.toIso, compareKey],
        queryFn: () => apiGet<TrendResponse<QueryTempTrendPoint>>(
            `/insights/${instancePk}/query-temp-trend?series_id=${seriesId}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${compareQp}`,
        ),
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
            const currentCalls = toNum(p.calls);
            const previousCalls = previous ? toNum(previous.calls) : 0;
            const currentTempMb = +(toNum(p.temp_written_blks) / 128.0).toFixed(2);
            const previousTempMb = previous ? +(toNum(previous.temp_written_blks) / 128.0).toFixed(2) : null;
            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_temp_mb: currentTempMb,
                previous_temp_mb: previousTempMb,
                current_calls: currentCalls,
                previous_calls: previous ? previousCalls : null,
                current_mb_per_call: currentCalls > 0 ? +(currentTempMb / Math.max(1, currentCalls)).toFixed(2) : 0,
                previous_mb_per_call: previous ? (previousCalls > 0 ? +(Number(previousTempMb ?? 0) / Math.max(1, previousCalls)).toFixed(2) : 0) : null,
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
            <InsightChart title="Temp Yazimi (MB)" height={200}>
                <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`qt-temp-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Area type="monotone" dataKey="previous_temp_mb" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                    <Area type="monotone" dataKey="current_temp_mb" name="Su an" stroke="#D97706" fill="#FBBF24" fillOpacity={0.6} strokeWidth={2} />
                </AreaChart>
            </InsightChart>
            <InsightChart title="Cagri Sayisi" height={200}>
                <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`qt-calls-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Area type="monotone" dataKey="previous_calls" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                    <Area type="monotone" dataKey="current_calls" name="Su an" stroke="#059669" fill="#D1FAE5" strokeWidth={2} />
                </AreaChart>
            </InsightChart>
            <InsightChart title="MB/Cagri" height={200}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`qt-mb-call-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Line type="monotone" dataKey="previous_mb_per_call" name={compareLabel(compareKey)} stroke="#94A3B8" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />}
                    <Line type="monotone" dataKey="current_mb_per_call" name="Su an" stroke="#7C3AED" strokeWidth={2} dot={false} />
                </LineChart>
            </InsightChart>
        </div>
    );
}

function QueryWalTrendPanel({ instancePk, seriesId, range, autoRefresh, compareKey }: { instancePk: number; seriesId: number | string; range: TimeRange; autoRefresh: boolean; compareKey: CompareKey | null }) {
    const compareQp = compareKey ? `&compare=${compareKey}` : '';
    const { data, isLoading } = useQuery({
        queryKey: ['insights-query-wal-trend', instancePk, seriesId, range.fromIso, range.toIso, compareKey],
        queryFn: () => apiGet<TrendResponse<QueryWalTrendPoint>>(
            `/insights/${instancePk}/query-wal-trend?series_id=${seriesId}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${compareQp}`,
        ),
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
            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_wal_mb: +(toNum(p.wal_bytes) / 1048576.0).toFixed(2),
                previous_wal_mb: previous ? +(toNum(previous.wal_bytes) / 1048576.0).toFixed(2) : null,
                current_records: toNum(p.wal_records),
                previous_records: previous ? toNum(previous.wal_records) : null,
                current_fpi: toNum(p.wal_fpi),
                previous_fpi: previous ? toNum(previous.wal_fpi) : null,
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
    if (chartData.length === 0) return <div className="text-xs text-[#94A3B8] py-4 text-center">Bu sorgu icin WAL trend verisi yok.</div>;

    const tooltipLabelFmt = (_l: any, p: any) => formatBucketFull(String((p?.[0]?.payload as any)?.bucket_iso ?? _l));

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <InsightChart title="WAL Yazimi (MB)" height={200}>
                <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`qw-wal-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Area type="monotone" dataKey="previous_wal_mb" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                    <Area type="monotone" dataKey="current_wal_mb" name="Su an" stroke="#7C3AED" fill="#DDD6FE" fillOpacity={0.65} strokeWidth={2} />
                </AreaChart>
            </InsightChart>
            <InsightChart title="WAL Kayit Sayisi" height={200}>
                <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`qw-rec-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Area type="monotone" dataKey="previous_records" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                    <Area type="monotone" dataKey="current_records" name="Su an" stroke="#0891B2" fill="#A5F3FC" strokeWidth={2} />
                </AreaChart>
            </InsightChart>
            <InsightChart title="FPI Trend" height={200}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`qw-fpi-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Line type="monotone" dataKey="previous_fpi" name={compareLabel(compareKey)} stroke="#94A3B8" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />}
                    <Line type="monotone" dataKey="current_fpi" name="Su an" stroke="#EA580C" strokeWidth={2} dot={false} />
                </LineChart>
            </InsightChart>
        </div>
    );
}

function QueryCacheHitTrendPanel({ instancePk, seriesId, range, autoRefresh, compareKey }: { instancePk: number; seriesId: number | string; range: TimeRange; autoRefresh: boolean; compareKey: CompareKey | null }) {
    const compareQp = compareKey ? `&compare=${compareKey}` : '';
    const { data, isLoading } = useQuery({
        queryKey: ['insights-query-cache-hit-trend', instancePk, seriesId, range.fromIso, range.toIso, compareKey],
        queryFn: () => apiGet<TrendResponse<QueryCacheHitTrendPoint>>(
            `/insights/${instancePk}/query-cache-hit-trend?series_id=${seriesId}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${compareQp}`,
        ),
        enabled: instancePk != null && seriesId != null && String(seriesId).length > 0,
        refetchInterval: autoRefresh ? 30_000 : false,
    });

    const windowHours = useMemo(
        () => (new Date(range.toIso).getTime() - new Date(range.fromIso).getTime()) / 3_600_000,
        [range.fromIso, range.toIso],
    );
    const chartData = useMemo<ChartDatum[]>(() => {
        const previousByBucket = new Map((data?.previous ?? []).map(p => [bucketKey(p.bucket_aligned ?? p.bucket_start), p]));
        const hitPct = (hitBlks: number, readBlks: number): number | null => {
            const total = hitBlks + readBlks;
            return total > 0 ? +(100 * hitBlks / total).toFixed(1) : null;
        };

        return (data?.current ?? []).map(p => {
            const key = bucketKey(p.bucket_start);
            const previous = previousByBucket.get(key);
            const currentHitBlks = toNum(p.hit_blks);
            const currentReadBlks = toNum(p.read_blks);
            const previousHitBlks = previous ? toNum(previous.hit_blks) : 0;
            const previousReadBlks = previous ? toNum(previous.read_blks) : 0;

            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_hit_pct: hitPct(currentHitBlks, currentReadBlks),
                previous_hit_pct: previous ? hitPct(previousHitBlks, previousReadBlks) : null,
                current_disk_read_mb: +(currentReadBlks * 8.0 / 1024.0).toFixed(2),
                previous_disk_read_mb: previous ? +(previousReadBlks * 8.0 / 1024.0).toFixed(2) : null,
                current_read_time_sec: +(toNum(p.read_time_ms) / 1000.0).toFixed(2),
                previous_read_time_sec: previous ? +(toNum(previous.read_time_ms) / 1000.0).toFixed(2) : null,
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
    if (chartData.length === 0) return <div className="text-xs text-[#94A3B8] py-4 text-center">Bu sorgu icin cache trend verisi yok.</div>;

    const tooltipLabelFmt = (_l: any, p: any) => formatBucketFull(String((p?.[0]?.payload as any)?.bucket_iso ?? _l));

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <InsightChart title="Cache Hit % Trend" height={200}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} tickFormatter={(v) => `%${v}`} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    <ReferenceLine y={90} stroke="#94A3B8" strokeDasharray="3 3" />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`qch-hit-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Line type="monotone" dataKey="previous_hit_pct" name={compareLabel(compareKey)} stroke="#94A3B8" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />}
                    <Line type="monotone" dataKey="current_hit_pct" name="Su an" stroke="#10B981" strokeWidth={2} dot={false} connectNulls />
                </LineChart>
            </InsightChart>
            <InsightChart title="Disk Read (MB) Trend" height={200}>
                <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`qch-read-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Area type="monotone" dataKey="previous_disk_read_mb" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                    <Area type="monotone" dataKey="current_disk_read_mb" name="Su an" stroke="#F59E0B" fill="#FEF3C7" fillOpacity={0.7} strokeWidth={2} connectNulls />
                </AreaChart>
            </InsightChart>
            <InsightChart title="Disk Read Time (sn) Trend" height={200}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                    <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                    {daySeparatorLabels.map(lbl => (
                        <ReferenceLine key={`qch-time-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                    ))}
                    {compareKey && <Line type="monotone" dataKey="previous_read_time_sec" name={compareLabel(compareKey)} stroke="#94A3B8" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />}
                    <Line type="monotone" dataKey="current_read_time_sec" name="Su an" stroke="#7C3AED" strokeWidth={2} dot={false} connectNulls />
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
    raw_retention_days?: number;
    hourly_retention_days?: number;
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
    const [search, setSearch] = useState<string>(() => consumePendingSearch());
    const [searchInput, setSearchInput] = useState<string>(search);
    const [datname, setDatname] = useState<string>('');
    const [expandedSeriesId, setExpandedSeriesId] = useState<number | null>(null);
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
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="PostgreSQL queryid (bigint). Plan ailesi icin esleme anahtari." label="Query ID" /></th>
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
                                    const expanded = expandedSeriesId === row.statement_series_id;
                                    return (
                                        <Fragment key={`${row.statement_series_id}-${i}`}>
                                        <tr
                                            onClick={() => setExpandedSeriesId(prev => prev === row.statement_series_id ? null : row.statement_series_id)}
                                            className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] cursor-pointer"
                                        >
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
                                                <button type="button" className="text-[#94A3B8] mr-3" title={expanded ? 'Grafikleri kapat' : 'Grafikleri ac'}>{expanded ? '-' : '+'}</button>
                                                <Link to={`/statements/${row.statement_series_id}`} onClick={e => e.stopPropagation()} className="text-[#2563EB] hover:underline">Detay</Link>
                                            </td>
                                        </tr>
                                        {expanded && (
                                            <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                                <td colSpan={16} className="p-4">
                                                    <QueryTempTrendPanel instancePk={instancePk} seriesId={row.statement_series_id} range={range} autoRefresh={autoRefresh} compareKey={compareKey} />
                                                </td>
                                            </tr>
                                        )}
                                        </Fragment>
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

// =========================================================================
// CACHE HIT sekmesi
// =========================================================================
interface CacheHitRow {
    datname: string | null;
    queryid: string | null;
    query_text_id: number | null;
    statement_series_id: number;
    query_short: string | null;
    query_full: string | null;
    toplam_cagri: string;
    toplam_hit_blks: string;
    toplam_read_blks: string;
    disk_read_mb: string;
    cache_hit_pct: string | null;
    disk_read_time_sec: string | null;
    disk_read_mb_per_call: string | null;
    read_blks_per_call: string | null;
    pct_of_total_disk_read: string | null;
    io_bound_pct: string | null;
    toplam_exec_ms: string;
    toplam_dk: string;
    ort_ms: string;
    toplam_satir: string;
}

interface CacheHitTotals {
    instance_hit_pct: number | null;
    worst_datname: { datname: string | null; hit_pct: number; disk_read_mb: number } | null;
    peak: { bucket_start: string; mb: number } | null;
    shared_buffers_kb: number | null;
    effective_cache_size_kb: number | null;
    heavy_reader_count: number;
    raw_retention_days?: number;
    hourly_retention_days?: number;
}

interface CacheHitResponse {
    rows: CacheHitRow[];
    totals: CacheHitTotals;
}

interface CacheHitTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    hit_blks: string | number;
    read_blks: string | number;
    read_time_ms: string | number;
    calls: string | number;
}

interface QueryCacheHitTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    hit_blks: string | number;
    read_blks: string | number;
    read_time_ms: string | number;
    calls: string | number;
}

type CacheSortMode = 'cache_miss' | 'disk_read' | 'read_time' | 'low_hit_pct';

function cacheHitClass(hitPct: number | null): string {
    if (hitPct == null) return 'bg-slate-100 text-slate-600';
    if (hitPct < 50) return 'bg-red-100 text-red-700';
    if (hitPct < 90) return 'bg-amber-100 text-amber-700';
    if (hitPct >= 99) return 'bg-emerald-100 text-emerald-700';
    return 'bg-slate-100 text-slate-600';
}

function diskReadClass(mb: number): string {
    if (mb > 1024) return 'bg-red-100 text-red-700';
    if (mb > 100) return 'bg-orange-100 text-orange-700';
    return 'bg-slate-100 text-slate-600';
}

function CacheHitCard({ instancePk, range, onRangeChange, autoRefresh, instanceName }: { instancePk: number | null; range: TimeRange; onRangeChange: (range: TimeRange) => void; autoRefresh: boolean; instanceName?: string }) {
    if (instancePk == null) {
        return <EmptyState icon="🖥️" title="Instance seçin" description="Yukarıdan bir aktif instance seçin." />;
    }
    return <CacheHitCardInner instancePk={instancePk} range={range} onRangeChange={onRangeChange} autoRefresh={autoRefresh} instanceName={instanceName} />;
}

function CacheHitCardInner({ instancePk, range, onRangeChange, autoRefresh, instanceName }: { instancePk: number; range: TimeRange; onRangeChange: (range: TimeRange) => void; autoRefresh: boolean; instanceName?: string }) {
    const [sort, setSort] = useState<CacheSortMode>('cache_miss');
    const [search, setSearch] = useState<string>(() => consumePendingSearch());
    const [searchInput, setSearchInput] = useState<string>(search);
    const [datname, setDatname] = useState<string>('');
    const [expandedSeriesId, setExpandedSeriesId] = useState<number | null>(null);
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
        queryKey: ['insights-cache-hit', instancePk, range.fromIso, range.toIso, sort, search, datname],
        queryFn: () => apiGet<CacheHitResponse>(
            `/insights/${instancePk}/cache-hit?sort=${sort}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}&limit=20${searchQp}${datnameQp}`,
        ),
        refetchInterval: autoRefresh ? 30_000 : false,
        staleTime: 0,
    });
    const rows = data?.rows ?? [];
    const totals = data?.totals;

    const baselineQp = search ? `&include_baseline=1` : '';
    const { data: trendData } = useQuery({
        queryKey: ['insights-cache-hit-trend', instancePk, range.fromIso, range.toIso, datname, search, compareKey],
        queryFn: () => apiGet<TrendResponse<CacheHitTrendPoint>>(
            `/insights/${instancePk}/cache-hit-trend?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${searchQp}${datnameQp}${compareQp}${baselineQp}`,
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
        const hitPct = (hit: number, read: number): number | null => {
            const total = hit + read;
            return total > 0 ? +(100 * hit / total).toFixed(1) : null;
        };
        return (trendData?.current ?? []).map(p => {
            const key = bucketKey(p.bucket_start);
            const previous = previousByBucket.get(key);
            const baseline = baselineByBucket.get(key);
            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_hit_pct: hitPct(toNum(p.hit_blks), toNum(p.read_blks)),
                previous_hit_pct: previous ? hitPct(toNum(previous.hit_blks), toNum(previous.read_blks)) : null,
                baseline_hit_pct: baseline ? hitPct(toNum(baseline.hit_blks), toNum(baseline.read_blks)) : null,
                current_disk_read_mb: +(toNum(p.read_blks) * 8.0 / 1024.0).toFixed(2),
                current_calls: toNum(p.calls),
            };
        });
    }, [trendData, windowHours]);
    const hasBaseline = useMemo(() => {
        const b = trendData?.baseline;
        return Array.isArray(b) && b.length > 0;
    }, [trendData]);
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

    const sortButtons: { key: CacheSortMode; label: string; tip: string }[] = [
        { key: 'cache_miss', label: 'Cache Miss', tip: "En cok disk'e giden (shared_blks_read sum)." },
        { key: 'disk_read', label: 'Disk Read', tip: 'En cok MB disk okuyan.' },
        { key: 'read_time', label: 'Read Time', tip: 'En uzun disk read bekleyen (PG15+).' },
        { key: 'low_hit_pct', label: 'Dusuk Hit %', tip: 'En dusuk cache hit orani (min 100 cagri esigi).' },
    ];
    const tagCounts = useMemo(() => {
        const counts: Record<string, { icon: string; count: number }> = {};
        for (const row of rows) {
            for (const tag of calculateCacheHitTags(row)) {
                counts[tag.key] = { icon: tag.icon, count: (counts[tag.key]?.count ?? 0) + 1 };
            }
        }
        return counts;
    }, [rows]);

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
    const worstDbIsActive = datname === totals?.worst_datname?.datname;
    const instanceHitPct = totals?.instance_hit_pct == null ? null : toNum(totals.instance_hit_pct);

    return (
        <div className="space-y-4">
            {totals && (
                <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] p-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-semibold text-[#1E293B]">🎯 {instanceName || `Instance ${instancePk}`} · {rangeLabel(range)}</span>
                        {datname && <span className="text-xs px-2 py-0.5 rounded bg-[#EFF6FF] text-[#2563EB]">{datname}</span>}
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-[#64748B]">
                        <div>
                            Instance hit %: {instanceHitPct == null ? <b className="text-[#94A3B8]">—</b> : (
                                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${cacheHitClass(instanceHitPct)}`}>%{instanceHitPct.toFixed(1)}</span>
                            )}
                            <span className="mx-1">·</span>
                            Heavy reader (&gt;100MB): <b className={toNum(totals.heavy_reader_count) > 0 ? 'text-orange-700' : 'text-[#1E293B]'}>{totals.heavy_reader_count}</b> sorgu
                            <span className="mx-1">·</span>
                            Etiketler: {Object.values(tagCounts).length === 0 ? <span className="text-[#94A3B8]">yok</span> : Object.values(tagCounts).map(t => <span key={t.icon} className="mr-2">{t.icon} {t.count}</span>)}
                        </div>
                        <div>
                            En kotu DB: <b className="text-[#1E293B]">{totals.worst_datname ? (
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!worstDbIsActive && totals.worst_datname?.datname) setDatname(totals.worst_datname.datname);
                                    }}
                                    title="Tikla - bu DB'yi filtre olarak uygula"
                                    className="underline decoration-dotted hover:text-[#2563EB] hover:decoration-solid"
                                >
                                    {totals.worst_datname.datname ?? '\u2014'} (%{totals.worst_datname.hit_pct.toFixed(1)})
                                </button>
                            ) : '\u2014'}</b>
                            <span className="mx-1">·</span>
                            Disk read piki: <b className="text-[#1E293B]">{totals.peak ? (
                                <button
                                    type="button"
                                    onClick={zoomToPeak}
                                    title="Tikla - date range pik saate daralsin"
                                    className="underline decoration-dotted hover:text-[#2563EB] hover:decoration-solid"
                                >
                                    {formatBucketFull(totals.peak.bucket_start)} - {totals.peak.mb.toFixed(1)} MB
                                </button>
                            ) : '\u2014'}</b>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                            <span title="Buffer pool boyutu. Cache hit dusuk ise artirilabilir.">Mevcut shared_buffers: <b className="text-[#1E293B]">{formatKb(totals.shared_buffers_kb)}</b></span>
                            <span title="Planner'in tahmini toplam OS+PG cache. Index secimi etkiler.">effective_cache_size: <b className="text-[#1E293B]">{formatKb(totals.effective_cache_size_kb)}</b></span>
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
                <InsightChart title="Cache Hit % Trend" height={300}>
                    <AreaChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} tickFormatter={(v) => `%${v}`} />
                        <Tooltip content={<ChartTooltip />} labelFormatter={(_l, p) => formatBucketFull(String((p?.[0]?.payload as any)?.bucket_iso ?? _l))} />
                        <ReferenceLine y={90} stroke="#94A3B8" strokeDasharray="3 3" label={{ value: '%90 sinir', position: 'right', fontSize: 10, fill: '#94A3B8' }} />
                        {daySeparatorLabels.map(lbl => (
                            <ReferenceLine key={`cache-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                        ))}
                        {hasBaseline && <Area type="monotone" dataKey="baseline_hit_pct" name={datname ? `${datname} toplam` : 'Instance toplam'} stroke="#94A3B8" fill="#E2E8F0" fillOpacity={0.5} strokeWidth={1} connectNulls />}
                        {compareKey && <Area type="monotone" dataKey="previous_hit_pct" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                        <Area type="monotone" dataKey="current_hit_pct" name={search ? 'Filtreli' : 'Şu an'} stroke="#10B981" fill="#D1FAE5" fillOpacity={0.65} strokeWidth={2} connectNulls />
                    </AreaChart>
                </InsightChart>
            )}

            <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0]">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="font-semibold text-[#1E293B]">Cache Hit Sorgular</h3>
                        <p className="text-xs text-[#64748B]">Disk'e giden ve buffer cache hit oranı düşük sorgular.</p>
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
                            <button onClick={clearSearch} className="px-2 py-1.5 text-xs text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">×</button>
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
                    <div className="p-4"><SkeletonTable rows={8} cols={15} /></div>
                ) : rows.length === 0 ? (
                    <EmptyState icon="📭" title="Tüm sorgular cache'den okunuyor"
                        description={totals?.shared_buffers_kb != null
                            ? `Mevcut shared_buffers: ${formatBytes(totals.shared_buffers_kb * 1024)} - yeterli görünüyor.`
                            : "Bu pencerede disk'e giden sorgu yok."} />
                ) : (
                    <div className="overflow-x-auto" key={`${sort}-${rows[0]?.statement_series_id ?? ''}`}>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide w-10">#</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">SQL</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">DB</th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="hit / (hit + read). %100 = tum okuma cache'den. <%50 = ciddi disk-bound." label="Cache Hit %" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="sum(shared_blks_read) x 8KB. Bu sorgunun diske gitme miktari." label="Disk Read (MB)" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Tek cagri basina ortalama disk okuma." label="Read/Cagri (MB)" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Tek cagri basina kac 8KB blok okundu. Yuksek = scan tabloyu komple gezi." label="Blocks/Cagri" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><span title="Bu sorgu instance'in toplam disk read'inin yuzde kaci." className="cursor-help border-b border-dotted border-[#94A3B8]">% Toplam Disk Read</span></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Sorgu exec zamaninin yuzde kaci disk I/O bekledi." label="I/O Bound %" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="shared_blk_read_time toplami. PG15+ gerektirir." label="Disk Read Time (sn)" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="sum(calls). Bu sorgu pencerede toplam kac defa cagrildi." label="Cagri" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="sum(total_exec_time) dakika cinsinden. DB time." label="Toplam (dk)" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="avg(mean_exec_time). Cagri basina ortalama yanit." label="Ort (ms)" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="PostgreSQL queryid (bigint). Plan ailesi icin esleme anahtari." label="Query ID" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row, i) => {
                                    const hitPct = row.cache_hit_pct == null ? null : toNum(row.cache_hit_pct);
                                    const diskReadMb = toNum(row.disk_read_mb);
                                    const pctDiskRead = row.pct_of_total_disk_read == null ? null : toNum(row.pct_of_total_disk_read);
                                    const pctDiskClass = pctDiskRead == null ? 'bg-slate-100 text-slate-600' : pctDiskRead >= 20 ? 'bg-red-100 text-red-700' : pctDiskRead >= 5 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
                                    const ioBoundPct = row.io_bound_pct == null ? null : toNum(row.io_bound_pct);
                                    const ioClass = ioBoundPct == null ? 'bg-slate-100 text-slate-600' : ioBoundPct >= 50 ? 'bg-red-100 text-red-700' : ioBoundPct >= 20 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
                                    const tags = calculateCacheHitTags(row);
                                    const expanded = expandedSeriesId === row.statement_series_id;
                                    return (
                                        <Fragment key={`${row.statement_series_id}-${i}`}>
                                        <tr
                                            onClick={() => setExpandedSeriesId(prev => prev === row.statement_series_id ? null : row.statement_series_id)}
                                            className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] cursor-pointer"
                                        >
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
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">{hitPct == null ? '—' : <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${cacheHitClass(hitPct)}`}>%{hitPct.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</span>}</td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap"><span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${diskReadClass(diskReadMb)}`}>{diskReadMb.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</span></td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{row.disk_read_mb_per_call == null ? '—' : Number(row.disk_read_mb_per_call).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{row.read_blks_per_call == null ? '—' : Number(row.read_blks_per_call).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">{pctDiskRead == null ? '—' : <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${pctDiskClass}`}>%{pctDiskRead.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</span>}</td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">{ioBoundPct == null ? '—' : <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${ioClass}`}>%{ioBoundPct.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</span>}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{toNum(row.disk_read_time_sec) > 0 ? toNum(row.disk_read_time_sec).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) : '—'}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">{Number(row.toplam_cagri).toLocaleString('tr-TR')}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono font-semibold text-[#1E293B] whitespace-nowrap">{Number(row.toplam_dk).toLocaleString('tr-TR')} dk</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{Number(row.ort_ms).toLocaleString('tr-TR')}</td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap"><span className="inline-flex items-center gap-1"><span className="font-mono text-[#64748B]">{row.queryid || '—'}</span><CopyButton value={row.queryid ?? ''} message="Query ID kopyalandı" disabled={!row.queryid} /></span></td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                                                <button type="button" className="text-[#94A3B8] mr-3" title={expanded ? 'Grafikleri kapat' : 'Grafikleri ac'}>{expanded ? '-' : '+'}</button>
                                                <Link to={`/statements/${row.statement_series_id}`} onClick={e => e.stopPropagation()} className="text-[#2563EB] hover:underline">Detay</Link>
                                            </td>
                                        </tr>
                                        {expanded && (
                                            <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                                <td colSpan={15} className="p-4">
                                                    <QueryCacheHitTrendPanel instancePk={instancePk} seriesId={row.statement_series_id} range={range} autoRefresh={autoRefresh} compareKey={compareKey} />
                                                </td>
                                            </tr>
                                        )}
                                        </Fragment>
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

// =========================================================================
// VACUUM LAG sekmesi
// =========================================================================
interface VacuumLagRow {
    dbid: number;
    relid: number;
    schemaname: string;
    relname: string;
    datname: string | null;
    n_live_tup: string;
    n_dead_tup: string;
    n_mod_since_analyze: string;
    dead_pct: string | null;
    last_vacuum: string | null;
    last_analyze: string | null;
    days_since_vacuum: string | null;
    days_since_analyze: string | null;
    vacuum_count: string;
    analyze_count: string;
    n_tup_ins: string;
    n_tup_upd: string;
    n_tup_del: string;
    n_tup_hot_upd: string;
    hot_upd_pct: string | null;
    update_per_sec: string | null;
}

interface VacuumLagTotals {
    total_dead_tup: number;
    worst_dead_pct: { schemaname: string; relname: string; datname: string | null; dead_pct: number; n_dead_tup: number } | null;
    oldest_vacuum: { schemaname: string; relname: string; datname: string | null; days_since_vacuum: number } | null;
    bloated_count: number;
    stale_count: number;
    autovacuum_settings: {
        autovacuum: string | null;
        autovacuum_max_workers: number | null;
        autovacuum_naptime_sec: number | null;
        autovacuum_vacuum_scale_factor: number | null;
        autovacuum_vacuum_threshold: number | null;
        autovacuum_analyze_scale_factor: number | null;
        autovacuum_analyze_threshold: number | null;
    };
    raw_retention_days?: number;
}

interface VacuumLagResponse {
    rows: VacuumLagRow[];
    totals: VacuumLagTotals;
}

interface VacuumLagTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    total_dead_tup: string | number;
    vacuum_count_manual: string | number;
    vacuum_count_auto: string | number;
    analyze_count_manual: string | number;
    analyze_count_auto: string | number;
}

interface TableVacuumTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    dead_tup: string | number;
    live_tup: string | number;
    n_tup_upd: string | number;
    n_tup_del: string | number;
    n_tup_ins: string | number;
    vacuum_count_manual: string | number;
    vacuum_count_auto: string | number;
    analyze_count_manual: string | number;
    analyze_count_auto: string | number;
}

type VacuumSortMode = 'dead_tup' | 'dead_pct' | 'stale_vacuum' | 'update_rate' | 'mod_since_analyze';

function deadTuplePctClass(deadPct: number | null): string {
    if (deadPct == null) return 'bg-slate-100 text-slate-600';
    if (deadPct > 20) return 'bg-red-100 text-red-700';
    if (deadPct > 10) return 'bg-orange-100 text-orange-700';
    if (deadPct > 5) return 'bg-amber-100 text-amber-700';
    return 'bg-slate-100 text-slate-600';
}

function vacuumAgeClass(days: number | null): string {
    if (days == null) return 'bg-slate-100 text-slate-600';
    if (days > 30) return 'bg-red-100 text-red-700';
    if (days > 7) return 'bg-orange-100 text-orange-700';
    return 'bg-slate-100 text-slate-600';
}

function hotUpdateClass(hotPct: number | null): string {
    if (hotPct == null) return 'bg-slate-100 text-slate-600';
    if (hotPct > 80) return 'bg-emerald-100 text-emerald-700';
    if (hotPct > 50) return 'bg-amber-100 text-amber-700';
    return 'bg-red-100 text-red-700';
}

function formatDaysAgo(days: number | null | undefined): string {
    if (days == null) return '\u2014';
    return `${days.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} gun once`;
}

function TableVacuumTrendPanel({ instancePk, dbid, relid, schemaname, relname, range, autoRefresh, compareKey }: { instancePk: number; dbid: number | string; relid: number | string; schemaname: string; relname: string; range: TimeRange; autoRefresh: boolean; compareKey: CompareKey | null }) {
    const compareQp = compareKey ? `&compare=${compareKey}` : '';
    const { data, isLoading } = useQuery({
        queryKey: ['insights-table-vacuum-trend', instancePk, dbid, relid, range.fromIso, range.toIso, compareKey],
        queryFn: () => apiGet<TrendResponse<TableVacuumTrendPoint>>(
            `/insights/${instancePk}/table-vacuum-trend?dbid=${dbid}&relid=${relid}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${compareQp}`,
        ),
        enabled: instancePk != null && dbid != null && relid != null,
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
            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_dead_tup: toNum(p.dead_tup),
                previous_dead_tup: previous ? toNum(previous.dead_tup) : null,
                current_upd_del: toNum(p.n_tup_upd) + toNum(p.n_tup_del),
                previous_upd_del: previous ? toNum(previous.n_tup_upd) + toNum(previous.n_tup_del) : null,
                current_vacuum_manual: toNum(p.vacuum_count_manual),
                current_vacuum_auto: toNum(p.vacuum_count_auto),
                current_analyze_manual: toNum(p.analyze_count_manual),
                current_analyze_auto: toNum(p.analyze_count_auto),
                previous_activity_total: previous
                    ? toNum(previous.vacuum_count_manual) + toNum(previous.vacuum_count_auto) + toNum(previous.analyze_count_manual) + toNum(previous.analyze_count_auto)
                    : null,
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
    if (chartData.length === 0) return <div className="text-xs text-[#94A3B8] py-4 text-center">Bu tablo icin trend verisi yok.</div>;

    const tooltipLabelFmt = (_l: any, p: any) => formatBucketFull(String((p?.[0]?.payload as any)?.bucket_iso ?? _l));

    return (
        <div>
            <div className="text-xs text-[#64748B] mb-2"><b>{schemaname}.{relname}</b> trendi</div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <InsightChart title="Dead Tuple Trend" height={200}>
                    <AreaChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                        <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                        {daySeparatorLabels.map(lbl => (
                            <ReferenceLine key={`tv-dead-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                        ))}
                        {compareKey && <Area type="monotone" dataKey="previous_dead_tup" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                        <Area type="monotone" dataKey="current_dead_tup" name="Su an" stroke="#0891B2" fill="#A5F3FC" fillOpacity={0.75} strokeWidth={2} connectNulls />
                    </AreaChart>
                </InsightChart>
                <InsightChart title="Update/Delete Activity" height={200}>
                    <AreaChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                        <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                        {daySeparatorLabels.map(lbl => (
                            <ReferenceLine key={`tv-upd-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                        ))}
                        {compareKey && <Area type="monotone" dataKey="previous_upd_del" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                        <Area type="monotone" dataKey="current_upd_del" name="Su an" stroke="#F59E0B" fill="#FEF3C7" fillOpacity={0.7} strokeWidth={2} connectNulls />
                    </AreaChart>
                </InsightChart>
                <InsightChart title="Vacuum & Analyze Aktivitesi" height={200}>
                    <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                        <Tooltip content={<ChartTooltip />} labelFormatter={tooltipLabelFmt} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        {daySeparatorLabels.map(lbl => (
                            <ReferenceLine key={`tv-vac-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                        ))}
                        {compareKey && <Line type="monotone" dataKey="previous_activity_total" name={compareLabel(compareKey) + ' toplam'} stroke="#94A3B8" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />}
                        <Line type="monotone" dataKey="current_vacuum_manual" name="Manuel Vacuum" stroke="#059669" strokeWidth={1.5} dot={false} connectNulls />
                        <Line type="monotone" dataKey="current_vacuum_auto" name="Autovacuum" stroke="#7C3AED" strokeWidth={1.5} dot={false} connectNulls />
                        <Line type="monotone" dataKey="current_analyze_manual" name="Manuel Analyze" stroke="#D97706" strokeWidth={1.5} dot={false} connectNulls />
                        <Line type="monotone" dataKey="current_analyze_auto" name="Auto Analyze" stroke="#2563EB" strokeWidth={1.5} dot={false} connectNulls />
                    </LineChart>
                </InsightChart>
            </div>
        </div>
    );
}

function VacuumLagCard({ instancePk, range, onRangeChange, autoRefresh, instanceName }: { instancePk: number | null; range: TimeRange; onRangeChange: (range: TimeRange) => void; autoRefresh: boolean; instanceName?: string }) {
    if (instancePk == null) {
        return <EmptyState icon="🖥️" title="Instance seçin" description="Yukarıdan bir aktif instance seçin." />;
    }
    return <VacuumLagCardInner instancePk={instancePk} range={range} onRangeChange={onRangeChange} autoRefresh={autoRefresh} instanceName={instanceName} />;
}

function VacuumLagCardInner({ instancePk, range, onRangeChange: _onRangeChange, autoRefresh, instanceName }: { instancePk: number; range: TimeRange; onRangeChange: (range: TimeRange) => void; autoRefresh: boolean; instanceName?: string }) {
    const [sort, setSort] = useState<VacuumSortMode>('dead_tup');
    const [searchInput, setSearchInput] = useState<string>('');
    const [search, setSearch] = useState<string>('');
    const [datname, setDatname] = useState<string>('');
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    // Vacuum Lag icin compare default 'off' — tablo bazli veri retention
    // sinirindan dolayi gecmis donem genelde bos donuyor. Ayri localStorage
    // anahtari ile digerlerinden bagimsiz tutuluyor.
    const [compareMode, setCompareMode] = useState<CompareMode>(() => {
        try {
            const saved = window.localStorage.getItem('pgstat.insights.vacuum-compare-mode');
            return saved === 'auto' ? 'auto' : 'off';
        } catch { return 'off'; }
    });
    useEffect(() => {
        try { window.localStorage.setItem('pgstat.insights.vacuum-compare-mode', compareMode); } catch { /* ignore */ }
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
        queryKey: ['insights-vacuum-lag', instancePk, range.fromIso, range.toIso, sort, search, datname],
        queryFn: () => apiGet<VacuumLagResponse>(
            `/insights/${instancePk}/vacuum-lag?sort=${sort}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}&limit=20${searchQp}${datnameQp}`,
        ),
        refetchInterval: autoRefresh ? 30_000 : false,
        staleTime: 0,
    });
    const rows = data?.rows ?? [];
    const totals = data?.totals;

    const { data: trendData } = useQuery({
        queryKey: ['insights-vacuum-lag-trend', instancePk, range.fromIso, range.toIso, datname, search, compareKey],
        queryFn: () => apiGet<TrendResponse<VacuumLagTrendPoint>>(
            `/insights/${instancePk}/vacuum-lag-trend?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${searchQp}${datnameQp}${compareQp}`,
        ),
        refetchInterval: autoRefresh ? 30_000 : false,
        staleTime: 0,
    });

    const windowHours = useMemo(
        () => (new Date(range.toIso).getTime() - new Date(range.fromIso).getTime()) / 3_600_000,
        [range.fromIso, range.toIso],
    );
    const chartData = useMemo<ChartDatum[]>(() => {
        const previousByBucket = new Map((trendData?.previous ?? []).map(p => [bucketKey(p.bucket_aligned ?? p.bucket_start), p]));
        return (trendData?.current ?? []).map(p => {
            const key = bucketKey(p.bucket_start);
            const previous = previousByBucket.get(key);
            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_dead_tup: toNum(p.total_dead_tup),
                previous_dead_tup: previous ? toNum(previous.total_dead_tup) : null,
                current_vacuum_manual: toNum(p.vacuum_count_manual),
                current_vacuum_auto: toNum(p.vacuum_count_auto),
                current_analyze_manual: toNum(p.analyze_count_manual),
                current_analyze_auto: toNum(p.analyze_count_auto),
                current_activity_total: toNum(p.vacuum_count_manual) + toNum(p.vacuum_count_auto) + toNum(p.analyze_count_manual) + toNum(p.analyze_count_auto),
                previous_activity_total: previous
                    ? toNum(previous.vacuum_count_manual) + toNum(previous.vacuum_count_auto) + toNum(previous.analyze_count_manual) + toNum(previous.analyze_count_auto)
                    : null,
            };
        });
    }, [trendData, windowHours]);
    const hasTrendData = useMemo(
        () => chartData.some(d => toNum(d.current_dead_tup) > 0 || toNum(d.current_activity_total) > 0 || toNum(d.previous_dead_tup) > 0 || toNum(d.previous_activity_total) > 0),
        [chartData],
    );
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
    const tagCounts = useMemo(() => {
        const counts: Record<string, { icon: string; count: number }> = {};
        for (const row of rows) {
            for (const tag of calculateVacuumLagTags(row)) {
                counts[tag.key] = { icon: tag.icon, count: (counts[tag.key]?.count ?? 0) + 1 };
            }
        }
        return counts;
    }, [rows]);

    const sortButtons: { key: VacuumSortMode; label: string; tip: string }[] = [
        { key: 'dead_tup', label: 'Dead Tuple', tip: 'En cok dead tuple iceren tablolar.' },
        { key: 'dead_pct', label: 'Dead %', tip: 'En sismis tablolar (live+dead > 1000 esikli).' },
        { key: 'stale_vacuum', label: 'Eski Vacuum', tip: 'En uzun zamandir vacuum almayan tablolar.' },
        { key: 'update_rate', label: 'Update/sn', tip: 'En cok update alan tablolar.' },
        { key: 'mod_since_analyze', label: 'Stale Stats', tip: 'Son analyze sonrasi en cok degisim olan tablolar.' },
    ];

    function applySearch() { setSearch(searchInput.trim()); }
    function clearSearch() { setSearchInput(''); setSearch(''); }
    function focusRelation(relname: string) {
        setSearchInput(relname);
        setSearch(relname);
    }

    const vacuumSettings = totals?.autovacuum_settings;
    const emptyDescription = `Tum tablolar guncel vacuum'lu gorunuyor (autovacuum: ${vacuumSettings?.autovacuum ?? '\u2014'}, max_workers: ${vacuumSettings?.autovacuum_max_workers ?? '\u2014'}).`;
    const trendTooltip = ({ active, payload }: any) => {
        if (!active || !payload?.length) return null;
        const bucketIso = String((payload?.[0]?.payload as any)?.bucket_iso ?? '');
        return (
            <div className="bg-white border border-[#CBD5E1] shadow-sm rounded px-3 py-2 text-xs min-w-[210px]">
                <div className="font-medium text-[#1E293B] mb-1">{formatBucketFull(bucketIso)}</div>
                {payload.filter((p: any) => p.value != null).map((p: any) => (
                    <div key={p.dataKey} className="flex items-center gap-2 text-[#64748B]">
                        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
                        <span>{p.name}: <b className="text-[#1E293B]">{compactNumber(p.value)}</b></span>
                    </div>
                ))}
            </div>
        );
    };

    return (
        <div className="space-y-4">
            {totals && (
                <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] p-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-semibold text-[#1E293B]">🧹 {instanceName || `Instance ${instancePk}`} · {rangeLabel(range)}</span>
                        {datname && <span className="text-xs px-2 py-0.5 rounded bg-[#EFF6FF] text-[#2563EB]">{datname}</span>}
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-[#64748B]">
                        <div>
                            Toplam dead tuple: <b className="text-[#1E293B]">{totals.total_dead_tup.toLocaleString('tr-TR')}</b>
                            <span className="mx-1">·</span>
                            Sismis tablo (Dead&gt;%20): <b className={totals.bloated_count > 0 ? 'text-red-700' : 'text-[#1E293B]'}>{totals.bloated_count}</b>
                            <span className="mx-1">·</span>
                            Eski vacuum: <b className={totals.stale_count > 0 ? 'text-orange-700' : 'text-[#1E293B]'}>{totals.stale_count}</b>
                            <span className="mx-1">·</span>
                            Etiketler: {Object.values(tagCounts).length === 0 ? <span className="text-[#94A3B8]">yok</span> : Object.values(tagCounts).map(t => <span key={t.icon} className="mr-2">{t.icon} {t.count}</span>)}
                        </div>
                        <div>
                            En sismis: <b className="text-[#1E293B]">{totals.worst_dead_pct ? (
                                <button
                                    type="button"
                                    onClick={() => focusRelation(totals.worst_dead_pct?.relname || '')}
                                    title="Tikla - bu tabloyu filtre olarak uygula"
                                    className="underline decoration-dotted hover:text-[#2563EB] hover:decoration-solid"
                                >
                                    {totals.worst_dead_pct.schemaname}.{totals.worst_dead_pct.relname} (%{totals.worst_dead_pct.dead_pct.toFixed(1)}, {totals.worst_dead_pct.n_dead_tup.toLocaleString('tr-TR')} dead)
                                </button>
                            ) : '\u2014'}</b>
                            <span className="mx-1">·</span>
                            En eski vacuum: <b className="text-[#1E293B]">{totals.oldest_vacuum ? (
                                <button
                                    type="button"
                                    onClick={() => focusRelation(totals.oldest_vacuum?.relname || '')}
                                    title="Tikla - bu tabloyu filtre olarak uygula"
                                    className="underline decoration-dotted hover:text-[#2563EB] hover:decoration-solid"
                                >
                                    {totals.oldest_vacuum.schemaname}.{totals.oldest_vacuum.relname} ({totals.oldest_vacuum.days_since_vacuum.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} gun once)
                                </button>
                            ) : '\u2014'}</b>
                        </div>
                    </div>
                    <details className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] mt-3">
                        <summary className="px-4 py-2 cursor-pointer text-sm text-[#64748B] hover:bg-[#F8FAFC]">
                            🛠 Autovacuum Parametreleri
                        </summary>
                        <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                            <div title="Autovacuum acik mi kapali mi. off ise dead tuple birikimi normaldir.">
                                <div className="text-[#94A3B8]">autovacuum</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{vacuumSettings?.autovacuum ?? '\u2014'}</div>
                            </div>
                            <div title="Ayni anda kac autovacuum worker calisabilir.">
                                <div className="text-[#94A3B8]">max_workers</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{vacuumSettings?.autovacuum_max_workers ?? '\u2014'}</div>
                            </div>
                            <div title="Autovacuum launcher iki tarama arasinda ne kadar bekler.">
                                <div className="text-[#94A3B8]">naptime</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{vacuumSettings?.autovacuum_naptime_sec == null ? '\u2014' : `${vacuumSettings.autovacuum_naptime_sec.toLocaleString('tr-TR', { maximumFractionDigits: 0 })} sn`}</div>
                            </div>
                            <div title="Vacuum esigi icin live tuple uzerinden carpilan oran.">
                                <div className="text-[#94A3B8]">vacuum_scale_factor</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{vacuumSettings?.autovacuum_vacuum_scale_factor == null ? '\u2014' : `%${(vacuumSettings.autovacuum_vacuum_scale_factor * 100).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`}</div>
                            </div>
                            <div title="Vacuum icin minimum degisen satir esigi.">
                                <div className="text-[#94A3B8]">vacuum_threshold</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{vacuumSettings?.autovacuum_vacuum_threshold == null ? '\u2014' : vacuumSettings.autovacuum_vacuum_threshold.toLocaleString('tr-TR', { maximumFractionDigits: 0 })}</div>
                            </div>
                            <div title="Analyze esigi icin live tuple uzerinden carpilan oran.">
                                <div className="text-[#94A3B8]">analyze_scale_factor</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{vacuumSettings?.autovacuum_analyze_scale_factor == null ? '\u2014' : `%${(vacuumSettings.autovacuum_analyze_scale_factor * 100).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`}</div>
                            </div>
                            <div title="Analyze icin minimum degisen satir esigi.">
                                <div className="text-[#94A3B8]">analyze_threshold</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{vacuumSettings?.autovacuum_analyze_threshold == null ? '\u2014' : vacuumSettings.autovacuum_analyze_threshold.toLocaleString('tr-TR', { maximumFractionDigits: 0 })}</div>
                            </div>
                        </div>
                    </details>
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

            {hasTrendData && (
                <InsightChart title="Dead Tuple & Vacuum Aktivitesi" height={300}>
                    <ComposedChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis yAxisId="left" tick={{ fontSize: 10 }} tickFormatter={compactNumber} />
                        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} allowDecimals={false} />
                        <Tooltip content={trendTooltip} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        {daySeparatorLabels.map(lbl => (
                            <ReferenceLine key={`vacuum-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                        ))}
                        {compareKey && <Line yAxisId="left" type="monotone" dataKey="previous_dead_tup" name={compareLabel(compareKey) + ' dead'} stroke="#94A3B8" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />}
                        {compareKey && <Line yAxisId="right" type="monotone" dataKey="previous_activity_total" name={compareLabel(compareKey) + ' toplam aktivite'} stroke="#CBD5E1" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />}
                        <Area yAxisId="left" type="monotone" dataKey="current_dead_tup" name="Dead tuple" stroke="#0891B2" fill="#A5F3FC" fillOpacity={0.75} strokeWidth={2} connectNulls />
                        <Line yAxisId="right" type="monotone" dataKey="current_vacuum_manual" name="Manuel Vacuum" stroke="#059669" strokeWidth={1.5} dot={false} connectNulls />
                        <Line yAxisId="right" type="monotone" dataKey="current_vacuum_auto" name="Autovacuum" stroke="#7C3AED" strokeWidth={1.5} dot={false} connectNulls />
                        <Line yAxisId="right" type="monotone" dataKey="current_analyze_manual" name="Manuel Analyze" stroke="#D97706" strokeWidth={1.5} dot={false} connectNulls />
                        <Line yAxisId="right" type="monotone" dataKey="current_analyze_auto" name="Auto Analyze" stroke="#2563EB" strokeWidth={1.5} dot={false} connectNulls />
                    </ComposedChart>
                </InsightChart>
            )}

            <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0]">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="font-semibold text-[#1E293B]">Vacuum Lag Tablolar</h3>
                        <p className="text-xs text-[#64748B]">Dead tuple biriktiren ve gec vacuum alan tablolar.</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <select value={datname} onChange={e => setDatname(e.target.value)}
                            title="Database filtresi" className="border border-[#E2E8F0] rounded px-2 py-1.5 text-xs bg-white max-w-[160px]">
                            <option value="">Tum Database'ler</option>
                            {(databases ?? []).map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') applySearch(); }}
                            placeholder="relname ara" className="border border-[#E2E8F0] rounded px-3 py-1.5 text-xs bg-white w-48 focus:outline-none focus:border-[#3B82F6]" />
                        <button onClick={applySearch} className="px-3 py-1.5 text-xs text-white bg-[#3B82F6] rounded hover:bg-[#2563EB]">Ara</button>
                        {search && (
                            <button onClick={clearSearch} className="px-2 py-1.5 text-xs text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">Ã—</button>
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
                    <div className="p-4"><SkeletonTable rows={8} cols={11} /></div>
                ) : rows.length === 0 ? (
                    <EmptyState icon="📭" title="Vacuum lag yok" description={emptyDescription} />
                ) : (
                    <div className="overflow-x-auto" key={`${sort}-${rows[0]?.dbid ?? ''}-${rows[0]?.relid ?? ''}`}>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide w-10">#</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">Tablo</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">DB</th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Tabloda update/delete'ten kalan dead tuple. Vacuum bunu temizler." label="Dead Tuple" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="n_live_tup_estimate (latest snapshot)." label="Live Tuple" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="dead / (live + dead). >%20 = bloat baslangici." label="Dead %" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Last vacuum veya autovacuum (en yenisi). Gun sayisi." label="Son Vacuum" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Pencerede tablo kac kez vacuum/autovacuum aldi." label="Vacuum Sayisi" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Saniyede ortalama update sayisi." label="Update/sn" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Heap-Only-Tuple update orani. Yuksek = index bloat dusuk." label="HOT Update %" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Son analyze sonrasi degisen satir tahmini." label="Mod Since Analyze" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row, i) => {
                                    const rowKey = `${row.dbid}-${row.relid}`;
                                    const expanded = expandedKey === rowKey;
                                    const deadPct = row.dead_pct == null ? null : toNum(row.dead_pct);
                                    const daysSinceVacuum = row.days_since_vacuum == null ? null : toNum(row.days_since_vacuum);
                                    const hotUpdPct = row.hot_upd_pct == null ? null : toNum(row.hot_upd_pct);
                                    const tags = calculateVacuumLagTags(row);
                                    return (
                                        <Fragment key={rowKey}>
                                            <tr
                                                onClick={() => setExpandedKey(prev => prev === rowKey ? null : rowKey)}
                                                className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] cursor-pointer"
                                            >
                                                <td className="py-2 px-3 text-xs text-[#94A3B8] font-semibold">#{i + 1}</td>
                                                <td className="py-2 px-3 max-w-md">
                                                    <div className="font-mono text-xs text-[#1E293B] truncate" title={`${row.schemaname}.${row.relname}`}>
                                                        {row.schemaname}.{row.relname}
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
                                                <td className="py-2 px-3 text-xs whitespace-nowrap">
                                                    <span className="inline-block px-1.5 py-0.5 rounded bg-[#EFF6FF] text-[#2563EB]">{row.datname || '\u2014'}</span>
                                                </td>
                                                <td className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">{Number(row.n_dead_tup).toLocaleString('tr-TR')}</td>
                                                <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{Number(row.n_live_tup).toLocaleString('tr-TR')}</td>
                                                <td className="py-2 px-3 text-xs text-right whitespace-nowrap">{deadPct == null ? '\u2014' : <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${deadTuplePctClass(deadPct)}`}>%{deadPct.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</span>}</td>
                                                <td className="py-2 px-3 text-xs text-right whitespace-nowrap">{daysSinceVacuum == null ? '\u2014' : <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${vacuumAgeClass(daysSinceVacuum)}`}>{formatDaysAgo(daysSinceVacuum)}</span>}</td>
                                                <td className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">{Number(row.vacuum_count).toLocaleString('tr-TR')}</td>
                                                <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{row.update_per_sec == null ? '\u2014' : Number(row.update_per_sec).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</td>
                                                <td className="py-2 px-3 text-xs text-right whitespace-nowrap">{hotUpdPct == null ? '\u2014' : <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${hotUpdateClass(hotUpdPct)}`}>%{hotUpdPct.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</span>}</td>
                                                <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{Number(row.n_mod_since_analyze).toLocaleString('tr-TR')}</td>
                                                <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                                                    <button type="button" className="text-[#94A3B8]" title={expanded ? 'Kapat' : 'Grafikler'}>{expanded ? '\u2212' : '+'}</button>
                                                </td>
                                            </tr>
                                            {expanded && (
                                                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                                    <td colSpan={12} className="p-4">
                                                        <TableVacuumTrendPanel
                                                            instancePk={instancePk}
                                                            dbid={row.dbid}
                                                            relid={row.relid}
                                                            schemaname={row.schemaname}
                                                            relname={row.relname}
                                                            range={range}
                                                            autoRefresh={autoRefresh}
                                                            compareKey={compareKey}
                                                        />
                                                    </td>
                                                </tr>
                                            )}
                                        </Fragment>
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

// =========================================================================
// WAL SPIKE sekmesi
// =========================================================================
interface WALSpikeRow {
    datname: string | null;
    queryid: string | null;
    query_text_id: number | null;
    statement_series_id: number;
    query_short: string | null;
    query_full: string | null;
    toplam_cagri: string;
    toplam_wal_bytes: string;
    wal_mb: string;
    toplam_wal_records: string;
    toplam_wal_fpi: string;
    wal_mb_per_call: string | null;
    max_wal_mb_per_call: string | null;
    fpi_ratio: string | null;
    pct_of_total_wal: string | null;
    wal_bytes_per_row: string | null;
    toplam_exec_ms: string;
    toplam_dk: string;
    ort_ms: string;
    toplam_satir: string;
}

interface WALSpikeTotals {
    total_wal_bytes: number;
    top_datname: { datname: string | null; wal_mb: number; pct: number } | null;
    peak: { bucket_start: string; mb: number } | null;
    max_wal_size_kb: number | null;
    wal_compression: string | null;
    fpi_heavy_count: number;
    wal_throughput_mb_per_sec: number;
    replication_lag: { slot_name: string | null; lag_bytes: number; wal_status: string | null; active: boolean | null } | null;
    spill_bytes_total: number;
    tps: { commit_per_sec: number; rollback_per_sec: number; total_per_sec: number } | null;
    archiver: { archived_count: number; last_archived_time: string | null; failed_count: number; last_failed_time: string | null; lag_seconds: number | null } | null;
    wal_settings: {
        max_wal_size_kb: number | null;
        min_wal_size_kb: number | null;
        checkpoint_timeout_sec: number | null;
        checkpoint_completion_target: number | null;
        wal_compression: string | null;
        wal_level: string | null;
        wal_buffers_kb: number | null;
    };
    raw_retention_days?: number;
    hourly_retention_days?: number;
}

interface WALSpikeResponse {
    rows: WALSpikeRow[];
    totals: WALSpikeTotals;
}

interface WALTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    wal_bytes: string | number;
    wal_records: string | number;
    wal_fpi: string | number;
    calls: string | number;
}

interface QueryWalTrendPoint {
    bucket_start: string;
    bucket_aligned?: string;
    wal_bytes: string | number;
    wal_records: string | number;
    wal_fpi: string | number;
    calls: string | number;
}

type WALSortMode = 'wal' | 'wal_per_call' | 'fpi_ratio' | 'wal_per_row';

function WALSpikeCard({ instancePk, range, onRangeChange, autoRefresh, instanceName }: { instancePk: number | null; range: TimeRange; onRangeChange: (range: TimeRange) => void; autoRefresh: boolean; instanceName?: string }) {
    if (instancePk == null) {
        return <EmptyState icon="🖥️" title="Instance seçin" description="Yukarıdan bir aktif instance seçin." />;
    }
    return <WALSpikeCardInner instancePk={instancePk} range={range} onRangeChange={onRangeChange} autoRefresh={autoRefresh} instanceName={instanceName} />;
}

function WALSpikeCardInner({ instancePk, range, onRangeChange, autoRefresh, instanceName }: { instancePk: number; range: TimeRange; onRangeChange: (range: TimeRange) => void; autoRefresh: boolean; instanceName?: string }) {
    const [sort, setSort] = useState<WALSortMode>('wal');
    const [search, setSearch] = useState<string>(() => consumePendingSearch());
    const [searchInput, setSearchInput] = useState<string>(search);
    const [datname, setDatname] = useState<string>('');
    const [expandedSeriesId, setExpandedSeriesId] = useState<number | null>(null);
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
        queryKey: ['insights-wal-spike', instancePk, range.fromIso, range.toIso, sort, search, datname],
        queryFn: () => apiGet<WALSpikeResponse>(
            `/insights/${instancePk}/wal-spike?sort=${sort}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}&limit=20${searchQp}${datnameQp}`,
        ),
        refetchInterval: autoRefresh ? 30_000 : false,
        staleTime: 0,
    });
    const rows = data?.rows ?? [];
    const totals = data?.totals;

    const baselineQp = search ? `&include_baseline=1` : '';
    const { data: trendData } = useQuery({
        queryKey: ['insights-wal-trend', instancePk, range.fromIso, range.toIso, datname, search, compareKey],
        queryFn: () => apiGet<TrendResponse<WALTrendPoint>>(
            `/insights/${instancePk}/wal-trend?from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}${searchQp}${datnameQp}${compareQp}${baselineQp}`,
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
            const currentWalMb = +(toNum(p.wal_bytes) / 1048576.0).toFixed(2);
            const baselineWalMb = baseline ? +(toNum(baseline.wal_bytes) / 1048576.0).toFixed(2) : null;
            return {
                label: formatBucket(String(p.bucket_start), windowHours),
                bucket_iso: String(p.bucket_start),
                bucket_key: key,
                current_wal_mb: currentWalMb,
                previous_wal_mb: previous ? +(toNum(previous.wal_bytes) / 1048576.0).toFixed(2) : null,
                baseline_wal_mb: baselineWalMb,
                current_calls: toNum(p.calls),
            };
        });
    }, [trendData, windowHours]);
    const hasBaseline = useMemo(() => {
        const b = trendData?.baseline;
        return Array.isArray(b) && b.length > 0;
    }, [trendData]);
    const yDomainWalMb = useMemo<[number, number] | undefined>(() => {
        if (!hasBaseline) return undefined;
        const currentMax = chartData.reduce((m, d) => Math.max(m, toNum(d.current_wal_mb)), 0);
        const baselineP70 = (() => {
            const vals = chartData.map(d => toNum(d.baseline_wal_mb)).filter(v => v > 0);
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
        const totalWalBytes = totals?.total_wal_bytes ?? rows.reduce((sum, r) => sum + toNum(r.toplam_wal_bytes), 0);
        const topShare = totalWalBytes > 0 ? (toNum(rows[0]?.toplam_wal_bytes) / totalWalBytes) * 100 : 0;
        return { totalWalBytes, topShare };
    }, [rows, totals]);
    const tagCounts = useMemo(() => {
        const counts: Record<string, { icon: string; count: number }> = {};
        for (const row of rows) {
            for (const tag of calculateWALTags(row)) {
                counts[tag.key] = { icon: tag.icon, count: (counts[tag.key]?.count ?? 0) + 1 };
            }
        }
        return counts;
    }, [rows]);

    const sortButtons: { key: WALSortMode; label: string; tip: string }[] = [
        { key: 'wal', label: 'Toplam WAL', tip: 'sum(wal_bytes) desc' },
        { key: 'wal_per_call', label: 'WAL/Cagri', tip: 'tek cagriya en cok WAL atan' },
        { key: 'fpi_ratio', label: 'FPI Orani', tip: 'cogu kaydi full-page-image olan checkpoint burst' },
        { key: 'wal_per_row', label: 'WAL/Row', tip: 'satir basina en pahali update/insert' },
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
    const walSettings = totals?.wal_settings;
    const replicationLagBytes = toNum(totals?.replication_lag?.lag_bytes);
    const replicationLagClass = replicationLagBytes > 1024 * 1024 * 1024
        ? 'text-red-700 font-semibold'
        : replicationLagBytes > 100 * 1024 * 1024
            ? 'text-orange-700 font-semibold'
            : 'text-[#1E293B]';
    const replicationStatus = totals?.replication_lag?.wal_status ?? '';
    const replicationStatusClass = replicationStatus === 'lost' || replicationStatus === 'unreserved'
        ? 'text-red-700 font-bold'
        : 'text-[#1E293B]';
    const showCompressionWarning = walSettings?.wal_compression === 'off' && toNum(totals?.fpi_heavy_count) >= 3;

    return (
        <div className="space-y-4">
            {summary && (
                <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] p-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-semibold text-[#1E293B]">💾 {instanceName || `Instance ${instancePk}`} · {rangeLabel(range)}</span>
                        {datname && <span className="text-xs px-2 py-0.5 rounded bg-[#EFF6FF] text-[#2563EB]">{datname}</span>}
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-[#64748B]">
                        <div>
                            Toplam WAL: <b className="text-[#1E293B]">{formatBytes(summary.totalWalBytes)}</b>
                            <span className="mx-1">·</span>
                            <b className="text-[#1E293B]">{toNum(totals?.wal_throughput_mb_per_sec).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} MB/sn</b>
                            <span className="mx-1">·</span>
                            En yuksek sorgu: <b className="text-[#1E293B]">%{summary.topShare.toFixed(1)}</b>
                            <span className="mx-1">·</span>
                            FPI heavy: <b className={toNum(totals?.fpi_heavy_count) > 0 ? 'text-orange-700' : 'text-[#1E293B]'}>{totals?.fpi_heavy_count ?? 0}</b>
                            <span className="mx-1">·</span>
                            Etiketler: {Object.values(tagCounts).length === 0 ? <span className="text-[#94A3B8]">yok</span> : Object.values(tagCounts).map(t => <span key={t.icon} className="mr-2">{t.icon} {t.count}</span>)}
                        </div>
                        <div>
                            Pik ani: <b className="text-[#1E293B]">{totals?.peak ? (
                                <button
                                    type="button"
                                    onClick={zoomToPeak}
                                    title="Tikla - date range pik saate daralsin"
                                    className="underline decoration-dotted hover:text-[#2563EB] hover:decoration-solid"
                                >
                                    {formatBucketFull(totals.peak.bucket_start)} - {totals.peak.mb.toFixed(1)} MB
                                </button>
                            ) : '\u2014'}</b>
                            <span className="mx-1">·</span>
                            En cok WAL ureten DB: <b className="text-[#1E293B]">{totals?.top_datname ? (
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
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {totals?.replication_lag ? (
                                <span>
                                    Replication: <b className="text-[#1E293B]">{totals.replication_lag.slot_name ?? '\u2014'}</b>
                                    <span className={`ml-1 ${replicationLagClass}`}>{formatBytes(replicationLagBytes)}</span>
                                    <span className="ml-1">(</span><span className={replicationStatusClass}>{replicationStatus || '\u2014'}</span><span>)</span>
                                    {!totals.replication_lag.active && <span className="text-orange-700"> (passive)</span>}
                                </span>
                            ) : (
                                <span className="text-[#94A3B8]">Replication slot yok</span>
                            )}
                            {toNum(totals?.spill_bytes_total) > 0 && <span>Spill: <b className="text-[#1E293B]">{formatBytes(toNum(totals?.spill_bytes_total))}</b></span>}
                            {totals?.tps && (
                                <span>
                                    TPS: <b className="text-[#1E293B]">{totals.tps.commit_per_sec.toFixed(1)} commit/sn</b>
                                    {totals.tps.rollback_per_sec > 0 && <span> ({totals.tps.rollback_per_sec.toFixed(1)} rollback)</span>}
                                </span>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {totals?.archiver && (
                                <span>
                                    Archive: <b className="text-[#1E293B]">{totals.archiver.lag_seconds == null ? '\u2014' : `${Math.floor(totals.archiver.lag_seconds / 60)} dk once`}</b>
                                    {totals.archiver.failed_count > 0 && <span className="text-red-700"> · failed: {totals.archiver.failed_count}</span>}
                                </span>
                            )}
                            <span>Mevcut max_wal_size: <b className="text-[#1E293B]">{formatKb(walSettings?.max_wal_size_kb ?? totals?.max_wal_size_kb)}</b></span>
                            <span>compression: <b className="text-[#1E293B]">{walSettings?.wal_compression ?? totals?.wal_compression ?? '\u2014'}</b></span>
                            <span>checkpoint_timeout: <b className="text-[#1E293B]">{formatMinutes(walSettings?.checkpoint_timeout_sec)}</b></span>
                        </div>
                        {showCompressionWarning && (
                            <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                                ⚠ WAL compression kapali ve {totals?.fpi_heavy_count ?? 0} sorgu FPI heavy. wal_compression=lz4 ayari ile FPI'lar %50-80 kuculur.
                            </div>
                        )}
                    </div>
                    <details className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] mt-3">
                        <summary className="px-4 py-2 cursor-pointer text-sm text-[#64748B] hover:bg-[#F8FAFC]">
                            ⚙️ WAL & Checkpoint Parametreleri
                        </summary>
                        <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                            <div title="Checkpoint arasi maksimum WAL hacmi. Astiginda zorla checkpoint tetiklenir.">
                                <div className="text-[#94A3B8]">max_wal_size</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{formatKb(walSettings?.max_wal_size_kb ?? totals?.max_wal_size_kb)}</div>
                            </div>
                            <div title="Checkpoint arasi minimum WAL. Recycle icin korunan miktar.">
                                <div className="text-[#94A3B8]">min_wal_size</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{formatKb(walSettings?.min_wal_size_kb)}</div>
                            </div>
                            <div title="Iki timed checkpoint arasi maksimum sure. Default 5dk.">
                                <div className="text-[#94A3B8]">checkpoint_timeout</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{formatMinutes(walSettings?.checkpoint_timeout_sec)}</div>
                            </div>
                            <div title="Checkpoint I/O nun pencereye yayilma orani. 0.9 = checkpoint'in cogu I/O smooth.">
                                <div className="text-[#94A3B8]">checkpoint_completion_target</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{walSettings?.checkpoint_completion_target ?? '\u2014'}</div>
                            </div>
                            <div title="WAL kayitlarini sikistir. lz4/zstd FPI'larin boyutunu yuzde 50-80 azaltir.">
                                <div className="text-[#94A3B8]">wal_compression</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{walSettings?.wal_compression ?? totals?.wal_compression ?? '\u2014'}</div>
                            </div>
                            <div title="WAL detay seviyesi. replica=replication icin yeterli, logical=logical decoding.">
                                <div className="text-[#94A3B8]">wal_level</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{walSettings?.wal_level ?? '\u2014'}</div>
                            </div>
                            <div title="WAL yazimi icin bellekten ayrilan buffer. Default shared_buffers/32, max 16MB.">
                                <div className="text-[#94A3B8]">wal_buffers</div>
                                <div className="font-mono font-semibold text-[#1E293B]">{formatKb(walSettings?.wal_buffers_kb)}</div>
                            </div>
                        </div>
                    </details>
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
                <InsightChart title="WAL Trend (MB)" height={300}>
                    <AreaChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={compactNumber} domain={yDomainWalMb as any} allowDataOverflow={hasBaseline} />
                        <Tooltip content={<ChartTooltip />} labelFormatter={(_l, p) => formatBucketFull(String((p?.[0]?.payload as any)?.bucket_iso ?? _l))} />
                        {daySeparatorLabels.map(lbl => (
                            <ReferenceLine key={`wal-${lbl}`} x={lbl} stroke="#CBD5E1" strokeDasharray="2 4" />
                        ))}
                        {hasBaseline && <Area type="monotone" dataKey="baseline_wal_mb" name={datname ? `${datname} toplam` : 'Instance toplam'} stroke="#94A3B8" fill="#E2E8F0" fillOpacity={0.5} strokeWidth={1} connectNulls />}
                        {compareKey && <Area type="monotone" dataKey="previous_wal_mb" name={compareLabel(compareKey)} stroke="#94A3B8" fill="#F1F5F9" fillOpacity={0.25} strokeWidth={2} strokeDasharray="4 3" connectNulls />}
                        <Area type="monotone" dataKey="current_wal_mb" name={search ? 'Filtreli' : 'Şu an'} stroke="#7C3AED" fill="#DDD6FE" fillOpacity={0.65} strokeWidth={2} />
                    </AreaChart>
                </InsightChart>
            )}

            <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0]">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="font-semibold text-[#1E293B]">WAL Spike Sorgular</h3>
                        <p className="text-xs text-[#64748B]">Replication ve recovery yukunu artiran WAL ureten sorgular.</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <select value={datname} onChange={e => setDatname(e.target.value)}
                            title="Database filtresi" className="border border-[#E2E8F0] rounded px-2 py-1.5 text-xs bg-white max-w-[160px]">
                            <option value="">Tüm Database'ler</option>
                            {(databases ?? []).map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') applySearch(); }}
                            placeholder="queryid veya %update%" className="border border-[#E2E8F0] rounded px-3 py-1.5 text-xs bg-white w-56 focus:outline-none focus:border-[#3B82F6]" />
                        <button onClick={applySearch} className="px-3 py-1.5 text-xs text-white bg-[#3B82F6] rounded hover:bg-[#2563EB]">Ara</button>
                        {search && (
                            <button onClick={clearSearch} className="px-2 py-1.5 text-xs text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">×</button>
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
                    <div className="p-4"><SkeletonTable rows={8} cols={14} /></div>
                ) : rows.length === 0 ? (
                    <EmptyState icon="📭" title="WAL üretimi yok"
                        description={totals?.wal_settings?.max_wal_size_kb != null
                            ? `Bu pencerede WAL ureten sorgu yok. Mevcut max_wal_size: ${formatBytes(totals.wal_settings.max_wal_size_kb * 1024)}.`
                            : totals?.max_wal_size_kb != null
                                ? `Bu pencerede WAL ureten sorgu yok. Mevcut max_wal_size: ${formatBytes(totals.max_wal_size_kb * 1024)}.`
                            : "Bu pencerede WAL ureten sorgu yok."} />
                ) : (
                    <div className="overflow-x-auto" key={`${sort}-${rows[0]?.statement_series_id ?? ''}`}>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide w-10">#</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">SQL</th>
                                    <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">DB</th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="sum(wal_bytes_delta). Bu sorgunun urettigi WAL bayti - replication yukunu besler." label="WAL (MB)" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Tek cagri basina ortalama WAL bayti." label="WAL/Cagri" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Tek sample periyodunda gorulen en yuksek WAL/cagri (outlier)." label="Max WAL/Cagri" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Bu sorgu instance'in toplam WAL uretiminin yuzde kaci." label="% Toplam WAL" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="wal_fpi / wal_records. >0.5 = checkpoint sonrasi burst." label="FPI Orani" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="Satir basina WAL bayti. Yuksekse buyuk row, TOAST veya update wave-of-pain." label="WAL/Row" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="sum(calls). Bu sorgu pencerede toplam kac defa cagrildi." label="Cagri" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="sum(total_exec_time) dakika cinsinden. DB time." label="Toplam (dk)" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="avg(mean_exec_time). Cagri basina ortalama yanit." label="Ort (ms)" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"><HeaderHelp title="PostgreSQL queryid (bigint). Plan ailesi icin esleme anahtari." label="Query ID" /></th>
                                    <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row, i) => {
                                    const walMb = toNum(row.wal_mb);
                                    const walClass = walMb > 1024 ? 'bg-red-100 text-red-700' : walMb > 100 ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-600';
                                    const pctWal = row.pct_of_total_wal == null ? null : toNum(row.pct_of_total_wal);
                                    const pctClass = pctWal == null ? 'bg-slate-100 text-slate-600' : pctWal >= 20 ? 'bg-red-100 text-red-700' : pctWal >= 5 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
                                    const fpiRatio = row.fpi_ratio == null ? null : toNum(row.fpi_ratio);
                                    const fpiClass = fpiRatio == null ? 'bg-slate-100 text-slate-600' : fpiRatio > 0.5 ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-600';
                                    const tags = calculateWALTags(row);
                                    const expanded = expandedSeriesId === row.statement_series_id;
                                    return (
                                        <Fragment key={`${row.statement_series_id}-${i}`}>
                                        <tr
                                            onClick={() => setExpandedSeriesId(prev => prev === row.statement_series_id ? null : row.statement_series_id)}
                                            className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] cursor-pointer"
                                        >
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
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap"><span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${walClass}`}>{walMb.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</span></td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{row.wal_mb_per_call == null ? '\u2014' : Number(row.wal_mb_per_call).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">{row.max_wal_mb_per_call == null ? '\u2014' : Number(row.max_wal_mb_per_call).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">{pctWal == null ? '\u2014' : <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${pctClass}`}>%{pctWal.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</span>}</td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">{fpiRatio == null ? '\u2014' : <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${fpiClass}`}>{fpiRatio.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</span>}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{row.wal_bytes_per_row == null ? '\u2014' : Number(row.wal_bytes_per_row).toLocaleString('tr-TR', { maximumFractionDigits: 0 })}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">{Number(row.toplam_cagri).toLocaleString('tr-TR')}</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono font-semibold text-[#1E293B] whitespace-nowrap">{Number(row.toplam_dk).toLocaleString('tr-TR')} dk</td>
                                            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{Number(row.ort_ms).toLocaleString('tr-TR')}</td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap"><span className="inline-flex items-center gap-1"><span className="font-mono text-[#64748B]">{row.queryid || '—'}</span><CopyButton value={row.queryid ?? ''} message="Query ID kopyalandı" disabled={!row.queryid} /></span></td>
                                            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                                                <button type="button" className="text-[#94A3B8] mr-3" title={expanded ? 'Grafikleri kapat' : 'Grafikleri ac'}>{expanded ? '-' : '+'}</button>
                                                <Link to={`/statements/${row.statement_series_id}`} onClick={e => e.stopPropagation()} className="text-[#2563EB] hover:underline">Detay</Link>
                                            </td>
                                        </tr>
                                        {expanded && (
                                            <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                                                <td colSpan={14} className="p-4">
                                                    <QueryWalTrendPanel instancePk={instancePk} seriesId={row.statement_series_id} range={range} autoRefresh={autoRefresh} compareKey={compareKey} />
                                                </td>
                                            </tr>
                                        )}
                                        </Fragment>
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
