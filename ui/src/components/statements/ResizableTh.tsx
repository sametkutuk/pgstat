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

interface Props {
    colKey: string;
    width?: number;
    onResize: (key: string, px: number) => void;
    className?: string;
    align?: 'left' | 'right';
    children: React.ReactNode;
}

// Sag kenarinda drag-handle olan th. Mouse ile cekilince genislik degisir.
export default function ResizableTh({ colKey, width, onResize, className, align = 'left', children }: Props) {
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

    return (
        <th
            ref={thRef}
            className={className}
            style={{ width: width != null ? `${width}px` : undefined, position: 'relative', textAlign: align }}>
            <div className="truncate pr-2">{children}</div>
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
                    borderRight: dragging ? '2px solid #3B82F6' : '1px solid #1E293B',
                }}
            />
        </th>
    );
}
