import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { apiGet, apiLogout } from '../../api/client';

const links = [
    { to: '/', label: 'Dashboard', icon: '📊' },
    { to: '/instances', label: 'Instances', icon: '🖥️' },
    { to: '/clusters', label: 'Kümeler', icon: '🗂️' },
    { to: '/statements', label: 'Statements', icon: '📝' },
    { to: '/cluster-detail', label: 'Cluster Detay', icon: '🗄️' },
    { to: '/alerts', label: 'Alerts', icon: '🔔' },
    { to: '/jobs', label: 'Job Runs', icon: '⚙️' },
    { to: '/reports/history', label: 'Raporlar', icon: '📜' },
    { to: '/settings', label: 'Ayarlar', icon: '🛠️' },
];

/**
 * Sidebar — mobile responsive: küçük ekranda hamburger menü, büyük ekranda
 * sabit sol kolon. Mobil overlay açıldığında body scroll lock yok (basit
 * yaklaşım — overlay arkaplan tıklamayla kapanır).
 */
export default function Sidebar() {
    const navigate = useNavigate();
    const location = useLocation();
    const [mobileOpen, setMobileOpen] = useState(false);

    // Route değiştiğinde mobile menüyü kapat
    useEffect(() => {
        setMobileOpen(false);
    }, [location.pathname]);

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
        <>
            {/* Mobile hamburger button — sadece md altında görünür */}
            <button
                onClick={() => setMobileOpen(!mobileOpen)}
                className="md:hidden fixed top-3 left-3 z-50 bg-[#1E293B] text-white p-2 rounded-md shadow-lg print:hidden"
                aria-label="Menüyü aç/kapat">
                {mobileOpen ? '✕' : '☰'}
            </button>

            {/* Mobile overlay — sidebar açıkken arkaplan kararır */}
            {mobileOpen && (
                <div
                    className="md:hidden fixed inset-0 bg-black/50 z-30 print:hidden"
                    onClick={() => setMobileOpen(false)} />
            )}

            <aside className={`
                w-56 min-h-screen bg-[#1E293B] text-[#94A3B8] flex flex-col
                fixed md:static top-0 left-0 z-40
                transform transition-transform duration-200
                ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
                print:hidden
            `}>
                <div className="px-5 py-5 text-white text-lg font-bold tracking-wide">
                    pgstat
                </div>
                <nav className="flex-1 flex flex-col gap-0.5 px-2 overflow-y-auto">
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
        </>
    );
}
