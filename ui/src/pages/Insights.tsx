import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import { SkeletonTable } from '../components/common/Skeleton';
import EmptyState from '../components/common/EmptyState';
import TimeRangePicker, { loadPersistedRange, type TimeRange } from '../components/common/TimeRangePicker';

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

    const instances = useQuery({
        queryKey: ['instances-list-insights'],
        queryFn: () => apiGet<Instance[]>('/instances'),
        staleTime: 60_000,
    });

    const activeInstances = (instances.data ?? []).filter(i => i.is_active);

    return (
        <div className="p-6 max-w-7xl mx-auto">
            {/* Başlık ve seçiciler */}
            <div className="mb-4">
                <h1 className="text-2xl font-semibold text-[#1E293B] mb-1">🔍 Insights</h1>
                <p className="text-sm text-[#64748B]">Bir instance ve zaman aralığı seçin, pgstat sizin için anlamlı çıkarımlar üretir.</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0] p-4 mb-4 flex flex-wrap gap-3 items-center">
                <div>
                    <label className="block text-xs text-[#64748B] mb-1">Instance</label>
                    <InstanceTypeahead
                        instances={activeInstances}
                        value={instancePk}
                        onChange={setInstancePk}
                    />
                </div>
                <div>
                    <label className="block text-xs text-[#64748B] mb-1">Tarih Aralığı</label>
                    <TimeRangePicker value={range} onChange={setRange} persistKey="insights-range" />
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
            {tab === 'top-exec' && <TopExecTimeCard instancePk={instancePk} range={range} />}
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
// InstanceTypeahead — uncontrolled input + datalist
// Kullanici elle yazar veya datalist'ten secer.
// Match bulunca onChange(instance_pk) parent'a gider.
// =========================================================================
function InstanceTypeahead({
    instances,
    value,
    onChange,
}: {
    instances: Instance[];
    value: number | null;
    onChange: (v: number | null) => void;
}) {
    const selected = instances.find(i => i.instance_pk === value);

    function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
        const val = e.target.value;
        if (val === '') {
            onChange(null);
            return;
        }
        const match = instances.find(i => i.display_name === val);
        if (match) {
            onChange(match.instance_pk);
        }
        // Match yoksa parent'a gönderme — kullanıcı henüz yazıyor olabilir
    }

    return (
        <>
            <input
                type="text"
                list="instances-datalist"
                defaultValue={selected?.display_name ?? ''}
                key={value ?? 'empty'}
                onInput={handleInput}
                placeholder="Instance ara veya seç..."
                className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[280px] focus:outline-none focus:border-[#3B82F6]"
            />
            <datalist id="instances-datalist">
                {instances.map(i => (
                    <option key={i.instance_pk} value={i.display_name} />
                ))}
            </datalist>
        </>
    );
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

function TopExecTimeCard({ instancePk, range }: { instancePk: number | null; range: TimeRange }) {
    const [sort, setSort] = useState<SortMode>('time');

    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['insights-top-queries', instancePk, range.fromIso, range.toIso, sort],
        queryFn: () => apiGet<TopQueryRow[]>(
            `/insights/${instancePk}/top-queries?sort=${sort}&from=${encodeURIComponent(range.fromIso)}&to=${encodeURIComponent(range.toIso)}&limit=20`,
        ),
        enabled: instancePk != null && Number.isFinite(instancePk),
    });

    if (instancePk == null) {
        return <EmptyState icon="🖥️" title="Instance seçin" description="Yukarıdan bir aktif instance seçin." />;
    }

    const sortButtons: { key: SortMode; label: string; tip: string }[] = [
        { key: 'time', label: 'Toplam Süre', tip: 'DB zamanını en çok yiyen sorgular (sum exec_time)' },
        { key: 'calls', label: 'Çağrı Sayısı', tip: 'En sık çalışan sorgular (sum calls). N+1 / ORM tespiti.' },
        { key: 'slow', label: 'Ortalama Yavaşlık', tip: 'Sürekli yavaş olan sorgular (avg mean_exec_time, min 10 çağrı)' },
    ];

    return (
        <div className="bg-white rounded-lg shadow-sm border border-[#E2E8F0]">
            <div className="px-4 py-3 border-b border-[#E2E8F0] flex flex-wrap items-center gap-3">
                <div className="flex-1">
                    <h3 className="font-semibold text-[#1E293B]">Top Sorgular</h3>
                    <p className="text-xs text-[#64748B]">Bu DB'nin zamanı nereye gidiyor? Sıralamayı değiştirerek farklı açılardan bak.</p>
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
                <button onClick={() => refetch()}
                    className="px-3 py-1.5 text-xs text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                    {isFetching ? '...' : 'Yenile'}
                </button>
            </div>

            {isLoading ? (
                <div className="p-4"><SkeletonTable rows={8} cols={9} /></div>
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
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">SQL</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase tracking-wide">Database</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">Çağrı</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">Toplam</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">%</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">Min ms</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">Ort ms</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">Max ms</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide">Satır</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase tracking-wide"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.map((row, i) => (
                                <TopQueryRow key={`${row.statement_series_id}-${i}`} row={row} rank={i + 1} />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function TopQueryRow({ row, rank }: { row: TopQueryRow; rank: number }) {
    const pct = parseFloat(row.pct_of_total);
    const ortMs = parseFloat(row.ort_ms);
    const maxMs = parseFloat(row.max_ms);
    const minMs = parseFloat(row.min_ms);
    const pctClass = pct >= 20 ? 'bg-red-100 text-red-700' : pct >= 5 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';

    return (
        <tr className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors">
            <td className="py-2 px-3 text-xs text-[#94A3B8] font-semibold">#{rank}</td>
            <td className="py-2 px-3 max-w-md">
                <div className="font-mono text-xs text-[#1E293B] truncate" title={row.query_short ?? ''}>
                    {row.query_short || <span className="italic text-[#94A3B8]">metin yok</span>}
                </div>
            </td>
            <td className="py-2 px-3 text-xs text-[#1E293B] whitespace-nowrap">{row.datname || '—'}</td>
            <td className="py-2 px-3 text-xs text-right font-mono text-[#1E293B] whitespace-nowrap">{Number(row.toplam_cagri).toLocaleString('tr-TR')}</td>
            <td className="py-2 px-3 text-xs text-right font-mono font-semibold text-[#1E293B] whitespace-nowrap">{Number(row.toplam_dk).toLocaleString('tr-TR')} dk</td>
            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${pctClass}`}>%{pct}</span>
            </td>
            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{minMs}</td>
            <td className="py-2 px-3 text-xs text-right font-mono font-semibold text-[#1E293B] whitespace-nowrap">{ortMs}</td>
            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{maxMs}</td>
            <td className="py-2 px-3 text-xs text-right font-mono text-[#64748B] whitespace-nowrap">{Number(row.toplam_satir).toLocaleString('tr-TR')}</td>
            <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                <Link to={`/statements/${row.statement_series_id}`} className="text-[#2563EB] hover:underline">Detay →</Link>
            </td>
        </tr>
    );
}
