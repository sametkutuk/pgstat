// Tarih aralığı seçici — preset + custom range.
// Reusable: persistKey verilirse localStorage'da hatırlar.
import { useEffect, useState } from 'react';

export interface TimeRange {
    fromIso: string;
    toIso: string;
}

function isoToLocal(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localToIso(local: string): string {
    return new Date(local).toISOString();
}

const PRESETS = [
    { label: '1sa', hours: 1 },
    { label: '6sa', hours: 6 },
    { label: '24sa', hours: 24 },
    { label: '7g', hours: 24 * 7 },
    { label: '30g', hours: 24 * 30 },
];

export function defaultRange(hours = 24): TimeRange {
    const to = new Date();
    const from = new Date(Date.now() - hours * 3600 * 1000);
    return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

export function loadPersistedRange(key: string): TimeRange {
    try {
        const raw = localStorage.getItem(key);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.fromIso && parsed.toIso) {
                // Relative ise yeniden hesapla (last 24h gibi)
                if (parsed.preset) {
                    return defaultRange(parsed.preset);
                }
                return { fromIso: parsed.fromIso, toIso: parsed.toIso };
            }
        }
    } catch { /* ignore */ }
    return defaultRange(24);
}

export default function TimeRangePicker({
    value,
    onChange,
    persistKey,
}: {
    value: TimeRange;
    onChange: (r: TimeRange) => void;
    persistKey?: string;
}) {
    const [fromLocal, setFromLocal] = useState(isoToLocal(value.fromIso));
    const [toLocal, setToLocal] = useState(isoToLocal(value.toIso));
    const [activePreset, setActivePreset] = useState<number | null>(24);

    // Dışarıdan value değişirse input'ları senkronla
    useEffect(() => {
        setFromLocal(isoToLocal(value.fromIso));
        setToLocal(isoToLocal(value.toIso));
    }, [value.fromIso, value.toIso]);

    const apply = (range: TimeRange, preset?: number) => {
        onChange(range);
        setActivePreset(preset ?? null);
        if (persistKey) {
            localStorage.setItem(persistKey, JSON.stringify({ ...range, preset }));
        }
    };

    const setPreset = (hours: number) => {
        const range = defaultRange(hours);
        apply(range, hours);
    };

    const applyCustom = () => {
        apply({ fromIso: localToIso(fromLocal), toIso: localToIso(toLocal) });
    };

    return (
        <div className="flex flex-wrap items-end gap-2 text-sm">
            <div className="flex gap-1">
                {PRESETS.map(p => (
                    <button
                        key={p.hours}
                        onClick={() => setPreset(p.hours)}
                        className={`px-2 py-1 text-xs rounded ${
                            activePreset === p.hours
                                ? 'bg-[#3B82F6] text-white'
                                : 'bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0]'
                        }`}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
            <div className="flex items-end gap-1 ml-2">
                <input
                    type="datetime-local"
                    value={fromLocal}
                    onChange={e => setFromLocal(e.target.value)}
                    className="border border-[#CBD5E1] rounded px-2 py-1 text-xs"
                />
                <span className="text-[#94A3B8] text-xs">→</span>
                <input
                    type="datetime-local"
                    value={toLocal}
                    onChange={e => setToLocal(e.target.value)}
                    className="border border-[#CBD5E1] rounded px-2 py-1 text-xs"
                />
                <button
                    onClick={applyCustom}
                    className="px-2 py-1 text-xs bg-[#3B82F6] text-white rounded hover:bg-[#2563EB]"
                >
                    Uygula
                </button>
            </div>
        </div>
    );
}
