import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import { useToast } from '../components/common/Toast';
import Skeleton from '../components/common/Skeleton';
import { Link, useSearchParams } from 'react-router-dom';

interface Candidate {
    instance_pk: number;
    instance_name: string;
    instance_host: string;
    datname: string;
    dbid: number | null;
    is_active: boolean | null;
    disabled_at: string | null;
    disabled_reason: string | null;
    first_error_at: string;
    last_error_at: string;
    error_count: number;
    latest_alert_id: number | null;
}

interface ActionLog {
    log_id: number;
    instance_pk: number;
    instance_name: string;
    datname: string;
    action: string;
    reason: string | null;
    alert_id: number | null;
    actioned_by: string;
    actioned_at: string;
}

export default function DatabaseCleanup() {
    const qc = useQueryClient();
    const toast = useToast();
    const [params] = useSearchParams();
    const focusAlertId = params.get('alert_id');

    const { data: candidates = [], isLoading } = useQuery<Candidate[]>({
        queryKey: ['db-cleanup-candidates'],
        queryFn: () => apiGet('/database-cleanup/candidates'),
    });

    const { data: log = [] } = useQuery<ActionLog[]>({
        queryKey: ['db-cleanup-log'],
        queryFn: () => apiGet('/database-cleanup/log'),
    });

    const disableMut = useMutation({
        mutationFn: (args: { instance_pk: number; datname: string; reason: string; alert_id: number | null; }) =>
            apiPost('/database-cleanup/disable', args),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['db-cleanup-candidates'] });
            qc.invalidateQueries({ queryKey: ['db-cleanup-log'] });
            qc.invalidateQueries({ queryKey: ['alerts'] });
            toast.success('Database takipten çıkarıldı');
            setConfirmTarget(null);
        },
        onError: (e: any) => toast.error(e.message || 'İşlem başarısız'),
    });

    const reenableMut = useMutation({
        mutationFn: (args: { instance_pk: number; datname: string; }) =>
            apiPost('/database-cleanup/reenable', args),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['db-cleanup-candidates'] });
            qc.invalidateQueries({ queryKey: ['db-cleanup-log'] });
            toast.success('Database takibe geri alındı');
        },
        onError: (e: any) => toast.error(e.message || 'İşlem başarısız'),
    });

    const [confirmTarget, setConfirmTarget] = useState<Candidate | null>(null);
    const [reasonInput, setReasonInput] = useState('');

    if (isLoading) return <Skeleton height="3rem" />;

    return (
        <div className="space-y-6">
            <div className="bg-[#FEF3C7] border border-[#FDE68A] rounded-lg p-3 flex items-start gap-3">
                <span className="text-xl">⚠️</span>
                <div className="text-xs text-[#92400E]">
                    Aşağıdaki database'lere erişilemiyor (job_failed / connection_failure / permission_denied alert mesajlarından tespit edildi).
                    "Takipten Çıkar" ile pgstat artık bu database için yeni delta toplamayı durdurur; geçmiş veri retention politikası ile temizlenir.
                </div>
            </div>

            <div>
                <h2 className="text-sm font-semibold text-[#1E293B] mb-3">
                    🗑️ Sorunlu Database'ler ({candidates.length})
                </h2>
                {candidates.length === 0 ? (
                    <div className="bg-white border border-[#E2E8F0] rounded-lg p-6 text-center text-sm text-[#64748B]">
                        Şu an erişim sorunu olan database yok.
                    </div>
                ) : (
                    <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                        <table className="w-full text-xs">
                            <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                                <tr className="text-left text-[#64748B]">
                                    <th className="px-4 py-2">Instance</th>
                                    <th className="px-4 py-2">Database</th>
                                    <th className="px-4 py-2">Durum</th>
                                    <th className="px-4 py-2">İlk Hata</th>
                                    <th className="px-4 py-2">Son Hata</th>
                                    <th className="px-4 py-2 text-right">Hata Sayısı</th>
                                    <th className="px-4 py-2 text-right">Aksiyon</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#F1F5F9]">
                                {candidates.map(c => {
                                    const highlighted = focusAlertId && String(c.latest_alert_id) === focusAlertId;
                                    return (
                                        <tr key={`${c.instance_pk}:${c.datname}`}
                                            className={`hover:bg-[#F8FAFC] ${highlighted ? 'bg-[#FEF9C3]' : ''}`}>
                                            <td className="px-4 py-2">
                                                <div className="font-medium text-[#1E293B]">{c.instance_name}</div>
                                                <div className="text-[10px] text-[#94A3B8]">{c.instance_host}</div>
                                            </td>
                                            <td className="px-4 py-2 font-mono text-[#475569]">{c.datname}</td>
                                            <td className="px-4 py-2">
                                                {c.is_active === false ? (
                                                    <span className="text-[#94A3B8]">✕ Takipten çıkarıldı</span>
                                                ) : (
                                                    <span className="text-[#DC2626]">● Aktif (hata alıyor)</span>
                                                )}
                                                {c.disabled_at && (
                                                    <div className="text-[10px] text-[#94A3B8]">{new Date(c.disabled_at).toLocaleString('tr-TR')}</div>
                                                )}
                                            </td>
                                            <td className="px-4 py-2 text-[#64748B]">{new Date(c.first_error_at).toLocaleString('tr-TR')}</td>
                                            <td className="px-4 py-2 text-[#64748B]">{new Date(c.last_error_at).toLocaleString('tr-TR')}</td>
                                            <td className="px-4 py-2 text-right font-mono text-[#1E293B]">{c.error_count}</td>
                                            <td className="px-4 py-2 text-right">
                                                {c.latest_alert_id && (
                                                    <Link to={`/alerts/${c.latest_alert_id}`}
                                                        className="text-[#3B82F6] hover:underline mr-2">Alert</Link>
                                                )}
                                                {c.is_active === false ? (
                                                    <button onClick={() => reenableMut.mutate({ instance_pk: c.instance_pk, datname: c.datname })}
                                                        className="text-[#22C55E] hover:underline">Geri Al</button>
                                                ) : (
                                                    <button onClick={() => { setConfirmTarget(c); setReasonInput(''); }}
                                                        className="text-[#DC2626] hover:underline">Takipten Çıkar</button>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Action log */}
            <div>
                <h2 className="text-sm font-semibold text-[#1E293B] mb-3">📜 Aksiyon Geçmişi (son 100)</h2>
                {log.length === 0 ? (
                    <div className="bg-white border border-[#E2E8F0] rounded-lg p-6 text-center text-sm text-[#64748B]">
                        Henüz işlem yok.
                    </div>
                ) : (
                    <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                        <table className="w-full text-xs">
                            <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                                <tr className="text-left text-[#64748B]">
                                    <th className="px-4 py-2">Zaman</th>
                                    <th className="px-4 py-2">Aksiyon</th>
                                    <th className="px-4 py-2">Instance</th>
                                    <th className="px-4 py-2">Database</th>
                                    <th className="px-4 py-2">Sebep</th>
                                    <th className="px-4 py-2">Kullanıcı</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#F1F5F9]">
                                {log.map(l => (
                                    <tr key={l.log_id}>
                                        <td className="px-4 py-2 text-[#64748B]">{new Date(l.actioned_at).toLocaleString('tr-TR')}</td>
                                        <td className="px-4 py-2">
                                            {l.action === 'disabled' && <span className="text-[#DC2626]">✕ Disabled</span>}
                                            {l.action === 're_enabled' && <span className="text-[#22C55E]">✓ Re-enabled</span>}
                                            {l.action === 'note' && <span className="text-[#64748B]">📝 Note</span>}
                                        </td>
                                        <td className="px-4 py-2 text-[#475569]">{l.instance_name}</td>
                                        <td className="px-4 py-2 font-mono text-[#475569]">{l.datname}</td>
                                        <td className="px-4 py-2 text-[#64748B]">{l.reason || '—'}</td>
                                        <td className="px-4 py-2 text-[#94A3B8]">{l.actioned_by}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Onay modal'i */}
            {confirmTarget && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
                        <div className="px-6 py-4 border-b border-[#E2E8F0]">
                            <h2 className="font-semibold text-[#1E293B]">Database'i takipten çıkar</h2>
                        </div>
                        <div className="px-6 py-4 space-y-3 text-sm">
                            <div>
                                <span className="text-[#64748B]">Instance:</span>{' '}
                                <span className="font-medium">{confirmTarget.instance_name}</span>
                            </div>
                            <div>
                                <span className="text-[#64748B]">Database:</span>{' '}
                                <span className="font-mono font-medium">{confirmTarget.datname}</span>
                            </div>
                            <div className="bg-[#FEE2E2] border border-[#FCA5A5] rounded p-3 text-xs text-[#7F1D1D]">
                                ⚠️ Bu database için yeni delta toplama duracak. Geçmiş istatistik
                                verileri kaybolmayacak — retention politikası zamanla temizler.
                                {confirmTarget.latest_alert_id && (
                                    <div className="mt-1">Bu işlem ilgili alert'i otomatik kapatır.</div>
                                )}
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-[#475569] mb-1">Sebep (opsiyonel)</label>
                                <input value={reasonInput} onChange={e => setReasonInput(e.target.value)}
                                    placeholder="Ör: database kalıcı olarak silindi"
                                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                            </div>
                        </div>
                        <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-end gap-2">
                            <button onClick={() => setConfirmTarget(null)}
                                className="px-4 py-2 text-sm text-[#475569]">İptal</button>
                            <button onClick={() => disableMut.mutate({
                                    instance_pk: confirmTarget.instance_pk,
                                    datname: confirmTarget.datname,
                                    reason: reasonInput,
                                    alert_id: confirmTarget.latest_alert_id,
                                })}
                                disabled={disableMut.isPending}
                                className="px-5 py-2 bg-[#DC2626] text-white text-sm rounded-md hover:bg-[#B91C1C] disabled:opacity-50">
                                {disableMut.isPending ? 'İşleniyor...' : 'Takipten Çıkar'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
