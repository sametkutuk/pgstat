/**
 * Skeleton — yükleme sırasında gösterilecek animasyonlu placeholder.
 *
 * Kullanım:
 *   <Skeleton />                          // tek satır
 *   <Skeleton width="60%" />              // sabit genişlik
 *   <SkeletonTable rows={5} cols={4} />   // tablo iskeleti
 *   <SkeletonCard />                      // kart iskeleti (header + 3 satır)
 */

interface SkeletonProps {
    width?: string;
    height?: string;
    className?: string;
}

export default function Skeleton({ width = '100%', height = '1rem', className = '' }: SkeletonProps) {
    return (
        <div
            className={`bg-[#E2E8F0] rounded animate-pulse ${className}`}
            style={{ width, height }}
        />
    );
}

interface SkeletonTableProps {
    rows?: number;
    cols?: number;
}

export function SkeletonTable({ rows = 5, cols = 5 }: SkeletonTableProps) {
    return (
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
            {/* Header */}
            <div className="border-b border-[#E2E8F0] px-4 py-3 flex gap-4">
                {Array.from({ length: cols }).map((_, i) => (
                    <Skeleton key={i} width={`${100 / cols}%`} height="0.75rem" />
                ))}
            </div>
            {/* Rows */}
            {Array.from({ length: rows }).map((_, r) => (
                <div key={r} className="border-b border-[#F1F5F9] px-4 py-3 flex gap-4">
                    {Array.from({ length: cols }).map((_, c) => (
                        <Skeleton key={c} width={`${100 / cols}%`} height="0.875rem" />
                    ))}
                </div>
            ))}
        </div>
    );
}

export function SkeletonCard() {
    return (
        <div className="bg-white rounded-lg shadow-sm p-4 space-y-3">
            <Skeleton width="40%" height="1rem" />
            <Skeleton height="0.875rem" />
            <Skeleton height="0.875rem" />
            <Skeleton width="80%" height="0.875rem" />
        </div>
    );
}
