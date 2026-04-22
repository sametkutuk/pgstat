interface Props {
    label: string;
    value: number | string;
    color?: string;
}

export default function StatCard({ label, value, color = '#3B82F6' }: Props) {
    return (
        <div
            className="bg-white rounded-lg p-5 shadow-sm"
            style={{ borderTop: `3px solid ${color}` }}
        >
            <div className="text-xs text-[#64748B] mb-2">{label}</div>
            <div className="text-2xl font-bold" style={{ color }}>
                {value}
            </div>
        </div>
    );
}
