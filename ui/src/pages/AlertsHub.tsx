import { useNavigate, useLocation, Link } from 'react-router-dom';
import Alerts from './Alerts';
import AlertRules from './AlertRules';
import AdaptiveAlerting from './AdaptiveAlerting';
import { MessageTemplatesTab } from './Settings';

/**
 * Alerts Hub — tek sayfada 4 tab (sub-route ile):
 *   /alerts            → Açık Alert'ler
 *   /alerts/rules      → Alert Kuralları
 *   /alerts/adaptive   → Adaptive Alerting (kanallar, maintenance, system config)
 *   /alerts/templates  → Mesaj Şablonları
 */
export default function AlertsHub() {
    const location = useLocation();
    const navigate = useNavigate();

    // Sub-route'tan aktif tab'ı belirle
    const path = location.pathname;
    const activeTab: 'open' | 'rules' | 'adaptive' | 'templates' =
        path.startsWith('/alerts/rules') ? 'rules' :
            path.startsWith('/alerts/adaptive') ? 'adaptive' :
                path.startsWith('/alerts/templates') ? 'templates' :
                    'open';

    const tabs = [
        { key: 'open' as const, label: '🔔 Açık Alert\'ler', path: '/alerts' },
        { key: 'rules' as const, label: '📋 Alert Kuralları', path: '/alerts/rules' },
        { key: 'adaptive' as const, label: '⚡ Adaptive Alerting', path: '/alerts/adaptive' },
        { key: 'templates' as const, label: '✉️ Mesaj Şablonları', path: '/alerts/templates' },
    ];

    return (
        <div>
            {/* Tab navigation */}
            <div className="flex gap-1 mb-5 border-b border-[#E2E8F0]">
                {tabs.map((t) => (
                    <Link
                        key={t.key}
                        to={t.path}
                        onClick={(e) => { e.preventDefault(); navigate(t.path); }}
                        className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === t.key
                                ? 'border-[#3B82F6] text-[#3B82F6]'
                                : 'border-transparent text-[#64748B] hover:text-[#1E293B]'
                            }`}>
                        {t.label}
                    </Link>
                ))}
            </div>

            {activeTab === 'open' && <Alerts />}
            {activeTab === 'rules' && <AlertRules />}
            {activeTab === 'adaptive' && <AdaptiveAlerting />}
            {activeTab === 'templates' && (
                <div className="bg-white rounded-lg shadow-sm">
                    <MessageTemplatesTab />
                </div>
            )}
        </div>
    );
}
