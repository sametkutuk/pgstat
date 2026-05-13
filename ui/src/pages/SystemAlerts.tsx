import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, apiDelete } from '../api/client';
import { useToast } from '../components/common/Toast';
import Badge from '../components/common/Badge';
import Skeleton from '../components/common/Skeleton';

interface SystemAlertConfig {
    alert_code: string;
    label: string;
    category: string;
    thresholdUnit: string | null;
    thresholdDesc: string | null;
    windowDesc: string | null;
    severity: string;
    description: string;
    global: { is_enabled: boolean; threshold_value: number | null; cooldown_minutes: number; window_minutes: number | null };
    overrides: { instance_pk: number; display_name: string; is_enabled: boolean; threshold_value: number | null; cooldown_minutes: number; window_minutes: number | null }[];
}

interface Instance { instance_pk: number; display_name: string; }

const CATEGORIES: { key: string; label: string; icon: string }[] = [
    { key: 'connectivity', label: 'Bağlantı', icon: '🔌' },
    { key: 'collection', label: 'Veri Toplama', icon: '📊' },
    { key: 'performance', label: 'Performans', icon: '⚡' },
    { key: 'index_table', label: 'Index / Tablo', icon: '🗄️' },
    { key: 'replication', label: 'Replikasyon', icon: '🔄' },
    { key: 'job', label: 'Job', icon: '🔧' },
];

export default function SystemAlerts() {
    const toast = useToast();
    const qc = useQueryClient();
    const [overrideModal, setOverrideModal] = useState<{ alertCode: string; label: string; windowDesc: string | null } | null>(null);

    const { data: configs = [], isLoading } = useQuery<SystemAlertConfig[]>({
        queryKey: ['system-alert-config'],
        queryFn: () => apiGet('/system-alerts/config'),
    });

    const { data: instances = [] } = useQuery<Instance[]>({
        queryKey: ['instances-list'],
        queryFn: () => apiGet<any[]>('/instances').then(r => r.map((i: any) => ({ instance_pk: i.instance_pk, display_name: i.display_name }))),
    });

    const toggleMut = useMutation({
        mutationFn: ({ code, enabled, threshold, cooldown, window }: { code: string; enabled: boolean; threshold: number | null; cooldown: number; window: number | null }) =>
            apiPut(`/system-alerts/config/${code}`, { is_enabled: enabled, threshold_value: threshold, cooldown_minutes: cooldown, window_minutes: window }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['system-alert-config'] }); toast.success('Güncellendi (60sn içinde etkili)'); },
        onError: () => toast.error('Güncelleme başarısız'),
    });

    const deleteOverrideMut = useMutation({
        mutationFn: ({ code, instancePk }: { code: string; instancePk: number }) =>
            apiDelete(`/system-alerts/config/${code}/instances/${instancePk}`),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['system-alert-config'] }); toast.success('Override silindi'); },
    });

    if (isLoading) return (
        <div className="space-y-3">
            <Skeleton height="3rem" />
            <Skeleton height="3rem" />
            <Skeleton height="3rem" />
            <Skeleton height="3rem" />
            <Skeleton height="3rem" />
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="bg-[#F0F9FF] border border-[#BAE6FD] rounded-lg p-3 flex items-start gap-3">
                <span className="text-xl">🛡️</span>
                <div className="text-xs text-[#0369A1]">
                    Sistem alert'leri otomatik çalışır. Global olarak kapatabilir veya belirli instance'larda devre dışı bırakabilirsiniz.
                    Değişiklikler 60 saniye içinde etkili olur.
                </div>
            </div>

            {CATEGORIES.map(cat => {
                const items = configs.filter(c => c.category === cat.key);
                if (items.length === 0) return null;
                return (
                    <div key={cat.key}>
                        <h2 className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide mb-3">
                            {cat.icon} {cat.label}
                        </h2>
                        <div className="space-y-2">
                            {items.map(cfg => (
                                <AlertConfigCard
                                    key={cfg.alert_code}
                                    config={cfg}
                                    isJob={cat.key === 'job'}
                                    onToggle={(enabled) => toggleMut.mutate({
                                        code: cfg.alert_code,
                                        enabled,
                                        threshold: cfg.global.threshold_value,
                                        cooldown: cfg.global.cooldown_minutes,
                                        window: cfg.global.window_minutes,
                                    })}
                                    onThresholdChange={(val) => toggleMut.mutate({
                                        code: cfg.alert_code,
                                        enabled: cfg.global.is_enabled,
                                        threshold: val,
                                        cooldown: cfg.global.cooldown_minutes,
                                        window: cfg.global.window_minutes,
                                    })}
                                    onCooldownChange={(val) => toggleMut.mutate({
                                        code: cfg.alert_code,
                                        enabled: cfg.global.is_enabled,
                                        threshold: cfg.global.threshold_value,
                                        cooldown: val,
                                        window: cfg.global.window_minutes,
                                    })}
                                    onWindowChange={(val) => toggleMut.mutate({
                                        code: cfg.alert_code,
                                        enabled: cfg.global.is_enabled,
                                        threshold: cfg.global.threshold_value,
                                        cooldown: cfg.global.cooldown_minutes,
                                        window: val,
                                    })}
                                    onAddOverride={() => setOverrideModal({ alertCode: cfg.alert_code, label: cfg.label, windowDesc: cfg.windowDesc })}
                                    onDeleteOverride={(instancePk) => deleteOverrideMut.mutate({ code: cfg.alert_code, instancePk })}
                                />
                            ))}
                        </div>
                    </div>
                );
            })}

            {overrideModal && (
                <OverrideModal
                    alertCode={overrideModal.alertCode}
                    label={overrideModal.label}
                    windowDesc={overrideModal.windowDesc}
                    instances={instances}
                    onClose={() => setOverrideModal(null)}
                />
            )}
        </div>
    );
}

function AlertConfigCard({ config, isJob, onToggle, onThresholdChange, onCooldownChange, onWindowChange, onAddOverride, onDeleteOverride }: {
    config: SystemAlertConfig;
    isJob: boolean;
    onToggle: (enabled: boolean) => void;
    onThresholdChange: (val: number | null) => void;
    onCooldownChange: (val: number) => void;
    onWindowChange: (val: number | null) => void;
    onAddOverride: () => void;
    onDeleteOverride: (instancePk: number) => void;
}) {
    const [editThreshold, setEditThreshold] = useState(false);
    const [editCooldown, setEditCooldown] = useState(false);
    const [editWindow, setEditWindow] = useState(false);
    const [thresholdInput, setThresholdInput] = useState(String(config.global.threshold_value ?? ''));
    const [cooldownInput, setCooldownInput] = useState(String(config.global.cooldown_minutes));
    const [windowInput, setWindowInput] = useState(String(config.global.window_minutes ?? ''));

    return (
        <div className={`bg-white border rounded-lg p-4 transition-colors ${config.global.is_enabled ? 'border-[#E2E8F0]' : 'border-[#E2E8F0] opacity-60'}`}>
            <div className="flex items-center gap-3">
                {/* Toggle */}
                <button onClick={() => onToggle(!config.global.is_enabled)}
                    className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${config.global.is_enabled ? 'bg-[#22C55E]' : 'bg-[#CBD5E1]'}`}>
                    <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${config.global.is_enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                </button>

                {/* İçerik */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-[#1E293B]">{config.label}</span>
                        <Badge value={config.severity} />
                        <span className="text-[10px] text-[#94A3B8] font-mono">{config.alert_code}</span>
                    </div>
                    <div className="text-xs text-[#64748B] mt-0.5">{config.description}</div>
                </div>

                {/* Eşik */}
                {config.thresholdUnit && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {editThreshold ? (
                            <form onSubmit={(e) => { e.preventDefault(); onThresholdChange(thresholdInput ? Number(thresholdInput) : null); setEditThreshold(false); }}
                                className="flex items-center gap-1">
                                <input value={thresholdInput} onChange={e => setThresholdInput(e.target.value)}
                                    className="w-16 border border-[#CBD5E1] rounded px-2 py-1 text-xs" autoFocus />
                                <span className="text-[10px] text-[#94A3B8]">{config.thresholdUnit}</span>
                                <button type="submit" className="text-xs text-[#22C55E]">✓</button>
                                <button type="button" onClick={() => setEditThreshold(false)} className="text-xs text-[#94A3B8]">✕</button>
                            </form>
                        ) : (
                            <button onClick={() => { setThresholdInput(String(config.global.threshold_value ?? '')); setEditThreshold(true); }}
                                className="text-xs bg-[#F1F5F9] px-2 py-1 rounded hover:bg-[#E2E8F0]"
                                title={config.thresholdDesc || ''}>
                                Eşik: {config.global.threshold_value ?? '—'} {config.thresholdUnit}
                            </button>
                        )}
                    </div>
                )}

                {/* Eval penceresi */}
                {config.windowDesc && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {editWindow ? (
                            <form onSubmit={(e) => { e.preventDefault(); onWindowChange(windowInput ? Number(windowInput) : null); setEditWindow(false); }}
                                className="flex items-center gap-1">
                                <input value={windowInput} onChange={e => setWindowInput(e.target.value)}
                                    className="w-14 border border-[#CBD5E1] rounded px-2 py-1 text-xs" autoFocus />
                                <span className="text-[10px] text-[#94A3B8]">dk</span>
                                <button type="submit" className="text-xs text-[#22C55E]">✓</button>
                                <button type="button" onClick={() => setEditWindow(false)} className="text-xs text-[#94A3B8]">✕</button>
                            </form>
                        ) : (
                            <button onClick={() => { setWindowInput(String(config.global.window_minutes ?? '')); setEditWindow(true); }}
                                className="text-xs bg-[#FEF3C7] px-2 py-1 rounded hover:bg-[#FDE68A]"
                                title={config.windowDesc}>
                                ⏲ Pencere: {config.global.window_minutes ?? '—'}dk
                            </button>
                        )}
                    </div>
                )}

                {/* Cooldown */}
                <div className="flex-shrink-0">
                    {editCooldown ? (
                        <form onSubmit={(e) => { e.preventDefault(); onCooldownChange(Number(cooldownInput) || 60); setEditCooldown(false); }}
                            className="flex items-center gap-1">
                            <input value={cooldownInput} onChange={e => setCooldownInput(e.target.value)}
                                className="w-12 border border-[#CBD5E1] rounded px-2 py-1 text-xs" autoFocus />
                            <span className="text-[10px] text-[#94A3B8]">dk</span>
                            <button type="submit" className="text-xs text-[#22C55E]">✓</button>
                            <button type="button" onClick={() => setEditCooldown(false)} className="text-xs text-[#94A3B8]">✕</button>
                        </form>
                    ) : (
                        <button onClick={() => { setCooldownInput(String(config.global.cooldown_minutes)); setEditCooldown(true); }}
                            className="text-xs bg-[#F1F5F9] px-2 py-1 rounded hover:bg-[#E2E8F0]"
                            title="Bildirim tekrar süresi (dakika)">
                            ⏱ {config.global.cooldown_minutes}dk
                        </button>
                    )}
                </div>

                {/* Override ekle (job kategorisinde yok) */}
                {!isJob && (
                    <button onClick={onAddOverride}
                        className="text-xs text-[#3B82F6] hover:text-[#2563EB] flex-shrink-0">
                        + Override
                    </button>
                )}
            </div>

            {/* Instance override'lar */}
            {config.overrides.length > 0 && (
                <div className="mt-3 pl-13 space-y-1">
                    {config.overrides.map(o => (
                        <div key={o.instance_pk} className="flex items-center gap-2 text-xs bg-[#F8FAFC] rounded px-3 py-1.5">
                            <span className={`w-2 h-2 rounded-full ${o.is_enabled ? 'bg-green-500' : 'bg-red-500'}`} />
                            <span className="text-[#475569] font-medium">{o.display_name}</span>
                            <span className="text-[#94A3B8]">
                                {o.is_enabled ? '✓ Aktif' : '✕ Devre dışı'}
                                {o.threshold_value != null && ` · Eşik: ${o.threshold_value}`}
                                {o.window_minutes != null && ` · Pencere: ${o.window_minutes}dk`}
                            </span>
                            <button onClick={() => onDeleteOverride(o.instance_pk)}
                                className="ml-auto text-[#DC2626] hover:text-[#B91C1C]">Sil</button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function OverrideModal({ alertCode, label, windowDesc, instances, onClose }: {
    alertCode: string; label: string; windowDesc: string | null; instances: Instance[]; onClose: () => void;
}) {
    const toast = useToast();
    const qc = useQueryClient();
    const [instancePk, setInstancePk] = useState<number | ''>('');
    const [enabled, setEnabled] = useState(false);
    const [threshold, setThreshold] = useState('');
    const [cooldown, setCooldown] = useState('60');
    const [windowMin, setWindowMin] = useState('');

    const saveMut = useMutation({
        mutationFn: () => apiPut(`/system-alerts/config/${alertCode}/instances/${instancePk}`, {
            is_enabled: enabled,
            threshold_value: threshold ? Number(threshold) : null,
            cooldown_minutes: Number(cooldown) || 60,
            window_minutes: windowMin ? Number(windowMin) : null,
        }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['system-alert-config'] }); toast.success('Override kaydedildi'); onClose(); },
        onError: () => toast.error('Kayıt başarısız'),
    });

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
                <div className="px-6 py-4 border-b border-[#E2E8F0]">
                    <h2 className="font-semibold text-[#1E293B]">Instance Override: {label}</h2>
                    <p className="text-xs text-[#64748B] mt-1">Bu instance için alert davranışını özelleştir</p>
                </div>
                <div className="px-6 py-4 space-y-4">
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Instance *</label>
                        <select value={instancePk} onChange={e => setInstancePk(Number(e.target.value) || '')}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                            <option value="">-- Seçin --</option>
                            {instances.map(i => <option key={i.instance_pk} value={i.instance_pk}>{i.display_name}</option>)}
                        </select>
                    </div>
                    <div className="flex items-center gap-3">
                        <label className="text-xs font-medium text-[#475569]">Alert durumu:</label>
                        <button onClick={() => setEnabled(!enabled)}
                            className={`px-3 py-1 text-xs rounded ${enabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {enabled ? '✓ Aktif' : '✕ Devre dışı'}
                        </button>
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Eşik (opsiyonel, boş = global)</label>
                        <input value={threshold} onChange={e => setThreshold(e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" placeholder="Global default kullan" />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Cooldown (dk)</label>
                        <input value={cooldown} onChange={e => setCooldown(e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                    {windowDesc && (
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">Eval penceresi (dk, boş = global)</label>
                            <input value={windowMin} onChange={e => setWindowMin(e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" placeholder={windowDesc} />
                        </div>
                    )}
                </div>
                <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-end gap-2">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-[#475569]">İptal</button>
                    <button onClick={() => saveMut.mutate()} disabled={!instancePk || saveMut.isPending}
                        className="px-5 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB] disabled:opacity-50">
                        {saveMut.isPending ? 'Kaydediliyor...' : 'Kaydet'}
                    </button>
                </div>
            </div>
        </div>
    );
}
