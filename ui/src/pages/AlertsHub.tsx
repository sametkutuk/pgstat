import { lazy, Suspense } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import Alerts from './Alerts';
import AlertRules from './AlertRules';
import AdaptiveAlerting from './AdaptiveAlerting';
import { MessageTemplatesTab } from './Settings';

const SystemHealthDashboard = lazy(() => import('./SystemHealthDashboard'));

export default function AlertsHub() {
    const location = useLocation();
    const navigate = useNavigate();

    const path = location.pathname;
    const activeTab: 'open' | 'system-health' | 'rules' | 'adaptive' | 'templates' =
        path.startsWith('/alerts/system-health') ? 'system-health' :
            path.startsWith('/alerts/rules') ? 'rules' :
                path.startsWith('/alerts/adaptive') ? 'adaptive' :
                    path.startsWith('/alerts/templates') ? 'templates' :
                        'open';

    const tabs = [
        { key: 'open' as const, label: "Acik Alert'ler", path: '/alerts' },
        { key: 'system-health' as const, label: 'HEALTH System Sagligi', path: '/alerts/system-health' },
        { key: 'rules' as const, label: 'Alert Kurallari', path: '/alerts/rules' },
        { key: 'adaptive' as const, label: 'Adaptive Alerting', path: '/alerts/adaptive' },
        { key: 'templates' as const, label: 'Mesaj Sablonlari', path: '/alerts/templates' },
    ];

    return (
        <div>
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
            {activeTab === 'system-health' && (
                <Suspense fallback={<div className="p-4 text-sm text-[#64748B]">Yukleniyor...</div>}>
                    <SystemHealthDashboard />
                </Suspense>
            )}
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
