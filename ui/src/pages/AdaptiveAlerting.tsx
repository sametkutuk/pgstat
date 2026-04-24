import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from '../api/client';
import { useToast } from '../components/common/Toast';

// =========================================================================
// Tipler
// =========================================================================

interface Instance {
    instance_pk: number;
    display_name: string;
}

interface Overview {
    baselines: { instance_count: number; total_baselines: number; latest_update: string | null };
    active_snoozes: number;
    enabled_maintenance: number;
    enabled_channels: number;
}

interface Snooze {
    snooze_id: number;
    rule_id: number | null;
    rule_name: string | null;
    instance_pk: number | null;
    instance_name: string | null;
    metric_key: string | null;
    snooze_until: string;
    snooze_reason: string | null;
    created_by: string;
    created_at: string;
}

interface MaintenanceWindow {
    window_id: number;
    window_name: string;
    description: string | null;
    instance_pks: number[] | null;
    day_of_week: number[] | null;
    start_time: string;
    end_time: string;
    timezone: string;
    suppress_all_alerts: boolean;
    suppress_severity: string[] | null;
    is_enabled: boolean;
}

interface NotificationChannel {
    channel_id: number;
    channel_name: string;
    channel_type: 'email' | 'slack' | 'pagerduty' | 'teams' | 'webhook';
    config: any;
    min_severity: string | null;
    is_enabled: boolean;
}

interface AlertRuleLite {
    rule_id: number;
    rule_name: string;
}

// =========================================================================
// Ana Sayfa
// =========================================================================

export default function AdaptiveAlerting() {
    const [tab, setTab] = useState<'overview' | 'baselines' | 'snooze' | 'maintenance' | 'channels'>('overview');

    const tabs = [
        { k: 'overview',    l: '📊 Genel Bakış' },
        { k: 'baselines',   l: '📈 Baseline Profiller' },
        { k: 'snooze',      l: '🔕 Snooze Yönetimi' },
        { k: 'maintenance', l: '🔧 Bakım Pencereleri' },
        { k: 'channels',    l: '📢 Bildirim Kanalları' },
    ];

    return (
        <div>
            <div className="flex items-center justify-between mb-5">
                <div>
                    <h1 className="text-xl font-bold">Adaptive Alerting</h1>
                    <p className="text-sm text-[#64748B] mt-1">
                        Otomatik baseline profilleme ve akıllı alert yönetimi
                    </p>
                </div>
            </div>

            <div className="flex gap-1 mb-4 border-b border-[#E2E8F0]">
                {tabs.map((t) => (
                    <button key={t.k} onClick={() => setTab(t.k as any)}
                        className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.k ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-[#64748B] hover:text-[#1E293B]'}`}>
                        {t.l}
                    </button>
                ))}
            </div>

            {tab === 'overview'    && <OverviewPanel />}
            {tab === 'baselines'   && <BaselinesPanel />}
            {tab === 'snooze'      && <SnoozePanel />}
            {tab === 'maintenance' && <MaintenancePanel />}
            {tab === 'channels'    && <ChannelsPanel />}
        </div>
    );
}

// =========================================================================
// Genel Bakış
// =========================================================================

function OverviewPanel() {
    const { data: overview } = useQuery<Overview>({
        queryKey: ['adaptive-overview'],
        queryFn: () => apiGet('/adaptive-alerting/overview'),
    });

    const cards = [
        { label: 'Baseline Olan Instance',   value: overview?.baselines?.instance_count ?? 0 },
        { label: 'Toplam Baseline Satırı',   value: overview?.baselines?.total_baselines ?? 0 },
        { label: 'Aktif Snooze',             value: overview?.active_snoozes ?? 0 },
        { label: 'Aktif Bakım Penceresi',    value: overview?.enabled_maintenance ?? 0 },
        { label: 'Aktif Bildirim Kanalı',    value: overview?.enabled_channels ?? 0 },
    ];

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {cards.map(c => (
                    <div key={c.label} className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                        <div className="text-xs text-[#64748B]">{c.label}</div>
                        <div className="text-2xl font-bold text-[#1E293B] mt-1">{c.value}</div>
                    </div>
                ))}
            </div>

            {overview?.baselines?.latest_update && (
                <div className="text-xs text-[#64748B]">
                    Son baseline güncellemesi: {new Date(overview.baselines.latest_update).toLocaleString('tr-TR')}
                </div>
            )}

            <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-lg p-4">
                <h3 className="text-sm font-semibold text-[#1E40AF] mb-2">Adaptive Alerting Nasıl Çalışır?</h3>
                <ul className="text-sm text-[#3B82F6] space-y-1 list-disc list-inside ml-2">
                    <li>Gece 02:00 UTC'de collector son 28 gün verinizden baseline hesaplar</li>
                    <li>Her metrik için saatlik profil (0–23) + genel profil üretir</li>
                    <li>Alert kurallarında <b>evaluation_type = adaptive</b> seçerseniz eşik baseline'dan otomatik gelir</li>
                    <li>Sensitivity: <b>low</b>=avg+3σ, <b>medium</b>=avg+2σ, <b>high</b>=avg+1.5σ</li>
                    <li>Snooze ve bakım pencerelerinde alert tetiklenmez (collector her değerlendirmede kontrol eder)</li>
                </ul>
            </div>
        </div>
    );
}

// =========================================================================
// Baseline Profiller
// =========================================================================

function BaselinesPanel() {
    const toast = useToast();
    const qc = useQueryClient();

    const { data: instances = [] } = useQuery<Instance[]>({
        queryKey: ['instances-list'],
        queryFn: () => apiGet<any[]>('/instances').then(r => r.map((i: any) => ({ instance_pk: i.instance_pk, display_name: i.display_name }))),
    });

    const [selectedInstance, setSelectedInstance] = useState<number | null>(null);

    const { data: baselines = [] } = useQuery<any[]>({
        queryKey: ['baselines-list', selectedInstance],
        queryFn: () => apiGet(`/adaptive-alerting/instances/${selectedInstance}/baseline`),
        enabled: !!selectedInstance,
    });

    const invalidateMut = useMutation({
        mutationFn: ({ pk, reason }: { pk: number; reason: string }) =>
            apiPost(`/adaptive-alerting/instances/${pk}/baseline/invalidate`, { reason }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['baselines-list'] });
            qc.invalidateQueries({ queryKey: ['adaptive-overview'] });
            toast.success('Baseline sıfırlandı. Yeni baseline 7 gün içinde yeniden oluşacak.');
        },
        onError: () => toast.error('Sıfırlama başarısız'),
    });

    const handleInvalidate = () => {
        if (!selectedInstance) return;
        const reason = prompt('Baseline sıfırlama sebebi:');
        if (!reason) return;
        invalidateMut.mutate({ pk: selectedInstance, reason });
    };

    return (
        <div className="space-y-4">
            <div className="flex items-end gap-3">
                <div className="flex-1">
                    <label className="block text-xs font-medium text-[#475569] mb-1">Instance</label>
                    <select value={selectedInstance || ''}
                        onChange={(e) => setSelectedInstance(Number(e.target.value) || null)}
                        className="w-full md:w-96 px-3 py-2 border border-[#CBD5E1] rounded-md text-sm">
                        <option value="">-- Instance seçin --</option>
                        {instances.map(i => (
                            <option key={i.instance_pk} value={i.instance_pk}>{i.display_name}</option>
                        ))}
                    </select>
                </div>
                {selectedInstance && (
                    <button onClick={handleInvalidate}
                        className="px-4 py-2 bg-[#FEE2E2] text-[#DC2626] text-sm rounded hover:bg-[#FECACA]">
                        Baseline'ı Sıfırla
                    </button>
                )}
            </div>

            {selectedInstance && baselines.length === 0 && (
                <div className="text-center py-12 text-[#64748B] text-sm bg-white rounded-lg border border-[#E2E8F0]">
                    <div className="text-2xl mb-2">⏳</div>
                    <div>Bu instance için henüz baseline yok.</div>
                    <div className="text-xs mt-1">İlk hesaplama gece 02:00 UTC'de çalışır. 28 gün veri birikene kadar baseline'lar zayıf olabilir.</div>
                </div>
            )}

            {selectedInstance && baselines.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {baselines.map((b: any) => (
                        <div key={b.metric_key} className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                            <div className="text-sm font-medium text-[#1E293B]">{b.metric_key}</div>
                            <div className="text-xs text-[#64748B] mt-1">
                                {b.hourly_count > 0 ? `${b.hourly_count} saatlik profil` : 'Sadece genel profil'}
                                {' · '}
                                örneklem ~{Math.round(Number(b.avg_sample_count || 0))}
                            </div>
                            <div className="text-xs text-[#94A3B8] mt-2">
                                Güncelleme: {new Date(b.updated_at).toLocaleString('tr-TR')}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// =========================================================================
// Snooze Yönetimi
// =========================================================================

function SnoozePanel() {
    const toast = useToast();
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);

    const { data: snoozes = [] } = useQuery<Snooze[]>({
        queryKey: ['snoozes'],
        queryFn: () => apiGet('/adaptive-alerting/snooze'),
    });

    const deleteMut = useMutation({
        mutationFn: (id: number) => apiDelete(`/adaptive-alerting/snooze/${id}`),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['snoozes'] });
            toast.success('Snooze kaldırıldı');
        },
    });

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <p className="text-sm text-[#64748B]">
                    Geçici olarak alert'leri sustur. Süre dolunca otomatik kalkar.
                </p>
                <button onClick={() => setShowForm(true)}
                    className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB]">
                    + Snooze Ekle
                </button>
            </div>

            {snoozes.length === 0 ? (
                <div className="text-center py-12 text-[#64748B] text-sm bg-white rounded-lg border border-[#E2E8F0]">
                    Aktif snooze yok.
                </div>
            ) : (
                <div className="bg-white border border-[#E2E8F0] rounded-lg divide-y divide-[#E2E8F0]">
                    {snoozes.map(s => {
                        const remaining = Math.max(0, new Date(s.snooze_until).getTime() - Date.now());
                        const mins = Math.floor(remaining / 60000);
                        const remainText = mins >= 60 ? `${Math.floor(mins / 60)}s ${mins % 60}dk` : `${mins}dk`;
                        return (
                            <div key={s.snooze_id} className="px-4 py-3 flex items-center gap-3">
                                <div className="flex-1">
                                    <div className="text-sm font-medium text-[#1E293B]">
                                        {s.rule_name || 'Tüm kurallar'}
                                        {s.instance_name && <span className="text-[#64748B] font-normal"> · {s.instance_name}</span>}
                                        {s.metric_key && <span className="text-[#64748B] font-normal"> · {s.metric_key}</span>}
                                    </div>
                                    {s.snooze_reason && (
                                        <div className="text-xs text-[#64748B] mt-0.5">{s.snooze_reason}</div>
                                    )}
                                    <div className="text-xs text-[#94A3B8] mt-0.5">
                                        Kalan: <span className="font-medium text-[#0284C7]">{remainText}</span>
                                        {' · '}oluşturan: {s.created_by}
                                    </div>
                                </div>
                                <button onClick={() => deleteMut.mutate(s.snooze_id)}
                                    className="text-xs px-2.5 py-1 bg-[#FEE2E2] text-[#DC2626] rounded hover:bg-[#FECACA]">
                                    Kaldır
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {showForm && <SnoozeFormModal onClose={() => setShowForm(false)} />}
        </div>
    );
}

function SnoozeFormModal({ onClose }: { onClose: () => void }) {
    const toast = useToast();
    const qc = useQueryClient();

    const { data: rules = [] } = useQuery<AlertRuleLite[]>({
        queryKey: ['rules-lite'],
        queryFn: () => apiGet<any[]>('/alert-rules').then(r => r.map((x: any) => ({ rule_id: x.rule_id, rule_name: x.rule_name }))),
    });
    const { data: instances = [] } = useQuery<Instance[]>({
        queryKey: ['instances-list'],
        queryFn: () => apiGet<any[]>('/instances').then(r => r.map((i: any) => ({ instance_pk: i.instance_pk, display_name: i.display_name }))),
    });

    const [form, setForm] = useState({
        rule_id: '' as string | number,
        instance_pk: '' as string | number,
        metric_key: '',
        duration_minutes: 60,
        snooze_reason: '',
    });
    const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

    const createMut = useMutation({
        mutationFn: () => {
            const until = new Date(Date.now() + Number(form.duration_minutes) * 60000).toISOString();
            return apiPost('/adaptive-alerting/snooze', {
                rule_id: form.rule_id || null,
                instance_pk: form.instance_pk || null,
                metric_key: form.metric_key || null,
                snooze_until: until,
                snooze_reason: form.snooze_reason || null,
                created_by: 'admin',
            });
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['snoozes'] });
            qc.invalidateQueries({ queryKey: ['adaptive-overview'] });
            toast.success('Snooze eklendi');
            onClose();
        },
        onError: (e: any) => toast.error(e?.message || 'Hata'),
    });

    return (
        <Modal title="Snooze Ekle" onClose={onClose}>
            <div className="space-y-4">
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Kural (opsiyonel)</label>
                    <select value={form.rule_id} onChange={e => set('rule_id', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                        <option value="">Tüm kurallar</option>
                        {rules.map(r => <option key={r.rule_id} value={r.rule_id}>{r.rule_name}</option>)}
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Instance (opsiyonel)</label>
                    <select value={form.instance_pk} onChange={e => set('instance_pk', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                        <option value="">Tüm instance'lar</option>
                        {instances.map(i => <option key={i.instance_pk} value={i.instance_pk}>{i.display_name}</option>)}
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Süre</label>
                    <select value={form.duration_minutes} onChange={e => set('duration_minutes', Number(e.target.value))}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                        <option value={15}>15 dakika</option>
                        <option value={60}>1 saat</option>
                        <option value={240}>4 saat</option>
                        <option value={1440}>1 gün</option>
                        <option value={4320}>3 gün</option>
                        <option value={10080}>1 hafta</option>
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Sebep (opsiyonel)</label>
                    <textarea value={form.snooze_reason} onChange={e => set('snooze_reason', e.target.value)}
                        rows={2}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm resize-none"
                        placeholder="Örn: planlı bakım yapılıyor" />
                </div>
            </div>
            <ModalFooter onClose={onClose} onSave={() => createMut.mutate()} busy={createMut.isPending} />
        </Modal>
    );
}

// =========================================================================
// Bakım Pencereleri
// =========================================================================

function MaintenancePanel() {
    const toast = useToast();
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);

    const { data: windows = [] } = useQuery<MaintenanceWindow[]>({
        queryKey: ['maintenance-windows'],
        queryFn: () => apiGet('/adaptive-alerting/maintenance-windows'),
    });

    const deleteMut = useMutation({
        mutationFn: (id: number) => apiDelete(`/adaptive-alerting/maintenance-windows/${id}`),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
            toast.success('Bakım penceresi silindi');
        },
    });

    const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <p className="text-sm text-[#64748B]">
                    Tekrarlanan bakım pencerelerinde alert'leri otomatik sustur.
                </p>
                <button onClick={() => setShowForm(true)}
                    className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB]">
                    + Pencere Ekle
                </button>
            </div>

            {windows.length === 0 ? (
                <div className="text-center py-12 text-[#64748B] text-sm bg-white rounded-lg border border-[#E2E8F0]">
                    Tanımlı bakım penceresi yok.
                </div>
            ) : (
                <div className="bg-white border border-[#E2E8F0] rounded-lg divide-y divide-[#E2E8F0]">
                    {windows.map(w => (
                        <div key={w.window_id} className="px-4 py-3 flex items-center gap-3">
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-[#1E293B]">{w.window_name}</span>
                                    {!w.is_enabled && (
                                        <span className="text-[10px] bg-[#F1F5F9] text-[#64748B] px-1.5 py-0.5 rounded">devre dışı</span>
                                    )}
                                </div>
                                <div className="text-xs text-[#64748B] mt-0.5">
                                    {(w.day_of_week || [0,1,2,3,4,5,6]).map(d => DAYS[d]).join(', ')}
                                    {' · '}{w.start_time}–{w.end_time} ({w.timezone})
                                </div>
                                {w.description && <div className="text-xs text-[#94A3B8] mt-0.5">{w.description}</div>}
                            </div>
                            <button onClick={() => deleteMut.mutate(w.window_id)}
                                className="text-xs px-2.5 py-1 bg-[#FEE2E2] text-[#DC2626] rounded hover:bg-[#FECACA]">
                                Sil
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {showForm && <MaintenanceFormModal onClose={() => setShowForm(false)} />}
        </div>
    );
}

function MaintenanceFormModal({ onClose }: { onClose: () => void }) {
    const toast = useToast();
    const qc = useQueryClient();

    const { data: instances = [] } = useQuery<Instance[]>({
        queryKey: ['instances-list'],
        queryFn: () => apiGet<any[]>('/instances').then(r => r.map((i: any) => ({ instance_pk: i.instance_pk, display_name: i.display_name }))),
    });

    const [form, setForm] = useState({
        window_name: '',
        description: '',
        instance_pks: [] as number[],
        day_of_week: [1, 2, 3, 4, 5] as number[],
        start_time: '02:00',
        end_time: '04:00',
        timezone: 'Europe/Istanbul',
        suppress_all_alerts: true,
    });
    const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));
    const toggleDay = (d: number) => set('day_of_week',
        form.day_of_week.includes(d) ? form.day_of_week.filter(x => x !== d) : [...form.day_of_week, d].sort());
    const toggleInstance = (pk: number) => set('instance_pks',
        form.instance_pks.includes(pk) ? form.instance_pks.filter(x => x !== pk) : [...form.instance_pks, pk]);

    const DAYS = [
        { d: 1, l: 'Pzt' }, { d: 2, l: 'Sal' }, { d: 3, l: 'Çar' },
        { d: 4, l: 'Per' }, { d: 5, l: 'Cum' }, { d: 6, l: 'Cmt' }, { d: 0, l: 'Paz' }
    ];

    const createMut = useMutation({
        mutationFn: () => apiPost('/adaptive-alerting/maintenance-windows', {
            window_name: form.window_name,
            description: form.description || null,
            instance_pks: form.instance_pks.length ? form.instance_pks : null,
            day_of_week: form.day_of_week.length ? form.day_of_week : null,
            start_time: form.start_time,
            end_time: form.end_time,
            timezone: form.timezone,
            suppress_all_alerts: form.suppress_all_alerts,
            suppress_severity: null,
        }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
            qc.invalidateQueries({ queryKey: ['adaptive-overview'] });
            toast.success('Bakım penceresi oluşturuldu');
            onClose();
        },
        onError: (e: any) => toast.error(e?.message || 'Hata'),
    });

    return (
        <Modal title="Bakım Penceresi Ekle" onClose={onClose}>
            <div className="space-y-4">
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Pencere Adı *</label>
                    <input value={form.window_name} onChange={e => set('window_name', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                        placeholder="Haftalık bakım" />
                </div>
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Açıklama</label>
                    <input value={form.description} onChange={e => set('description', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                </div>
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Günler</label>
                    <div className="flex gap-1 flex-wrap">
                        {DAYS.map(d => (
                            <button key={d.d} onClick={() => toggleDay(d.d)} type="button"
                                className={`px-3 py-1.5 text-xs rounded ${form.day_of_week.includes(d.d) ? 'bg-[#3B82F6] text-white' : 'bg-[#F1F5F9] text-[#64748B]'}`}>
                                {d.l}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Başlangıç</label>
                        <input type="time" value={form.start_time} onChange={e => set('start_time', e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Bitiş</label>
                        <input type="time" value={form.end_time} onChange={e => set('end_time', e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Timezone</label>
                        <input value={form.timezone} onChange={e => set('timezone', e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                </div>
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Instance'lar (boş = tümü)</label>
                    <div className="max-h-40 overflow-y-auto border border-[#E2E8F0] rounded-md p-2 space-y-1">
                        {instances.map(i => (
                            <label key={i.instance_pk} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-[#F8FAFC] px-2 py-1 rounded">
                                <input type="checkbox" checked={form.instance_pks.includes(i.instance_pk)}
                                    onChange={() => toggleInstance(i.instance_pk)} className="accent-[#3B82F6]" />
                                <span>{i.display_name}</span>
                            </label>
                        ))}
                    </div>
                </div>
            </div>
            <ModalFooter onClose={onClose} onSave={() => createMut.mutate()} busy={createMut.isPending} />
        </Modal>
    );
}

// =========================================================================
// Bildirim Kanalları
// =========================================================================

function ChannelsPanel() {
    const toast = useToast();
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);

    const { data: channels = [] } = useQuery<NotificationChannel[]>({
        queryKey: ['channels'],
        queryFn: () => apiGet('/adaptive-alerting/notification-channels'),
    });

    const deleteMut = useMutation({
        mutationFn: (id: number) => apiDelete(`/adaptive-alerting/notification-channels/${id}`),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['channels'] });
            toast.success('Kanal silindi');
        },
    });

    const testMut = useMutation({
        mutationFn: (id: number) => apiPost(`/adaptive-alerting/notification-channels/${id}/test`, {}),
        onSuccess: () => toast.success('Test gönderildi'),
        onError: (e: any) => toast.error(e?.message || 'Test başarısız'),
    });

    const TYPE_ICONS: Record<string, string> = {
        email: '📧', slack: '💬', pagerduty: '🚨', teams: '👥', webhook: '🔗',
    };

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <p className="text-sm text-[#64748B]">
                    Alert oluşunca bildirim gitmesi için kanal tanımla.
                </p>
                <button onClick={() => setShowForm(true)}
                    className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB]">
                    + Kanal Ekle
                </button>
            </div>

            {channels.length === 0 ? (
                <div className="text-center py-12 text-[#64748B] text-sm bg-white rounded-lg border border-[#E2E8F0]">
                    Tanımlı bildirim kanalı yok.
                </div>
            ) : (
                <div className="bg-white border border-[#E2E8F0] rounded-lg divide-y divide-[#E2E8F0]">
                    {channels.map(c => (
                        <div key={c.channel_id} className="px-4 py-3 flex items-center gap-3">
                            <span className="text-2xl">{TYPE_ICONS[c.channel_type] || '🔔'}</span>
                            <div className="flex-1">
                                <div className="text-sm font-medium text-[#1E293B]">
                                    {c.channel_name}
                                    <span className="ml-2 text-[10px] bg-[#F1F5F9] text-[#475569] px-1.5 py-0.5 rounded uppercase">{c.channel_type}</span>
                                    {!c.is_enabled && <span className="ml-1 text-[10px] bg-[#FEF2F2] text-[#DC2626] px-1.5 py-0.5 rounded">devre dışı</span>}
                                </div>
                                <div className="text-xs text-[#94A3B8] mt-0.5">
                                    {c.min_severity && `Min: ${c.min_severity}`}
                                </div>
                            </div>
                            <button onClick={() => testMut.mutate(c.channel_id)}
                                className="text-xs px-2.5 py-1 bg-[#EFF6FF] text-[#2563EB] rounded hover:bg-[#DBEAFE]">
                                Test Gönder
                            </button>
                            <button onClick={() => deleteMut.mutate(c.channel_id)}
                                className="text-xs px-2.5 py-1 bg-[#FEE2E2] text-[#DC2626] rounded hover:bg-[#FECACA]">
                                Sil
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {showForm && <ChannelFormModal onClose={() => setShowForm(false)} />}
        </div>
    );
}

function ChannelFormModal({ onClose }: { onClose: () => void }) {
    const toast = useToast();
    const qc = useQueryClient();

    const [form, setForm] = useState({
        channel_name: '',
        channel_type: 'slack' as NotificationChannel['channel_type'],
        min_severity: '' as string,
        // config alanları
        webhook_url: '',
        channel: '',
        recipients: '',
        integration_key: '',
        url: '',
    });
    const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

    const createMut = useMutation({
        mutationFn: () => {
            let config: any = {};
            switch (form.channel_type) {
                case 'slack':     config = { webhook_url: form.webhook_url, channel: form.channel || undefined }; break;
                case 'teams':     config = { webhook_url: form.webhook_url }; break;
                case 'email':     config = { recipients: form.recipients.split(',').map(s => s.trim()).filter(Boolean) }; break;
                case 'pagerduty': config = { integration_key: form.integration_key }; break;
                case 'webhook':   config = { url: form.url, method: 'POST' }; break;
            }
            return apiPost('/adaptive-alerting/notification-channels', {
                channel_name: form.channel_name,
                channel_type: form.channel_type,
                config,
                min_severity: form.min_severity || null,
                instance_pks: null,
                metric_categories: null,
            });
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['channels'] });
            qc.invalidateQueries({ queryKey: ['adaptive-overview'] });
            toast.success('Kanal eklendi');
            onClose();
        },
        onError: (e: any) => toast.error(e?.message || 'Hata'),
    });

    return (
        <Modal title="Bildirim Kanalı Ekle" onClose={onClose}>
            <div className="space-y-4">
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Kanal Adı *</label>
                    <input value={form.channel_name} onChange={e => set('channel_name', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                </div>
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Tip</label>
                    <select value={form.channel_type} onChange={e => set('channel_type', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                        <option value="slack">Slack</option>
                        <option value="teams">Microsoft Teams</option>
                        <option value="email">Email</option>
                        <option value="pagerduty">PagerDuty</option>
                        <option value="webhook">Webhook (Generic)</option>
                    </select>
                </div>

                {/* Tip'e göre dinamik alanlar */}
                {(form.channel_type === 'slack' || form.channel_type === 'teams') && (
                    <>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">Webhook URL *</label>
                            <input value={form.webhook_url} onChange={e => set('webhook_url', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="https://hooks.slack.com/services/..." />
                        </div>
                        {form.channel_type === 'slack' && (
                            <div>
                                <label className="block text-xs font-medium text-[#475569] mb-1">Kanal (opsiyonel)</label>
                                <input value={form.channel} onChange={e => set('channel', e.target.value)}
                                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                    placeholder="#alerts" />
                            </div>
                        )}
                    </>
                )}
                {form.channel_type === 'email' && (
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Alıcılar (virgülle ayır)</label>
                        <input value={form.recipients} onChange={e => set('recipients', e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                            placeholder="ops@example.com, dba@example.com" />
                    </div>
                )}
                {form.channel_type === 'pagerduty' && (
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Integration Key *</label>
                        <input value={form.integration_key} onChange={e => set('integration_key', e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                )}
                {form.channel_type === 'webhook' && (
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">URL *</label>
                        <input value={form.url} onChange={e => set('url', e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                )}

                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Minimum Severity</label>
                    <select value={form.min_severity} onChange={e => set('min_severity', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                        <option value="">Hepsi</option>
                        <option value="warning">Warning+</option>
                        <option value="critical">Critical+</option>
                        <option value="emergency">Emergency</option>
                    </select>
                </div>
            </div>
            <ModalFooter onClose={onClose} onSave={() => createMut.mutate()} busy={createMut.isPending} />
        </Modal>
    );
}

// =========================================================================
// Ortak Modal bileşenleri
// =========================================================================

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
                <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-center justify-between">
                    <h2 className="font-semibold text-[#1E293B]">{title}</h2>
                    <button onClick={onClose} className="text-[#94A3B8] hover:text-[#475569] text-xl">×</button>
                </div>
                <div className="px-6 py-4">{children}</div>
            </div>
        </div>
    );
}

function ModalFooter({ onClose, onSave, busy }: { onClose: () => void; onSave: () => void; busy: boolean }) {
    return (
        <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-end gap-2 -mx-6 -mb-4 mt-4">
            <button onClick={onClose} className="px-4 py-2 text-sm text-[#475569] hover:text-[#1E293B]">İptal</button>
            <button onClick={onSave} disabled={busy}
                className="px-5 py-2 bg-[#22C55E] text-white text-sm rounded-md hover:bg-[#16A34A] disabled:opacity-50">
                {busy ? 'Kaydediliyor...' : 'Kaydet'}
            </button>
        </div>
    );
}
