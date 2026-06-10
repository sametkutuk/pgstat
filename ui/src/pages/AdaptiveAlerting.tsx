import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';
import { useToast } from '../components/common/Toast';
import InfoTip from '../components/common/InfoTip';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';

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
    channel_type: 'email' | 'slack' | 'pagerduty' | 'teams' | 'webhook' | 'telegram';
    config: any;
    min_severity: string | null;
    is_enabled: boolean;
}

interface AlertRuleLite {
    rule_id: number;
    rule_name: string;
}

interface SlotLifecycleSubscription {
    subscription_id: number;
    instance_pk: number;
    instance_name: string;
    is_enabled: boolean;
    inactive_minutes: number;
    retrigger_minutes: number;
    notify_on_lost: boolean;
    notify_on_active_deleted: boolean;
    notify_on_inactive_deleted: boolean;
    notify_on_inactive: boolean;
    updated_at: string;
}

interface SlotObservationState {
    instance_pk: number;
    instance_name: string;
    slot_name: string;
    last_seen_at: string;
    last_restart_lsn: string | null;
    last_stats_reset: string | null;
    last_active: boolean | null;
    last_wal_status: string | null;
    inactive_since: string | null;
    last_retrigger_at: string | null;
    tombstone_at: string | null;
}

interface SlotLifecycleEvent {
    alert_id: number;
    alert_key: string;
    alert_code: string;
    severity: string;
    status: string;
    instance_pk: number | null;
    instance_name: string | null;
    first_seen_at: string;
    last_seen_at: string;
    occurrence_count: number;
    title: string | null;
    message: string | null;
    details_json: any;
}

interface LongQuerySubscription {
    subscription_id: number;
    instance_pk: number;
    instance_name: string;
    is_enabled: boolean;
    long_query_minutes: number;
    idle_tx_minutes: number;
    notify_on_long_query: boolean;
    notify_on_idle_tx: boolean;
    notify_on_idle_tx_aborted: boolean;
    updated_at: string;
}

interface LongQueryLiveRow {
    instance_name: string;
    pid: number;
    datname: string | null;
    usename: string | null;
    state: string | null;
    duration_minutes: number;
    query_preview: string;
}

interface LongQueryEvent {
    alert_id: number;
    alert_key: string;
    alert_code: string;
    severity: string;
    status: string;
    occurrence_count: number;
    instance_pk: number | null;
    instance_name: string | null;
    title: string | null;
    message: string | null;
    first_seen_at: string;
    last_seen_at: string;
    resolved_at: string | null;
    details_json: any;
}

interface XidFreezeSubscription {
    subscription_id: number;
    instance_pk: number;
    instance_name: string;
    is_enabled: boolean;
    warning_pct: number;
    critical_pct: number;
    notify_on_xid: boolean;
    notify_on_mxid: boolean;
    updated_at: string;
}

interface XidFreezeStateRow {
    instance_name: string;
    datname: string | null;
    dbid: number;
    datfrozenxid_age: number | null;
    datminmxid_age: number | null;
    xid_max_age: number;
    mxid_max_age: number;
    xid_pct: number | null;
    mxid_pct: number | null;
    snapshot_ts: string;
}

interface XidFreezeEvent {
    alert_id: number;
    alert_key: string;
    alert_code: string;
    severity: string;
    status: string;
    occurrence_count: number;
    instance_pk: number | null;
    instance_name: string | null;
    title: string | null;
    message: string | null;
    first_seen_at: string;
    last_seen_at: string;
    resolved_at: string | null;
    details_json: any;
}

// =========================================================================
// Ana Sayfa
// =========================================================================

export default function AdaptiveAlerting() {
    const [tab, setTab] = useState<'overview' | 'baselines' | 'snooze' | 'maintenance' | 'channels' | 'slot-lifecycle' | 'long-query' | 'xid-freeze'>('overview');

    const tabs = [
        { k: 'overview', l: '📊 Genel Bakış' },
        { k: 'baselines', l: '📈 Baseline Profiller' },
        { k: 'snooze', l: '🔕 Snooze Yönetimi' },
        { k: 'maintenance', l: '🔧 Bakım Pencereleri' },
        { k: 'channels', l: '📢 Bildirim Kanalları' },
    ];

    tabs.push({ k: 'slot-lifecycle', l: 'Slot Lifecycle' });
    tabs.push({ k: 'long-query', l: 'Uzun Sorgu' });
    tabs.push({ k: 'xid-freeze', l: 'XID Freeze' });

    return (
        <div>
            <div className="flex items-center justify-between mb-5">
                <div>
                    <div className="flex items-center gap-2">
                        <h1 className="text-xl font-bold">Adaptive Alerting</h1>
                        <InfoTip text="Otomatik baseline profilleme sistemi. Collector gece 02:00 UTC'de son 28 gün verinizden saatlik profil hesaplar. Alert kurallarında evaluation_type=adaptive seçerseniz eşik otomatik gelir. Snooze ile geçici, bakım penceresi ile periyodik susturma yapabilirsiniz." />
                    </div>
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

            {tab === 'overview' && <OverviewPanel />}
            {tab === 'baselines' && <BaselinesPanel />}
            {tab === 'snooze' && <SnoozePanel />}
            {tab === 'maintenance' && <MaintenancePanel />}
            {tab === 'channels' && <ChannelsPanel />}
            {tab === 'slot-lifecycle' && <SlotLifecyclePanel />}
            {tab === 'long-query' && <LongQueryPanel />}
            {tab === 'xid-freeze' && <XidFreezePanel />}
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
        { label: 'Baseline Olan Instance', value: overview?.baselines?.instance_count ?? 0 },
        { label: 'Toplam Baseline Satırı', value: overview?.baselines?.total_baselines ?? 0 },
        { label: 'Aktif Snooze', value: overview?.active_snoozes ?? 0 },
        { label: 'Aktif Bakım Penceresi', value: overview?.enabled_maintenance ?? 0 },
        { label: 'Aktif Bildirim Kanalı', value: overview?.enabled_channels ?? 0 },
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
    const [selectedMetric, setSelectedMetric] = useState<string | null>(null);

    const { data: baselines = [] } = useQuery<any[]>({
        queryKey: ['baselines-list', selectedInstance],
        queryFn: () => apiGet(`/adaptive-alerting/instances/${selectedInstance}/baseline`),
        enabled: !!selectedInstance,
    });

    const { data: baselineDetail } = useQuery<{ general: any; hourly: any[] }>({
        queryKey: ['baseline-detail', selectedInstance, selectedMetric],
        queryFn: () => apiGet(`/adaptive-alerting/instances/${selectedInstance}/baseline/${encodeURIComponent(selectedMetric!)}`),
        enabled: !!selectedInstance && !!selectedMetric,
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

    const triggerMut = useMutation({
        mutationFn: (pk: number | null) =>
            apiPost('/adaptive-alerting/baselines/trigger', { instance_pk: pk }),
        onSuccess: () => {
            toast.success('Baseline hesaplaması kuyruğa alındı. 5-30 saniye içinde tamamlanacak.');
            // Biraz bekleyip query'i refresh et
            setTimeout(() => {
                qc.invalidateQueries({ queryKey: ['baselines-list'] });
                qc.invalidateQueries({ queryKey: ['adaptive-overview'] });
            }, 10000);
        },
        onError: (e: any) => toast.error(e?.message || 'Tetikleme başarısız'),
    });

    const handleInvalidate = () => {
        if (!selectedInstance) return;
        const reason = prompt('Baseline sıfırlama sebebi:');
        if (!reason) return;
        invalidateMut.mutate({ pk: selectedInstance, reason });
    };

    const snapshotMut = useMutation({
        mutationFn: () => apiPost('/adaptive-alerting/nightly-snapshot/trigger', {}),
        onSuccess: () => {
            toast.success('Snapshot toplama başlatıldı. 10-30 saniye içinde tamamlanacak.');
        },
        onError: (e: any) => toast.error(e?.message || 'Snapshot tetikleme başarısız'),
    });

    return (
        <div className="space-y-4">
            <div className="bg-[#F0F9FF] border border-[#BAE6FD] rounded-lg p-3 flex items-center gap-3">
                <span className="text-xl">💡</span>
                <div className="flex-1 text-xs text-[#0369A1]">
                    Baseline normalde gece 02:00 UTC'de otomatik hesaplanır. Mevcut veriyle (2-3 gün bile) hemen hesaplamak için aşağıdaki butona bas.
                </div>
                <button onClick={() => triggerMut.mutate(null)} disabled={triggerMut.isPending}
                    className="px-4 py-2 bg-[#0284C7] text-white text-sm rounded hover:bg-[#0369A1] disabled:opacity-50 whitespace-nowrap">
                    {triggerMut.isPending ? 'Tetikleniyor...' : 'Tüm Instance\'lar İçin Hesapla'}
                </button>
            </div>

            <div className="bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg p-3 flex items-center gap-3">
                <span className="text-xl">📸</span>
                <div className="flex-1 text-xs text-[#5B21B6]">
                    PG parametreleri, tablo/index boyutları, sequence durumu ve XID age bilgisi normalde gece 03:00 UTC'de toplanır. Hemen toplamak için:
                </div>
                <button onClick={() => snapshotMut.mutate()} disabled={snapshotMut.isPending}
                    className="px-4 py-2 bg-[#7C3AED] text-white text-sm rounded hover:bg-[#6D28D9] disabled:opacity-50 whitespace-nowrap">
                    {snapshotMut.isPending ? 'Toplanıyor...' : 'Snapshot Topla'}
                </button>
            </div>

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
                    <>
                        <button onClick={() => triggerMut.mutate(selectedInstance)} disabled={triggerMut.isPending}
                            className="px-4 py-2 bg-[#0284C7] text-white text-sm rounded hover:bg-[#0369A1] disabled:opacity-50 whitespace-nowrap">
                            Hemen Hesapla
                        </button>
                        <button onClick={handleInvalidate}
                            className="px-4 py-2 bg-[#FEE2E2] text-[#DC2626] text-sm rounded hover:bg-[#FECACA] whitespace-nowrap">
                            Sıfırla
                        </button>
                    </>
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
                        <div key={b.metric_key}
                            onClick={() => setSelectedMetric(selectedMetric === b.metric_key ? null : b.metric_key)}
                            className={`bg-white border rounded-lg p-4 cursor-pointer transition-colors ${selectedMetric === b.metric_key
                                ? 'border-[#3B82F6] ring-1 ring-[#3B82F6]'
                                : 'border-[#E2E8F0] hover:border-[#94A3B8]'
                                }`}>
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

            {selectedMetric && baselineDetail && (
                <BaselineChart detail={baselineDetail} metricKey={selectedMetric} />
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
                <div className="flex items-center gap-2">
                    <p className="text-sm text-[#64748B]">
                        Geçici olarak alert'leri sustur. Süre dolunca otomatik kalkar.
                    </p>
                    <InfoTip text="Snooze belirli bir kural veya instance için alert'leri geçici olarak susturur. Süre dolunca otomatik kalkar. Planlı bakım, bilinen sorunlar veya false positive durumlarında kullanın. Tüm kurallar + tüm instance seçerseniz tüm alert'ler susturulur." />
                </div>
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
    const [editingWindow, setEditingWindow] = useState<MaintenanceWindow | null>(null);

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

    const toggleMut = useMutation({
        mutationFn: ({ id, is_enabled }: { id: number; is_enabled: boolean }) =>
            apiPut(`/adaptive-alerting/maintenance-windows/${id}`, { is_enabled }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
            qc.invalidateQueries({ queryKey: ['adaptive-overview'] });
        },
        onError: (e: any) => toast.error(e?.message || 'Hata'),
    });

    const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                    <p className="text-sm text-[#64748B]">
                        Tekrarlanan bakım pencerelerinde alert'leri otomatik sustur.
                    </p>
                    <InfoTip text="Bakım penceresi belirli gün ve saatlerde alert'leri otomatik susturur. Haftalık bakım, yedekleme veya deploy saatlerinde kullanın. Timezone ayarına dikkat edin — container UTC'de çalışır. Instance seçmezseniz tüm instance'lar etkilenir." />
                </div>
                <button onClick={() => { setEditingWindow(null); setShowForm(true); }}
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
                                    {(w.day_of_week || [0, 1, 2, 3, 4, 5, 6]).map(d => DAYS[d]).join(', ')}
                                    {' · '}{w.start_time}–{w.end_time} ({w.timezone})
                                </div>
                                {w.description && <div className="text-xs text-[#94A3B8] mt-0.5">{w.description}</div>}
                            </div>
                            <button onClick={() => toggleMut.mutate({ id: w.window_id, is_enabled: !w.is_enabled })}
                                className={`text-xs px-2.5 py-1 rounded ${w.is_enabled ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-green-50 text-green-700 hover:bg-green-100'}`}>
                                {w.is_enabled ? 'Devre Dışı' : 'Etkinleştir'}
                            </button>
                            <button onClick={() => { setEditingWindow(w); setShowForm(true); }}
                                className="text-xs px-2.5 py-1 bg-blue-50 text-blue-700 rounded hover:bg-blue-100">
                                Düzenle
                            </button>
                            <button onClick={() => deleteMut.mutate(w.window_id)}
                                className="text-xs px-2.5 py-1 bg-[#FEE2E2] text-[#DC2626] rounded hover:bg-[#FECACA]">
                                Sil
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {showForm && <MaintenanceFormModal window={editingWindow} onClose={() => { setShowForm(false); setEditingWindow(null); }} />}
        </div>
    );
}

function MaintenanceFormModal({ window: editWindow, onClose }: { window: MaintenanceWindow | null; onClose: () => void }) {
    const toast = useToast();
    const qc = useQueryClient();

    const { data: instances = [] } = useQuery<Instance[]>({
        queryKey: ['instances-list'],
        queryFn: () => apiGet<any[]>('/instances').then(r => r.map((i: any) => ({ instance_pk: i.instance_pk, display_name: i.display_name }))),
    });

    const [form, setForm] = useState({
        window_name: editWindow?.window_name || '',
        description: editWindow?.description || '',
        instance_pks: editWindow?.instance_pks || [] as number[],
        day_of_week: editWindow?.day_of_week || [1, 2, 3, 4, 5] as number[],
        start_time: (editWindow?.start_time || '02:00').slice(0, 5),
        end_time: (editWindow?.end_time || '04:00').slice(0, 5),
        timezone: editWindow?.timezone || 'Europe/Istanbul',
        suppress_all_alerts: editWindow?.suppress_all_alerts ?? true,
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

    const saveMut = useMutation({
        mutationFn: () => {
            const payload = {
                window_name: form.window_name,
                description: form.description || null,
                instance_pks: form.instance_pks.length ? form.instance_pks : null,
                day_of_week: form.day_of_week.length ? form.day_of_week : null,
                start_time: form.start_time,
                end_time: form.end_time,
                timezone: form.timezone,
                suppress_all_alerts: form.suppress_all_alerts,
                suppress_severity: null,
            };
            return editWindow
                ? apiPut(`/adaptive-alerting/maintenance-windows/${editWindow.window_id}`, payload)
                : apiPost('/adaptive-alerting/maintenance-windows', payload);
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
            qc.invalidateQueries({ queryKey: ['adaptive-overview'] });
            toast.success(editWindow ? 'Bakım penceresi güncellendi' : 'Bakım penceresi oluşturuldu');
            onClose();
        },
        onError: (e: any) => toast.error(e?.message || 'Hata'),
    });

    return (
        <Modal title={editWindow ? 'Bakım Penceresi Düzenle' : 'Bakım Penceresi Ekle'} onClose={onClose}>
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
            <ModalFooter onClose={onClose} onSave={() => saveMut.mutate()} busy={saveMut.isPending} />
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
    const [editingChannel, setEditingChannel] = useState<NotificationChannel | null>(null);

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
        email: '📧', slack: '💬', pagerduty: '🚨', teams: '👥', webhook: '🔗', telegram: '✈️',
    };

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                    <p className="text-sm text-[#64748B]">
                        Alert oluşunca bildirim gitmesi için kanal tanımla.
                    </p>
                    <InfoTip text="Bildirim kanalları alert oluştuğunda otomatik mesaj gönderir. Telegram: BotFather'dan bot oluşturun, gruba ekleyin, chat_id'yi /getUpdates ile bulun. Teams: Incoming Webhook connector ekleyin. Email: .env'de SMTP ayarlarını yapın (PGSTAT_SMTP_HOST vb.). Min severity ile sadece kritik alert'lerde bildirim alabilirsiniz." />
                </div>
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
                            <button onClick={() => setEditingChannel(c)}
                                className="text-xs px-2.5 py-1 bg-[#FEF3C7] text-[#B45309] rounded hover:bg-[#FDE68A]">
                                Düzenle
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
            {editingChannel && <ChannelFormModal channel={editingChannel} onClose={() => setEditingChannel(null)} />}
        </div>
    );
}

function ChannelFormModal({ channel, onClose }: { channel?: NotificationChannel; onClose: () => void }) {
    const toast = useToast();
    const qc = useQueryClient();
    const isEdit = !!channel;

    // Mevcut config'ten form alanlarını çıkar
    const existingConfig: any = channel?.config && typeof channel.config === 'object'
        ? channel.config
        : (typeof channel?.config === 'string' ? (() => { try { return JSON.parse(channel.config as any); } catch { return {}; } })() : {});

    const [form, setForm] = useState({
        channel_name: channel?.channel_name ?? '',
        channel_type: (channel?.channel_type ?? 'telegram') as NotificationChannel['channel_type'],
        min_severity: channel?.min_severity ?? '',
        // config alanları (mevcut kanaldan doldurulur)
        webhook_url: existingConfig.webhook_url ?? '',
        channel: existingConfig.channel ?? '',
        recipients: Array.isArray(existingConfig.recipients) ? existingConfig.recipients.join(', ') : (existingConfig.recipients ?? ''),
        integration_key: existingConfig.integration_key ?? '',
        url: existingConfig.url ?? '',
        bot_token: existingConfig.bot_token ?? '',
        chat_id: existingConfig.chat_id ?? '',
        webhook_method: existingConfig.method ?? 'POST',
        webhook_headers: existingConfig.headers ? JSON.stringify(existingConfig.headers, null, 2) : '{"Content-Type": "application/json"}',
        webhook_body_template: existingConfig.body_template ?? `{
  "alert_id": "{{alert_id}}",
  "severity": "{{severity}}",
  "title": "{{title}}",
  "message": "{{message}}",
  "timestamp": "{{timestamp}}"
}`,
        // Email subject + body template (V038+)
        email_from: existingConfig.from ?? '',
        email_subject_template: existingConfig.subject_template ?? '',
        email_body_template: existingConfig.body_template ?? '',
        // Teams card_template + theme_color (V038+)
        teams_theme_color: existingConfig.theme_color ?? '',
        teams_card_template: existingConfig.card_template ?? '',
    });
    const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

    const buildConfig = () => {
        let config: any = {};
        switch (form.channel_type) {
            case 'slack': config = { webhook_url: form.webhook_url, channel: form.channel || undefined }; break;
            case 'teams': {
                const c: any = { webhook_url: form.webhook_url };
                if (form.teams_theme_color?.trim()) c.theme_color = form.teams_theme_color.trim();
                if (form.teams_card_template?.trim()) c.card_template = form.teams_card_template.trim();
                config = c;
                break;
            }
            case 'email': {
                const c: any = { recipients: form.recipients.split(',').map((s: string) => s.trim()).filter(Boolean) };
                if (form.email_from?.trim()) c.from = form.email_from.trim();
                if (form.email_subject_template?.trim()) c.subject_template = form.email_subject_template.trim();
                if (form.email_body_template?.trim()) c.body_template = form.email_body_template.trim();
                config = c;
                break;
            }
            case 'pagerduty': config = { integration_key: form.integration_key }; break;
            case 'webhook': config = {
                url: form.url,
                method: form.webhook_method,
                headers: (() => { try { return JSON.parse(form.webhook_headers); } catch { return { 'Content-Type': 'application/json' }; } })(),
                body_template: form.webhook_body_template,
            }; break;
            case 'telegram': config = { bot_token: form.bot_token, chat_id: form.chat_id }; break;
        }
        return config;
    };

    const saveMut = useMutation({
        mutationFn: () => {
            const body = {
                channel_name: form.channel_name,
                channel_type: form.channel_type,
                config: buildConfig(),
                min_severity: form.min_severity || null,
            };
            return isEdit
                ? apiPut(`/adaptive-alerting/notification-channels/${channel!.channel_id}`, body)
                : apiPost('/adaptive-alerting/notification-channels', { ...body, instance_pks: null, metric_categories: null });
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['channels'] });
            qc.invalidateQueries({ queryKey: ['adaptive-overview'] });
            toast.success(isEdit ? 'Kanal güncellendi' : 'Kanal eklendi');
            onClose();
        },
        onError: (e: any) => toast.error(e?.message || 'Hata'),
    });

    return (
        <Modal title={isEdit ? 'Bildirim Kanalı Düzenle' : 'Bildirim Kanalı Ekle'} onClose={onClose}>
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
                        <option value="telegram">Telegram</option>
                    </select>
                </div>

                {/* Tip'e göre dinamik alanlar */}
                {(form.channel_type === 'slack' || form.channel_type === 'teams') && (
                    <>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Webhook URL *
                                {form.channel_type === 'teams' && (
                                    <InfoTip text="Teams kanalında ... > Connectors > Incoming Webhook ekleyin. Oluşturulan URL'i buraya yapıştırın." className="ml-1" />
                                )}
                            </label>
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
                        {form.channel_type === 'teams' && (
                            <>
                                <div>
                                    <label className="block text-xs font-medium text-[#475569] mb-1">
                                        Theme Color (opsiyonel)
                                        <InfoTip text="Kart sol kenar rengi. Boş bırakılırsa severity'ye göre (kırmızı/turuncu/mavi). Hex: FF0000" className="ml-1" />
                                    </label>
                                    <input value={form.teams_theme_color} onChange={e => set('teams_theme_color', e.target.value)}
                                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-mono"
                                        placeholder="0078D4" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-[#475569] mb-1">
                                        Card Template (opsiyonel, JSON)
                                        <InfoTip text="Boş bırakılırsa default Adaptive Card kullanılır. Custom JSON yazarsan placeholder: {{title}}, {{message}}, {{severity}}, {{severity_upper}}, {{color}}" className="ml-1" />
                                    </label>
                                    <textarea value={form.teams_card_template} onChange={e => set('teams_card_template', e.target.value)}
                                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-xs font-mono"
                                        rows={6}
                                        placeholder={"{\"@type\":\"MessageCard\",\"themeColor\":\"{{color}}\",\"summary\":\"{{title}}\",\"text\":\"{{message}}\"}"} />
                                </div>
                            </>
                        )}
                    </>
                )}
                {form.channel_type === 'email' && (
                    <>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Alıcılar (virgülle ayır)
                                <InfoTip text="Email bildirimi için sunucuda SMTP ayarları gerekir. .env dosyasında PGSTAT_SMTP_HOST, PGSTAT_SMTP_PORT, PGSTAT_SMTP_USER, PGSTAT_SMTP_PASSWORD değerlerini ayarlayın. Gmail için: host=smtp.gmail.com, port=587, App Password kullanın." className="ml-1" />
                            </label>
                            <input value={form.recipients} onChange={e => set('recipients', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="ops@example.com, dba@example.com" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                From (opsiyonel)
                                <InfoTip text="Boş bırakılırsa pgstat@localhost kullanılır. SMTP'nin izin verdiği bir from adresi yazın." className="ml-1" />
                            </label>
                            <input value={form.email_from} onChange={e => set('email_from', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="pgstat@example.com" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Subject Template (opsiyonel)
                                <InfoTip text="Boş bırakılırsa: '[pgstat SEVERITY] title'. Placeholder: {{title}}, {{message}}, {{severity}}, {{severity_upper}}" className="ml-1" />
                            </label>
                            <input value={form.email_subject_template} onChange={e => set('email_subject_template', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-mono"
                                placeholder="[{{severity_upper}}] pgstat: {{title}}" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Body Template (opsiyonel)
                                <InfoTip text="Email gövdesi. Boş bırakılırsa default mesaj gönderilir. Placeholder: {{title}}, {{message}}, {{severity}}, {{severity_upper}}" className="ml-1" />
                            </label>
                            <textarea value={form.email_body_template} onChange={e => set('email_body_template', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-xs font-mono"
                                rows={5}
                                placeholder={"Severity: {{severity_upper}}\nKonu: {{title}}\n\n{{message}}\n\n— pgstat Monitoring"} />
                        </div>
                    </>
                )}
                {form.channel_type === 'pagerduty' && (
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Integration Key *</label>
                        <input value={form.integration_key} onChange={e => set('integration_key', e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                )}
                {form.channel_type === 'webhook' && (
                    <>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                URL *
                                <InfoTip text="Alert oluştuğunda HTTP isteği gönderilecek endpoint. Herhangi bir REST API, n8n, Zapier, custom endpoint olabilir." className="ml-1" />
                            </label>
                            <input value={form.url} onChange={e => set('url', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="https://api.example.com/alerts" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">HTTP Method</label>
                            <select value={form.webhook_method} onChange={e => set('webhook_method', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                                <option value="POST">POST</option>
                                <option value="PUT">PUT</option>
                                <option value="PATCH">PATCH</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Headers (JSON)
                                <InfoTip text="HTTP header'ları JSON formatında. Örn: Authorization header eklemek için {&quot;Content-Type&quot;: &quot;application/json&quot;, &quot;Authorization&quot;: &quot;Bearer TOKEN&quot;}" className="ml-1" />
                            </label>
                            <textarea value={form.webhook_headers} onChange={e => set('webhook_headers', e.target.value)}
                                rows={2}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-mono text-xs resize-none" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Body Template (JSON)
                                <InfoTip text="Gönderilecek JSON body. Değişkenler: {{alert_id}}, {{severity}}, {{title}}, {{message}}, {{instance_pk}}, {{timestamp}}. Değişkenler gönderim sırasında gerçek değerlerle değiştirilir." className="ml-1" />
                            </label>
                            <textarea value={form.webhook_body_template} onChange={e => set('webhook_body_template', e.target.value)}
                                rows={6}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-mono text-xs resize-y"
                                placeholder={'{\n  "severity": "{{severity}}",\n  "title": "{{title}}"\n}'} />
                            <div className="text-[10px] text-[#94A3B8] mt-1">
                                Değişkenler: <code className="bg-[#F1F5F9] px-1 rounded">{'{{alert_id}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{severity}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{title}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{message}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{instance_pk}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{timestamp}}'}</code>
                            </div>
                        </div>
                    </>
                )}
                {form.channel_type === 'telegram' && (
                    <>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Bot Token *
                                <InfoTip text="Telegram'da @BotFather'a /newbot yazın, bot oluşturun. Size verilen token'ı buraya yapıştırın. Örn: 123456:ABC-DEF..." className="ml-1" />
                            </label>
                            <input value={form.bot_token} onChange={e => set('bot_token', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Chat ID *
                                <InfoTip text="Botu gruba ekledikten sonra gruba bir mesaj yazın. Sonra tarayıcıda https://api.telegram.org/bot{TOKEN}/getUpdates adresini açın. JSON'daki chat.id değerini buraya yazın. Grup ID'leri - ile başlar." className="ml-1" />
                            </label>
                            <input value={form.chat_id} onChange={e => set('chat_id', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="-1001234567890 veya @kanal_adi" />
                        </div>
                    </>
                )}

                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                        Minimum Severity
                        <InfoTip text="Bu kanala sadece seçilen seviye ve üstü alert'ler gönderilir. Örn: Warning+ seçerseniz info alert'leri gönderilmez. Boş bırakırsanız tüm alert'ler gönderilir." className="ml-1" />
                    </label>
                    <select value={form.min_severity} onChange={e => set('min_severity', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                        <option value="">Hepsi</option>
                        <option value="warning">Warning+</option>
                        <option value="critical">Critical+</option>
                        <option value="emergency">Emergency</option>
                    </select>
                </div>
            </div>
            <ModalFooter onClose={onClose} onSave={() => saveMut.mutate()} busy={saveMut.isPending} />
        </Modal>
    );
}

// =========================================================================
// Slot Lifecycle
// =========================================================================

function SlotLifecyclePanel() {
    const toast = useToast();
    const qc = useQueryClient();
    const [editing, setEditing] = useState<SlotLifecycleSubscription | null>(null);
    const [forgetTarget, setForgetTarget] = useState<SlotObservationState | null>(null);
    const [instanceFilter, setInstanceFilter] = useState<string>('');
    const [severityFilter, setSeverityFilter] = useState<string>('');

    const { data: subscriptions = [] } = useQuery<SlotLifecycleSubscription[]>({
        queryKey: ['slot-lifecycle-subscriptions'],
        queryFn: () => apiGet('/adaptive-alerting/slot-lifecycle/subscriptions'),
    });

    const statePath = instanceFilter
        ? `/adaptive-alerting/slot-lifecycle/state?instancePk=${encodeURIComponent(instanceFilter)}`
        : '/adaptive-alerting/slot-lifecycle/state';
    const { data: states = [] } = useQuery<SlotObservationState[]>({
        queryKey: ['slot-lifecycle-state', instanceFilter],
        queryFn: () => apiGet(statePath),
    });

    const eventParams = new URLSearchParams({ limit: '100' });
    if (instanceFilter) eventParams.set('instancePk', instanceFilter);
    if (severityFilter) eventParams.set('severity', severityFilter);
    const { data: events = [] } = useQuery<SlotLifecycleEvent[]>({
        queryKey: ['slot-lifecycle-events', instanceFilter, severityFilter],
        queryFn: () => apiGet(`/adaptive-alerting/slot-lifecycle/events?${eventParams.toString()}`),
    });

    const forgetMut = useMutation({
        mutationFn: (row: SlotObservationState) =>
            apiDelete(`/adaptive-alerting/slot-lifecycle/state/${row.instance_pk}/${encodeURIComponent(row.slot_name)}`),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['slot-lifecycle-state'] });
            toast.success('Slot state silindi');
            setForgetTarget(null);
        },
        onError: (e: any) => toast.error(e?.message || 'Slot state silinemedi'),
    });

    return (
        <div className="space-y-6">
            <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Subscription Ayarlari</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Ayarlar instance bazindadir; instance altindaki tum slotlara uygulanir.</p>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                            <tr>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Instance</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Aktif</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Inactive (dk)</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Re-trigger (dk)</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Bildirimler</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Duzenle</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                            {subscriptions.map((row) => (
                                <tr key={row.subscription_id} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 font-medium text-[#1E293B]">{row.instance_name}</td>
                                    <td className="py-2 px-3">{yesNoBadge(row.is_enabled)}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.inactive_minutes}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.retrigger_minutes}</td>
                                    <td className="py-2 px-3">
                                        <div className="flex flex-wrap gap-1">
                                            <MiniToggle label="lost" value={row.notify_on_lost} />
                                            <MiniToggle label="active del" value={row.notify_on_active_deleted} />
                                            <MiniToggle label="inactive del" value={row.notify_on_inactive_deleted} />
                                            <MiniToggle label="inactive" value={row.notify_on_inactive} />
                                        </div>
                                    </td>
                                    <td className="py-2 px-3 text-right">
                                        <button onClick={() => setEditing(row)}
                                            className="px-3 py-1 text-xs rounded bg-[#EFF6FF] text-[#2563EB] hover:bg-[#DBEAFE]">
                                            Duzenle
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Aktif Slot Listesi</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Tombstone kayitlarinda Unut butonu gorunur.</p>
                    </div>
                    <select value={instanceFilter} onChange={e => setInstanceFilter(e.target.value)}
                        className="px-3 py-2 border border-[#CBD5E1] rounded-md text-sm">
                        <option value="">Tum instance'lar</option>
                        {subscriptions.map(s => (
                            <option key={s.instance_pk} value={s.instance_pk}>{s.instance_name}</option>
                        ))}
                    </select>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                            <tr>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Instance</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Slot</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Aktif</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">WAL Status</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Inactive Since</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Last Restart LSN</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Last Seen</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Tombstone</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Aksiyon</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                            {states.length === 0 ? (
                                <tr><td colSpan={9} className="py-8 text-center text-sm text-[#64748B]">Slot state kaydi yok.</td></tr>
                            ) : states.map((row) => (
                                <tr key={`${row.instance_pk}-${row.slot_name}`} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 text-[#1E293B]">{row.instance_name}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.slot_name}</td>
                                    <td className="py-2 px-3">{yesNoBadge(Boolean(row.last_active))}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.last_wal_status ?? '-'}</td>
                                    <td className="py-2 px-3 text-xs text-[#64748B] whitespace-nowrap">{formatSlotDate(row.inactive_since)}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.last_restart_lsn ?? '-'}</td>
                                    <td className="py-2 px-3 text-xs text-[#64748B] whitespace-nowrap">{formatSlotDate(row.last_seen_at)}</td>
                                    <td className="py-2 px-3 text-xs text-[#64748B] whitespace-nowrap">{formatSlotDate(row.tombstone_at)}</td>
                                    <td className="py-2 px-3 text-right">
                                        {row.tombstone_at ? (
                                            <button onClick={() => setForgetTarget(row)}
                                                className="px-3 py-1 text-xs rounded bg-[#FEE2E2] text-[#DC2626] hover:bg-[#FECACA]">
                                                Unut
                                            </button>
                                        ) : <span className="text-xs text-[#94A3B8]">-</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Olay Gecmisi</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Son 100 slot lifecycle alert kaydi.</p>
                    </div>
                    <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}
                        className="px-3 py-2 border border-[#CBD5E1] rounded-md text-sm">
                        <option value="">Tum severity</option>
                        <option value="critical">critical</option>
                        <option value="warning">warning</option>
                        <option value="info">info</option>
                    </select>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                            <tr>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Last Seen</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Instance</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Slot</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Code</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Severity</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Status</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Occurrence</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                            {events.length === 0 ? (
                                <tr><td colSpan={7} className="py-8 text-center text-sm text-[#64748B]">Slot lifecycle olayi yok.</td></tr>
                            ) : events.map((row) => (
                                <tr key={row.alert_id} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 text-xs text-[#64748B] whitespace-nowrap">{formatSlotDate(row.last_seen_at)}</td>
                                    <td className="py-2 px-3 text-[#1E293B]">{row.instance_name ?? '-'}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{eventSlotName(row)}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.alert_code}</td>
                                    <td className="py-2 px-3">{severityBadge(row.severity)}</td>
                                    <td className="py-2 px-3 text-xs">{row.status}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.occurrence_count}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {editing && <SlotLifecycleEditModal subscription={editing} onClose={() => setEditing(null)} />}
            {forgetTarget && (
                <Modal title="Slot state unut" onClose={() => setForgetTarget(null)}>
                    <p className="text-sm text-[#475569]">
                        "{forgetTarget.slot_name}" slot'unun gozlem durumu silinecek. Onayliyor musunuz?
                    </p>
                    <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-end gap-2 -mx-6 -mb-4 mt-4">
                        <button onClick={() => setForgetTarget(null)}
                            className="px-4 py-2 text-sm text-[#475569] hover:text-[#1E293B]">Iptal</button>
                        <button onClick={() => forgetMut.mutate(forgetTarget)} disabled={forgetMut.isPending}
                            className="px-5 py-2 bg-[#DC2626] text-white text-sm rounded-md hover:bg-[#B91C1C] disabled:opacity-50">
                            {forgetMut.isPending ? 'Siliniyor...' : 'Unut'}
                        </button>
                    </div>
                </Modal>
            )}
        </div>
    );
}

function SlotLifecycleEditModal({ subscription, onClose }: { subscription: SlotLifecycleSubscription; onClose: () => void }) {
    const toast = useToast();
    const qc = useQueryClient();
    const [form, setForm] = useState({
        is_enabled: subscription.is_enabled,
        inactive_minutes: subscription.inactive_minutes,
        retrigger_minutes: subscription.retrigger_minutes,
        notify_on_lost: subscription.notify_on_lost,
        notify_on_active_deleted: subscription.notify_on_active_deleted,
        notify_on_inactive_deleted: subscription.notify_on_inactive_deleted,
        notify_on_inactive: subscription.notify_on_inactive,
    });

    const set = (key: keyof typeof form, value: boolean | number) => {
        setForm(prev => ({ ...prev, [key]: value }));
    };

    const saveMut = useMutation({
        mutationFn: () => apiPut(`/adaptive-alerting/slot-lifecycle/subscriptions/${subscription.instance_pk}`, form),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['slot-lifecycle-subscriptions'] });
            toast.success('Slot lifecycle ayarlari kaydedildi');
            onClose();
        },
        onError: (e: any) => toast.error(e?.message || 'Kayit basarisiz'),
    });

    return (
        <Modal title={`Slot Lifecycle - ${subscription.instance_name}`} onClose={onClose}>
            <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm text-[#334155]">
                    <input type="checkbox" checked={form.is_enabled} onChange={e => set('is_enabled', e.target.checked)} />
                    Aktif
                </label>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Inactive (dk)</label>
                        <input type="number" min={5} value={form.inactive_minutes}
                            onChange={e => set('inactive_minutes', Number(e.target.value))}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Re-trigger (dk)</label>
                        <input type="number" min={5} value={form.retrigger_minutes}
                            onChange={e => set('retrigger_minutes', Number(e.target.value))}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                </div>
                <div className="grid grid-cols-1 gap-2">
                    <ToggleRow label="Lost bildirimi" value={form.notify_on_lost} onChange={v => set('notify_on_lost', v)} />
                    <ToggleRow label="Aktif silindi bildirimi" value={form.notify_on_active_deleted} onChange={v => set('notify_on_active_deleted', v)} />
                    <ToggleRow label="Pasif silindi bildirimi" value={form.notify_on_inactive_deleted} onChange={v => set('notify_on_inactive_deleted', v)} />
                    <ToggleRow label="Uzun pasif bildirimi" value={form.notify_on_inactive} onChange={v => set('notify_on_inactive', v)} />
                </div>
            </div>
            <ModalFooter onClose={onClose} onSave={() => saveMut.mutate()} busy={saveMut.isPending} />
        </Modal>
    );
}

// =========================================================================
// Long Query
// =========================================================================

function LongQueryPanel() {
    const [editing, setEditing] = useState<LongQuerySubscription | null>(null);
    const [instanceFilter, setInstanceFilter] = useState<string>('');
    const [severityFilter, setSeverityFilter] = useState<string>('');
    const [statusFilter, setStatusFilter] = useState<string>('');

    const { data: subscriptions = [] } = useQuery<LongQuerySubscription[]>({
        queryKey: ['long-query-subscriptions'],
        queryFn: () => apiGet('/adaptive-alerting/long-query/subscriptions'),
    });

    const liveParams = new URLSearchParams({ limit: '100' });
    if (instanceFilter) liveParams.set('instancePk', instanceFilter);
    const { data: liveRows = [] } = useQuery<LongQueryLiveRow[]>({
        queryKey: ['long-query-live', instanceFilter],
        queryFn: () => apiGet(`/adaptive-alerting/long-query/live?${liveParams.toString()}`),
        refetchInterval: 30_000,
    });

    const eventParams = new URLSearchParams({ limit: '100' });
    if (instanceFilter) eventParams.set('instancePk', instanceFilter);
    if (severityFilter) eventParams.set('severity', severityFilter);
    if (statusFilter) eventParams.set('status', statusFilter);
    const { data: events = [] } = useQuery<LongQueryEvent[]>({
        queryKey: ['long-query-events', instanceFilter, severityFilter, statusFilter],
        queryFn: () => apiGet(`/adaptive-alerting/long-query/events?${eventParams.toString()}`),
    });

    return (
        <div className="space-y-6">
            <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Subscription Ayarlari</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Ayarlar instance bazindadir; uzun sorgu ve idle transaction alertlerini yonetir.</p>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                            <tr>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Instance</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Aktif</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Uzun Sorgu (dk)</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Idle Tx (dk)</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Bildirimler</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Duzenle</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                            {subscriptions.length === 0 ? (
                                <tr><td colSpan={6} className="py-8 text-center text-sm text-[#64748B]">Subscription kaydi yok.</td></tr>
                            ) : subscriptions.map((row) => (
                                <tr key={row.subscription_id} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 font-medium text-[#1E293B]">{row.instance_name}</td>
                                    <td className="py-2 px-3">{yesNoBadge(row.is_enabled)}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.long_query_minutes}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.idle_tx_minutes}</td>
                                    <td className="py-2 px-3">
                                        <div className="flex flex-wrap gap-1">
                                            <MiniToggle label="long" value={row.notify_on_long_query} />
                                            <MiniToggle label="idle" value={row.notify_on_idle_tx} />
                                            <MiniToggle label="aborted" value={row.notify_on_idle_tx_aborted} />
                                        </div>
                                    </td>
                                    <td className="py-2 px-3 text-right">
                                        <button onClick={() => setEditing(row)}
                                            className="px-3 py-1 text-xs rounded bg-[#EFF6FF] text-[#2563EB] hover:bg-[#DBEAFE]">
                                            Duzenle
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Canli Uzun Calisanlar</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Son snapshot'taki aktif/idle-tx sorgular. Esik asilmasa bile gosterilir.</p>
                    </div>
                    <select value={instanceFilter} onChange={e => setInstanceFilter(e.target.value)}
                        className="px-3 py-2 border border-[#CBD5E1] rounded-md text-sm">
                        <option value="">Tum instance'lar</option>
                        {subscriptions.map(s => (
                            <option key={s.instance_pk} value={s.instance_pk}>{s.instance_name}</option>
                        ))}
                    </select>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                            <tr>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Instance</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">PID</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">DB</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">User</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">State</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Sure (dk)</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Sorgu</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                            {liveRows.length === 0 ? (
                                <tr><td colSpan={7} className="py-8 text-center text-sm text-[#64748B]">Canli uzun calisan sorgu yok.</td></tr>
                            ) : liveRows.map((row) => (
                                <tr key={`${row.instance_name}-${row.pid}-${row.state}`} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 text-[#1E293B]">{row.instance_name}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.pid}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.datname ?? '-'}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.usename ?? '-'}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.state ?? '-'}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.duration_minutes}</td>
                                    <td className="py-2 px-3 font-mono text-xs max-w-[520px] truncate" title={row.query_preview}>{row.query_preview || '-'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Olay Gecmisi</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Son 100 uzun sorgu ve idle transaction alert kaydi.</p>
                    </div>
                    <div className="flex gap-2">
                        <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}
                            className="px-3 py-2 border border-[#CBD5E1] rounded-md text-sm">
                            <option value="">Tum severity</option>
                            <option value="warning">warning</option>
                        </select>
                        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                            className="px-3 py-2 border border-[#CBD5E1] rounded-md text-sm">
                            <option value="">Tum status</option>
                            <option value="open">open</option>
                            <option value="resolved">resolved</option>
                            <option value="acknowledged">acknowledged</option>
                        </select>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                            <tr>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Last Seen</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Instance</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Code</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Severity</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Status</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">PID</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Sure</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Occurrence</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                            {events.length === 0 ? (
                                <tr><td colSpan={8} className="py-8 text-center text-sm text-[#64748B]">Uzun sorgu olayi yok.</td></tr>
                            ) : events.map((row) => (
                                <tr key={row.alert_id} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 text-xs text-[#64748B] whitespace-nowrap">{formatSlotDate(row.last_seen_at)}</td>
                                    <td className="py-2 px-3 text-[#1E293B]">{row.instance_name ?? '-'}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.alert_code}</td>
                                    <td className="py-2 px-3">{severityBadge(row.severity)}</td>
                                    <td className="py-2 px-3">{statusBadge(row.status)}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{eventPid(row)}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{eventDuration(row)}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.occurrence_count}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {editing && <LongQueryEditModal subscription={editing} onClose={() => setEditing(null)} />}
        </div>
    );
}

function LongQueryEditModal({ subscription, onClose }: { subscription: LongQuerySubscription; onClose: () => void }) {
    const toast = useToast();
    const qc = useQueryClient();
    const [form, setForm] = useState({
        is_enabled: subscription.is_enabled,
        long_query_minutes: subscription.long_query_minutes,
        idle_tx_minutes: subscription.idle_tx_minutes,
        notify_on_long_query: subscription.notify_on_long_query,
        notify_on_idle_tx: subscription.notify_on_idle_tx,
        notify_on_idle_tx_aborted: subscription.notify_on_idle_tx_aborted,
    });

    const set = (key: keyof typeof form, value: boolean | number) => {
        setForm(prev => ({ ...prev, [key]: value }));
    };

    const saveMut = useMutation({
        mutationFn: () => apiPut(`/adaptive-alerting/long-query/subscriptions/${subscription.instance_pk}`, form),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['long-query-subscriptions'] });
            toast.success('Uzun sorgu ayarlari kaydedildi');
            onClose();
        },
        onError: (e: any) => toast.error(e?.message || 'Kayit basarisiz'),
    });

    return (
        <Modal title={`Uzun Sorgu - ${subscription.instance_name}`} onClose={onClose}>
            <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm text-[#334155]">
                    <input type="checkbox" checked={form.is_enabled} onChange={e => set('is_enabled', e.target.checked)} />
                    Aktif
                </label>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Uzun Sorgu (dk)</label>
                        <input type="number" min={1} value={form.long_query_minutes}
                            onChange={e => set('long_query_minutes', Number(e.target.value))}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Idle Tx (dk)</label>
                        <input type="number" min={1} value={form.idle_tx_minutes}
                            onChange={e => set('idle_tx_minutes', Number(e.target.value))}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                </div>
                <div className="grid grid-cols-1 gap-2">
                    <ToggleRow label="Uzun sorgu bildirimi" value={form.notify_on_long_query} onChange={v => set('notify_on_long_query', v)} />
                    <ToggleRow label="Idle tx bildirimi" value={form.notify_on_idle_tx} onChange={v => set('notify_on_idle_tx', v)} />
                    <ToggleRow label="Aborted idle tx bildirimi" value={form.notify_on_idle_tx_aborted} onChange={v => set('notify_on_idle_tx_aborted', v)} />
                </div>
            </div>
            <ModalFooter onClose={onClose} onSave={() => saveMut.mutate()} busy={saveMut.isPending} />
        </Modal>
    );
}

// =========================================================================
// XID Freeze
// =========================================================================

function XidFreezePanel() {
    const [editing, setEditing] = useState<XidFreezeSubscription | null>(null);
    const [instanceFilter, setInstanceFilter] = useState<string>('');
    const [severityFilter, setSeverityFilter] = useState<string>('');
    const [statusFilter, setStatusFilter] = useState<string>('');

    const { data: subscriptions = [] } = useQuery<XidFreezeSubscription[]>({
        queryKey: ['xid-freeze-subscriptions'],
        queryFn: () => apiGet('/adaptive-alerting/xid-freeze/subscriptions'),
    });

    const stateParams = new URLSearchParams();
    if (instanceFilter) stateParams.set('instancePk', instanceFilter);
    const stateUrl = stateParams.toString()
        ? `/adaptive-alerting/xid-freeze/current-state?${stateParams.toString()}`
        : '/adaptive-alerting/xid-freeze/current-state';
    const { data: stateRows = [], refetch: refetchState, isFetching: stateFetching } = useQuery<XidFreezeStateRow[]>({
        queryKey: ['xid-freeze-current-state', instanceFilter],
        queryFn: () => apiGet(stateUrl),
        refetchInterval: 5 * 60 * 1000,
    });

    const eventParams = new URLSearchParams({ limit: '100' });
    if (instanceFilter) eventParams.set('instancePk', instanceFilter);
    if (severityFilter) eventParams.set('severity', severityFilter);
    if (statusFilter) eventParams.set('status', statusFilter);
    const { data: events = [] } = useQuery<XidFreezeEvent[]>({
        queryKey: ['xid-freeze-events', instanceFilter, severityFilter, statusFilter],
        queryFn: () => apiGet(`/adaptive-alerting/xid-freeze/events?${eventParams.toString()}`),
    });

    return (
        <div className="space-y-6">
            <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Subscription Ayarlari</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Ayarlar instance bazindadir; instance altindaki tum database'lere uygulanir.</p>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                            <tr>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Instance</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Aktif</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Warning %</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Critical %</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Bildirimler</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Duzenle</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                            {subscriptions.length === 0 ? (
                                <tr><td colSpan={6} className="py-8 text-center text-sm text-[#64748B]">Subscription kaydi yok.</td></tr>
                            ) : subscriptions.map((row) => (
                                <tr key={row.subscription_id} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 font-medium text-[#1E293B]">{row.instance_name}</td>
                                    <td className="py-2 px-3">{yesNoBadge(row.is_enabled)}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.warning_pct}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.critical_pct}</td>
                                    <td className="py-2 px-3">
                                        <div className="flex flex-wrap gap-1">
                                            <MiniToggle label="XID" value={row.notify_on_xid} />
                                            <MiniToggle label="MXID" value={row.notify_on_mxid} />
                                        </div>
                                    </td>
                                    <td className="py-2 px-3 text-right">
                                        <button onClick={() => setEditing(row)}
                                            className="px-3 py-1 text-xs rounded bg-[#EFF6FF] text-[#2563EB] hover:bg-[#DBEAFE]">
                                            Duzenle
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Mevcut Durum</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Son gece snapshot. Wraparound 2.1B XID'de. Yuzde = age / autovacuum_freeze_max_age.</p>
                    </div>
                    <div className="flex gap-2">
                        <select value={instanceFilter} onChange={e => setInstanceFilter(e.target.value)}
                            className="px-3 py-2 border border-[#CBD5E1] rounded-md text-sm">
                            <option value="">Tum instance'lar</option>
                            {subscriptions.map(s => (
                                <option key={s.instance_pk} value={s.instance_pk}>{s.instance_name}</option>
                            ))}
                        </select>
                        <button onClick={() => refetchState()} disabled={stateFetching}
                            className="px-3 py-2 text-sm rounded bg-[#EFF6FF] text-[#2563EB] hover:bg-[#DBEAFE] disabled:opacity-50">
                            Yenile
                        </button>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                            <tr>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Instance</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">DB</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">XID Age</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">XID %</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">MXID Age</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">MXID %</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Son Snapshot</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                            {stateRows.length === 0 ? (
                                <tr><td colSpan={7} className="py-8 text-center text-sm text-[#64748B]">Son 36 saat icinde freeze snapshot yok.</td></tr>
                            ) : stateRows.map((row) => (
                                <tr key={`${row.instance_name}-${row.dbid}`} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 text-[#1E293B]">{row.instance_name}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.datname ?? '-'}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{formatNumber(row.datfrozenxid_age)}</td>
                                    <td className="py-2 px-3">{pctBadge(row.xid_pct)}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{formatNumber(row.datminmxid_age)}</td>
                                    <td className="py-2 px-3">{pctBadge(row.mxid_pct)}</td>
                                    <td className="py-2 px-3 text-xs text-[#64748B] whitespace-nowrap">{formatSlotDate(row.snapshot_ts)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold text-[#1E293B]">Olay Gecmisi</h2>
                        <p className="text-xs text-[#64748B] mt-0.5">Son 100 XID ve MXID freeze alert kaydi.</p>
                    </div>
                    <div className="flex gap-2">
                        <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}
                            className="px-3 py-2 border border-[#CBD5E1] rounded-md text-sm">
                            <option value="">Tum severity</option>
                            <option value="warning">warning</option>
                            <option value="critical">critical</option>
                        </select>
                        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                            className="px-3 py-2 border border-[#CBD5E1] rounded-md text-sm">
                            <option value="">Tum status</option>
                            <option value="open">open</option>
                            <option value="resolved">resolved</option>
                            <option value="acknowledged">acknowledged</option>
                        </select>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                            <tr>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Last Seen</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Instance</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Code</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Severity</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">Status</th>
                                <th className="py-2 px-3 text-left text-xs font-semibold text-[#64748B] uppercase">DB</th>
                                <th className="py-2 px-3 text-right text-xs font-semibold text-[#64748B] uppercase">Occurrence</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                            {events.length === 0 ? (
                                <tr><td colSpan={7} className="py-8 text-center text-sm text-[#64748B]">Freeze olayi yok.</td></tr>
                            ) : events.map((row) => (
                                <tr key={row.alert_id} className="hover:bg-[#F8FAFC]">
                                    <td className="py-2 px-3 text-xs text-[#64748B] whitespace-nowrap">{formatSlotDate(row.last_seen_at)}</td>
                                    <td className="py-2 px-3 text-[#1E293B]">{row.instance_name ?? '-'}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{row.alert_code}</td>
                                    <td className="py-2 px-3">{severityBadge(row.severity)}</td>
                                    <td className="py-2 px-3">{statusBadge(row.status)}</td>
                                    <td className="py-2 px-3 font-mono text-xs">{eventFreezeDb(row)}</td>
                                    <td className="py-2 px-3 text-right font-mono text-xs">{row.occurrence_count}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {editing && <XidFreezeEditModal subscription={editing} onClose={() => setEditing(null)} />}
        </div>
    );
}

function XidFreezeEditModal({ subscription, onClose }: { subscription: XidFreezeSubscription; onClose: () => void }) {
    const toast = useToast();
    const qc = useQueryClient();
    const [form, setForm] = useState({
        is_enabled: subscription.is_enabled,
        warning_pct: subscription.warning_pct,
        critical_pct: subscription.critical_pct,
        notify_on_xid: subscription.notify_on_xid,
        notify_on_mxid: subscription.notify_on_mxid,
    });

    const set = (key: keyof typeof form, value: boolean | number) => {
        setForm(prev => ({ ...prev, [key]: value }));
    };

    const saveMut = useMutation({
        mutationFn: () => apiPut(`/adaptive-alerting/xid-freeze/subscriptions/${subscription.instance_pk}`, form),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['xid-freeze-subscriptions'] });
            toast.success('XID freeze ayarlari kaydedildi');
            onClose();
        },
        onError: (e: any) => toast.error(e?.message || 'Kayit basarisiz'),
    });

    return (
        <Modal title={`XID Freeze - ${subscription.instance_name}`} onClose={onClose}>
            <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm text-[#334155]">
                    <input type="checkbox" checked={form.is_enabled} onChange={e => set('is_enabled', e.target.checked)} />
                    Aktif
                </label>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Warning %</label>
                        <input type="number" min={1} max={100} value={form.warning_pct}
                            onChange={e => set('warning_pct', Number(e.target.value))}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Critical %</label>
                        <input type="number" min={1} max={100} value={form.critical_pct}
                            onChange={e => set('critical_pct', Number(e.target.value))}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                </div>
                <div className="grid grid-cols-1 gap-2">
                    <ToggleRow label="XID bildirimi" value={form.notify_on_xid} onChange={v => set('notify_on_xid', v)} />
                    <ToggleRow label="MXID bildirimi" value={form.notify_on_mxid} onChange={v => set('notify_on_mxid', v)} />
                </div>
            </div>
            <ModalFooter onClose={onClose} onSave={() => saveMut.mutate()} busy={saveMut.isPending} />
        </Modal>
    );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
    return (
        <label className="flex items-center justify-between gap-3 rounded border border-[#E2E8F0] px-3 py-2 text-sm">
            <span className="text-[#334155]">{label}</span>
            <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
        </label>
    );
}

function MiniToggle({ label, value }: { label: string; value: boolean }) {
    return (
        <span className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium ${value ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            {label}: {value ? 'on' : 'off'}
        </span>
    );
}

function yesNoBadge(value: boolean) {
    return (
        <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${value ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
            {value ? 'Evet' : 'Hayir'}
        </span>
    );
}

function severityBadge(severity: string) {
    const cls = severity === 'critical'
        ? 'bg-red-100 text-red-700'
        : severity === 'warning'
            ? 'bg-amber-100 text-amber-700'
            : 'bg-blue-100 text-blue-700';
    return <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{severity}</span>;
}

function statusBadge(status: string) {
    const cls = status === 'open'
        ? 'bg-emerald-100 text-emerald-700'
        : status === 'resolved'
            ? 'bg-slate-100 text-slate-600'
            : 'bg-blue-100 text-blue-700';
    return <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}

function pctBadge(value: number | null | undefined) {
    if (value == null) {
        return <span className="text-xs text-[#94A3B8]">-</span>;
    }
    const cls = value >= 95
        ? 'bg-red-100 text-red-700'
        : value >= 80
            ? 'bg-amber-100 text-amber-700'
            : 'bg-emerald-100 text-emerald-700';
    return <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{value}%</span>;
}

function formatNumber(value: number | null | undefined): string {
    if (value == null) return '-';
    return Number(value).toLocaleString('tr-TR');
}

function formatSlotDate(value: string | null | undefined): string {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('tr-TR');
}

function eventSlotName(row: SlotLifecycleEvent): string {
    const details = typeof row.details_json === 'string'
        ? safeJsonParse(row.details_json)
        : row.details_json;
    const fromDetails = details?.context?.slot_name;
    if (typeof fromDetails === 'string' && fromDetails.length > 0) return fromDetails;
    const marker = ':slot=';
    const idx = row.alert_key.indexOf(marker);
    return idx >= 0 ? row.alert_key.slice(idx + marker.length) : '-';
}

function longQueryDetails(row: LongQueryEvent): any {
    return typeof row.details_json === 'string'
        ? safeJsonParse(row.details_json)
        : row.details_json;
}

function eventPid(row: LongQueryEvent): string {
    const pid = longQueryDetails(row)?.context?.pid;
    if (pid != null) return String(pid);
    const match = row.alert_key.match(/:pid=(\d+)/);
    return match ? match[1] : '-';
}

function eventDuration(row: LongQueryEvent): string {
    const duration = longQueryDetails(row)?.context?.duration_minutes;
    return duration != null ? `${duration} dk` : '-';
}

function eventFreezeDb(row: XidFreezeEvent): string {
    const details = typeof row.details_json === 'string'
        ? safeJsonParse(row.details_json)
        : row.details_json;
    const datname = details?.context?.datname;
    if (typeof datname === 'string' && datname.length > 0) return datname;
    const dbid = details?.context?.dbid;
    if (dbid != null) return `dbid=${dbid}`;
    const match = row.alert_key.match(/:dbid=(\d+)/);
    return match ? `dbid=${match[1]}` : '-';
}

function safeJsonParse(value: string): any {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

// =========================================================================
// Baseline Chart
// =========================================================================

function BaselineChart({ detail, metricKey }: { detail: { general: any; hourly: any[] }; metricKey: string }) {
    const hourly = detail.hourly || [];
    const general = detail.general;

    if (hourly.length === 0 && !general) {
        return <div className="text-sm text-[#94A3B8] py-4 text-center">Bu metrik için saatlik profil yok.</div>;
    }

    // 0-23 saat için veri hazırla (eksik saatler 0)
    const chartData = Array.from({ length: 24 }, (_, h) => {
        const row = hourly.find((r: any) => Number(r.hour_of_day) === h);
        return {
            hour: `${String(h).padStart(2, '0')}:00`,
            avg: row ? Number(row.avg_value) : 0,
            p95: row ? Number(row.p95_value) : 0,
            min: row ? Number(row.min_value) : 0,
            max: row ? Number(row.max_value) : 0,
            stddev: row ? Number(row.stddev_value) : 0,
            samples: row ? Number(row.sample_count) : 0,
        };
    });

    const generalAvg = general ? Number(general.avg_value) : null;
    const currentHour = new Date().getUTCHours();

    return (
        <div className="bg-white border border-[#E2E8F0] rounded-lg p-5 space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#1E293B]">
                    📈 {metricKey} — Saatlik Baseline Profili
                </h3>
                {general && (
                    <div className="text-xs text-[#64748B]">
                        Genel: avg={Number(general.avg_value).toFixed(2)}, σ={Number(general.stddev_value).toFixed(2)}, örneklem={general.sample_count}
                    </div>
                )}
            </div>

            <ResponsiveContainer width="100%" height={260}>
                <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <XAxis dataKey="hour" tick={{ fontSize: 10 }} interval={1} />
                    <YAxis tick={{ fontSize: 10 }} width={60} />
                    <Tooltip
                        contentStyle={{ fontSize: 12, borderRadius: 8 }}
                        formatter={(value: unknown, name: unknown) => {
                            const labels: Record<string, string> = { avg: 'Ortalama', p95: 'P95', min: 'Min', max: 'Max' };
                            const key = String(name);
                            return [Number(value ?? 0).toFixed(2), labels[key] || key];
                        }}
                        labelFormatter={(label) => `Saat: ${label} (UTC)`}
                    />
                    <Bar dataKey="avg" name="avg" radius={[3, 3, 0, 0]}>
                        {chartData.map((_entry, idx) => (
                            <Cell key={idx} fill={idx === currentHour ? '#2563EB' : '#93C5FD'} />
                        ))}
                    </Bar>
                    <Bar dataKey="p95" name="p95" fill="#F59E0B" opacity={0.5} radius={[3, 3, 0, 0]} />
                    {generalAvg !== null && (
                        <ReferenceLine y={generalAvg} stroke="#DC2626" strokeDasharray="4 4"
                            label={{ value: `Genel avg: ${generalAvg.toFixed(1)}`, position: 'right', fontSize: 10, fill: '#DC2626' }} />
                    )}
                </BarChart>
            </ResponsiveContainer>

            <div className="flex items-center gap-4 text-[10px] text-[#64748B]">
                <span className="flex items-center gap-1"><span className="w-3 h-2 bg-[#93C5FD] rounded-sm inline-block" /> Saatlik Avg</span>
                <span className="flex items-center gap-1"><span className="w-3 h-2 bg-[#2563EB] rounded-sm inline-block" /> Şu anki saat (UTC)</span>
                <span className="flex items-center gap-1"><span className="w-3 h-2 bg-[#F59E0B] opacity-50 rounded-sm inline-block" /> P95</span>
                <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#DC2626] inline-block" style={{ borderTop: '2px dashed #DC2626' }} /> Genel Ortalama</span>
            </div>
        </div>
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
