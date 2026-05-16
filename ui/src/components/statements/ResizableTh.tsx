import { useEffect, useRef, useState } from 'react';

// Kolon genisliklerini LocalStorage'da saklayan basit hook.
// storageKey her sayfa icin farkli olmali (ornk pgstat.statements.widths).
export function useColumnWidths(storageKey: string): {
    widths: Record<string, number>;
    setWidth: (key: string, px: number) => void;
    reset: () => void;
} {
    const [widths, setWidths] = useState<Record<string, number>>(() => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (raw) return JSON.parse(raw);
        } catch { /* ignore */ }
        return {};
    });

    function persist(next: Record<string, number>) {
        setWidths(next);
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
    }

    function setWidth(key: string, px: number) {
        persist({ ...widths, [key]: Math.max(40, Math.round(px)) });
    }

    function reset() {
        persist({});
    }

    return { widths, setWidth, reset };
}

// Multi-sort kriteri: kolon + yon. Liste icindeki sira = oncelik (0 birinci).
export interface SortKey { col: string; dir: 'asc' | 'desc'; }

// Headera tiklama: yon dongusu (yok -> desc -> asc -> kaldir).
// Shift basili degilse tek kriter olur (digerlerini siler).
// Shift basiliysa listeye ekler veya yon degistirir. Max 3 kriter.
export function toggleSort(current: SortKey[], col: string, additive: boolean): SortKey[] {
    const idx = current.findIndex(s => s.col === col);
    if (!additive) {
        if (idx === -1) return [{ col, dir: 'desc' }];
        const cur = current[idx];
        if (cur.dir === 'desc') return [{ col, dir: 'asc' }];
        return []; // 3. tiklamada kaldir, default'a don
    }
    if (idx === -1) {
        if (current.length >= 3) return current; // max 3 kriter
        return [...current, { col, dir: 'desc' }];
    }
    const cur = current[idx];
    if (cur.dir === 'desc') {
        const next = [...current];
        next[idx] = { col, dir: 'asc' };
        return next;
    }
    return current.filter(s => s.col !== col);
}

export function sortKeysToParam(keys: SortKey[]): string {
    return keys.map(k => `${k.col}:${k.dir}`).join(',');
}

interface Props {
    colKey: string;
    width?: number;
    onResize: (key: string, px: number) => void;
    className?: string;
    align?: 'left' | 'right';
    // Sort destegi (opsiyonel) — verildiyse header tiklanabilir olur
    sortKeys?: SortKey[];
    onSortToggle?: (col: string, additive: boolean) => void;
    children: React.ReactNode;
}

// Sag kenarinda drag-handle olan th. Mouse ile cekilince genislik degisir.
// Sort verildiyse content tiklanabilir, shift+click ile multi-sort.
export default function ResizableTh({ colKey, width, onResize, className, align = 'left', sortKeys, onSortToggle, children }: Props) {
    const thRef = useRef<HTMLTableCellElement>(null);
    const [dragging, setDragging] = useState(false);

    useEffect(() => {
        if (!dragging) return;
        function onMove(e: MouseEvent) {
            if (!thRef.current) return;
            const rect = thRef.current.getBoundingClientRect();
            const newWidth = e.clientX - rect.left;
            onResize(colKey, newWidth);
        }
        function onUp() { setDragging(false); }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [dragging, colKey, onResize]);

    const sortIdx = sortKeys?.findIndex(s => s.col === colKey) ?? -1;
    const sortDir = sortIdx >= 0 ? sortKeys![sortIdx].dir : null;
    const clickable = !!onSortToggle;

    function handleClick(e: React.MouseEvent) {
        if (!onSortToggle) return;
        onSortToggle(colKey, e.shiftKey);
    }

    return (
        <th
            ref={thRef}
            className={className}
            style={{ width: width != null ? `${width}px` : undefined, position: 'relative', textAlign: align }}>
            <div
                onClick={handleClick}
                className={clickable ? 'truncate pr-2 cursor-pointer select-none hover:text-[#1E293B]' : 'truncate pr-2'}
                title={clickable ? 'Tıkla: sırala · Shift+Tıkla: ek sıralama (max 3)' : undefined}>
                {children}
                {sortDir && (
                    <span className="ml-1 text-[#3B82F6] font-bold">
                        {sortDir === 'desc' ? '↓' : '↑'}
                        {sortKeys && sortKeys.length > 1 && (
                            <sub className="text-[9px] ml-0.5">{sortIdx + 1}</sub>
                        )}
                    </span>
                )}
            </div>
            <div
                onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
                title="Genişliği ayarla"
                style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    width: 5,
                    height: '100%',
                    cursor: 'col-resize',
                    userSelect: 'none',
                    borderRight: dragging ? '2px solid #3B82F6' : '1px solid #CBD5E1',
                }}
            />
        </th>
    );
}
