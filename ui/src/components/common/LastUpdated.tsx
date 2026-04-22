import { useEffect, useState } from 'react';

// "Son güncelleme: X dk önce" göstergesi
export default function LastUpdated({ dataUpdatedAt }: { dataUpdatedAt: number }) {
    const [, setTick] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => setTick((t) => t + 1), 10000);
        return () => clearInterval(interval);
    }, []);

    if (!dataUpdatedAt) return null;

    const diff = Math.floor((Date.now() - dataUpdatedAt) / 1000);
    let label: string;
    if (diff < 10) label = 'az önce';
    else if (diff < 60) label = `${diff}s önce`;
    else if (diff < 3600) label = `${Math.floor(diff / 60)}dk önce`;
    else label = `${Math.floor(diff / 3600)}sa önce`;

    return (
        <span className="text-xs text-[#94A3B8]">Son güncelleme: {label}</span>
    );
}
