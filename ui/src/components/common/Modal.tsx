import type { ReactNode } from 'react';

// =========================================================================
// Ortak Modal bileşenleri
// Birden fazla sayfada (AdaptiveAlerting, NotificationChannels, Settings ...)
// kullanilir. Buradan import edilir; sayfa icinde tekrar tanimlanmaz.
// =========================================================================

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
                <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-center justify-between">
                    <h2 className="font-semibold text-[#1E293B]">{title}</h2>
                    <button onClick={onClose} className="text-[#94A3B8] hover:text-[#475569] text-xl">×</button>
                </div>
                <div className="px-6 py-4">{children}</div>
            </div>
        </div>
    );
}

export function ModalFooter({ onClose, onSave, busy }: { onClose: () => void; onSave: () => void; busy: boolean }) {
    return (
        <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-end gap-2 -mx-6 -mb-4 mt-4">
            <button onClick={onClose} className="px-4 py-2 text-sm text-[#475569] hover:text-[#1E293B]">İptal</button>
            <button onClick={onSave} disabled={busy}
                className="px-5 py-2 bg-[#22C55E] text-white text-sm rounded-md hover:bg-[#16A34A] disabled:opacity-50">
                {busy ? 'Kaydediliyor...' : 'Kaydet'}
            </button>
        </div>
    );
}
