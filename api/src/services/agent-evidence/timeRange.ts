// Zaman araligi cozumleme.
//
// Butun agent-evidence endpoint'leri YARI ACIK aralik kullanir: [from, to).
// Boylece ardisik pencereler (orn. donem karsilastirmasi) sinir ornegini iki
// kez saymaz.
//
// Zaman araligi ZORUNLUDUR. Mevcut UI endpoint'lerindeki "from/to yoksa son N
// saat" davranisi burada bilerek yoktur: AI'a sessizce baska bir pencere
// vermek, sonucu yanlis pencereye atfetmesine yol acar.

import { EffectiveRange, Resolution, TimeRangeRef } from './contract';

/** Kullanici girdisi hatasi — urun eksigi DEGILDIR, 400 ile doner. */
export class EvidenceValidationError extends Error {
    readonly code: string;
    readonly field: string;

    constructor(code: string, field: string, message: string) {
        super(message);
        this.name = 'EvidenceValidationError';
        this.code = code;
        this.field = field;
    }
}

/** Tek bir istegin kapsayabilecegi en uzun pencere. */
export const MAX_RANGE_DAYS = 92;
/** Ham cozunurlukte izin verilen en uzun pencere (satir sayisi sinirlamasi). */
export const MAX_RAW_RANGE_HOURS = 48;

/**
 * ISO 8601 zaman damgasini cozer.
 *
 * Offset tasimayan girdi (orn. "2026-09-14T10:00:00") REDDEDILIR: JavaScript
 * bunu yerel saat sayar, PostgreSQL ise sunucu timezone'una gore yorumlar;
 * ikisi ayni degeri uretmez. AI'in zaman penceresini kaydirmasindansa acik
 * hata vermek dogrudur.
 */
export function parseInstant(raw: unknown, field: string): Date {
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new EvidenceValidationError('missing_parameter', field, `${field} zorunludur (ISO 8601, offset ile)`);
    }
    const value = raw.trim();
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
    if (!hasOffset) {
        throw new EvidenceValidationError(
            'ambiguous_timezone',
            field,
            `${field} icin UTC offset zorunlu (orn. 2026-09-14T10:00:00Z)`
        );
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
        throw new EvidenceValidationError('invalid_timestamp', field, `${field} gecerli bir ISO 8601 zamani degil`);
    }
    return d;
}

export interface ResolvedRange {
    requested: TimeRangeRef;
    effective: EffectiveRange;
    /** Pencere uzunlugu — oran hesaplarinda kullanilir. */
    durationSeconds: number;
}

/**
 * from/to/resolution parametrelerini cozer ve sinirlari uygular.
 *
 * `resolution` verilmezse pencere uzunluguna gore secilir. Secim ACIKCA
 * cevapta tasinir; ayni pencerede ham ve saatlik veri KARISTIRILMAZ.
 */
export function resolveRange(query: Record<string, unknown>): ResolvedRange {
    const from = parseInstant(query.from, 'from');
    const to = parseInstant(query.to, 'to');

    if (to.getTime() <= from.getTime()) {
        throw new EvidenceValidationError('empty_range', 'to', 'to, from degerinden buyuk olmalidir');
    }

    const durationSeconds = (to.getTime() - from.getTime()) / 1000;
    const durationDays = durationSeconds / 86400;
    if (durationDays > MAX_RANGE_DAYS) {
        throw new EvidenceValidationError(
            'range_too_wide',
            'to',
            `Zaman araligi en fazla ${MAX_RANGE_DAYS} gun olabilir (istenen: ${durationDays.toFixed(1)} gun)`
        );
    }

    const requested: TimeRangeRef = { from: from.toISOString(), to: to.toISOString() };

    const requestedResolution = parseResolution(query.resolution);
    const durationHours = durationSeconds / 3600;

    let resolution: Resolution;
    let adjustedReason: string | null = null;

    if (requestedResolution) {
        if (requestedResolution === 'raw' && durationHours > MAX_RAW_RANGE_HOURS) {
            throw new EvidenceValidationError(
                'raw_range_too_wide',
                'resolution',
                `Ham cozunurluk en fazla ${MAX_RAW_RANGE_HOURS} saatlik pencerede istenebilir`
            );
        }
        resolution = requestedResolution;
    } else {
        resolution = durationHours <= MAX_RAW_RANGE_HOURS ? 'raw' : 'hourly';
        if (resolution === 'hourly') {
            adjustedReason = `Pencere ${MAX_RAW_RANGE_HOURS} saatten uzun; saatlik aggregate kullanildi`;
        }
    }

    return {
        requested,
        effective: {
            from: requested.from,
            to: requested.to,
            resolution,
            adjusted_reason: adjustedReason,
        },
        durationSeconds,
    };
}

function parseResolution(raw: unknown): Resolution | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const value = String(raw).toLowerCase();
    if (value === 'raw' || value === 'hourly' || value === 'daily') return value;
    throw new EvidenceValidationError('invalid_resolution', 'resolution', 'resolution yalnizca raw/hourly/daily olabilir');
}

/**
 * Karsilastirma icin iki bitisik olmayan pencere cozer.
 * Ust uste binen pencereler reddedilir — ayni ornek iki donemde sayilamaz.
 */
export interface ResolvedComparison {
    baseline: ResolvedRange;
    comparison: ResolvedRange;
}

export function resolveComparisonRanges(query: Record<string, unknown>): ResolvedComparison {
    const baseline = resolveRange({
        from: query.baseline_from,
        to: query.baseline_to,
        resolution: query.resolution,
    });
    const comparison = resolveRange({
        from: query.comparison_from,
        to: query.comparison_to,
        resolution: query.resolution,
    });

    const bFrom = Date.parse(baseline.requested.from);
    const bTo = Date.parse(baseline.requested.to);
    const cFrom = Date.parse(comparison.requested.from);
    const cTo = Date.parse(comparison.requested.to);

    // [from, to) yari acik oldugu icin bTo === cFrom ust uste binme DEGILDIR.
    const overlaps = bFrom < cTo && cFrom < bTo;
    if (overlaps) {
        throw new EvidenceValidationError(
            'overlapping_ranges',
            'comparison_from',
            'Karsilastirma pencereleri ust uste binemez; ayni ornek iki donemde sayilir'
        );
    }

    if (baseline.effective.resolution !== comparison.effective.resolution) {
        throw new EvidenceValidationError(
            'resolution_mismatch',
            'resolution',
            'Iki pencere ayni cozunurlukte olmalidir; farkli cozunurluk karsilastirmayi bozar'
        );
    }

    return { baseline, comparison };
}

/** Limit parametresi — aday/bucket sayisi sinirlamasi. */
export function resolveLimit(raw: unknown, defaultValue: number, max: number): number {
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
        throw new EvidenceValidationError('invalid_limit', 'limit', 'limit pozitif tam sayi olmalidir');
    }
    if (n > max) {
        throw new EvidenceValidationError('limit_too_large', 'limit', `limit en fazla ${max} olabilir`);
    }
    return n;
}
