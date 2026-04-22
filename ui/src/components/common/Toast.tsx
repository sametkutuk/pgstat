import { useState, createContext, useContext, useCallback } from 'react';

interface ToastItem {
    id: number;
    message: string;
    type: 'success' | 'error';
}

interface ToastCtx {
    success: (msg: string) => void;
    error: (msg: string) => void;
}

const ToastContext = createContext<ToastCtx>({ success: () => { }, error: () => { } });

export function useToast() {
    return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    const add = useCallback((message: string, type: 'success' | 'error') => {
        const id = nextId++;
        setToasts((t) => [...t, { id, message, type }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
    }, []);

    const success = useCallback((msg: string) => add(msg, 'success'), [add]);
    const error = useCallback((msg: string) => add(msg, 'error'), [add]);

    return (
        <ToastContext.Provider value={{ success, error }}>
            {children}
            <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
                {toasts.map((t) => (
                    <div
                        key={t.id}
                        className={`px-4 py-2.5 rounded-lg shadow-lg text-sm text-white transition-all ${t.type === 'success' ? 'bg-green-600' : 'bg-red-600'
                            }`}
                    >
                        {t.message}
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}
