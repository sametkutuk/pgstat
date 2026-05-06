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
    const [pos, setPos] = useState<{ left: number; top: number; placement: 'above' | 'below' } | null>(null);
    const btnRef = useRef<HTMLButtonElement>(null);

    // Açıldığında butonun pozisyonuna göre popup koordinatlarını hesapla.
    // Üstte yer yoksa (sayfa başında / viewport top'a yakın) altta aç.
    useEffect(() => {
        if (!open || !btnRef.current) {
            setPos(null);
            return;
        }
        const rect = btnRef.current.getBoundingClientRect();
        const minTopSpace = 250;  // popup tahmini yüksekliği (uzun metin için)
        const placement: 'above' | 'below' = rect.top < minTopSpace ? 'below' : 'above';
        setPos({
            left: rect.left + rect.width / 2,
            top: placement === 'above' ? rect.top - 8 : rect.bottom + 8,
            placement,
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

    // Hover'da geç kapatma — kullanıcı popup'a hareket ederken kapanmasın.
    const closeTimer = useRef<number | null>(null);
    const scheduleClose = () => {
        if (closeTimer.current) window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => setOpen(false), 200);
    };
    const cancelClose = () => {
        if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    };

    return (
        <span className={`relative inline-flex ${className}`}>
            <button
                ref={btnRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                onMouseEnter={() => { cancelClose(); setOpen(true); }}
                onMouseLeave={scheduleClose}
                className="w-4 h-4 rounded-full bg-[#E2E8F0] text-[#64748B] text-[10px] font-bold leading-none flex items-center justify-center hover:bg-[#CBD5E1] hover:text-[#475569] transition-colors cursor-help flex-shrink-0"
                aria-label="Bilgi"
            >
                i
            </button>
            {open && pos && createPortal(
                <div
                    className="fixed z-[9999] px-4 py-3 bg-[#1E293B] text-white text-xs rounded-lg shadow-2xl leading-relaxed whitespace-pre-line"
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                    style={{
                        left: pos.left,
                        top: pos.top,
                        transform: pos.placement === 'above'
                            ? 'translate(-50%, -100%)'
                            : 'translate(-50%, 0)',
                        minWidth: '280px',
                        width: 'max-content',
                        maxWidth: 'min(560px, calc(100vw - 32px))',
                        maxHeight: 'calc(100vh - 32px)',
                        overflowY: 'auto',
                        // pointer-events:auto (default) — popup üzerinde scroll/hover işler
                    }}
                >
                    {text}
                </div>,
                document.body
            )}
        </span>
    );
}
