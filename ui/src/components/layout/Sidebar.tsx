import { NavLink } from 'react-router-dom';

const links = [
    { to: '/', label: 'Dashboard', icon: '📊' },
    { to: '/instances', label: 'Instances', icon: '🖥️' },
    { to: '/statements', label: 'Statements', icon: '📝' },
    { to: '/cluster-detail', label: 'Cluster Detay', icon: '🗄️' },
    { to: '/alerts', label: 'Alerts', icon: '🔔' },
    { to: '/jobs', label: 'Job Runs', icon: '⚙️' },
    { to: '/settings', label: 'Ayarlar', icon: '🛠️' },
];

export default function Sidebar() {
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
            </nav>
        </aside>
    );
}
