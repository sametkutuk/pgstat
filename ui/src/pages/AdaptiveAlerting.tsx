import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';

interface Instance {
    instance_pk: number;
    display_name: string;
}

interface MetricBaseline {
    instance_pk: number;
    instance_name: string;
    metric_key: string;
    hour_of_day: number;
    avg_value: number;
    stddev_value: number;
    p95_value: number;
    p99_value: number;
    updated_at: string;
}

export default function AdaptiveAlerting() {
    const [tab, setTab] = useState<'overview' | 'baselines' | 'snooze' | 'maintenance' | 'channels'>('overview');

    const tabs = [
        { k: 'overview', l: '📊 Genel Bakış' },
        { k: 'baselines', l: '📈 Baseline Profiller' },
        { k: 'snooze', l: '🔕 Snooze Yönetimi' },
        { k: 'maintenance', l: '🔧 Bakım Pencereleri' },
        { k: 'channels', l: '📢 Bildirim Kanalları' },
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
                    <button
                        key={t.k}
                        onClick={() => setTab(t.k as any)}
                        className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.k
                                ? 'border-[#3B82F6] text-[#3B82F6]'
                                : 'border-transparent text-[#64748B] hover:text-[#1E293B]'
                            }`}
                    >
                        {t.l}
                    </button>
                ))}
            </div>

            {tab === 'overview' && <OverviewPanel />}
            {tab === 'baselines' && <BaselinesPanel />}
            {tab === 'snooze' && <SnoozePanel />}
            {tab === 'maintenance' && <MaintenancePanel />}
            {tab === 'channels' && <ChannelsPanel />}
        </div>
    );
}

// =========================================================================
// Genel Bakış
// =========================================================================

function OverviewPanel() {
    const { data: instances = [] } = useQuery<Instance[]>({
        queryKey: ['instances'],
        queryFn: () => apiGet('/instances'),
    });

    return (
        <div className="space-y-6">
            {/* Bilgi kartları */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                    <div className="text-sm text-[#64748B]">İzlenen Instance</div>
                    <div className="text-2xl font-bold text-[#1E293B] mt-1">{instances.length}</div>
                </div>
                <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                    <div className="text-sm text-[#64748B]">Aktif Baseline</div>
                    <div className="text-2xl font-bold text-[#1E293B] mt-1">-</div>
                    <div className="text-xs text-[#94A3B8] mt-1">Henüz hesaplanmadı</div>
                </div>
                <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                    <div className="text-sm text-[#64748B]">Snooze Edilen Alert</div>
                    <div className="text-2xl font-bold text-[#1E293B] mt-1">0</div>
                </div>
            </div>

            {/* Açıklama */}
            <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-lg p-4">
                <h3 className="text-sm font-semibold text-[#1E40AF] mb-2">Adaptive Alerting Nedir?</h3>
                <div className="text-sm text-[#3B82F6] space-y-2">
                    <p>
                        Adaptive alerting sistemi, PostgreSQL instance'larınızın normal davranış profillerini otomatik olarak öğrenir
                        ve anormal durumları tespit eder.
                    </p>
                    <ul className="list-disc list-inside space-y-1 ml-2">
                        <li>28 günlük geçmiş veriden baseline profiller oluşturur</li>
                        <li>Saatlik örüntüleri (peak saatler, gece düşüşleri) öğrenir</li>
                        <li>Manuel eşik tanımlamadan anomali tespiti yapar</li>
                        <li>Bakım pencereleri ve snooze ile false positive'leri azaltır</li>
                    </ul>
                </div>
            </div>
        </div>
    );
}

// =========================================================================
// Baseline Profiller
// =========================================================================

function BaselinesPanel() {
    const { data: instances = [] } = useQuery<Instance[]>({
        queryKey: ['instances'],
        queryFn: () => apiGet('/instances'),
    });

    const [selectedInstance, setSelectedInstance] = useState<number | null>(null);

    return (
        <div className="space-y-4">
            <div className="bg-[#FFF7ED] border border-[#FED7AA] rounded-lg p-4">
                <div className="flex items-start gap-3">
                    <span className="text-2xl">⚠️</span>
                    <div>
                        <div className="text-sm font-semibold text-[#EA580C]">Baseline Hesaplama Henüz Aktif Değil</div>
                        <div className="text-xs text-[#C2410C] mt-1">
                            Baseline profilleri oluşturmak için collector'da baseline hesaplama job'ı eklenmelidir.
                            Bu özellik Phase 2'de (Collector Entegrasyonu) geliştirilecek.
                        </div>
                    </div>
                </div>
            </div>

            {/* Instance seçici */}
            <div>
                <label className="block text-sm font-medium text-[#475569] mb-2">Instance Seç</label>
                <select
                    value={selectedInstance || ''}
                    onChange={(e) => setSelectedInstance(Number(e.target.value) || null)}
                    className="w-full md:w-96 px-3 py-2 border border-[#CBD5E1] rounded-md text-sm"
                >
                    <option value="">-- Instance seçin --</option>
                    {instances.map((inst) => (
                        <option key={inst.instance_pk} value={inst.instance_pk}>
                            {inst.display_name}
                        </option>
                    ))}
                </select>
            </div>

            {selectedInstance && (
                <div className="text-center py-12 text-[#64748B] text-sm">
                    Baseline verileri henüz mevcut değil.
                </div>
            )}
        </div>
    );
}

// =========================================================================
// Snooze Yönetimi
// =========================================================================

function SnoozePanel() {
    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <p className="text-sm text-[#64748B]">
                    Geçici olarak alert'leri susturmak için snooze ekleyin.
                </p>
                <button className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB]">
                    + Snooze Ekle
                </button>
            </div>

            <div className="text-center py-12 text-[#64748B] text-sm">
                Aktif snooze bulunamadı.
            </div>
        </div>
    );
}

// =========================================================================
// Bakım Pencereleri
// =========================================================================

function MaintenancePanel() {
    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <p className="text-sm text-[#64748B]">
                    Planlı bakım pencerelerinde alert'leri otomatik sustur.
                </p>
                <button className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB]">
                    + Bakım Penceresi Ekle
                </button>
            </div>

            <div className="text-center py-12 text-[#64748B] text-sm">
                Tanımlı bakım penceresi bulunamadı.
            </div>
        </div>
    );
}

// =========================================================================
// Bildirim Kanalları
// =========================================================================

function ChannelsPanel() {
    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <p className="text-sm text-[#64748B]">
                    Email, Slack, PagerDuty gibi bildirim kanallarını yönetin.
                </p>
                <button className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB]">
                    + Kanal Ekle
                </button>
            </div>

            <div className="text-center py-12 text-[#64748B] text-sm">
                Tanımlı bildirim kanalı bulunamadı.
            </div>
        </div>
    );
}
