import { useParams, useNavigate, Link } from 'react-router-dom';
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
}

const DASHBOARDS: DashboardEntry[] = [
    {
        uid: 'pgstat-fleet-overview',
        title: 'Fleet Overview',
        description: 'Tüm instance\'ların tek ekrandaki durumu — NOC için',
        icon: '🌐',
    },
    {
        uid: 'pgstat-instance-detail',
        title: 'Instance Detail',
        description: '360° instance görünümü — DoD/WoW/MoM overlay\'li',
        icon: '🔍',
    },
    {
        uid: 'pgstat-top-queries-detail',
        title: 'Top Queries Detail',
        description: 'Sorgu seviyesinde derin analiz — drill-down\'dan açılır',
        icon: '📝',
    },
    {
        uid: 'pgstat-locks-activity',
        title: 'Locks & Activity',
        description: 'Aktif sorgu, wait events, blocking chains, vacuum progress',
        icon: '🔒',
    },
    {
        uid: 'pgstat-replication-wal',
        title: 'Replication & WAL',
        description: 'Replikasyon lag, slot durumu, WAL üretimi, archiver',
        icon: '🔄',
    },
    {
        uid: 'pgstat-io-buffers',
        title: 'I/O & Buffers (PG16+)',
        description: 'pg_stat_io detay — backend_type × context kırılımı',
        icon: '💾',
    },
    {
        uid: 'pgstat-vacuum-bloat',
        title: 'Vacuum & Bloat',
        description: 'Dead tuple oranı, autovacuum geçmişi, devam eden vacuumlar',
        icon: '🧹',
    },
    {
        uid: 'pgstat-database-tables',
        title: 'Database & Tables',
        description: 'Per-DB aktivite, en çok yazılan tablolar, deadlock/conflict',
        icon: '🗄️',
    },
    {
        uid: 'pgstat-alerts-slo',
        title: 'Alerts & SLO',
        description: 'Alert hacmi, MTTA/MTTR, gürültülü alert kodları, kanal başarı oranı',
        icon: '🚨',
    },
    {
        uid: 'pgstat-capacity-trends',
        title: 'Capacity & Trends',
        description: '30 günlük trend, lineer tahmin, kapasite planlaması',
        icon: '📈',
    },
];

export default function GrafanaEmbed() {
    const { uid } = useParams<{ uid?: string }>();
    const navigate = useNavigate();
    const [iframeKey, setIframeKey] = useState(0);

    // UID belirtilmediyse — dashboard listesi göster
    if (!uid) {
        return (
            <div className="p-6">
                <div className="mb-6">
                    <h1 className="text-xl font-bold text-[#1E293B]">Grafana Dashboards</h1>
                    <p className="text-sm text-[#64748B] mt-1">
                        Detaylı analiz ve trend grafikleri için bir dashboard seç. Pgstat UI içinde gömülü açılır.
                    </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {DASHBOARDS.map(d => (
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
                                </div>
                            </div>
                        </Link>
                    ))}
                </div>
                <div className="mt-6 bg-[#EFF6FF] border border-[#BFDBFE] rounded-md px-4 py-3 text-xs text-[#1E40AF]">
                    💡 Yeni sekmede tam ekran açmak istersen <a href="/grafana/" target="_blank" rel="noopener noreferrer" className="underline font-medium">Grafana ana sayfası</a>'na git.
                </div>
            </div>
        );
    }

    // Belirli dashboard — iframe ile göster
    const selected = DASHBOARDS.find(d => d.uid === uid);
    // kiosk=tv mode → Grafana'nın kendi top/side bar'ı gizli
    // theme=light → açık tema (env'de de varsayılan light)
    const grafanaUrl = `/grafana/d/${uid}/?orgId=1&kiosk=tv&theme=light`;

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
