import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';

// Versiyon-agnostik default kolonlar
const DEFAULT_COLS = [
    'total_calls',
    'total_exec_time_ms',
    'mean_exec_time_ms',
    'min_exec_time_ms',
    'max_exec_time_ms',
    'stddev_exec_time_ms',
    'total_rows',
    'total_shared_blks_hit',
    'total_shared_blks_read',
    'total_temp_blks_written',
    'total_blk_read_time',
];

const STORAGE_KEY = 'pgstat.statements.columns';

export interface AvailableColumn {
    key: string;
    label: string;
    since: number; // ilk var oldugu PG surumu
}

export interface ColumnsMeta {
    defaults: string[];
    available: AvailableColumn[];
}

// LocalStorage tabanli kullanici tercihi
export function useStatementColumns(): {
    selected: string[];
    setSelected: (cols: string[]) => void;
    meta: ColumnsMeta | undefined;
    isLoading: boolean;
} {
    const [selected, setSelectedState] = useState<string[]>(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr) && arr.length > 0) return arr;
            }
        } catch { /* ignore */ }
        return DEFAULT_COLS;
    });

    const { data: meta, isLoading } = useQuery<ColumnsMeta>({
        queryKey: ['statements-columns-meta'],
        queryFn: () => apiGet('/statements/columns'),
        staleTime: 60_000 * 60, // 1 saat — bu metadata nadiren degisir
    });

    function setSelected(cols: string[]) {
        setSelectedState(cols);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cols)); } catch { /* ignore */ }
    }

    return { selected, setSelected, meta, isLoading };
}

// Sayisal degeri kisa formatla
export function fmtStmtValue(key: string, val: any): string {
    if (val == null) return '—';
    const n = Number(val);
    if (Number.isNaN(n)) return String(val);

    // Zaman alanlari (ms)
    if (key.endsWith('_time_ms') || key.endsWith('_time') ||
        key === 'total_exec_time_ms' || key === 'total_plan_time_ms' ||
        key.startsWith('total_jit_') && key.endsWith('_time')) {
        if (n >= 60_000) return `${(n / 60_000).toFixed(1)}dk`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(2)}s`;
        if (n >= 1) return `${n.toFixed(1)}ms`;
        return `${n.toFixed(2)}ms`;
    }

    // Byte
    if (key === 'total_wal_bytes') {
        if (n >= 1e9) return `${(n / 1e9).toFixed(1)}GB`;
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}KB`;
        return `${n}B`;
    }

    // Genel sayisal
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
}

interface ModalProps {
    open: boolean;
    onClose: () => void;
    selected: string[];
    onChange: (cols: string[]) => void;
    meta: ColumnsMeta | undefined;
}

export default function StatementColumnsModal({ open, onClose, selected, onChange, meta }: ModalProps) {
    const [draft, setDraft] = useState<Set<string>>(new Set(selected));

    useEffect(() => {
        if (open) setDraft(new Set(selected));
    }, [open, selected]);

    if (!open || !meta) return null;

    function toggle(key: string) {
        const next = new Set(draft);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setDraft(next);
    }

    function applyAndClose() {
        onChange(Array.from(draft));
        onClose();
    }

    function resetDefaults() {
        setDraft(new Set(meta!.defaults));
    }

    // Surume gore grupla
    const groups: Record<number, AvailableColumn[]> = {};
    meta.available.forEach(c => {
        if (!groups[c.since]) groups[c.since] = [];
        groups[c.since].push(c);
    });
    const sinceList = Object.keys(groups).map(Number).sort();

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
                <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-center justify-between">
                    <h2 className="font-semibold text-[#1E293B]">⚙️ Statement Kolonlarını Yönet</h2>
                    <button onClick={onClose} className="text-[#94A3B8] hover:text-[#1E293B]">✕</button>
                </div>
                <div className="px-6 py-4 overflow-y-auto flex-1">
                    <div className="text-xs text-[#64748B] mb-3">
                        Sadece seçtiğiniz kolonlar API'den çekilir — DB ve network tasarrufu.
                        Tercih tarayıcıda kaydedilir. <b>{draft.size}</b> kolon seçili.
                    </div>
                    {sinceList.map(since => (
                        <div key={since} className="mb-4">
                            <div className="text-xs font-semibold text-[#475569] mb-2 uppercase tracking-wide">
                                PG {since}+ {since === 11 ? '(tüm sürümlerde var)' : '(opsiyonel — eski sürümlerde NULL)'}
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                {groups[since].map(c => (
                                    <label key={c.key}
                                        className="flex items-center gap-2 text-xs cursor-pointer py-1 px-2 rounded hover:bg-[#F8FAFC]">
                                        <input
                                            type="checkbox"
                                            checked={draft.has(c.key)}
                                            onChange={() => toggle(c.key)}
                                            className="w-3.5 h-3.5"
                                        />
                                        <span className={draft.has(c.key) ? 'text-[#1E293B] font-medium' : 'text-[#64748B]'}>
                                            {c.label}
                                        </span>
                                        <span className="text-[10px] text-[#94A3B8] font-mono ml-auto">{c.key}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
                <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-between gap-2">
                    <button onClick={resetDefaults}
                        className="px-3 py-1.5 text-xs text-[#475569] hover:underline">
                        Default'a Dön
                    </button>
                    <div className="flex gap-2">
                        <button onClick={onClose}
                            className="px-4 py-2 text-sm text-[#475569]">İptal</button>
                        <button onClick={applyAndClose}
                            disabled={draft.size === 0}
                            className="px-5 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB] disabled:opacity-50">
                            Uygula
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
