import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * ErrorBoundary — React render hatasi olursa friendly UI goster.
 *
 * Class component zorunlu — React error boundary'leri sadece class'larda calisir.
 *
 * Kullanim:
 *   <ErrorBoundary>
 *     <App />
 *   </ErrorBoundary>
 */
interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        // Console'a tam hata bilgisi
        console.error('[ErrorBoundary] React render error:', error);
        console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);

        this.setState({ errorInfo });

        // Opsiyonel: log endpoint'ine fire-and-forget POST
        // (auth gerektirir, hata sırasında çalışmayabilir — sessizce atlat)
        try {
            const token = localStorage.getItem('pgstat_token');
            if (token) {
                fetch('/api/client-error', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({
                        message: error.message,
                        stack: error.stack,
                        componentStack: errorInfo.componentStack,
                        url: window.location.href,
                        timestamp: new Date().toISOString(),
                    }),
                }).catch(() => { /* sessiz */ });
            }
        } catch { /* sessiz */ }
    }

    handleReload = () => {
        window.location.reload();
    };

    handleReset = () => {
        this.setState({ hasError: false, error: null, errorInfo: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen bg-[#F1F5F9] flex items-center justify-center p-6">
                    <div className="max-w-2xl w-full bg-white rounded-lg shadow-lg p-8">
                        <div className="text-center mb-6">
                            <div className="text-5xl mb-3">⚠️</div>
                            <h1 className="text-xl font-bold text-[#1E293B] mb-2">
                                Beklenmeyen bir hata oluştu
                            </h1>
                            <p className="text-sm text-[#64748B]">
                                Sayfa beklenmedik şekilde çalışmayı durdurdu. Yenilemeyi deneyin veya
                                bir önceki sayfaya geri dönün.
                            </p>
                        </div>

                        {this.state.error && (
                            <div className="bg-red-50 border border-red-200 rounded-md p-3 mb-4">
                                <div className="text-xs font-semibold text-red-700 mb-1">Hata mesajı:</div>
                                <div className="text-xs text-red-700 font-mono break-all">
                                    {this.state.error.message}
                                </div>
                            </div>
                        )}

                        <details className="mb-4">
                            <summary className="text-xs text-[#64748B] cursor-pointer hover:text-[#1E293B]">
                                Teknik detaylar (geliştiriciler için)
                            </summary>
                            <pre className="mt-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded p-2 text-[10px] font-mono overflow-x-auto max-h-48">
                                {this.state.error?.stack}
                                {this.state.errorInfo?.componentStack}
                            </pre>
                        </details>

                        <div className="flex gap-3 justify-center">
                            <button onClick={this.handleReload}
                                className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB]">
                                🔄 Sayfayı Yenile
                            </button>
                            <button onClick={this.handleReset}
                                className="px-4 py-2 bg-[#F1F5F9] text-[#64748B] text-sm rounded-md hover:bg-[#E2E8F0]">
                                Tekrar Dene
                            </button>
                        </div>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
