interface Props {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function ConfirmDialog({ open, title, message, confirmLabel = 'Sil', onConfirm, onCancel }: Props) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onCancel}>
            <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-base font-semibold mb-2">{title}</h3>
                <p className="text-sm text-[#64748B] mb-5">{message}</p>
                <div className="flex gap-2 justify-end">
                    <button onClick={onCancel}
                        className="px-4 py-2 text-sm border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">
                        İptal
                    </button>
                    <button onClick={onConfirm}
                        className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700">
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
