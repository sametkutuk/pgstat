// Gonderilen rapor tarihce sayfasi.
// Liste (tablo) + tikla detay (modal). Filtre: tip (gunluk/haftalik).
// Manuel silme destekli (DELETE /api/reports/history/:id).

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet, apiDelete } from '../api/client';
import DataTable from '../components/common/DataTable';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import LastUpdated from '../components/common/LastUpdated';
import InfoTip from '../components/common/InfoTip';
import PrintButton from '../components/common/PrintButton';
import Skeleton, { SkeletonTable } from '../components/common/Skeleton';
import EmptyState from '../components/common/EmptyState';
import { useToast } from '../components/common/Toast';

interface ReportListItem {
    report_id: number;
    report_type: 'daily' | 'weekly';
    generated_at: string;
    title: string;
    sent_status: 'sent' | 'failed' | 'partial';
    channels_count: number;
    recipients_json: any;
    body_length: number;
    error_message: string | null;
}

interface ReportDetail extends ReportListItem {
    body: string;
}

export default function ReportHistory() {
    const [typeFilter, setTypeFilter] = useState<'' | 'daily' | 'weekly'>('');
    const [openId, setOpenId] = useState<number | null>(null);
    const qc = useQueryClient();
    const toast = useToast();

    const params = new URLSearchParams();
    if (typeFilter) params.set('type', typeFilter);
    params.set('limit', '200');

    const { data, isLoading, dataUpdatedAt } = useQuery({
        queryKey: ['report-history', typeFilter],
        queryFn: () => apiGet<ReportListItem[]>(`/reports/history?${params.toString()}`),
    });

    const deleteMut = useMutation({
        mutationFn: (id: number) => apiDelete(`/reports/history/${id}`),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['report-history'] });
            toast.success('Rapor silindi');
        },
        onError: () => toast.error('Silme başarısız'),
    });

    const columns = [
        {
            key: 'report_type', header: 'Tip',
            render: (r: ReportListItem) => (
                <span className={r.report_type === 'daily'
                    ? 'text-blue-600 font-medium'
                    : 'text-purple-600 font-medium'}>
                    {r.report_type === 'daily' ? '📊 Günlük' : '📈 Haftalık'}
                </span>
            )
        },
        { key: 'title', header: 'Başlık' },
        {
            key: 'sent_status', header: 'Durum',
            render: (r: ReportListItem) => <Badge value={r.sent_status} />
        },
        {
            key: 'channels_count', header: 'Kanal',
            className: 'text-right',
            render: (r: ReportListItem) => `${r.channels_count} kanal`
        },
        {
            key: 'generated_at', header: 'Gönderim',
            render: (r: ReportListItem) => <TimeAgo date={r.generated_at} />
        },
        {
            key: 'actions', header: '', render: (r: ReportListItem) => (
                <div className="flex gap-1">
                    <button
                        onClick={(e) => { e.stopPropagation(); setOpenId(r.report_id); }}
                        className="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100">
                        Aç
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            if (confirm('Bu raporu silmek istediğinize emin misiniz?')) {
                                deleteMut.mutate(r.report_id);
                            }
                        }}
                        className="px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100">
                        Sil
                    </button>
                </div>
            )
        },
    ];

    return (
        <div>
            <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2">
                    <h1 className="text-xl font-bold">Rapor Tarihçesi</h1>
                    <InfoTip text="Otomatik gönderilen günlük ve haftalık özet raporlar burada saklanır. Saklama süresi (retention) Ayarlar > Raporlar sekmesinden değiştirilebilir; eski raporlar UTC 02:00'da otomatik temizlenir." />
                </div>
                <div className="flex items-center gap-3">
                    <Link to="/settings" className="text-sm text-[#3B82F6] hover:underline print:hidden">
                        ⚙ Ayarlar
                    </Link>
                    <LastUpdated dataUpdatedAt={dataUpdatedAt} />
                    <PrintButton title="Rapor Tarihçesi" />
                </div>
            </div>

            <div className="flex gap-2 mb-4">
                {(['', 'daily', 'weekly'] as const).map((t) => (
                    <button key={t || 'all'} onClick={() => setTypeFilter(t)}
                        className={`px-3 py-1.5 text-sm rounded ${typeFilter === t
                            ? 'bg-[#3B82F6] text-white'
                            : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:bg-[#F8FAFC]'}`}>
                        {t === '' ? 'Tümü' : t === 'daily' ? 'Günlük' : 'Haftalık'}
                    </button>
                ))}
            </div>

            <div className="bg-white rounded-lg shadow-sm p-4">
                {isLoading
                    ? <SkeletonTable rows={5} cols={5} />
                    : (data && data.length === 0)
                        ? <EmptyState icon="📜" title="Henüz rapor yok" description="Otomatik günlük/haftalık raporlar Settings → Raporlar bölümünden yapılandırılır." />
                        : <DataTable columns={columns} data={data || []} />}
            </div>

            {openId !== null && <ReportDetailModal id={openId} onClose={() => setOpenId(null)} />}
        </div>
    );
}

function ReportDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
    const { data, isLoading } = useQuery({
        queryKey: ['report-detail', id],
        queryFn: () => apiGet<ReportDetail>(`/reports/history/${id}`),
    });

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
                <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-start justify-between">
                    <div>
                        <h2 className="font-semibold text-[#1E293B]">{data?.title || 'Rapor'}</h2>
                        {data && (
                            <p className="text-xs text-[#64748B] mt-1">
                                {data.report_type === 'daily' ? '📊 Günlük' : '📈 Haftalık'}
                                {' · '}
                                {new Date(data.generated_at).toLocaleString('tr-TR')}
                                {' · '}
                                <Badge value={data.sent_status} />
                                {' · '}
                                {data.channels_count} kanal
                            </p>
                        )}
                    </div>
                    <button onClick={onClose} className="text-[#94A3B8] hover:text-[#1E293B] text-xl">
                        ×
                    </button>
                </div>
                <div className="px-6 py-4 overflow-y-auto flex-1">
                    {isLoading
                        ? <div className="space-y-3"><Skeleton width="60%" height="1rem" /><Skeleton height="0.875rem" /><Skeleton height="0.875rem" /><Skeleton height="0.875rem" /></div>
                        : (
                            <>
                                {data?.error_message && (
                                    <div className="bg-red-50 border border-red-200 rounded px-3 py-2 mb-3 text-xs text-red-700">
                                        <strong>Hata:</strong> {data.error_message}
                                    </div>
                                )}
                                {data?.recipients_json && Array.isArray(data.recipients_json) && data.recipients_json.length > 0 && (
                                    <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded px-3 py-2 mb-3 text-xs">
                                        <strong className="text-[#475569]">Kanal sonuçları:</strong>
                                        <ul className="mt-1 space-y-0.5">
                                            {data.recipients_json.map((r: any, i: number) => (
                                                <li key={i} className="font-mono">
                                                    #{r.channel_id} ({r.channel_type}) →{' '}
                                                    <span className={r.status === 'sent' ? 'text-green-600' : 'text-red-600'}>
                                                        {r.status}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                <pre className="text-sm text-[#334155] whitespace-pre-wrap font-sans bg-[#F8FAFC] rounded p-4">
                                    {data?.body || '(boş)'}
                                </pre>
                            </>
                        )}
                </div>
                <div className="px-6 py-3 border-t border-[#E2E8F0] flex justify-end">
                    <button onClick={onClose}
                        className="px-4 py-2 text-sm text-[#475569] hover:text-[#1E293B]">
                        Kapat
                    </button>
                </div>
            </div>
        </div>
    );
}
