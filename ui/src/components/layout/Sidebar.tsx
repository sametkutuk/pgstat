import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiLogout } from '../../api/client';

const links = [
    { to: '/', label: 'Dashboard', icon: '📊' },
    { to: '/instances', label: 'Instances', icon: '🖥️' },
    { to: '/statements', label: 'Statements', icon: '📝' },
    { to: '/cluster-detail', label: 'Cluster Detay', icon: '🗄️' },
    { to: '/alerts', label: 'Alerts', icon: '🔔' },
    { to: '/jobs', label: 'Job Runs', icon: '⚙️' },
    { to: '/settings', label: 'Ayarlar', icon: '🛠️' },
    { to: '/settings/alert-rules', label: 'Alert Kuralları', icon: '📋' },
    { to: '/settings/adaptive-alerting', label: 'Adaptive Alerting', icon: '⚡' },
];

export default function Sidebar() {
    const navigate = useNavigate();

    const handleLogout = async () => {
        await apiLogout();
        navigate('/login');
    };

    const { data } = useQuery<{ version: string }>({
        queryKey: ['version'],
        queryFn: () => apiGet('/version'),
        staleTime: Infinity,
    });

    return (
        <aside className="w-56 min-h-screen bg-[#1E293B] text-[#94A3B8] flex flex-col">
            <div className="px-5 py-5 text-white text-lg font-bold tracking-wide">
                pgstat
            </div>
            <nav className="flex-1 flex flex-col gap-0.5 px-2">
                {links.map((l) => (
                    <NavLink
                        key={l.to}
                        to={l.to}
                        end={l.to === '/'}
                        className={({ isActive }) =>
                            `flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors ${isActive
                                ? 'bg-[#3B82F6] text-white'
                                : 'hover:bg-[#334155] hover:text-white'
                            }`
                        }
                    >
                        <span>{l.icon}</span>
                        <span>{l.label}</span>
                    </NavLink>
                ))}

                {/* Grafana — pgstat UI icinde iframe olarak gomulu */}
                <NavLink
                    to="/grafana"
                    className={({ isActive }) =>
                        `flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors mt-2 border-t border-[#334155] pt-3 ${isActive
                            ? 'bg-[#3B82F6] text-white'
                            : 'hover:bg-[#334155] hover:text-white'
                        }`
                    }
                    title="Grafana dashboard'lari (10 adet)"
                >
                    <span>📈</span>
                    <span>Grafana</span>
                </NavLink>
            </nav>
            <div className="px-3 py-3 border-t border-[#334155]">
                <button onClick={handleLogout}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[#94A3B8] hover:text-white hover:bg-[#334155] rounded-md transition-colors">
                    <span>⎋</span>
                    <span>Çıkış</span>
                </button>
                {data?.version && (
                    <div className="px-3 pt-2 text-xs text-[#475569]">v{data.version}</div>
                )}
            </div>
        </aside>
    );
}
