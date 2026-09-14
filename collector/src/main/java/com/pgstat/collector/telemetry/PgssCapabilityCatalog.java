package com.pgstat.collector.telemetry;

import org.yaml.snakeyaml.Yaml;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * pg_stat_statements yetenek katalogu ve surume gore projection uretimi.
 *
 * ---------------------------------------------------------------------------
 * NEDEN VAR
 * ---------------------------------------------------------------------------
 * pgss extension surumu PostgreSQL surumunden BAGIMSIZDIR. Collector ise
 * sorguyu yalnizca pg_major'a bakarak seciyordu; extension geride kalmissa
 * sorgu var olmayan bir kolona referans verip TAMAMEN basarisiz oluyordu.
 *
 * Olculdu (2026-09-14, postgres:17 uzerinde her surum tek tek kurularak):
 *   pgss 1.9  + Pg14_16 sorgusu  -> ERROR: column "jit_generation_time" does not exist
 *   pgss 1.10 + Pg17_18 sorgusu  -> ERROR: column "shared_blk_read_time" does not exist
 *
 * Ilki uc durum bile degil: PG14 varsayilan olarak pgss 1.9 ile gelir.
 *
 * ---------------------------------------------------------------------------
 * NEDEN KATALOG, NEDEN YAMA DEGIL
 * ---------------------------------------------------------------------------
 * Dort ayri elle yazilmis sorgudaki kolonlari tek tek duzeltmek, ayni hatanin
 * besinci ailede tekrar etmesini engellemez. Kolon-surum sinirlari tek bir
 * deklaratif dosyada (telemetry/pgss-capabilities.yml) tutuluyor ve sorgu
 * oradan URETILIYOR. Sinirlar dokumantasyondan kopyalanmadi, gercek
 * PostgreSQL'de olculdu.
 *
 * ---------------------------------------------------------------------------
 * BILINMEYEN SURUM POLITIKASI
 * ---------------------------------------------------------------------------
 * Surum okunamazsa surume bagli HER kolon to_jsonb uzerinden okunur.
 *
 * Once "en dusuk surumun projection'i her yerde calisir" varsayilmisti; bu
 * YANLIS cikti ve ancak gercek veritabaninda kosturunca goruldu: pgss 1.8
 * total_time'i total_exec_time olarak YENIDEN ADLANDIRDI, yani 1.4
 * projection'i 1.8+ uzerinde "column total_time does not exist" ile patliyor.
 * Surum uzayi ikiye bolunmus; tek bir dogrudan referansli guvenli taban yok.
 *
 * Iyimser davranip en yeni sorguyu denemek ise tam da duzeltmeye calistigimiz
 * kirilmayi ureten davranistir.
 *
 * Katalogda "verified": false isaretli bir sinir olursa o kolon her zaman
 * to_jsonb ile guvenli okunur. Su anki sinirlarin tamami gercek PostgreSQL'de
 * olculdu; mekanizma gelecekteki dogrulanmamis eklemeler icin korunuyor.
 */
@Component
public class PgssCapabilityCatalog {

    private static final Logger log = LoggerFactory.getLogger(PgssCapabilityCatalog.class);

    private static final String RESOURCE = "telemetry/pgss-capabilities.yml";

    private final java.util.Map<String, Object> root;
    private final List<Capability> capabilities;

    private static final Pattern IDENTIFIER = Pattern.compile("[a-z][a-z0-9_]*");
    private static final Set<String> ALLOWED_TYPES = Set.of(
            "oid", "bigint", "numeric", "double precision", "boolean", "timestamptz");

    public PgssCapabilityCatalog() {
        this(load());
    }

    /** Testlerin bozuk kataloglari dosya sistemi olmadan dogrulayabilmesi icin. */
    PgssCapabilityCatalog(Map<String, Object> root) {
        this.root = root;
        this.capabilities = parse(root);
        validate(root, capabilities);
    }

    @SuppressWarnings("unchecked")
    private static java.util.Map<String, Object> load() {
        // SnakeYAML, spring-boot-starter ile zaten geliyor — bu katalog icin
        // yeni bir bagimlilik eklenmedi. YAML secildi cunku yorumlar yerel ve
        // katalog ileride Node tarafindan da okunabilir olmali.
        try (InputStream in = new ClassPathResource(RESOURCE).getInputStream()) {
            return (java.util.Map<String, Object>) new Yaml().load(in);
        } catch (Exception e) {
            // Katalog okunamazsa sessizce bos donmek, sorgunun kolonsuz
            // uretilmesine ve her seyin sifirlanmasina yol acardi. Baslangicta
            // patlamasi dogru: eksik bir katalog, yanlis veriden iyidir.
            throw new IllegalStateException("pgss yetenek katalogu okunamadi: " + RESOURCE, e);
        }
    }

    /** Iki parcali pgss surumu. "1.4" < "1.10" karsilastirmasi METIN olarak yanlistir. */
    public record PgssVersion(int major, int minor) implements Comparable<PgssVersion> {
        public static PgssVersion of(String raw) {
            if (raw == null || raw.isBlank()) return null;
            String[] parts = raw.trim().split("\\.");
            try {
                int mj = Integer.parseInt(parts[0]);
                int mn = parts.length > 1 ? Integer.parseInt(parts[1]) : 0;
                return new PgssVersion(mj, mn);
            } catch (NumberFormatException e) {
                return null;
            }
        }
        @Override public int compareTo(PgssVersion o) {
            return major != o.major ? Integer.compare(major, o.major)
                                    : Integer.compare(minor, o.minor);
        }
        @Override public String toString() { return major + "." + minor; }
    }

    /**
     * Bir hedef kolonun tek bir surum araligindaki kaynagi.
     *
     * Ya tek bir kolon adi (name) ya da SINIRLI bir turetme (derive). Serbest
     * SQL bilerek desteklenmiyor: serbest bir ifade savunmaci (to_jsonb) modda
     * uretilemiyordu ve degeri sessizce sifirliyordu.
     */
    record Source(String name, String deriveOp, List<String> deriveOf, PgssVersion min, PgssVersion max) {
        boolean covers(PgssVersion v) {
            if (min != null && v.compareTo(min) < 0) return false;
            if (max != null && v.compareTo(max) > 0) return false;
            return true;
        }
        boolean isDerived() { return deriveOp != null; }

        /** Dogrudan mod: kolonlara referans. */
        String sql(String type) {
            if (!isDerived()) return name;
            return "(" + join(deriveOf.stream()
                .map(c -> "coalesce(" + c + ", 0)").toList()) + ")";
        }

        /** Savunmaci mod: ayni turetme, to_jsonb uzerinden. */
        String jsonSql(String type) {
            if (!isDerived()) return "(j->>'" + name + "')::" + type;
            return "(" + join(deriveOf.stream()
                .map(c -> "coalesce((j->>'" + c + "')::" + type + ", 0)").toList()) + ")";
        }

        private String join(List<String> parts) {
            // Su an tek islem: sum. Yeni bir islem eklenirse burada acikca
            // ele alinmali; sessiz bir varsayilan yanlis metrik uretir.
            if (!"sum".equals(deriveOp)) {
                throw new IllegalStateException("Bilinmeyen derive islemi: " + deriveOp);
            }
            return String.join(" + ", parts);
        }
    }

    record Column(String target, String type, String defaultValue, boolean verified, List<Source> sources) {}

    record Capability(String key, String title, PgssVersion minPgss, boolean verified, List<Column> columns) {}

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> nodes(Object parent, String key) {
        if (!(parent instanceof Map<?, ?> m)) return List.of();
        Object v = m.get(key);
        return v instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
    }

    private static String str(Map<String, Object> m, String key, String fallback) {
        Object v = m.get(key);
        return v == null ? fallback : String.valueOf(v);
    }

    private static boolean bool(Map<String, Object> m, String key, boolean fallback) {
        Object v = m.get(key);
        return v instanceof Boolean b ? b : fallback;
    }

    private static List<Capability> parse(Map<String, Object> root) {
        List<Capability> out = new ArrayList<>();
        for (Map<String, Object> c : nodes(root, "capabilities")) {
            boolean capabilityVerified = bool(c, "verified", true);
            List<Column> cols = new ArrayList<>();
            for (Map<String, Object> col : nodes(c, "columns")) {
                List<Source> sources = new ArrayList<>();
                for (Map<String, Object> s : nodes(col, "sources")) {
                    String op = null;
                    List<String> of = null;
                    if (s.get("derive") instanceof Map<?, ?> d) {
                        op = d.get("op") == null ? null : String.valueOf(d.get("op"));
                        if (d.get("of") instanceof List<?> l) {
                            of = l.stream().map(String::valueOf).toList();
                        }
                    }
                    sources.add(new Source(
                        str(s, "name", null),
                        op, of,
                        PgssVersion.of(str(s, "min", null)),
                        PgssVersion.of(str(s, "max", null))));
                }
                cols.add(new Column(
                    str(col, "target", null),
                    str(col, "type", "text"),
                    str(col, "default", "0"),
                    capabilityVerified && bool(col, "verified", true),
                    sources));
            }
            out.add(new Capability(
                str(c, "key", null),
                str(c, "title", ""),
                PgssVersion.of(str(c, "min_pgss", "1.4")),
                capabilityVerified,
                cols));
        }
        return out;
    }

    private static void validate(Map<String, Object> root, List<Capability> capabilities) {
        validateRawVersions(root);
        Object catalogVersion = root.get("catalog_version");
        if (!(catalogVersion instanceof Number n) || n.intValue() <= 0) {
            fail("catalog_version", "pozitif bir tamsayi olmali");
        }
        if (capabilities.isEmpty()) fail("capabilities", "en az bir capability gerekli");

        Set<String> keys = new HashSet<>();
        Set<String> targets = new HashSet<>();
        for (Capability capability : capabilities) {
            String cp = "capability[" + capability.key() + "]";
            if (blank(capability.key())) fail(cp, "key bos olamaz");
            if (!keys.add(capability.key())) fail(cp, "yinelenen capability key");
            if (capability.minPgss() == null) fail(cp, "min_pgss gecersiz");

            for (Column column : capability.columns()) {
                String p = cp + ".column[" + column.target() + "]";
                if (blank(column.target()) || !IDENTIFIER.matcher(column.target()).matches()) {
                    fail(p, "target gecerli bir SQL identifier olmali");
                }
                if (!targets.add(column.target())) fail(p, "yinelenen target");
                if (!ALLOWED_TYPES.contains(column.type())) fail(p, "izin verilmeyen type: " + column.type());
                validateDefault(p, column.type(), column.defaultValue());
                if (column.sources().isEmpty()) fail(p, "sources bos olamaz");

                for (int i = 0; i < column.sources().size(); i++) {
                    Source source = column.sources().get(i);
                    String sp = p + ".sources[" + i + "]";
                    boolean hasName = !blank(source.name());
                    boolean hasDerive = !blank(source.deriveOp());
                    if (hasName == hasDerive) fail(sp, "tam olarak name veya derive tanimlanmali");
                    if (hasName && !IDENTIFIER.matcher(source.name()).matches()) fail(sp, "gecersiz source name");
                    if (source.min() != null && source.max() != null
                            && source.min().compareTo(source.max()) > 0) fail(sp, "min max'tan buyuk");
                    if (hasDerive) {
                        if (!"sum".equals(source.deriveOp())) fail(sp, "desteklenmeyen derive.op: " + source.deriveOp());
                        if (source.deriveOf() == null || source.deriveOf().isEmpty()) fail(sp, "derive.of bos olamaz");
                        for (String name : source.deriveOf()) {
                            if (blank(name) || !IDENTIFIER.matcher(name).matches()) fail(sp, "gecersiz derive.of");
                        }
                    }
                    for (int j = i + 1; j < column.sources().size(); j++) {
                        if (overlaps(source, column.sources().get(j))) fail(sp, "surum araligi sources[" + j + "] ile cakisisiyor");
                    }
                }
                validateNoInternalGaps(p, column.sources());
            }
        }
    }

    /**
     * Bir kolonun kaynaklari arasinda kapsanmayan surum araligi birakilmis mi?
     *
     * VARSAYIM: pgss surumleri minor numaralarini ATLAMADAN yayimlanir
     * (1.4, 1.5, ... 1.12 boyle geldi). Bitisiklik bu yuzden minor + 1 olarak
     * hesaplaniyor.
     *
     * PostgreSQL bu duzeni degistirir ve bir minor atlarsa — orn. 1.12 sonrasi
     * dogrudan 1.14 — GECERLI bir katalog burada reddedilir ve dogrulama
     *  constructor.inda calistigi icin COLLECTOR HIC BASLAMAZ.
     *
     * Fail-fast bilerek korundu: gercek katalog her build.te test ediliyor,
     * yani bozuk bir katalog CI.yi gecemez; bu kontrol ikinci savunma hatti.
     * Ama yeni bir pgss surumu eklenirken bu varsayim AYRICA dogrulanmalidir.
     */
    private static void validateNoInternalGaps(String path, List<Source> sources) {
        if (sources.size() < 2) return;
        List<Source> ordered = new ArrayList<>(sources);
        ordered.sort(Comparator.comparing(Source::min,
                Comparator.nullsFirst(Comparator.naturalOrder())));
        for (int i = 1; i < ordered.size(); i++) {
            PgssVersion previousMax = ordered.get(i - 1).max();
            PgssVersion currentMin = ordered.get(i).min();
            if (previousMax == null || currentMin == null) continue;
            PgssVersion next = new PgssVersion(previousMax.major(), previousMax.minor() + 1);
            if (currentMin.compareTo(next) > 0) {
                fail(path, "sources arasinda kapsanmayan surum araligi: "
                        + previousMax + " sonrasi " + currentMin);
            }
        }
    }

    private static void validateRawVersions(Map<String, Object> root) {
        for (Map<String, Object> capability : nodes(root, "capabilities")) {
            validateVersionValue(capability, "min_pgss", "capability[" + capability.get("key") + "]");
            for (Map<String, Object> column : nodes(capability, "columns")) {
                String path = "capability[" + capability.get("key") + "].column[" + column.get("target") + "]";
                for (Map<String, Object> source : nodes(column, "sources")) {
                    validateVersionValue(source, "min", path);
                    validateVersionValue(source, "max", path);
                }
            }
        }
    }

    private static void validateVersionValue(Map<String, Object> node, String key, String path) {
        if (!node.containsKey(key)) return;
        String raw = String.valueOf(node.get(key));
        if (!raw.matches("\\d+\\.\\d+") || PgssVersion.of(raw) == null) {
            fail(path, key + " gecersiz: " + raw);
        }
    }

    private static boolean overlaps(Source a, Source b) {
        return (a.max() == null || b.min() == null || a.max().compareTo(b.min()) >= 0)
                && (b.max() == null || a.min() == null || b.max().compareTo(a.min()) >= 0);
    }

    private static void validateDefault(String path, String type, String value) {
        if ("null".equalsIgnoreCase(value)) return;
        boolean valid = switch (type) {
            case "oid", "bigint" -> value.matches("-?\\d+");
            case "numeric", "double precision" -> value.matches("-?\\d+(\\.\\d+)?");
            case "boolean" -> "true".equalsIgnoreCase(value) || "false".equalsIgnoreCase(value);
            case "timestamptz" -> false;
            default -> false;
        };
        if (!valid) fail(path, "default '" + value + "' type " + type + " ile uyumsuz");
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }

    private static void fail(String path, String message) {
        throw new IllegalStateException("Gecersiz pgss katalogu: " + path + " — " + message);
    }

    /** Katalogdaki tum hedef kolonlar, katalog sirasinda. */
    public List<String> targetColumns() {
        List<String> out = new ArrayList<>();
        for (Capability c : capabilities) for (Column col : c.columns()) out.add(col.target());
        return out;
    }

    /**
     * Bir surumde yeteneklerin durumu.
     *
     * UC KUMEDIR, IKI DEGIL. Surum bilinmiyorsa hicbir yetenek "var" ya da
     * "yok" degildir — hepsi BILINMIYOR. Onceki API bilinmeyen surumu en dusuk
     * surum sayiyordu; bu, sorunun cevabini uydurmak oluyordu ve tam da bu
     * calismanin kaldirdigi "surumu baska bir seyden cikarma" hatasinin bir
     * baska bicimiydi.
     *
     * @param available kanitlanmis olarak MEVCUT
     * @param missing   kanitlanmis olarak YOK
     * @param unknown   surum okunamadigi icin karar verilemeyen
     */
    public record CapabilityAssessment(Set<String> available, Set<String> missing, Set<String> unknown) {
        public boolean versionKnown() { return unknown.isEmpty(); }
    }

    /**
     * Verilen surumde yeteneklerin durumu.
     *
     * SORGUNUN CALISABILMESI, YETENEGIN KANITLANMIS OLMASI DEMEK DEGILDIR.
     * Surum bilinmedigi halde savunmaci projection her surumde kosar; ama o
     * modda bir kolonun sifir donmesi "olculdu ve sifir" ile "kolon yok"
     * arasinda ayrim tasimaz. Sorgunun ayakta kalmasi ile verinin anlamli
     * olmasi iki ayri sey.
     */
    public CapabilityAssessment assess(PgssVersion version) {
        Set<String> available = new LinkedHashSet<>();
        Set<String> missing = new LinkedHashSet<>();
        Set<String> unknown = new LinkedHashSet<>();
        for (Capability c : capabilities) {
            if (version == null) {
                unknown.add(c.key());
            } else if (c.minPgss() == null || version.compareTo(c.minPgss()) >= 0) {
                available.add(c.key());
            } else {
                missing.add(c.key());
            }
        }
        return new CapabilityAssessment(available, missing, unknown);
    }

    /**
     * Verilen pgss surumu icin SELECT listesini uretir.
     *
     *  version null ise savunmaci projection uretilir (surume bagli her
     *                kolon to_jsonb uzerinden okunur).
     */
    public String buildSelectList(PgssVersion version) {
        List<String> lines = new ArrayList<>();
        for (Capability c : capabilities) {
            for (Column col : c.columns()) {
                lines.add("  " + (version == null
                    ? defensiveProjectionFor(col)
                    : projectionFor(col, version)));
            }
        }
        return String.join(",\n", lines);
    }

    /**
     * Surum BILINMEDIGINDE kullanilan projection.
     *
     * "En dusuk surumun projection'i her yerde calisir" varsayimi YANLIS ve
     * bu gercek PostgreSQL'de olculdu: pgss 1.8 total_time'i total_exec_time
     * olarak YENIDEN ADLANDIRDI, yani 1.4 projection'i 1.8+ uzerinde
     * "column total_time does not exist" ile patliyor. Surum uzayi ikiye
     * bolunmus durumda; tek bir dogrudan referansli guvenli taban yok.
     *
     * Bu yuzden bilinmeyen surumde surume bagli her kolon to_jsonb uzerinden,
     * kaynak adaylari sirayla denenerek okunur. Boylece sorgu HICBIR surumde
     * patlamaz.
     *
     * TURETILMIS kolonlar da bu modda uretilir. Ilk surumde serbest SQL
     * kullanilmisti ve savunmaci modda uretilemiyordu; sonuc olarak
     * blk_read_time 1.11+ uzerinde SESSIZCE sifira duruyordu. Kod yorumu
     * bunun "version_unknown olarak kaydedildigini" soyluyordu ama boyle bir
     * kayit yoktu — yorum gercekle celisiyordu (dis inceleme, 2026-09-14).
     * Sinirli derive islemleri bu kaybi tamamen ortadan kaldirdi.
     */
    private String defensiveProjectionFor(Column col) {
        List<String> candidates = new ArrayList<>();
        for (Source s : col.sources()) {
            candidates.add(s.jsonSql(col.type()));
        }
        if (candidates.isEmpty()) {
            return col.defaultValue() + "::" + col.type() + " as " + col.target();
        }
        candidates.add(col.defaultValue() + "::" + col.type());
        return "coalesce(" + String.join(", ", candidates) + ") as " + col.target();
    }

    private String projectionFor(Column col, PgssVersion v) {
        Source hit = null;
        for (Source s : col.sources()) {
            if (s.covers(v)) { hit = s; break; }
        }

        if (hit == null) {
            // Bu surumde kolon YOK. Varsayilan uretilir ve bu deger "olculmedi"
            // demektir, "sifir" demek degil — ayrimi kanit katmani tasiyacak.
            return col.defaultValue() + "::" + col.type() + " as " + col.target();
        }

        if (!col.verified() && !hit.isDerived()) {
            // Sinir OLCULMEDI. Dogrudan referans, sinir yanlissa sorgunun
            // tamamini dusurur; to_jsonb ile okumak yalnizca o kolonu bosaltir.
            return "coalesce((j->>'" + hit.name() + "')::" + col.type() + ", "
                 + col.defaultValue() + ") as " + col.target();
        }

        return hit.sql(col.type()) + " as " + col.target();
    }

    /**
     * Tam pgss sorgusu.
     *
     * to_jsonb(s.*) her zaman uretilir: dogrulanmamis sinirlardaki kolonlar
     * bunun uzerinden okunuyor ve maliyeti zaten mevcut sorgularda var.
     *
     * @param pgssFunction schema-qualified pg_stat_statements fonksiyonu
     * @param version      okunan extension surumu; null ise guvenli taban
     */
    public String buildStatsQuery(String pgssFunction, PgssVersion version) {
        if (version == null) {
            // "Guvenli taban" demek yaniltici olurdu: en dusuk surumun
            // projection.i her yerde calismiyor (1.8 yeniden adlandirmasi).
            // Uretilen sey savunmaci projection — her surumde kosar ama
            // kolonlarin bir kismi sessizce varsayilana dusebilir.
            log.warn("pgss surumu bilinmiyor, savunmaci projection kullaniliyor; "
                   + "yetenek kaniti YOK ve bazi kolonlar varsayilana dusebilir");
        }
        return """
            with src as (
              select to_jsonb(s.*) as j, s.* from %s(false) s
            )
            select
            %s
            from src
            """.formatted(pgssFunction, buildSelectList(version));
    }

    /**
     * pg_stat_statements_info bu surumde okunabilir mi?
     *
     * Karar PG AILESINDEN degil, kesfedilen extension surumunden verilir.
     * Onceden supportsPgssInfo() yalnizca Pg14_16Queries'te true idi; PG14+
     * sunucuda pgss 1.8 kalmissa view yok ve sorgu patliyordu. Uretimde bu
     * hatanin izi var (bipgsql-test, 2026-04-30).
     *
     * Surum bilinmiyorsa FALSE doner: okunamayacagini varsaymak, olmayan bir
     * view'i sorgulamaktan iyidir.
     */
    public boolean supportsInfoView(PgssVersion version) {
        return assess(version).available().contains("statements.info");
    }

    /**
     * Katalog revizyonu — merkezi kayitla birlikte saklanir ve OKUNUR.
     *
     * Kanitin anlami kataloga baglidir: ayni kolon, katalog degistiginde farkli
     * bir kaynaktan veya farkli bir semantikle uretilmis olabilir. Kayitli
     * revizyon calisandan farkliysa o instance in yetenek kaniti baska bir
     * katalogla yazilmis demektir ve yeniden kesfedilmelidir.
     *
     * NE ZAMAN ARTIRILIR: bir kolonun ANLAMI degistiginde ya da bir sinir
     * duzeltildiginde. Yalnizca yorum veya baslik degisikligi artirmaz.
     */
    public int catalogVersion() {
        Object v = root.get("catalog_version");
        return v instanceof Number n ? n.intValue() : 0;
    }
}
