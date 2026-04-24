import { useState, useRef, useEffect } from 'react';

/**
 * ⓘ butonu — hover veya tıklama ile bilgi baloncuğu gösterir.
 * Kullanım: <InfoTip text="Açıklama metni" />
 */
export default function InfoTip({ text, className = '' }: { text: string; className?: string }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    return (
        <div ref={ref} className={`relative inline-flex ${className}`}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                onMouseEnter={() => setOpen(true)}
                onMouseLeave={() => setOpen(false)}
                className="w-4 h-4 rounded-full bg-[#E2E8F0] text-[#64748B] text-[10px] font-bold leading-none flex items-center justify-center hover:bg-[#CBD5E1] hover:text-[#475569] transition-colors cursor-help flex-shrink-0"
                aria-label="Bilgi"
            >
                i
            </button>
            {open && (
                <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 px-3 py-2 bg-[#1E293B] text-white text-xs rounded-lg shadow-lg leading-relaxed pointer-events-none">
                    {text}
                    <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-[5px] border-r-[5px] border-t-[5px] border-l-transparent border-r-transparent border-t-[#1E293B]" />
                </div>
            )}
        </div>
    );
}
