import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import DataTable from '../components/common/DataTable';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

interface Instance {
    instance_pk: number; display_name: string; host: string; port: number;
    bootstrap_state: string; pg_major: number | null; is_primary: boolean | null;
}

type Tab = 'databases' | 'statements' | 'tables' | 'activity' | 'replication';

export default function ClusterDetail() {
    const { id } = useParams<{ id?: string }>();
    const navigate = useNavigate();
    const urlPk = id ? parseInt(id) : null;

    const [selectedDbid, setSelectedDbid] = useState<number | null>(null);
    const [tab, setTab] = useState<Tab>('databases');

    // Reset per-instance state when instance changes via URL
    useEffect(() => {
        setSelectedDbid(null);
        setTab('databases');
    }, [urlPk]);

    const instances = useQuery({ queryKey: ['instances'], queryFn: () => apiGet<Instance[]>('/instances') });

    const inst = instances.data?.find((i) => i.instance_pk === urlPk);

    function handleSelectInstance(pk: number | null) {
        if (pk) navigate(`/cluster/${pk}`);
        else navigate('/cluster-detail');
    }

    return (
        <div>
            <h1 className="text-xl font-bold mb-5">Cluster / Database Toplama Detayı</h1>

            {/* Instance seçimi */}
            <div className="flex gap-4 mb-5 items-end">
                <div>
                    <label className="block text-xs text-[#64748B] mb-1">Instance Seçin</label>
                    <select value={urlPk ?? ''} onChange={(e) => handleSelectInstance(parseInt(e.target.value) || null)}
                        className="border border-[#E2E8F0] rounded px-3 py-2 text-sm bg-white min-w-[250px]" aria-label="Instance seçimi">
                        <option value="">Seçiniz...</option>
                        {(instances.data || []).map((i) => (
                            <option key={i.instance_pk} value={i.instance_pk}>
                                {i.display_name} ({i.host}:{i.port}) — PG{i.pg_major || '?'}
                            </option>
                        ))}
                    </select>
                </div>
                {inst && (
                    <div className="flex gap-2 items-center text-sm">
                        <Badge value={inst.bootstrap_state} />
                        {inst.is_primary !== null && <span className={inst.is_primary ? 'text-blue-600' : 'text-purple-600'}>{inst.is_primary ? 'Primary' : 'Replica'}</span>}
                    </div>
                )}
            </div>

            {!urlPk && <div className="text-[#94A3B8] py-8 text-center">Bir instance seçin</div>}

            {urlPk && (
                <>
                    <div className="flex gap-1 mb-4 border-b border-[#E2E8F0] overflow-x-auto">
                        {([
                            { key: 'databases', label: 'Databases' },
                            { key: 'statements', label: 'Statement Serileri' },
                            { key: 'tables', label: 'Tablo / Index' },
                            { key: 'activity', label: 'Aktif Sessionlar' },
                            { key: 'replication', label: 'Replikasyon' },
                        ] as { key: Tab; label: string }[]).map((t) => (
                            <button key={t.key} onClick={() => setTab(t.key)}
                                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${tab === t.key ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-[#64748B] hover:text-[#1E293B]'
                                    }`}>{t.label}</button>
                        ))}
                    </div>

                    {tab === 'databases' && <DatabasesPanel instancePk={urlPk} onSelectDb={setSelectedDbid} />}
                    {tab === 'statements' && <StatementsPanel instancePk={urlPk} />}
                    {tab === 'tables' && <TablesPanel instancePk={urlPk} selectedDbid={selectedDbid} onSelectDb={setSelectedDbid} />}
                    {tab === 'activity' && <ActivityPanel instancePk={urlPk} />}
                    {tab === 'replication' && <ReplicationPanel instancePk={urlPk} isPrimary={inst?.is_primary} />}
                </>
            )}
        </div>
    );
}

// =========================================================================
// Databases
// =========================================================================

function DatabasesPanel({ instancePk, onSelectDb }: { instancePk: number; onSelectDb: (dbid: number) => void }) {
    const { data, isLoading } = useQuery({
        queryKey: ['cluster-dbs', instancePk],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/databases`),
    });

    const columns = [
        { key: 'datname', header: 'Database' },
        { key: 'dbid', header: 'OID' },
        { key: 'first_seen_at', header: 'İlk Görülme', render: (r: any) => <TimeAgo date={r.first_seen_at} /> },
        { key: 'last_seen_at', header: 'Son Görülme', render: (r: any) => <TimeAgo date={r.last_seen_at} /> },
        { key: 'last_db_objects_collect_at', header: 'Son Toplama', render: (r: any) => <TimeAgo date={r.last_db_objects_collect_at} /> },
        { key: 'next_db_objects_collect_at', header: 'Sonraki', render: (r: any) => <TimeAgo date={r.next_db_objects_collect_at} /> },
        { key: 'consecutive_failures', header: 'Hatalar', render: (r: any) => (r.consecutive_failures || 0) > 0 ? <span className="text-red-600">{r.consecutive_failures}</span> : <span className="text-green-600">0</span> },
    ];

    if (isLoading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;
    return <div className="bg-white rounded-lg shadow-sm p-4"><DataTable columns={columns} data={data || []} onRowClick={(r) => onSelectDb(r.dbid)} /></div>;
}

// =========================================================================
// Statement Serileri
// =========================================================================

function fmtMs(ms: number): string {
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}dk`;
    if (ms >= 1_000)  return `${(ms / 1_000).toFixed(2)}s`;
    return `${ms.toFixed(1)}ms`;
}
function fmtNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
}

function StatementsPanel({ instancePk }: { instancePk: number }) {
    const navigate = useNavigate();

    // Server-side filtreler
    const [hours, setHours]     = useState(24);
    const [orderBy, setOrderBy] = useState('exec_time');
    const [datname, setDatname] = useState('');
    const [rolname, setRolname] = useState('');

    // Client-side filtreler
    const [sqlSearch, setSqlSearch] = useState('');
    const [minAvgMs, setMinAvgMs]   = useState('');

    const qp = new URLSearchParams({
        hours: String(hours), limit: '100', order_by: orderBy,
        ...(datname ? { datname } : {}),
        ...(rolname ? { rolname } : {}),
    });

    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['cluster-top-stmts', instancePk, hours, orderBy, datname, rolname],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/statements?${qp}`),
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

    if (isLoading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;

    return (
        <div>
            {/* Filtre paneli */}
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
                                ✕ Temizle
                            </button>
                        )}
                        <button onClick={() => refetch()}
                            className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                            {isFetching ? 'Yenileniyor…' : 'Yenile'}
                        </button>
                        <span className="text-xs text-[#94A3B8]">
                            {hasFilter && filtered.length !== (data?.length ?? 0)
                                ? `${filtered.length} / ${data?.length ?? 0}`
                                : `${filtered.length} sorgu`}
                        </span>
                    </div>
                </div>
            </div>

            {/* Tablo */}
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                {filtered.length === 0 ? (
                    <div className="text-[#94A3B8] py-8 text-center text-sm">
                        {data?.length === 0 ? 'Bu aralıkta statement verisi yok.' : 'Filtreyle eşleşen sorgu bulunamadı.'}
                    </div>
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
                                {filtered.map((r: any) => {
                                    const avgMs = Number(r.avg_exec_time_ms);
                                    const avgColor = avgMs >= 1000 ? 'text-red-600 font-semibold'
                                        : avgMs >= 100 ? 'text-amber-600 font-semibold' : 'text-[#64748B]';
                                    return (
                                        <tr key={r.statement_series_id}
                                            onClick={() => navigate(`/statements/${r.statement_series_id}`)}
                                            className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] cursor-pointer transition-colors">
                                            <td className="py-2.5 px-3 text-xs">
                                                <div className="text-[#1E293B]">{r.datname ?? '—'}</div>
                                                <div className="text-[#94A3B8]">{r.rolname ?? '—'}</div>
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

// =========================================================================
// Tablo / Index
// =========================================================================

function TablesPanel({ instancePk, selectedDbid, onSelectDb }: { instancePk: number; selectedDbid: number | null; onSelectDb: (dbid: number) => void }) {
    const dbs = useQuery({ queryKey: ['cluster-dbs', instancePk], queryFn: () => apiGet<any[]>(`/instances/${instancePk}/databases`) });

    const tables = useQuery({
        queryKey: ['cluster-tables', instancePk, selectedDbid],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/databases/${selectedDbid}/tables?hours=24`),
        enabled: !!selectedDbid,
    });

    const indexes = useQuery({
        queryKey: ['cluster-indexes', instancePk, selectedDbid],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/databases/${selectedDbid}/indexes?hours=24`),
        enabled: !!selectedDbid,
    });

    const tableCols = [
        { key: 'schemaname', header: 'Schema' },
        { key: 'relname', header: 'Tablo' },
        { key: 'total_seq_scan', header: 'Seq Scan', render: (r: any) => Number(r.total_seq_scan).toLocaleString(), className: 'text-right' },
        { key: 'total_idx_scan', header: 'Idx Scan', render: (r: any) => Number(r.total_idx_scan).toLocaleString(), className: 'text-right' },
        { key: 'total_inserts', header: 'Insert', render: (r: any) => Number(r.total_inserts).toLocaleString(), className: 'text-right' },
        { key: 'total_updates', header: 'Update', render: (r: any) => Number(r.total_updates).toLocaleString(), className: 'text-right' },
        { key: 'total_deletes', header: 'Delete', render: (r: any) => Number(r.total_deletes).toLocaleString(), className: 'text-right' },
        { key: 'n_live_tup', header: 'Live Tup', render: (r: any) => Number(r.n_live_tup).toLocaleString(), className: 'text-right' },
        { key: 'n_dead_tup', header: 'Dead Tup', render: (r: any) => Number(r.n_dead_tup).toLocaleString(), className: 'text-right' },
    ];

    const indexCols = [
        { key: 'schemaname', header: 'Schema' },
        { key: 'table_relname', header: 'Tablo' },
        { key: 'index_relname', header: 'Index' },
        { key: 'total_idx_scan', header: 'Idx Scan', render: (r: any) => Number(r.total_idx_scan).toLocaleString(), className: 'text-right' },
        { key: 'total_idx_tup_read', header: 'Tup Read', render: (r: any) => Number(r.total_idx_tup_read).toLocaleString(), className: 'text-right' },
        { key: 'total_idx_blks_read', header: 'Blks Read', render: (r: any) => Number(r.total_idx_blks_read).toLocaleString(), className: 'text-right' },
        { key: 'total_idx_blks_hit', header: 'Blks Hit', render: (r: any) => Number(r.total_idx_blks_hit).toLocaleString(), className: 'text-right' },
    ];

    return (
        <div>
            <div className="mb-4">
                <label className="block text-xs text-[#64748B] mb-1">Database Seçin</label>
                <select value={selectedDbid ?? ''} onChange={(e) => onSelectDb(parseInt(e.target.value) || 0)}
                    className="border border-[#E2E8F0] rounded px-3 py-2 text-sm bg-white min-w-[200px]" aria-label="Database seçimi">
                    <option value="">Seçiniz...</option>
                    {(dbs.data || []).map((d: any) => <option key={d.dbid} value={d.dbid}>{d.datname}</option>)}
                </select>
            </div>

            {!selectedDbid && <div className="text-[#94A3B8] py-4 text-center">Bir database seçin</div>}

            {selectedDbid && (
                <>
                    <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                        <h3 className="text-sm font-semibold text-[#64748B] mb-3">Tablolar (son 24 saat)</h3>
                        {tables.isLoading ? <div className="text-[#94A3B8]">Yükleniyor...</div> : <DataTable columns={tableCols} data={tables.data || []} />}
                    </div>
                    <div className="bg-white rounded-lg shadow-sm p-4">
                        <h3 className="text-sm font-semibold text-[#64748B] mb-3">Indexler (son 24 saat)</h3>
                        {indexes.isLoading ? <div className="text-[#94A3B8]">Yükleniyor...</div> : <DataTable columns={indexCols} data={indexes.data || []} />}
                    </div>
                </>
            )}
        </div>
    );
}

// =========================================================================
// Aktif Sessionlar
// =========================================================================

function ActivityPanel({ instancePk }: { instancePk: number }) {
    const [view, setView] = useState<'summary' | 'detail'>('summary');
    const [filter, setFilter] = useState('all');
    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: ['cluster-activity', instancePk],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/activity`),
    });

    // Snapshot zamani
    const snapshotDate = data?.[0]?.snapshot_ts ? new Date(data[0].snapshot_ts) : null;
    const snapshotAgo = snapshotDate
        ? Math.round((Date.now() - snapshotDate.getTime()) / 1000)
        : null;

    // Sadece client backend session'lari
    const clientSessions = (data || []).filter((r: any) => r.backend_type === 'client backend');

    // just_became_idle: snapshot anindan 1 saniye oncesine kadar idle olmus (aslinda aktifti)
    const HOT_WINDOW_MS = 1000;
    const isJustBecameIdle = (r: any) => {
        if (r.state !== 'idle' || !r.state_change || !snapshotDate) return false;
        const stateChangeMs = new Date(r.state_change).getTime();
        return (snapshotDate.getTime() - stateChangeMs) <= HOT_WINDOW_MS;
    };

    // Ozet: datname + client_addr + usename bazinda gruplama
    const summaryMap = new Map<string, {
        datname: string; client_addr: string; usename: string;
        open: number; active_now: number; idle_in_trans_now: number;
        idle_now: number; just_became_idle: number;
    }>();
    for (const r of clientSessions) {
        const key = `${r.datname || ''}|${r.client_addr || ''}|${r.usename || ''}`;
        let row = summaryMap.get(key);
        if (!row) {
            row = { datname: r.datname || '—', client_addr: r.client_addr || '—', usename: r.usename || '—',
                open: 0, active_now: 0, idle_in_trans_now: 0, idle_now: 0, just_became_idle: 0 };
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

    // Totals satiri
    const totals = summaryRows.reduce((t, r) => ({
        open: t.open + r.open, active_now: t.active_now + r.active_now,
        idle_in_trans_now: t.idle_in_trans_now + r.idle_in_trans_now,
        idle_now: t.idle_now + r.idle_now, just_became_idle: t.just_became_idle + r.just_became_idle,
    }), { open: 0, active_now: 0, idle_in_trans_now: 0, idle_now: 0, just_became_idle: 0 });

    // Detay filtreleri
    const IDLE_WAIT_TYPES = new Set(['Activity', 'Client']);
    const detailFiltered = (data || []).filter((r: any) => {
        if (filter === 'client') return r.backend_type === 'client backend';
        if (filter === 'active') return r.state === 'active' || isJustBecameIdle(r);
        if (filter === 'idle') return r.state === 'idle' && !isJustBecameIdle(r);
        if (filter === 'idle_tx') return r.state === 'idle in transaction';
        if (filter === 'waiting') return r.wait_event_type && !IDLE_WAIT_TYPES.has(r.wait_event_type);
        return true;
    });
    const detailCounts = {
        all: (data || []).length,
        client: clientSessions.length,
        active: (data || []).filter((r: any) => r.state === 'active' || isJustBecameIdle(r)).length,
        idle: clientSessions.filter((r: any) => r.state === 'idle' && !isJustBecameIdle(r)).length,
        idle_tx: (data || []).filter((r: any) => r.state === 'idle in transaction').length,
        waiting: (data || []).filter((r: any) => r.wait_event_type && !IDLE_WAIT_TYPES.has(r.wait_event_type)).length,
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
                const label = jbi ? 'idle (aktifti)' : r.state || '—';
                return <span className={`font-medium ${color}`}>{label}</span>;
            }
        },
        { key: 'wait_event_type', header: 'Wait', render: (r: any) => r.wait_event_type ? `${r.wait_event_type}/${r.wait_event}` : '—' },
        { key: 'query', header: 'Sorgu', render: (r: any) => <div className="max-w-xs truncate text-xs font-mono" title={r.query}>{r.query ? r.query.substring(0, 120) : '—'}</div> },
        { key: 'backend_type', header: 'Backend' },
    ];

    if (isLoading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;

    const summaryColumns = [
        { key: 'datname', header: 'Database' },
        { key: 'client_addr', header: 'Client' },
        { key: 'usename', header: 'User' },
        { key: 'open', header: 'Open', className: 'text-right' },
        { key: 'active_now', header: 'Active', render: (r: any) => <span className={r.active_now > 0 ? 'text-green-600 font-medium' : ''}>{r.active_now}</span>, className: 'text-right' },
        { key: 'idle_in_trans_now', header: 'Idle in TX', render: (r: any) => <span className={r.idle_in_trans_now > 0 ? 'text-yellow-600 font-medium' : ''}>{r.idle_in_trans_now}</span>, className: 'text-right' },
        { key: 'idle_now', header: 'Idle', className: 'text-right' },
        { key: 'just_became_idle', header: 'Just Idle', render: (r: any) => <span className={r.just_became_idle > 0 ? 'text-green-500' : ''} title="Snapshot anindan < 1s once idle olmus (buyuk ihtimalle aktifti)">{r.just_became_idle}</span>, className: 'text-right' },
    ];

    return (
        <div>
            {/* Ust bar: gorunum secimi + snapshot zamani + yenile */}
            <div className="flex gap-1 mb-3 items-center">
                <button onClick={() => setView('summary')}
                    className={`px-3 py-1 text-xs rounded ${view === 'summary' ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0]'}`}>
                    Ozet
                </button>
                <button onClick={() => setView('detail')}
                    className={`px-3 py-1 text-xs rounded ${view === 'detail' ? 'bg-[#3B82F6] text-white' : 'bg-white text-[#64748B] border border-[#E2E8F0]'}`}>
                    Detay
                </button>
                {snapshotDate && (
                    <span className="ml-auto text-xs text-[#64748B]">
                        Snapshot: {snapshotDate.toLocaleTimeString()}
                        <span className="text-[#94A3B8] ml-1">
                            ({snapshotAgo! < 60 ? `${snapshotAgo}s` : `${Math.floor(snapshotAgo! / 60)}dk`} once)
                        </span>
                    </span>
                )}
                <button onClick={() => refetch()} disabled={isFetching}
                    className={`px-3 py-1 text-xs rounded border border-[#E2E8F0] hover:bg-[#F1F5F9] ${isFetching ? 'bg-[#F1F5F9] text-[#94A3B8]' : 'bg-white text-[#64748B]'}`}>
                    {isFetching ? 'Yenileniyor...' : 'Yenile'}
                </button>
            </div>

            {/* Ozet gorunumu */}
            {view === 'summary' && (
                <div className="bg-white rounded-lg shadow-sm p-4">
                    <DataTable columns={summaryColumns} data={summaryRows} emptyText="Client session yok" />
                    {summaryRows.length > 0 && (
                        <div className="border-t border-[#E2E8F0] mt-1 pt-2 flex gap-6 text-xs">
                            <span className="text-[#64748B] font-medium">TOPLAM</span>
                            <span>Open: <strong>{totals.open}</strong></span>
                            <span className={totals.active_now > 0 ? 'text-green-600' : ''}>Active: <strong>{totals.active_now}</strong></span>
                            <span className={totals.idle_in_trans_now > 0 ? 'text-yellow-600' : ''}>Idle in TX: <strong>{totals.idle_in_trans_now}</strong></span>
                            <span>Idle: <strong>{totals.idle_now}</strong></span>
                            <span className={totals.just_became_idle > 0 ? 'text-green-500' : ''}>Just Idle: <strong>{totals.just_became_idle}</strong></span>
                        </div>
                    )}
                    <p className="text-[10px] text-[#94A3B8] mt-2">
                        Just Idle = snapshot anindan &lt;1s once idle olmus session (buyuk ihtimalle aktifti).
                        Sadece client backend session'lari gosterilir.
                    </p>
                </div>
            )}

            {/* Detay gorunumu */}
            {view === 'detail' && (
                <div>
                    <div className="flex gap-1 mb-3">
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

// =========================================================================
// Replikasyon
// =========================================================================

function ReplicationPanel({ instancePk, isPrimary }: { instancePk: number; isPrimary: boolean | null | undefined }) {
    const { data, isLoading } = useQuery({
        queryKey: ['cluster-repl', instancePk],
        queryFn: () => apiGet<any[]>(`/instances/${instancePk}/replication`),
        enabled: isPrimary === true,
    });

    if (isPrimary !== true) {
        return <div className="text-[#94A3B8] py-8 text-center">Bu node primary değil — replikasyon bilgisi yalnızca primary node'larda gösterilir.</div>;
    }

    if (isLoading) return <div className="text-[#94A3B8] py-4">Yükleniyor...</div>;

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
