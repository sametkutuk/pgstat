import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';

interface Props {
    queryTextId: number | null;
    short: string | null;
    showDeltaBadge?: boolean;
}

/**
 * SQL hucresi — once kisa ozet (80 karakter), tiklayinca tam metin lazy load.
 * React Query cache'i query_text_id key'iyle saklar — ayni queryid tekrar
 * acildiginda DB'ye gitmez.
 */
export default function StatementSqlCell({ queryTextId, short, showDeltaBadge }: Props) {
    const [expanded, setExpanded] = useState(false);

    const { data: fullText, isLoading } = useQuery<{ query_text: string }>({
        queryKey: ['stmt-text', queryTextId],
        queryFn: () => apiGet(`/statements/text/${queryTextId}`),
        enabled: expanded && queryTextId != null,
        staleTime: 60_000 * 60 * 24, // SQL metni cok nadiren degisir (queryid stabil)
    });

    return (
        <div onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5">
                <div className="truncate text-xs font-mono text-[#1E293B]" title={short ?? ''}>
                    {short || <span className="text-[#94A3B8] italic">metin yok</span>}
                </div>
                {showDeltaBadge && (
                    <span className="flex-shrink-0 text-[10px] bg-[#FEF3C7] text-[#D97706] px-1.5 py-0.5 rounded"
                        title="Collector bu sorguyu gördü ama delta verisi yok. Sorgu nadir çalışıyor veya pg_stat_statements reset sonrası henüz 2 cycle geçmemiş.">
                        delta yok
                    </span>
                )}
                {queryTextId != null && (
                    <button
                        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                        className="flex-shrink-0 text-[10px] text-[#3B82F6] hover:underline"
                        title={expanded ? 'Kapat' : 'Tam SQL'}>
                        {expanded ? '▼' : '▶'}
                    </button>
                )}
            </div>
            {expanded && (
                <div className="mt-2 p-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded text-xs font-mono text-[#1E293B] whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                    {isLoading ? <span className="text-[#94A3B8]">Yükleniyor…</span>
                        : fullText?.query_text || short || '—'}
                </div>
            )}
        </div>
    );
}
