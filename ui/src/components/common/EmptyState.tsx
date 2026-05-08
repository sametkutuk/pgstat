import type { ReactNode } from 'react';

/**
 * EmptyState — boş liste/tablo/grafik için friendly placeholder.
 *
 * Kullanım:
 *   <EmptyState
 *     icon="📭"
 *     title="Henüz instance eklenmedi"
 *     description="İlk PostgreSQL instance'ını ekleyerek izlemeye başlayın."
 *     action={{ label: '+ İlk Instance\'ı Ekle', onClick: () => setShow(true) }}
 *   />
 */
interface EmptyStateProps {
    icon?: string;
    title: string;
    description?: string;
    action?: {
        label: string;
        onClick: () => void;
    };
    children?: ReactNode;
}

export default function EmptyState({ icon = '📭', title, description, action, children }: EmptyStateProps) {
    return (
        <div className="text-center py-12 px-6 bg-white rounded-lg border border-[#E2E8F0]">
            <div className="text-4xl mb-3">{icon}</div>
            <h3 className="text-base font-semibold text-[#1E293B] mb-1">{title}</h3>
            {description && (
                <p className="text-sm text-[#64748B] max-w-md mx-auto mb-4">{description}</p>
            )}
            {action && (
                <button
                    onClick={action.onClick}
                    className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB]">
                    {action.label}
                </button>
            )}
            {children && <div className="mt-3">{children}</div>}
        </div>
    );
}
