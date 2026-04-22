import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiLogin, setToken } from '../api/client';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';

export default function Login() {
    const navigate = useNavigate();
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const { data: versionData } = useQuery<{ version: string }>({
        queryKey: ['version'],
        queryFn: () => apiGet('/version'),
        staleTime: Infinity,
    });

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const { token } = await apiLogin(password);
            setToken(token);
            navigate('/');
        } catch (err: any) {
            setError(err.message || 'Giriş başarısız');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#0F172A] flex items-center justify-center">
            <div className="w-full max-w-sm">
                <div className="text-center mb-8">
                    <div className="text-white text-3xl font-bold tracking-wide mb-1">pgstat</div>
                    <div className="text-[#64748B] text-sm">PostgreSQL İstatistik Toplama Sistemi</div>
                    {versionData?.version && (
                        <div className="text-[#475569] text-xs mt-1">v{versionData.version}</div>
                    )}
                </div>

                <div className="bg-[#1E293B] rounded-xl p-8 shadow-2xl">
                    <h2 className="text-white text-lg font-semibold mb-6">Giriş</h2>
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="block text-xs text-[#94A3B8] mb-1.5">Şifre</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoFocus
                                className="w-full bg-[#0F172A] border border-[#334155] rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#3B82F6] transition-colors"
                                placeholder="••••••••••••"
                            />
                        </div>

                        {error && (
                            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2.5 text-red-400 text-sm">
                                {error}
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={loading || !password}
                            className="w-full bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
                        >
                            {loading ? 'Giriş yapılıyor...' : 'Giriş Yap'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
