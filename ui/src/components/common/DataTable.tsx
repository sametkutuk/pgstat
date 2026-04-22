interface Column<T> {
    key: string;
    header: string;
    render?: (row: T) => React.ReactNode;
    className?: string;
}

interface Props<T> {
    columns: Column<T>[];
    data: T[];
    onRowClick?: (row: T) => void;
    emptyText?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function DataTable<T = any>({
    columns,
    data,
    onRowClick,
    emptyText = 'Veri bulunamadı',
}: Props<T>) {
    if (data.length === 0) {
        return <div className="text-center text-[#64748B] py-8">{emptyText}</div>;
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-[#E2E8F0]">
                        {columns.map((col) => (
                            <th
                                key={col.key}
                                className={`text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wider ${col.className || ''}`}
                            >
                                {col.header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {data.map((row, i) => (
                        <tr
                            key={i}
                            onClick={() => onRowClick?.(row)}
                            className={`border-b border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors ${onRowClick ? 'cursor-pointer' : ''
                                }`}
                        >
                            {columns.map((col) => (
                                <td key={col.key} className={`py-2.5 px-3 ${col.className || ''}`}>
                                    {col.render
                                        ? col.render(row)
                                        : String((row as Record<string, unknown>)[col.key] ?? '-')}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
