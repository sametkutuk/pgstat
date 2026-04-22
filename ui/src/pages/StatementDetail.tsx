import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import { useState } from 'react';

export default function StatementDetail() {
    const { seriesId } = useParams();
    const [hours, setHours] = useState(24);

    const { data, isLoading } = useQuery({
        queryKey: ['statement-detail', seriesId, hours],
        queryFn: () => apiGet<any>(`/statements/${seriesId}?hours=${hours}`),
    });

    if (isLoading) return <div className="py-8 text-[#94A3B8]">Yükleniyor...</div>;
    if (!data) return <div className="py-8 text-red-500">Statement bulunamadı</div>;

    const { series, deltas } = data;

    return (
        <div>
            <Link to="/statements" className="text-sm text-[#3B82F6] hover:underline mb-3 inline-block">← Statements</Link>
            <h1 className="text-xl font-bold mb-2">Statement Detayı</h1>

            {/* SQL text */}
            <div className="bg-white rounded-lg shadow-sm p-5 mb-5">
                <h3 className="text-sm font-semibold text-[#64748B] mb-2">SQL Text</h3>
                <pre className="text-xs font-mono bg-[#F8FAFC] p-3 rounded overflow-x-auto whitespace-pre-wrap max-h-48">
                    {series.query_text || 'Text henüz enrichment yapılmadı'}
                </pre>
                <div className="flex gap-4 mt-3 text-xs text-[#64748B]">
                    <span>Database: <strong>{series.datname || '—'}</strong></span>
                    <span>Rol: <strong>{series.rolname || '—'}</strong></span>
                    <span>QueryID: <strong>{series.queryid}</strong></span>
                    <span>Epoch: <strong>{series.pgss_epoch_key}</strong></span>
                </div>
            </div>

            {/* Zaman filtresi */}
            <div className="flex gap-4 mb-4">
                <select
                    value={hours}
                    onChange={(e) => setHours(Number(e.target.value))}
                    className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white"
                    aria-label="Zaman aralığı"
                >
                    <option value={1}>Son 1 saat</option>
                    <option value={6}>Son 6 saat</option>
                    <option value={24}>Son 24 saat</option>
                    <option value={168}>Son 7 gün</option>
                </select>
            </div>

            {/* Delta zaman serisi tablosu */}
            <div className="bg-white rounded-lg shadow-sm p-4">
                <h3 className="text-sm font-semibold text-[#64748B] mb-3">Delta Zaman Serisi</h3>
                {deltas.length === 0 ? (
                    <div className="text-[#94A3B8] text-sm py-4 text-center">Bu aralıkta veri yok</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="border-b border-[#E2E8F0]">
                                    <th className="text-left py-2 px-2 text-[#64748B]">Zaman</th>
                                    <th className="text-right py-2 px-2 text-[#64748B]">Calls</th>
                                    <th className="text-right py-2 px-2 text-[#64748B]">Exec (ms)</th>
                                    <th className="text-right py-2 px-2 text-[#64748B]">Rows</th>
                                    <th className="text-right py-2 px-2 text-[#64748B]">Blks Hit</th>
                                    <th className="text-right py-2 px-2 text-[#64748B]">Blks Read</th>
                                    <th className="text-right py-2 px-2 text-[#64748B]">Temp W</th>
                                </tr>
                            </thead>
                            <tbody>
                                {deltas.map((d: any, i: number) => (
                                    <tr key={i} className="border-b border-[#F1F5F9]">
                                        <td className="py-1.5 px-2">{new Date(d.sample_ts).toLocaleTimeString()}</td>
                                        <td className="py-1.5 px-2 text-right">{Number(d.calls_delta).toLocaleString()}</td>
                                        <td className="py-1.5 px-2 text-right">{Number(d.total_exec_time_ms_delta).toFixed(1)}</td>
                                        <td className="py-1.5 px-2 text-right">{Number(d.rows_delta).toLocaleString()}</td>
                                        <td className="py-1.5 px-2 text-right">{Number(d.shared_blks_hit_delta).toLocaleString()}</td>
                                        <td className="py-1.5 px-2 text-right">{Number(d.shared_blks_read_delta).toLocaleString()}</td>
                                        <td className="py-1.5 px-2 text-right">{Number(d.temp_blks_written_delta).toLocaleString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
