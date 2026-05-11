/** Query param'ları güvenli şekilde parse eder ve sınırlar */

export function parseHours(val: unknown, defaultVal = 1): number {
    const n = parseInt(val as string);
    if (isNaN(n)) return defaultVal;
    return Math.min(Math.max(n, 1), 8760); // 1 saat - 1 yıl
}

/**
 * Time range parser — from/to ISO query parametrelerinden saat sayısı çıkarır.
 * Eğer from/to verilmemişse hours parametresine veya default'a düşer.
 * Endpoint'lerin geriye uyumlu olması için: from/to varsa onları öncelikle kullan,
 * yoksa eski hours mantığı.
 */
export function parseTimeRange(query: any, defaultHours = 1): { fromIso: string; toIso: string } {
    let fromIso: string | null = null;
    let toIso: string | null = null;
    if (typeof query.from === 'string') {
        const d = new Date(query.from);
        if (!isNaN(d.getTime())) fromIso = d.toISOString();
    }
    if (typeof query.to === 'string') {
        const d = new Date(query.to);
        if (!isNaN(d.getTime())) toIso = d.toISOString();
    }
    if (fromIso && toIso) return { fromIso, toIso };
    // Geriye uyumluluk: hours param varsa onu kullan, yoksa default
    const hours = parseHours(query.hours, defaultHours);
    const now = new Date();
    return {
        fromIso: new Date(now.getTime() - hours * 3600 * 1000).toISOString(),
        toIso: now.toISOString(),
    };
}

export function parseDays(val: unknown, defaultVal = 7): number {
    const n = parseInt(val as string);
    if (isNaN(n)) return defaultVal;
    return Math.min(Math.max(n, 1), 365);
}

export function parseLimit(val: unknown, defaultVal = 100): number {
    const n = parseInt(val as string);
    if (isNaN(n)) return defaultVal;
    return Math.min(Math.max(n, 1), 10000);
}

export function parseId(val: unknown): number | null {
    const n = parseInt(val as string);
    return isNaN(n) || n <= 0 ? null : n;
}

/** Whitelist'e göre order_by kolonunu doğrular */
export function parseOrderBy(val: unknown, allowed: Record<string, string>, defaultCol: string): string {
    return allowed[val as string] || defaultCol;
}

/** DB ismi SQL identifier kurallarına uygun mu */
export function isValidDbName(name: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name);
}
