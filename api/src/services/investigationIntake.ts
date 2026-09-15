// Arastirma alimi: kullaniciyi listeden secim yapmaya zorlamadan baslatmak.
//
// Sohbet arayuzunde once form doldurtmak akisi bozar. Bu yuzden hedef ve zaman
// araligi ZORUNLU DEGIL; eksik olan ya guvenle cozulur ya da SORULUR. Hicbiri
// sessizce uydurulmaz: otomatik secim de, varsayilan pencere de konusma
// gecmisine acik bir mesaj olarak yazilir.

import type { PoolClient } from 'pg';

/** Zaman araligi verilmezse kullanilan pencere. */
export const DEFAULT_WINDOW_HOURS = 24;

export interface IntakeRequest {
    question: string;
    investigationType: string;
    instancePk: number | null;
    dbid: number | null;
    timeFrom: string | null;
    timeTo: string | null;
}

export type TargetResolution =
    | { kind: 'explicit'; instancePk: number }
    | { kind: 'auto_single'; instancePk: number; displayName: string }
    | { kind: 'ask'; candidates: { instance_pk: number; display_name: string }[] }
    | { kind: 'not_found' };

/** Hedefi cozer. Secim yapilamiyorsa uydurmaz, sorulacagini bildirir. */
export async function resolveTarget(
    client: PoolClient,
    instancePk: number | null
): Promise<TargetResolution> {
    if (instancePk !== null) {
        const found = await client.query(
            `select instance_pk from control.instance_inventory
              where instance_pk = $1 and is_active`,
            [instancePk]
        );
        return found.rowCount === 0 ? { kind: 'not_found' } : { kind: 'explicit', instancePk };
    }

    // Tek aktif instance varsa soru sormanin anlami yok. Ikiden fazlaysa
    // "muhtemelen bunu kastetti" tahmini yapilmaz.
    const active = await client.query(
        `select instance_pk, display_name from control.instance_inventory
          where is_active order by display_name limit 26`
    );
    if (active.rowCount === 1) {
        return {
            kind: 'auto_single',
            instancePk: Number(active.rows[0].instance_pk),
            displayName: String(active.rows[0].display_name),
        };
    }
    return {
        kind: 'ask',
        candidates: active.rows.slice(0, 25).map((row) => ({
            instance_pk: Number(row.instance_pk),
            display_name: String(row.display_name),
        })),
    };
}

export interface ResolvedWindow {
    from: string;
    to: string;
    /** true ise kullanici vermedi, varsayilan uygulandi. */
    defaulted: boolean;
}

/**
 * Zaman araligini cozer. Verilmediyse son DEFAULT_WINDOW_HOURS saat kullanilir
 * ve bunun varsayilan oldugu isaretlenir; cagirici bunu kullaniciya yazar.
 */
export function resolveWindow(timeFrom: string | null, timeTo: string | null, now = new Date()): ResolvedWindow {
    if (timeFrom !== null && timeTo !== null) {
        return { from: timeFrom, to: timeTo, defaulted: false };
    }
    const to = timeTo !== null ? new Date(timeTo) : now;
    const from = timeFrom !== null
        ? new Date(timeFrom)
        : new Date(to.getTime() - DEFAULT_WINDOW_HOURS * 3600 * 1000);
    return { from: from.toISOString(), to: to.toISOString(), defaulted: true };
}

export interface IntakeOutcome {
    status: 'queued' | 'needs_clarification';
    instancePk: number | null;
    window: ResolvedWindow;
    /** Konusmaya yazilacak assistant mesajlari (varsa). */
    assistantMessages: string[];
    /** needs_clarification ise kullaniciya sunulacak secenekler. */
    candidates: { instance_pk: number; display_name: string }[];
}

/**
 * Alim kararini uretir. DB yazmaz; cagirici tek transaction icinde uygular.
 *
 * 'not_found' buraya GELMEZ: kullanici var olmayan/pasif bir instance verdiyse
 * bu bir girdi hatasidir (404), sorulacak bir belirsizlik degil. Cagirici onu
 * once ayikilar.
 */
export function decideIntake(
    target: Exclude<TargetResolution, { kind: 'not_found' }>,
    window: ResolvedWindow
): IntakeOutcome {
    const messages: string[] = [];
    if (window.defaulted) {
        messages.push(
            `Zaman araligi belirtilmedigi icin son ${DEFAULT_WINDOW_HOURS} saat kullanildi `
            + `(${window.from} – ${window.to}). Baska bir aralik isterseniz soyleyin.`
        );
    }

    if (target.kind === 'explicit') {
        return { status: 'queued', instancePk: target.instancePk, window, assistantMessages: messages, candidates: [] };
    }

    if (target.kind === 'auto_single') {
        messages.push(
            `Sistemde tek aktif instance oldugu icin "${target.displayName}" secildi. `
            + 'Baska bir instance kastettiyseniz belirtin.'
        );
        return { status: 'queued', instancePk: target.instancePk, window, assistantMessages: messages, candidates: [] };
    }

    // Birden fazla aday var (ya da hic yok): tahmin yurutup yanlis instance'ta
    // arastirma baslatmak yerine soruluyor.
    messages.push(
        target.candidates.length === 0
            ? 'Hangi instance icin bakmami istersiniz? Su an kayitli aktif instance gorunmuyor.'
            : 'Hangi instance icin bakmami istersiniz? Aktif olanlar: '
              + target.candidates.map((c) => c.display_name).join(', ')
    );
    return {
        status: 'needs_clarification',
        instancePk: null,
        window,
        assistantMessages: messages,
        candidates: target.candidates,
    };
}
