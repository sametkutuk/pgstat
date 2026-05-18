/**
 * Generic column whitelist helper — tüm stat tab'ları için reusable.
 * Pattern: PGSS_COLUMNS (statements.ts) ile aynı, generic hale getirildi.
 */

export interface ColDef {
    sql: string;    // SELECT expression (aggregate veya direkt kolon)
    since: number;  // İlk mevcut olduğu PG major sürümü
    label: string;  // UI'da gösterilecek başlık
}

export type ColumnRegistry = Record<string, ColDef>;

export function rawSelectExpr(colDef: ColDef, key: string): string {
    const m = /^(?:sum|max|min|avg|count)\s*\(\s*([a-z_0-9\.]+)\s*\)$/i.exec(colDef.sql);
    return m ? `${m[1]} as ${key}` : `${colDef.sql} as ${key}`;
}

/**
 * İstenen kolonları whitelist'e göre filtreler.
 * Bilinmeyen kolon adları sessizce atılır (SQL injection koruması).
 */
export function parseColumns(raw: string | undefined, registry: ColumnRegistry, defaults: string[]): string[] {
    if (!raw) return defaults;
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    const safe = list.filter(c => Object.prototype.hasOwnProperty.call(registry, c));
    return safe.length > 0 ? safe : defaults;
}

/**
 * Multi-sort order_by parser — "col1:desc,col2:asc" formatını parse eder.
 * Max 3 kriter, sadece requestedCols içindeki kolonlara izin verilir.
 */
export function parseOrderBy(raw: string | undefined, requestedCols: string[], fallbackCol?: string): string {
    const fb = (fallbackCol && requestedCols.includes(fallbackCol) ? fallbackCol : requestedCols[0]) + ' desc nulls last';
    if (!raw) return fb;
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
    const clauses: string[] = [];
    for (const p of parts) {
        const [col, dirRaw] = p.split(':').map(s => s.trim());
        if (!requestedCols.includes(col)) continue;
        const dir = (dirRaw || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
        clauses.push(`${col} ${dir} nulls last`);
    }
    return clauses.length > 0 ? clauses.join(', ') : fb;
}

/**
 * Kolon meta endpoint response'u oluşturur.
 */
export function columnsMetaResponse(registry: ColumnRegistry, defaults: string[]) {
    return {
        defaults,
        available: Object.entries(registry).map(([key, v]) => ({
            key, label: v.label, since: v.since,
        })),
    };
}
