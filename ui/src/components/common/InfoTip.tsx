import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * ⓘ butonu — hover veya tıklama ile bilgi baloncuğu gösterir.
 * Popup body'e portal ile render edilir — parent overflow:hidden/auto
 * olduğunda da görünür kalır (örn. tab container, modal'lar).
 *
 * Kullanım: <InfoTip text="Açıklama. \n Multi-line de destekli." />
 */
export default function InfoTip({ text, className = '' }: { text: string; className?: string }) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const btnRef = useRef<HTMLButtonElement>(null);

    // Açıldığında butonun pozisyonuna göre popup koordinatlarını hesapla
    useEffect(() => {
        if (!open || !btnRef.current) {
            setPos(null);
            return;
        }
        const rect = btnRef.current.getBoundingClientRect();
        // Popup'ı butonun üstünde, yatayda ortalı yerleştir
        setPos({
            left: rect.left + rect.width / 2,
            top: rect.top, // popup top:absolute ile alttan açar
        });
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    return (
        <span className={`relative inline-flex ${className}`}>
            <button
                ref={btnRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                onMouseEnter={() => setOpen(true)}
                onMouseLeave={() => setOpen(false)}
                className="w-4 h-4 rounded-full bg-[#E2E8F0] text-[#64748B] text-[10px] font-bold leading-none flex items-center justify-center hover:bg-[#CBD5E1] hover:text-[#475569] transition-colors cursor-help flex-shrink-0"
                aria-label="Bilgi"
            >
                i
            </button>
            {open && pos && createPortal(
                <div
                    className="fixed z-[9999] px-4 py-3 bg-[#1E293B] text-white text-xs rounded-lg shadow-2xl leading-relaxed pointer-events-none whitespace-pre-line"
                    style={{
                        left: pos.left,
                        top: pos.top,
                        transform: 'translate(-50%, calc(-100% - 8px))',
                        minWidth: '280px',
                        width: 'max-content',
                        maxWidth: 'min(560px, calc(100vw - 32px))',
                    }}
                >
                    {text}
                </div>,
                document.body
            )}
        </span>
    );
}
