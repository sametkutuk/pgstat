/** Query param'ları güvenli şekilde parse eder ve sınırlar */

export function parseHours(val: unknown, defaultVal = 1): number {
    const n = parseInt(val as string);
    if (isNaN(n)) return defaultVal;
    return Math.min(Math.max(n, 1), 8760); // 1 saat - 1 yıl
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
