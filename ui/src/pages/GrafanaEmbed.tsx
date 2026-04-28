import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useState } from 'react';

// =========================================================================
// Grafana Embed Page
// =========================================================================
// pgstat UI içinde Grafana dashboard'larını iframe olarak gösterir.
// Tek port üzerinden /grafana/ proxy ile servisleniyor.
// kiosk=tv → Grafana'nın kendi sidebar/topbar'ı gizli, sadece dashboard.
// =========================================================================

interface DashboardEntry {
    uid: string;
    title: string;
    description: string;
    icon: string;
    category: 'fleet' | 'topic' | 'detail';
}

// Sıralama: Fleet (NOC, başlangıç) → Topics (konu odaklı, fleet karşılaştırma)
// → Detail-only (drill-down hedefleri)
const DASHBOARDS: DashboardEntry[] = [
    // === FLEET ===
    {
        uid: 'pgstat-fleet-overview',
        title: 'Fleet Overview',
        description: 'Tüm instance\'ların tek ekrandaki durumu — başlangıç sayfası, NOC için',
        icon: '🌐',
        category: 'fleet',
    },
    {
        uid: 'pgstat-alerts-slo',
        title: 'Alerts & SLO',
        description: 'Alert hacmi, MTTA/MTTR, gürültülü alert kodları, kanal başarı oranı',
        icon: '🚨',
        category: 'fleet',
    },

    // === TOPICS (cross-instance, drill-down ile Instance Detail'a geçer) ===
    {
        uid: 'pgstat-locks-activity',
        title: 'Locks & Activity Overview',
        description: 'Fleet aktif sorgu, idle in tx, blocking chains, uzun süreli sorgular',
        icon: '🔒',
        category: 'topic',
    },
    {
        uid: 'pgstat-replication-wal',
        title: 'Replication & WAL Overview',
        description: 'Tüm primary/standby replikasyon lag, slot durumu, WAL üretimi',
        icon: '🔄',
        category: 'topic',
    },
    {
        uid: 'pgstat-io-buffers',
        title: 'I/O & Buffers Overview (PG16+)',
        description: 'Top read/write yapan instance\'lar, backend_type × context kırılımı',
        icon: '💾',
        category: 'topic',
    },
    {
        uid: 'pgstat-vacuum-bloat',
        title: 'Vacuum & Bloat Overview',
        description: 'Cross-instance dead tuple sıralaması, vacuum geçmişi, aktif vacuum',
        icon: '🧹',
        category: 'topic',
    },
    {
        uid: 'pgstat-database-tables',
        title: 'Database & Tables Overview',
        description: 'Cross-instance en aktif DB\'ler, en çok yazılan tablolar',
        icon: '🗄️',
        category: 'topic',
    },
    {
        uid: 'pgstat-capacity-trends',
        title: 'Capacity & Trends',
        description: '30 günlük trend, lineer tahmin, kapasite planlaması',
        icon: '📈',
        category: 'topic',
    },

    // === DETAIL (genelde drill-down ile açılır, list'te de gösterilir) ===
    {
        uid: 'pgstat-instance-detail',
        title: 'Instance Detail',
        description: '360° tek instance görünümü — DoD/WoW/MoM overlay\'li',
        icon: '🔍',
        category: 'detail',
    },
    {
        uid: 'pgstat-top-queries-detail',
        title: 'Top Queries Detail',
        description: 'Cross-instance sorgu listesi VEYA tek queryid filtreli detay',
        icon: '📝',
        category: 'detail',
    },
];

const CATEGORY_LABELS: Record<DashboardEntry['category'], { label: string; description: string }> = {
    fleet: { label: '🌍 Fleet — Genel Görünüm', description: 'Tüm sistemin sağlık panosu' },
    topic: { label: '🎯 Konular — Cross-Instance', description: 'Konu seç, tüm instance\'ları karşılaştır, bir satıra tıklayınca instance detayına git' },
    detail: { label: '🔬 Detay — Tek Instance / Sorgu', description: 'Drill-down hedefleri (genelde otomatik açılır)' },
};

export default function GrafanaEmbed() {
    const { uid } = useParams<{ uid?: string }>();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const [iframeKey, setIframeKey] = useState(0);

    // UID belirtilmediyse — dashboard listesi göster (kategorili)
    if (!uid) {
        const grouped = (cat: DashboardEntry['category']) =>
            DASHBOARDS.filter(d => d.category === cat);

        return (
            <div className="p-6">
                <div className="mb-6">
                    <h1 className="text-xl font-bold text-[#1E293B]">Grafana Dashboards</h1>
                    <p className="text-sm text-[#64748B] mt-1">
                        Bir konuyu seç, tüm fleet'i karşılaştır, sonra bir satıra/instance'a tıklayarak detaya git.
                    </p>
                </div>

                {(['fleet', 'topic', 'detail'] as const).map(cat => {
                    const items = grouped(cat);
                    if (items.length === 0) return null;
                    const meta = CATEGORY_LABELS[cat];
                    return (
                        <div key={cat} className="mb-8">
                            <div className="mb-3">
                                <h2 className="text-sm font-bold text-[#1E293B] uppercase tracking-wide">{meta.label}</h2>
                                <p className="text-xs text-[#64748B] mt-0.5">{meta.description}</p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {items.map(d => (
                                    <Link
                                        key={d.uid}
                                        to={`/grafana/${d.uid}`}
                                        className="block bg-white border border-[#E2E8F0] rounded-lg p-4 hover:border-[#3B82F6] hover:shadow-md transition-all"
                                    >
                                        <div className="flex items-start gap-3">
                                            <span className="text-3xl">{d.icon}</span>
                                            <div className="flex-1">
                                                <h3 className="font-semibold text-[#1E293B] mb-1">{d.title}</h3>
                                                <p className="text-xs text-[#64748B]">{d.description}</p>
                                                {d.uid === 'pgstat-top-queries-detail' && (
                                                    <div className="mt-2 flex gap-2">
                                                        <span className="text-[10px] bg-[#EFF6FF] text-[#1E40AF] px-1.5 py-0.5 rounded">List</span>
                                                        <span className="text-[10px] bg-[#FEF3C7] text-[#92400E] px-1.5 py-0.5 rounded">Drill-Down (queryid)</span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        </div>
                    );
                })}
                <div className="mt-6 bg-[#EFF6FF] border border-[#BFDBFE] rounded-md px-4 py-3 text-xs text-[#1E40AF]">
                    💡 Yeni sekmede tam ekran açmak istersen <a href="/grafana/" target="_blank" rel="noopener noreferrer" className="underline font-medium">Grafana ana sayfası</a>'na git.
                </div>
            </div>
        );
    }

    // Belirli dashboard — iframe ile göster
    const selected = DASHBOARDS.find(d => d.uid === uid);

    // pgstat UI'dan from/to ve var-* parametreleri geçirilebilir
    // Örn: /grafana/pgstat-instance-detail?from=now-24h&to=now&var-instance=3
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const variableParams = Array.from(searchParams.entries())
        .filter(([k]) => k.startsWith('var-'))
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

    let grafanaUrl = `/grafana/d/${uid}/?orgId=1&theme=light`;
    if (from) grafanaUrl += `&from=${encodeURIComponent(from)}`;
    if (to) grafanaUrl += `&to=${encodeURIComponent(to)}`;
    if (variableParams) grafanaUrl += `&${variableParams}`;

    return (
        <div className="-m-6 flex flex-col" style={{ height: 'calc(100vh - 0px)' }}>
            {/* Üst bar — geri buton + dashboard seçici + yenile */}
            <div className="flex items-center gap-3 px-4 py-2 bg-white border-b border-[#E2E8F0] shadow-sm">
                <button
                    onClick={() => navigate('/grafana')}
                    className="px-3 py-1.5 text-sm bg-[#F1F5F9] text-[#475569] rounded-md hover:bg-[#E2E8F0]"
                    title="Dashboard listesine dön"
                >
                    ← Liste
                </button>
                <span className="text-2xl">{selected?.icon || '📊'}</span>
                <div className="flex-1">
                    <h1 className="text-sm font-semibold text-[#1E293B]">{selected?.title || uid}</h1>
                    {selected?.description && (
                        <p className="text-xs text-[#64748B]">{selected.description}</p>
                    )}
                </div>
                <select
                    value={uid}
                    onChange={e => navigate(`/grafana/${e.target.value}`)}
                    className="text-sm border border-[#CBD5E1] rounded-md px-3 py-1.5 bg-white"
                    title="Dashboard değiştir"
                >
                    {DASHBOARDS.map(d => (
                        <option key={d.uid} value={d.uid}>{d.icon} {d.title}</option>
                    ))}
                </select>
                <button
                    onClick={() => setIframeKey(k => k + 1)}
                    className="px-3 py-1.5 text-sm bg-[#3B82F6] text-white rounded-md hover:bg-[#2563EB]"
                    title="Iframe'i yenile"
                >
                    🔄 Yenile
                </button>
                <a
                    href={`/grafana/d/${uid}/?orgId=1&theme=light`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 text-sm bg-white border border-[#CBD5E1] text-[#475569] rounded-md hover:bg-[#F8FAFC]"
                    title="Yeni sekmede aç"
                >
                    ↗ Yeni Sekme
                </a>
            </div>
            {/* Grafana iframe */}
            <iframe
                key={iframeKey}
                src={grafanaUrl}
                className="flex-1 w-full border-0"
                title={selected?.title || 'Grafana'}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            />
        </div>
    );
}
