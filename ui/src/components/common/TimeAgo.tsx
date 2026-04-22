// Basit zaman farkı gösterimi
export default function TimeAgo({ date }: { date: string | null }) {
    if (!date) return <span className="text-[#94A3B8]">—</span>;

    const diff = Date.now() - new Date(date).getTime();
    const secs = Math.floor(diff / 1000);

    if (secs < 60) return <span>{secs}s önce</span>;
    if (secs < 3600) return <span>{Math.floor(secs / 60)}dk önce</span>;
    if (secs < 86400) return <span>{Math.floor(secs / 3600)}sa önce</span>;
    return <span>{Math.floor(secs / 86400)}g önce</span>;
}
