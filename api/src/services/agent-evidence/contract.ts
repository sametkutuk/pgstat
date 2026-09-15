// AI DBA kanit sozlesmesi — butun agent-evidence cevaplarinin ortak zarfi.
//
// Tasarim kurali: cevap AI tarafindan yorumlanacak. Bu yuzden sayinin yaninda
// ne oldugu (birim, toplam/snapshot/delta), nereden geldigi ve NULL'un ne
// anlama geldigi de tasinir. "Veri yok" ile "toplanmiyor" ayri durumlardir ve
// asla birbirine cevrilmez.
//
// Kaynak plan: docs/ai-dba-mcp-implementation-plan.md bolum 7.

/** Zarf surumu. Alan ekleme minor, alan kaldirma/anlam degistirme major. */
export const SCHEMA_VERSION = '1.0.0';

// =============================================================================
// Durum sozlugu
// =============================================================================

/**
 * Cevabin genel durumu. Plan bolum 7'deki ayrimi korur.
 *
 * ONEMLI: `no_data` ile `not_collected` ayri seylerdir. Sorgunun sifir satir
 * dondurmesi toplamanin kapali oldugunu KANITLAMAZ — yalnizca bu hedef ve
 * pencerede kayit bulunmadigini gosterir.
 */
export type EvidenceStatus =
    | 'ok'                    // istenen kanit tam olarak uretildi
    | 'partial'               // bir kismi uretildi, en az bir alt kaynak eksik/hatali
    | 'no_data'               // kaynak tanimli ve calisiyor, bu pencerede kayit yok
    | 'not_collected'         // bu yetenek icin toplama esleme si tanimli degil
    | 'unsupported_version'   // PG/extension surumu bu alani desteklemiyor
    | 'unknown_capability'    // kaynak/uyumluluk durumu bilinmiyor
    | 'stale'                 // veri var ama son olcum penceresinin disinda
    | 'insufficient_samples'  // ornek sayisi istenen hesap icin yetersiz
    | 'failed';               // teknik hata; kanit alinamadi

/**
 * Bir gozlemin NEDENI. Gozlemden nedene atlamayi engellemek icin ayri tutulur:
 * `zero_rows_in_window` gorulen seydir, `collector_mapping_missing` ise
 * dogrulanmis bir yapilandirma gercegidir.
 */
export type ReasonCode =
    | 'ok'
    | 'zero_rows_in_window'          // sorgu sifir satir dondurdu — sebebi bilinmiyor
    | 'collector_mapping_missing'    // bu yetenek icin collector kaynagi tanimli degil
    | 'version_unsupported'          // surum kisiti (dogrulanmis)
    | 'permission_denied_recorded'   // kaynakta yetki reddi kaydi var
    | 'data_stale'                   // son olcum zamani pencerenin gerisinde
    | 'capability_unknown'           // capability kaydi yok ya da 'version_unknown'
    | 'samples_below_minimum'        // ornek sayisi hesap icin yetersiz
    | 'query_failed';                // teknik hata

// =============================================================================
// Hedef ve zaman
// =============================================================================

/** Instance kimligi. AI'in hedefi karistirmamasi icin her cevapta tasinir. */
export interface TargetRef {
    instance_pk: string;
    instance_id: string;
    display_name: string;
    /** null = capability kaydi yok; "eski surum" demek DEGILDIR. */
    pg_major: number | null;
    server_version_num: number | null;
    is_active: boolean;
}

/**
 * Tablo kimligi: instance + database OID + relation OID.
 * Ad ile eslestirme yapilmaz — ayni isim farkli DB'lerde farkli tablodur.
 */
export interface TableRef {
    dbid: number;
    relid: number;
    datname: string | null;
    schemaname: string;
    relname: string;
}

/** Yari acik aralik [from, to). Butun endpoint'ler ayni bicimi kullanir. */
export interface TimeRangeRef {
    /** ISO 8601, UTC. Dahil. */
    from: string;
    /** ISO 8601, UTC. HARIC. */
    to: string;
}

/** Hangi cozunurlukten okundugu — ham ve aggregate ayni pencerede karistirilmaz. */
export type Resolution = 'raw' | 'hourly' | 'daily';

export interface EffectiveRange extends TimeRangeRef {
    resolution: Resolution;
    /**
     * Istenen aralik ile gercekte kullanilan aralik farkli ise nedeni.
     * null = fark yok.
     */
    adjusted_reason: string | null;
}

// =============================================================================
// Kaynak basina kapsam
// =============================================================================

/**
 * Ornek biriminin ne oldugu. Satir sayisi toplama turu sayisi DEGILDIR:
 * bir tablo-istatistik turunda yuzlerce tablo satiri, bir activity
 * snapshot'inda yuzlerce PID satiri yazilir.
 */
export type SampleUnit =
    | 'collection_round'   // distinct sample_ts — gercek toplama turu
    | 'hourly_bucket'
    | 'daily_bucket'
    | 'job_run'            // ops.job_run_instance kaydi
    | 'row';

/**
 * TEK BIR GENEL "complete" ETIKETI YOKTUR. Her kaynak kendi durumunu tasir:
 * tablo istatistigi kullanilabilirken I/O kaniti desteklenmiyor olabilir.
 */
export interface CoverageEntry {
    /** Fiziksel kaynak, orn. 'fact.pg_table_stat_delta'. */
    source: string;
    /** AI'in anlamsal olarak bekledigi yetenek adi. */
    capability: string;
    status: EvidenceStatus;
    reason_code: ReasonCode;
    resolution: Resolution | null;
    sample_unit: SampleUnit;
    /** Gozlenen ornek sayisi. */
    sample_count: number;
    /**
     * Beklenen ornek sayisi. Neredeyse her zaman null: zamanlama GECMISI
     * saklanmiyor (control.schedule_profile yalnizca BUGUNKU araliklari
     * tutar), bu yuzden gecmis bir pencere icin beklenen tur sayisi
     * BILINMEZ. Bugunku araligi gecmise uygulamak uydurma olur.
     */
    expected_sample_count: number | null;
    /** Kayip yuzde de ayni nedenle null kalir. */
    missing_sample_pct: number | null;
    earliest_sample_at: string | null;
    latest_sample_at: string | null;
    /**
     * Gozlenen en buyuk ardisik bosluk (saniye). Bu GOZLEMDIR;
     * "kacirilmis toplama turu" degildir — toplama o sirada hic
     * planlanmamis da olabilir.
     */
    max_observed_gap_seconds: number | null;
    /** Kaynak hakkinda serbest metin not (veri, talimat degil). */
    note: string | null;
}

// =============================================================================
// Metrik katalogu
// =============================================================================

export type MetricKind =
    | 'snapshot'      // o andaki deger
    | 'delta_sum'     // pencere icindeki deltalarin toplami
    | 'delta_rate'    // birim zamandaki delta
    | 'average'       // agirlikli ortalama
    | 'ratio'         // oran/yuzde
    | 'timestamp'
    | 'identity';

/**
 * Metrik anlami. Cevap boyutunu sismemek icin metrik basina bir kez,
 * `data` yaninda sozluk olarak tasinir.
 */
export interface MetricDescriptor {
    unit: string;
    kind: MetricKind;
    /** Okundugu fiziksel kolon. */
    source: string;
    /** true ise PostgreSQL tahminidir, kesin satir sayisi degildir. */
    estimate: boolean;
    /** NULL'un anlami. NULL asla otomatik sifira cevrilmez. */
    null_means: string;
    note?: string;
}

export type MetricCatalog = Record<string, MetricDescriptor>;

// =============================================================================
// Sinirlama ve eksiklik adaylari
// =============================================================================

export interface Limitation {
    code: string;
    /** Kullaniciya/AI'a gosterilecek kisa aciklama. */
    message: string;
    /** Etkilenen kaynak ya da metrik. */
    scope: string;
}

/**
 * Kalici improvement KAYDI DEGILDIR — yalnizca sonraki katmana adaydir.
 * Bu API kayit acmaz.
 *
 * Yalnizca DOGRULANMIS gozlem tasinir: gecici HTTP hatasi, gecersiz kullanici
 * girdisi ve yetkisizlik buraya girmez.
 */
export interface GapCandidate {
    /** Plan bolum 6'daki ana turler. */
    kind: 'DATA_NOT_COLLECTED' | 'DATA_INSUFFICIENT' | 'MCP_FUNCTION_MISSING';
    /** Teknik alt neden. */
    detail_code: string;
    capability: string;
    /** Gozlemin kendisi — cikarim degil. */
    observed: string;
    /** Bu eksigin arastirmayi nasil sinirladigi. */
    impact: string;
}

// =============================================================================
// Zarf
// =============================================================================

export interface EvidenceEnvelope<T> {
    schema_version: string;
    /** Anlamsal yetenek adi, orn. 'autovacuum_overview'. */
    capability: string;
    status: EvidenceStatus;
    target: TargetRef | null;
    requested_range: TimeRangeRef | null;
    effective_range: EffectiveRange | null;
    data: T | null;
    metric_catalog: MetricCatalog;
    coverage: CoverageEntry[];
    limitations: Limitation[];
    gap_candidates: GapCandidate[];
    /** Kanit referanslari — hangi tablolardan okundugu. */
    sources: string[];
    /** Cevabin uretildigi an; "bayat mi" karari bunun uzerinden yapilmaz. */
    generated_at: string;
}

// =============================================================================
// Yardimcilar
// =============================================================================

/**
 * Alt kaynak durumlarindan genel durumu turetir.
 *
 * Kural: en kotu durum kazanir, ancak kismi basari "partial" olarak gorunur.
 * Hicbir kaynak veri uretmediyse tek tip bir sonuca duser.
 */
export function deriveOverallStatus(coverage: CoverageEntry[]): EvidenceStatus {
    if (coverage.length === 0) return 'no_data';

    const statuses = coverage.map((c) => c.status);
    if (statuses.every((s) => s === 'ok')) return 'ok';
    if (statuses.some((s) => s === 'ok')) return 'partial';

    // Hicbiri ok degil — hepsi ayni nedenle basarisizsa o nedeni koru.
    const unique = Array.from(new Set(statuses));
    if (unique.length === 1) return unique[0];

    // Karisik basarisizlik: en ciddi olani one cikar.
    const severity: EvidenceStatus[] = [
        'failed',
        'not_collected',
        'unsupported_version',
        'unknown_capability',
        'insufficient_samples',
        'stale',
        'no_data',
    ];
    for (const s of severity) {
        if (statuses.includes(s)) return s;
    }
    return 'partial';
}

export interface EnvelopeInput<T> {
    capability: string;
    target: TargetRef | null;
    requestedRange: TimeRangeRef | null;
    effectiveRange: EffectiveRange | null;
    data: T | null;
    metricCatalog?: MetricCatalog;
    coverage: CoverageEntry[];
    limitations?: Limitation[];
    gapCandidates?: GapCandidate[];
    sources: string[];
    /** Verilmezse coverage'dan turetilir. */
    status?: EvidenceStatus;
}

export function buildEnvelope<T>(input: EnvelopeInput<T>): EvidenceEnvelope<T> {
    return {
        schema_version: SCHEMA_VERSION,
        capability: input.capability,
        status: input.status ?? deriveOverallStatus(input.coverage),
        target: input.target,
        requested_range: input.requestedRange,
        effective_range: input.effectiveRange,
        data: input.data,
        metric_catalog: input.metricCatalog ?? {},
        coverage: input.coverage,
        limitations: input.limitations ?? [],
        gap_candidates: input.gapCandidates ?? [],
        sources: input.sources,
        generated_at: new Date().toISOString(),
    };
}
