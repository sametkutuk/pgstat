export type ViewMode = 'summary' | 'raw';

interface Props {
    mode: ViewMode;
    onChange: (mode: ViewMode) => void;
}

export default function ViewModeToggle({ mode, onChange }: Props) {
    return (
        <div className="inline-flex rounded-md border border-[#E2E8F0] bg-white p-0.5">
            <button
                type="button"
                onClick={() => onChange('summary')}
                className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors ${mode === 'summary'
                    ? 'border-[#3B82F6] text-[#2563EB] bg-[#EFF6FF]'
                    : 'border-transparent text-[#64748B] hover:text-[#1E293B] hover:bg-[#F8FAFC]'
                    }`}
            >
                📊 Toplam
            </button>
            <button
                type="button"
                onClick={() => onChange('raw')}
                className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors ${mode === 'raw'
                    ? 'border-[#3B82F6] text-[#2563EB] bg-[#EFF6FF]'
                    : 'border-transparent text-[#64748B] hover:text-[#1E293B] hover:bg-[#F8FAFC]'
                    }`}
            >
                📋 Ham Delta
            </button>
        </div>
    );
}
