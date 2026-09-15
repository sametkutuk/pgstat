// Sayisal donusum ve hesap yardimcilari.
//
// Olculen gercek (2026-09-15): api/src icinde `pg.types.setTypeParser` cagrisi
// YOKTUR. Bu yuzden node-postgres int8/bigint ve numeric degerleri STRING
// olarak dondurur. Bu iyi bir varsayilandir; asil risk onu `Number(...)` ile
// sessizce bozmaktir. 2^53'un uzerindeki bir bigint Number'a cevrildiginde
// sessizce yanlis deger uretir.
//
// Kural: bigint sayaclari disariya STRING olarak cikar. Yalnizca sinirli
// oldugu kanitlanabilen degerler (satir sayisi, saniye, yuzde) number olur.

/** JavaScript'in guvenli tamsayi siniri. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * bigint kolonunu string olarak tasir. Deger zaten string geliyorsa dogrular.
 * Bozuk/eksik deger null doner — sifira CEVRILMEZ.
 */
export function asBigIntString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        return /^-?\d+$/.test(value) ? value : null;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
        return String(value);
    }
    if (typeof value === 'bigint') return value.toString();
    return null;
}

/**
 * Guvenli tamsayi sinirini asmayan degerleri number'a cevirir.
 * Sinir asilirsa null doner — sessiz bozulma yerine gorunur eksiklik.
 */
export function asSafeInt(value: unknown): number | null {
    const s = asBigIntString(value);
    if (s === null) return null;
    const n = Number(s);
    if (!Number.isSafeInteger(n)) return null;
    return n;
}

/** Sinir asimini ayirt etmek isteyen cagirici icin. */
export function exceedsSafeInteger(value: unknown): boolean {
    const s = asBigIntString(value);
    if (s === null) return false;
    const n = Number(s);
    return !Number.isSafeInteger(n);
}

/** float8/numeric -> number. NULL korunur. */
export function asFloat(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

/** timestamptz -> ISO string. NULL korunur. */
export function asIso(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// =============================================================================
// Oran hesabi
// =============================================================================

/**
 * Oran sonucu. Sifir payda ile eksik payda AYRI durumlardir:
 *   - `zero_denominator`: payda olculdu ve sifirdi (orn. tabloda hic satir yok)
 *   - `missing_input`: pay ya da payda olculemedi (NULL)
 * Ikisi de 0 veya %100 anlamina gelmez.
 */
export interface RatioResult {
    value: number | null;
    state: 'ok' | 'zero_denominator' | 'missing_input';
}

/**
 * Yuzde hesabi. Girdiler bigint-string olabilir; bolme BigInt uzerinde
 * yapilmaz cunku sonuc kesirlidir — bunun yerine sayi sinirini asan
 * girdilerde float'a duser ve bunu note ile bildirir (cagirici karar verir).
 */
export function percentOf(numerator: unknown, denominator: unknown): RatioResult {
    const num = asBigIntString(numerator) ?? (asFloat(numerator) !== null ? String(asFloat(numerator)) : null);
    const den = asBigIntString(denominator) ?? (asFloat(denominator) !== null ? String(asFloat(denominator)) : null);
    if (num === null || den === null) return { value: null, state: 'missing_input' };

    const denNum = Number(den);
    if (denNum === 0) return { value: null, state: 'zero_denominator' };

    const numNum = Number(num);
    if (!Number.isFinite(numNum) || !Number.isFinite(denNum)) {
        return { value: null, state: 'missing_input' };
    }
    return { value: (numNum / denNum) * 100, state: 'ok' };
}

/** Iki deger arasindaki degisim yuzdesi. Taban sifirsa oran tanimsizdir. */
export function changePercent(before: unknown, after: unknown): RatioResult {
    const b = asFloat(asBigIntString(before) ?? before);
    const a = asFloat(asBigIntString(after) ?? after);
    if (b === null || a === null) return { value: null, state: 'missing_input' };
    if (b === 0) return { value: null, state: 'zero_denominator' };
    return { value: ((a - b) / Math.abs(b)) * 100, state: 'ok' };
}

/** Mutlak fark. Iki taraf da bigint olabilecegi icin string doner. */
export function absoluteDelta(before: unknown, after: unknown): string | null {
    const b = asBigIntString(before);
    const a = asBigIntString(after);
    if (b === null || a === null) return null;
    try {
        return (BigInt(a) - BigInt(b)).toString();
    } catch {
        return null;
    }
}

/**
 * Agirlikli ortalama sure: toplam sure / toplam cagri.
 * Ortalamalarin basit ortalamasi ALINMAZ — farkli cagri sayilari sonucu bozar.
 */
export function weightedAverage(totalValue: unknown, totalCount: unknown): RatioResult {
    const v = asFloat(totalValue);
    const c = asFloat(asBigIntString(totalCount) ?? totalCount);
    if (v === null || c === null) return { value: null, state: 'missing_input' };
    if (c === 0) return { value: null, state: 'zero_denominator' };
    return { value: v / c, state: 'ok' };
}

/** Belirtilen basamaga yuvarlar; null korunur. */
export function round(value: number | null, digits = 2): number | null {
    if (value === null) return null;
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}
