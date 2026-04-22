const colorMap: Record<string, string> = {
    ready: 'bg-green-100 text-green-700',
    degraded: 'bg-yellow-100 text-yellow-700',
    pending: 'bg-blue-100 text-blue-700',
    discovering: 'bg-blue-100 text-blue-700',
    baselining: 'bg-blue-100 text-blue-700',
    enriching: 'bg-blue-100 text-blue-700',
    paused: 'bg-gray-100 text-gray-600',
    // severity
    critical: 'bg-red-100 text-red-700',
    error: 'bg-red-100 text-red-600',
    warning: 'bg-yellow-100 text-yellow-700',
    info: 'bg-blue-100 text-blue-600',
    // status
    open: 'bg-red-100 text-red-700',
    acknowledged: 'bg-yellow-100 text-yellow-700',
    resolved: 'bg-green-100 text-green-700',
    success: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    partial: 'bg-yellow-100 text-yellow-700',
    running: 'bg-blue-100 text-blue-700',
};

export default function Badge({ value }: { value: string }) {
    const cls = colorMap[value] || 'bg-gray-100 text-gray-600';
    return (
        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
            {value}
        </span>
    );
}
