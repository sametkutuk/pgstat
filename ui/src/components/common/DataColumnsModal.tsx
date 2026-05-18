/**
 * Generic kolon yönetim modal'ı — tüm stat tab'ları için reusable.
 * StatementColumnsModal ile aynı UX, generic prop'larla.
 */
import { useEffect, useState } from 'react';

export interface AvailableColumn {
    key: string;
    label: string;
    since: number;
}

export interface ColumnsMeta {
    defaults: string[];
    available: AvailableColumn[];
}

/** LocalStorage tabanlı kolon tercihi hook'u */
export function useDataColumns(storageKey: string, defaults: string[], meta?: ColumnsMeta) {
    const [selected, setSelectedState] = useState<string[]>(() => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr) && arr.length > 0) return arr;
            }
        } catch { /* ignore */ }
        return defaults;
    });

    function setSelected(cols: string[]) {
        setSelectedState(cols);
        try { localStorage.setItem(storageKey, JSON.stringify(cols)); } catch { /* ignore */ }
    }

    return { selected, setSelected, meta };
}

/** Sayısal değeri kısa formatla (time/byte/count) */
export function fmtValue(key: string, val: any): string {
    if (val == null) return '—';
    const n = Number(val);
    if (Number.isNaN(n)) return String(val);

    // Zaman alanları (ms)
    if (key.includes('time') && (key.includes('_ms') || key.includes('_time'))) {
        if (n >= 60_000) return `${(n / 60_000).toFixed(1)}dk`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(2)}s`;
        if (n >= 1) return `${n.toFixed(1)}ms`;
        return `${n.toFixed(2)}ms`;
    }

    // Byte alanları
    if (key.includes('bytes') || key.includes('_byte')) {
        if (n >= 1e9) return `${(n / 1e9).toFixed(1)}GB`;
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}KB`;
        return `${n}B`;
    }

    // Genel sayısal
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
}

interface ModalProps {
    open: boolean;
    onClose: () => void;
    selected: string[];
    onChange: (cols: string[]) => void;
    meta: ColumnsMeta | undefined;
    pgMajor?: number;
    title?: string;
}

export default function DataColumnsModal({ open, onClose, selected, onChange, meta, pgMajor, title }: ModalProps) {
    const [draft, setDraft] = useState<Set<string>>(new Set(selected));

    useEffect(() => {
        if (open) setDraft(new Set(selected));
    }, [open, selected]);

    if (!open || !meta) return null;

    function toggle(key: string) {
        const next = new Set(draft);
        if (next.has(key)) next.delete(key); else next.add(key);
        setDraft(next);
    }

    function applyAndClose() { onChange(Array.from(draft)); onClose(); }
    function resetDefaults() { setDraft(new Set(meta!.defaults)); }

    const cols = pgMajor != null
        ? meta.available.filter(c => c.since <= pgMajor)
        : meta.available;

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
                <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-center justify-between">
                    <h2 className="font-semibold text-[#1E293B]">{title || '⚙️ Sütun Yönet'}</h2>
                    <button onClick={onClose} className="text-[#94A3B8] hover:text-[#1E293B]">✕</button>
                </div>
                <div className="px-6 py-4 overflow-y-auto flex-1">
                    <div className="text-xs text-[#64748B] mb-3">
                        Seçtiğiniz kolonlar API'den çekilir. <b>{draft.size}</b> kolon seçili
                        {pgMajor != null && <> · PG{pgMajor} için {cols.length} kolon</>}.
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        {cols.map(c => (
                            <label key={c.key}
                                className="flex items-center gap-2 text-xs cursor-pointer py-1 px-2 rounded hover:bg-[#F8FAFC]">
                                <input type="checkbox" checked={draft.has(c.key)} onChange={() => toggle(c.key)} className="w-3.5 h-3.5" />
                                <span className={draft.has(c.key) ? 'text-[#1E293B] font-medium' : 'text-[#64748B]'}>{c.label}</span>
                                {c.since > 11 && <span className="text-[9px] text-[#94A3B8] ml-auto">PG{c.since}+</span>}
                            </label>
                        ))}
                    </div>
                </div>
                <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-between gap-2">
                    <button onClick={resetDefaults} className="px-3 py-1.5 text-xs text-[#475569] hover:underline">Default'a Dön</button>
                    <div className="flex gap-2">
                        <button onClick={onClose} className="px-4 py-2 text-sm text-[#475569]">İptal</button>
                        <button onClick={applyAndClose} disabled={draft.size === 0}
                            className="px-5 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB] disabled:opacity-50">Uygula</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
