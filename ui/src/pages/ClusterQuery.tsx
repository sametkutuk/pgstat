// Bir queryid icin tum instance'lardaki (primary+replikalar) toplam istatistik raporu.
// URL: /cluster-query/:queryid?from=ISO&to=ISO[&system_identifier=N]
import { useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import DataTable from '../components/common/DataTable';
import Badge from '../components/common/Badge';

function fmtMs(ms: number) {
    if (ms >= 3_600_000) return (ms / 3_600_000).toFixed(2) + ' sa';
    if (ms >= 60_000) return (ms / 60_000).toFixed(2) + ' dk';
    if (ms >= 1000) return (ms / 1000).toFixed(2) + ' sn';
    return ms.toFixed(0) + ' ms';
}
function fmtBytes(b: number) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(2) + ' KB';
    return b + ' B';
}
function localToIso(local: string) { return new Date(local).toISOString(); }
function isoToLocal(iso: string) {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ClusterQuery() {
    const { queryid } = useParams<{ queryid: string }>();
    const [search, setSearch] = useSearchParams();
    const sysId = search.get('system_identifier') || '';

    // Default: son 24 saat
    const defaultTo = new Date();
    const defaultFrom = new Date(Date.now() - 24 * 3600 * 1000);
    const [fromLocal, setFromLocal] = useState(search.get('from') ? isoToLocal(search.get('from')!) : isoToLocal(defaultFrom.toISOString()));
    const [toLocal, setToLocal] = useState(search.get('to') ? isoToLocal(search.get('to')!) : isoToLocal(defaultTo.toISOString()));

    const fromIso = localToIso(fromLocal);
    const toIso = localToIso(toLocal);

    const { data, isLoading } = useQuery({
        queryKey: ['cluster-query', queryid, fromIso, toIso, sysId],
        queryFn: () => apiGet<any>(
            `/statements/cluster/${queryid}?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}${sysId ? `&system_identifier=${sysId}` : ''}`
        ),
        enabled: !!queryid,
    });

    const apply = () => {
        const p = new URLSearchParams(search);
        p.set('from', fromIso);
        p.set('to', toIso);
        setSearch(p);
    };

    const presets = [
        { label: 'Son 1 saat', hours: 1 },
        { label: 'Son 6 saat', hours: 6 },
        { label: 'Son 24 saat', hours: 24 },
        { label: 'Son 7 gün', hours: 168 },
    ];
    const setPreset = (h: number) => {
        const t = new Date();
        const f = new Date(Date.now() - h * 3600 * 1000);
        setFromLocal(isoToLocal(f.toISOString()));
        setToLocal(isoToLocal(t.toISOString()));
        const p = new URLSearchParams(search);
        p.set('from', f.toISOString());
        p.set('to', t.toISOString());
        setSearch(p);
    };

    const columns = [
        {
            key: 'role', header: 'Rol', render: (r: any) => (
                <Badge value={r.is_primary === true ? 'primary' : r.is_primary === false ? 'replica' : '?'} />
            )
        },
        {
            key: 'display_name', header: 'Instance', render: (r: any) => (
                <Link to={`/instances/${r.instance_pk}`} className="text-[#3B82F6] hover:underline font-mono text-xs">
                    {r.display_name}
                </Link>
            )
        },
        { key: 'datname', header: 'DB', render: (r: any) => <span className="font-mono text-xs">{r.datname || '—'}</span> },
        { key: 'rolname', header: 'Kullanıcı', render: (r: any) => <span className="font-mono text-xs">{r.rolname || '—'}</span> },
        { key: 'calls', header: 'Çağrı', render: (r: any) => Number(r.calls).toLocaleString(), className: 'text-right font-mono' },
        { key: 'exec_ms', header: 'Toplam Süre', render: (r: any) => fmtMs(Number(r.exec_ms)), className: 'text-right font-mono' },
        { key: 'avg_ms', header: 'Ort/Çağrı', render: (r: any) => Number(r.calls) > 0 ? fmtMs(Number(r.exec_ms) / Number(r.calls)) : '—', className: 'text-right font-mono' },
        { key: 'rows_delta', header: 'Satır', render: (r: any) => Number(r.rows_delta).toLocaleString(), className: 'text-right font-mono' },
        { key: 'wal_bytes', header: 'WAL', render: (r: any) => fmtBytes(Number(r.wal_bytes)), className: 'text-right font-mono' },
        {
            key: 'detail', header: '', render: (r: any) => (
                <Link to={`/statements/${r.statement_series_id}`} className="text-[#3B82F6] hover:underline text-xs">
                    Detay →
                </Link>
            )
        },
    ];

    const totals = data?.totals;
    const totalCalls = totals?.calls || 0;
    const totalExec = totals?.exec_ms || 0;

    return (
        <div>
            <div className="flex items-center gap-2 mb-4">
                <Link to="/statements" className="text-[#3B82F6] hover:underline text-sm">← Statements</Link>
                <h1 className="text-xl font-bold ml-2">Küme Geneli — Sorgu Raporu</h1>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4 mb-4">
                <div className="flex flex-wrap items-end gap-3">
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Başlangıç</label>
                        <input type="datetime-local" value={fromLocal} onChange={e => setFromLocal(e.target.value)}
                            className="border border-[#CBD5E1] rounded px-2 py-1 text-sm" />
                    </div>
                    <div>
                        <label className="block text-xs text-[#64748B] mb-1">Bitiş</label>
                        <input type="datetime-local" value={toLocal} onChange={e => setToLocal(e.target.value)}
                            className="border border-[#CBD5E1] rounded px-2 py-1 text-sm" />
                    </div>
                    <button onClick={apply}
                        className="px-4 py-1.5 bg-[#3B82F6] text-white text-sm rounded hover:bg-[#2563EB]">
                        Uygula
                    </button>
                    <div className="flex gap-1 ml-2">
                        {presets.map(p => (
                            <button key={p.hours} onClick={() => setPreset(p.hours)}
                                className="px-2 py-1 text-xs bg-[#F1F5F9] text-[#475569] rounded hover:bg-[#E2E8F0]">
                                {p.label}
                            </button>
                        ))}
                    </div>
                    {sysId && (
                        <span className="ml-auto text-xs text-[#64748B]">
                            system_identifier filtresi: <code className="font-mono">{sysId}</code>
                        </span>
                    )}
                </div>
                <div className="mt-3 text-xs text-[#94A3B8]">
                    queryid: <code className="font-mono text-[#1E293B]">{queryid}</code>
                </div>
                {data?.query_text && (
                    <pre className="mt-2 bg-[#F8FAFC] rounded px-3 py-2 text-[11px] font-mono whitespace-pre-wrap break-words text-[#334155]">
                        {data.query_text}
                    </pre>
                )}
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4">
                {isLoading ? (
                    <div className="text-[#94A3B8] py-8 text-center">Yükleniyor...</div>
                ) : !data?.instances?.length ? (
                    <div className="text-[#94A3B8] py-8 text-center">
                        Bu queryid için seçili aralıkta veri yok.
                        Farklı bir tarih seç ya da queryid'nin tüm instance'larda gerçekten kullanıldığından emin ol.
                    </div>
                ) : (
                    <>
                        <DataTable columns={columns} data={data.instances} />
                        {totals && (
                            <div className="mt-3 pt-3 border-t-2 border-[#1E293B] grid grid-cols-2 md:grid-cols-7 gap-3 text-sm">
                                <div className="font-semibold text-[#1E293B]">TOPLAM ({data.instances.length} instance)</div>
                                <div></div>
                                <div></div>
                                <div></div>
                                <div className="text-right font-mono font-bold">
                                    {Number(totals.calls).toLocaleString()}
                                </div>
                                <div className="text-right font-mono font-bold">
                                    {fmtMs(Number(totals.exec_ms))}
                                </div>
                                <div className="text-right text-xs text-[#64748B]">
                                    Ort: {totalCalls > 0 ? fmtMs(totalExec / totalCalls) : '—'}
                                </div>
                            </div>
                        )}
                        {totals && (
                            <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-[#64748B]">
                                <div>Toplam satır: <span className="font-mono text-[#1E293B]">{Number(totals.rows_delta).toLocaleString()}</span></div>
                                <div>Cache hit: <span className="font-mono text-[#1E293B]">{Number(totals.blks_hit).toLocaleString()}</span> blok</div>
                                <div>Disk read: <span className="font-mono text-[#1E293B]">{Number(totals.blks_read).toLocaleString()}</span> blok</div>
                                <div>Temp yazılan: <span className="font-mono text-[#1E293B]">{fmtBytes(Number(totals.temp_blks_written) * 8192)}</span></div>
                                <div>WAL: <span className="font-mono text-[#1E293B]">{fmtBytes(Number(totals.wal_bytes))}</span></div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
