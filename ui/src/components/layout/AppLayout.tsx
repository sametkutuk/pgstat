import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function AppLayout() {
    return (
        <div className="flex min-h-screen bg-[#F1F5F9]">
            <Sidebar />
            <main className="flex-1 p-3 md:p-6 pt-14 md:pt-6 overflow-auto">
                <Outlet />
            </main>
        </div>
    );
}
