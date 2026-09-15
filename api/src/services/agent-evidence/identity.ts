// Hedef kimligi cozumleme ve dogrulama.
//
// Tablo kimligi HER ZAMAN instance_pk + dbid + relid uclusudur. Ad ile
// eslestirme yapilmaz: ayni relname farkli veritabanlarinda farkli tablodur.
//
// Kimlik dogrulamasi ayni zamanda bir guvenlik sinnifidir: istemci rastgele
// bir dbid/relid gonderip baska bir hedefin verisini goremez, cunku kimlik
// once o instance'a ait mi diye kontrol edilir.

import { Limitation, TableRef, TargetRef } from './contract';
import { EvidenceValidationError } from './timeRange';
import { asIso, asSafeInt } from './numeric';
import { queryBounded } from './db';

/** Pozitif tam sayi parametresi dogrular. */
export function parsePositiveInt(raw: unknown, field: string): number {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        throw new EvidenceValidationError('missing_parameter', field, `${field} zorunludur`);
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new EvidenceValidationError('invalid_parameter', field, `${field} pozitif tam sayi olmalidir`);
    }
    return n;
}

/**
 * OID parametresi. PostgreSQL OID'i isaretsiz 32-bit'tir; 2^31'in ustundeki
 * degerler gecerlidir ve int'e sigmaz. Bu yuzden 0..4294967295 araliginda
 * dogrulanir ve sorgulara oid olarak gonderilir.
 */
export function parseOid(raw: unknown, field: string): number {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        throw new EvidenceValidationError('missing_parameter', field, `${field} zorunludur`);
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 4294967295) {
        throw new EvidenceValidationError('invalid_parameter', field, `${field} gecerli bir OID olmalidir (0..4294967295)`);
    }
    return n;
}

/**
 * Instance kimligi ve surum baglamini okur.
 *
 * pg_major NULL olabilir: capability kaydi henuz olusmamis olabilir. Bu
 * "eski surum" ANLAMINA GELMEZ; bilinmiyor demektir.
 */
export async function resolveTarget(instancePk: number): Promise<TargetRef | null> {
    const rows = await queryBounded({
        text: `
            select inv.instance_pk,
                   inv.instance_id,
                   inv.display_name,
                   inv.is_active,
                   cap.pg_major,
                   cap.server_version_num
              from control.instance_inventory inv
              left join control.instance_capability cap
                     on cap.instance_pk = inv.instance_pk
             where inv.instance_pk = $1
        `,
        values: [instancePk],
    });
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
        instance_pk: asSafeInt(row.instance_pk)!,
        instance_id: String(row.instance_id),
        display_name: String(row.display_name),
        pg_major: asSafeInt(row.pg_major),
        server_version_num: asSafeInt(row.server_version_num),
        is_active: row.is_active === true,
    };
}

export interface ResolvedTable {
    table: TableRef;
    /** Kimlik belirsizligi varsa cevaba eklenecek sinirlamalar. */
    limitations: Limitation[];
}

/**
 * Tabloyu kimligiyle cozer ve hedefe ait oldugunu dogrular.
 *
 * Kimlik sinirlari (dim.relation_ref yapisindan olculmus):
 *  - (instance_pk, dbid, relid) tek satirdir; tablo DROP edilip ayni OID ile
 *    yeniden olusturulursa iki donem tek satirda birlesir ve ayirt edilemez.
 *  - relname uzerine yazilir; yeniden adlandirma gecmisi tutulmaz.
 * Bu yuzden gecmis karsilastirmasinda ilgili sinirlama acikca bildirilir.
 */
export async function resolveTable(
    instancePk: number,
    dbid: number,
    relid: number
): Promise<ResolvedTable | null> {
    const rows = await queryBounded({
        text: `
            select rr.dbid,
                   rr.relid,
                   rr.schemaname,
                   rr.relname,
                   rr.relkind,
                   rr.first_seen_at,
                   rr.last_seen_at,
                   dbr.datname
              from dim.relation_ref rr
              left join dim.database_ref dbr
                     on dbr.instance_pk = rr.instance_pk
                    and dbr.dbid = rr.dbid
             where rr.instance_pk = $1
               and rr.dbid = $2::oid
               and rr.relid = $3::oid
        `,
        values: [instancePk, dbid, relid],
    });
    if (rows.length === 0) return null;

    const row = rows[0];
    const limitations: Limitation[] = [
        {
            code: 'relation_identity_reuse',
            scope: `${row.schemaname}.${row.relname}`,
            message:
                'Tablo kimligi (dbid, relid) OID tabanlidir. Tablo silinip ayni OID ile yeniden '
                + 'olusturulduysa ya da yeniden adlandirildiysa gecmis kayitlari ayni kimlik altinda '
                + 'gorunur; mevcut veri bu iki durumu ayirt edemez.',
        },
    ];

    const firstSeen = asIso(row.first_seen_at);
    if (firstSeen) {
        limitations.push({
            code: 'relation_first_seen',
            scope: `${row.schemaname}.${row.relname}`,
            message: `Bu tablo ilk kez ${firstSeen} tarihinde gozlendi; oncesi icin kanit yoktur.`,
        });
    }

    return {
        table: {
            dbid: asSafeInt(row.dbid)!,
            relid: asSafeInt(row.relid)!,
            datname: row.datname === null || row.datname === undefined ? null : String(row.datname),
            schemaname: String(row.schemaname),
            relname: String(row.relname),
        },
        limitations,
    };
}

/**
 * Instance'a ait veritabani adini dogrular. Istemciden gelen datname SQL'e
 * identifier olarak GOMULMEZ; yalnizca parametre olarak eslestirilir.
 */
export async function resolveDatabaseId(instancePk: number, datname: string): Promise<number | null> {
    const rows = await queryBounded({
        text: `
            select dbid from dim.database_ref
             where instance_pk = $1 and datname = $2
        `,
        values: [instancePk, datname],
    });
    if (rows.length === 0) return null;
    return asSafeInt(rows[0].dbid);
}
