import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

/**
 * Instance Sağlık Raporu sayfası.
 * Grafikleri 2'li grid'de gösterir — kompakt tek sayfa rapor.
 */
export default function HealthReport() {
    const { id } = useParams();
    const [days, setDays] = useState(7);

    const { data: report, isLoading } = useQuery({
        queryKey: ['health-report', id, days],
        queryFn: () => apiGet<any>(`/instances/${id}/health-report?days=${days}`),
        enabled: !!id,
    });

    if (isLoading) return <div className="py-12 text-center text-[#94A3B8]">Rapor hazırlanıyor...</div>;
    if (!report) return <div className="py-12 text-center text-red-500">Rapor oluşturulamadı</div>;

    const statusColors: Record<string, string> = {
        ok: 'text-green-600', warning: 'text-amber-600', critical: 'text-red-600', info: 'text-blue-600'
    };
    const statusIcons: Record<string, string> = {
        ok: '✅', warning: '⚠️', critical: '❌', info: 'ℹ️'
    };
    const overallBg: Record<string, string> = {
        healthy: 'bg-green-50 border-green-200', warning: 'bg-amber-50 border-amber-200', critical: 'bg-red-50 border-red-200'
    };

    // Checks'i section'a göre grupla
    const sections: Record<string, any[]> = {};
    report.checks.forEach((c: any) => {
        if (!sections[c.section]) sections[c.section] = [];
        sections[c.section].push(c);
    });

    return (
        <div className="max-w-5xl mx-auto">
            {/* Print-only header */}
            <div className="hidden print:block mb-4">
                <h1 className="text-2xl font-bold">pgstat Sağlık Raporu</h1>
            </div>

            {/* Screen header */}
            <div className="flex items-center justify-between mb-5 print:hidden">
                <div>
                    <Link to={`/cluster/${id}`} className="text-sm text-[#3B82F6] hover:underline">← Instance Detail</Link>
                    <h1 className="text-xl font-bold mt-1">Sağlık Raporu</h1>
                </div>
                <div className="flex items-center gap-3">
                    <select value={days} onChange={e => setDays(Number(e.target.value))}
                        className="border border-[#CBD5E1] rounded px-3 py-1.5 text-sm">
                        <option value={1}>Son 1 gün</option>
                        <option value={3}>Son 3 gün</option>
                        <option value={7}>Son 7 gün</option>
                        <option value={14}>Son 14 gün</option>
                        <option value={30}>Son 30 gün</option>
                    </select>
                    <button onClick={() => window.print()}
                        className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded hover:bg-[#2563EB]">
                        🖨️ Yazdır / PDF
                    </button>
                </div>
            </div>

            {/* Rapor başlığı */}
            <div className={`border rounded-lg p-4 mb-5 ${overallBg[report.overall_status] || 'bg-gray-50 border-gray-200'}`}>
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-bold text-[#1E293B]">{report.display_name}</h2>
                        <p className="text-sm text-[#64748B]">{report.host}:{report.port} · PG{report.pg_major} · {report.is_primary ? 'Primary' : 'Replica'}</p>
                    </div>
                    <div className="text-right">
                        <div className={`text-lg font-bold ${statusColors[report.overall_status] || ''}`}>
                            {report.overall_status === 'healthy' ? '✅ Sağlıklı' : report.overall_status === 'warning' ? '⚠️ Dikkat' : '❌ Kritik'}
                        </div>
                        <p className="text-xs text-[#94A3B8]">
                            {new Date(report.generated_at).toLocaleString('tr-TR')} · Son {report.period_days} gün
                        </p>
                    </div>
                </div>
            </div>

            {/* Checklist */}
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-5 mb-5">
                <h3 className="text-sm font-semibold text-[#64748B] mb-4">Kontrol Listesi</h3>
                <div className="space-y-4">
                    {Object.entries(sections).map(([section, checks]) => (
                        <div key={section}>
                            <h4 className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide mb-2">{section}</h4>
                            <div className="space-y-1">
                                {checks.map((c: any, i: number) => (
                                    <div key={i} className="flex items-center gap-2 text-sm">
                                        <span>{statusIcons[c.status] || '•'}</span>
                                        <span className="text-[#475569] w-48">{c.name}</span>
                                        <span className={`font-mono font-medium ${statusColors[c.status] || ''}`}>{c.value}</span>
                                        {c.threshold && <span className="text-xs text-[#94A3B8] ml-2">(eşik: {c.threshold})</span>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Trend Grafikleri — 2'li grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                {/* TPS Trendi */}
                {report.trends?.tps_daily?.length > 0 && (
                    <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                        <h3 className="text-sm font-semibold text-[#64748B] mb-3">Günlük TPS Trendi</h3>
                        <ResponsiveContainer width="100%" height={180}>
                            <BarChart data={report.trends.tps_daily.map((d: any) => ({
                                day: new Date(d.day).toLocaleDateString('tr-TR', { month: '2-digit', day: '2-digit' }),
                                tps: Number(d.avg_tps),
                            }))}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                                <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                                <YAxis tick={{ fontSize: 10 }} />
                                <Tooltip formatter={(v: number) => [v.toLocaleString(), 'Ort. TPS']} />
                                <Bar dataKey="tps" fill="#3B82F6" radius={[3, 3, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                )}

                {/* Max Bağlantı */}
                {report.trends?.connection_daily?.length > 0 && (
                    <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                        <h3 className="text-sm font-semibold text-[#64748B] mb-3">Günlük Max Bağlantı</h3>
                        <ResponsiveContainer width="100%" height={180}>
                            <LineChart data={report.trends.connection_daily.map((d: any) => ({
                                day: new Date(d.day).toLocaleDateString('tr-TR', { month: '2-digit', day: '2-digit' }),
                                conn: Number(d.max_connections),
                            }))}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                                <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                                <YAxis tick={{ fontSize: 10 }} />
                                <Tooltip formatter={(v: number) => [v.toLocaleString(), 'Max Bağlantı']} />
                                <Line type="monotone" dataKey="conn" stroke="#8B5CF6" strokeWidth={2} dot={{ r: 3 }} />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}

                {/* WAL Üretimi */}
                {report.trends?.wal_daily?.length > 0 && (
                    <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                        <h3 className="text-sm font-semibold text-[#64748B] mb-3">Günlük WAL Üretimi</h3>
                        <ResponsiveContainer width="100%" height={180}>
                            <BarChart data={report.trends.wal_daily.map((d: any) => {
                                const mb = Number(d.wal_mb);
                                return {
                                    day: new Date(d.day).toLocaleDateString('tr-TR', { month: '2-digit', day: '2-digit' }),
                                    wal: mb >= 1024 ? +(mb / 1024).toFixed(2) : +mb.toFixed(1),
                                    unit: mb >= 1024 ? 'GB' : 'MB',
                                };
                            })}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                                <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                                <YAxis tick={{ fontSize: 10 }} />
                                <Tooltip formatter={(v: number, _: any, entry: any) => [`${v} ${entry.payload.unit}`, 'WAL']} />
                                <Bar dataKey="wal" fill="#F59E0B" radius={[3, 3, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                )}

                {/* CPU Proxy (PG14+ active_time/session_time) — veri varsa göster */}
                {report.trends?.cpu_proxy_daily?.length > 0 && (
                    <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                        <h3 className="text-sm font-semibold text-[#64748B] mb-1">CPU Proxy — Active Time %</h3>
                        <p className="text-xs text-[#94A3B8] mb-2">active_time / session_time (PG14+)</p>
                        <ResponsiveContainer width="100%" height={160}>
                            <LineChart data={report.trends.cpu_proxy_daily.map((d: any) => ({
                                day: new Date(d.day).toLocaleDateString('tr-TR', { month: '2-digit', day: '2-digit' }),
                                pct: Number(d.active_pct) || 0,
                            }))}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                                <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                                <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} unit="%" />
                                <Tooltip formatter={(v: number) => [`${v}%`, 'Active %']} />
                                <Line type="monotone" dataKey="pct" stroke="#EF4444" strokeWidth={2} dot={{ r: 3 }} />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </div>

            {/* Top Bloat Tabloları */}
            {report.trends?.bloat_top?.length > 0 && (
                <div className="bg-white border border-[#E2E8F0] rounded-lg p-5 mb-5">
                    <h3 className="text-sm font-semibold text-[#64748B] mb-3">Top Bloat Tabloları</h3>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-[#E2E8F0] text-[#64748B]">
                                <th className="text-left py-2">Tablo</th>
                                <th className="text-right py-2">Dead %</th>
                                <th className="text-right py-2">Dead Tup</th>
                                <th className="text-right py-2">Live Tup</th>
                            </tr>
                        </thead>
                        <tbody>
                            {report.trends.bloat_top.map((r: any, i: number) => (
                                <tr key={i} className="border-b border-[#F1F5F9]">
                                    <td className="py-1.5 font-mono text-xs">{r.relation}</td>
                                    <td className={`text-right font-mono ${Number(r.dead_pct) > 20 ? 'text-red-600 font-semibold' : 'text-amber-600'}`}>
                                        {Number(r.dead_pct).toFixed(1)}%
                                    </td>
                                    <td className="text-right font-mono text-[#64748B]">{Number(r.dead_tup).toLocaleString()}</td>
                                    <td className="text-right font-mono text-[#64748B]">{Number(r.live_tup).toLocaleString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* PG Ayarları */}
            {report.settings?.length > 0 && (
                <div className="bg-white border border-[#E2E8F0] rounded-lg p-5 mb-5">
                    <h3 className="text-sm font-semibold text-[#64748B] mb-3">PG Yapılandırması</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                        {report.settings.slice(0, 16).map((s: any, i: number) => (
                            <div key={i} className="bg-[#F8FAFC] rounded px-2 py-1.5">
                                <span className="text-[#64748B]">{s.setting_name}: </span>
                                <span className="font-mono font-medium">{s.setting_value}{s.unit ? ' ' + s.unit : ''}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Print footer */}
            <div className="text-xs text-[#94A3B8] text-center mt-8 print:mt-4">
                pgstat Health Report · {report.display_name} · {new Date(report.generated_at).toLocaleString('tr-TR')} · Son {report.period_days} gün
            </div>
        </div>
    );
}
