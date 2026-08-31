# Bulgular (Findings) — Tasarım

**Durum:** r5 — dar inceleme uygulandı; §8 ve §4.4 için yeni toplama gerekiyor
**Tarih:** 2026-08-31
**Değişiklik:** dört tur dış inceleme uygulandı. r1→r2 §11, r2→r3 §11b,
r3→r4 §11c, r4→r5 §11d.

> **Dar inceleme sonucu:** §4.3 küçük düzeltmelerle geçti. §4.4 ve §8
> revize edildi — ikisi de kodlamadan önce yeni veri toplama gerektiriyor.
> İnceleme ayrıca **canlıdaki bir hatayı** buldu: table_space_bloat
> alarmı fillfactor payını iki kez düşüyordu. Düzeltildi ve kural, kalan
> iki sorun giderilene kadar **devre dışı bırakıldı** (PGSTAT-P0-046).

---

## 1. Problem

pgstat bugün **alarm** üretiyor: eşik aşılınca açılan, çözülünce kapanan,
bildirim gönderen kayıtlar. "Şu an müdahale gerekli mi?" sorusunu
cevaplıyor.

İzleme sırasında ortaya çıkan değerli gözlemlerin çoğu bu kalıba uymuyor.
Son bir haftada üretilen ve **hepsi elle SQL yazılarak** bulunan gözlemler:

| Gözlem | Neden alarm değil |
|---|---|
| `reltuples` 30.404.328, `n_live_tup` 0 — istatistikler güvenilmez | Acil değil, ama üstüne kurulan her hesabı bozuyor |
| Bir partition 11.740 satırı 637 MB'da tutuyor | Eşik yok; sorun tasarımsal |
| `fact.pg_index_stat_delta` günde ~3 GB üretiyor | Büyüme normal, ama sonucu bilinmeli |
| 12.116 tablonun 4.478'i analiz edilmemiş | Çoğu masum; hangisi değil? |
| Bir tabloda satır başına ~9 UPDATE | Yavaş biriken tasarım sorunu |
| `agg.pg_table_stat_hourly_202608` %98 boş alan | Ölü satır oranı bunu göstermiyordu |

Hiçbiri gece 3'te kimseyi uyandırmamalı. Hepsi bilinmeye değer. Şu an
yalnızca birisi elle sorgu yazarsa görünüyorlar.

## 2. Mevcut yüzeylerle ilişki

pgstat'ta bugün üç kullanıcı yüzeyi var. Dördüncüsünü eklemeden önce
farkın net olması gerekiyor.

Ayırt edici olan **teknik üretim farkı değil, kullanıcı niyeti**:

| Sıra | Yüzey | Kullanıcının sorusu |
|---|---|---|
| 1 | **Alarmlar** | "Şimdi neye müdahale etmeliyim?" |
| 2 | **Bulgular** *(yeni)* | "Sistem planlı incelemem için ne fark etti?" |
| 3 | **Insights / Analiz** | "Ben neyi araştırmak istiyorum?" |
| 4 | **Sistem Sağlığı** | "Toplama sistemine güvenebilir miyim?" |

**Karar: Bulgular ayrı bir üst seviye sekme olur**, yukarıdaki sırayla.

Gerekçe: Bulgular **fleet çapında bir inceleme kuyruğu**, Insights ise bir
**araştırma aracı**. Bulguları Insights altına koymak, sistemin seçtiği
inceleme adayını yeniden kullanıcının keşfetmesine bırakır — yani işin
tam tersini yapar.

Ayrı sekmeyi haklı çıkaran, Insights'ta karşılığı olmayan özellikler:
yeni/değişen/geri dönen yaşam döngüsü (§6), kullanıcı bazlı
görüldü/beklenen/ertelendi durumu, haftalık inceleme ritmi (§7), birden
fazla Insights merceğine yönlendirme, kendi filtreleri ve geçmişi.

Bunlar olmasa "Insights → Öne Çıkanlar" yeterdi. Bulgular artık filtrelenmiş
bir kart listesi değil, bir **dikkat yönlendirme katmanı**.

### Kullanıcı akışı

> Sistem seçer → kullanıcı **Bulgular**'da değerlendirir → gerekirse
> **Insights**'ta araştırır.

### Navigasyon kuralları

Ayrı sekmenin alarm gibi algılanmaması için:

- **Rozet**, toplam aktif bulguyu değil yalnızca *"son incelemeden beri
  yeni veya anlamlı değişen"* sayısını gösterir
- Rozet ve kartlar **kırmızı/uyarı tonunda olmaz**
- Kart, analiz ekranını **kopyalamaz**: kısa gözlem + önem gerekçesi +
  kapsam + sınırlama
- Birincil eylem **"Insights'ta incele"**
- Derin bağlantı instance, veritabanı, relation, zaman aralığı ve **mercek
  seçimini** taşır
- Insights'tan dönüldüğünde Bulgular'ın filtresi ve liste konumu **korunur**

### Örtüşme kuralı

`Insights` içinde zaten "Vacuum Lag" merceği var ve önerdiğimiz
"autovacuum yetişemiyor" bulgusuyla aynı olguya bakıyor.

**Aynı gerçek iki kart üretmez.** Bulgu ilgili mercege *bağlantı verir*,
merceğin kendisini kopyalamaz.

### İsimlendirme

"Findings" ve "Insights" İngilizcede birbirine yakın algılanabiliyor.
Navigasyonda görev odaklı alt açıklama kullanılır:

| Sekme | Alt açıklama |
|---|---|
| **Bulgular** | Sistemin seçtiği inceleme adayları |
| **Insights / Analiz** | Araştırma mercekleri |

### Yüzey sınırı: sağlık mı, bulgu mu

| Durum | Yüzey |
|---|---|
| Collector tazeliği, toplama hatası, pgstat'ın kendi çalışma sorunu | **Sistem Sağlığı** |
| Veritabanı istatistiklerinin bir kararı güvenilmez hâle getirmesi | **Bulgular** |

Örnek: "toplama 2 saattir yapılamıyor" Sistem Sağlığı'dır. "4.478 tablonun
satır sayısı tahmini güvenilmez, bu tablolarda bloat hesabı yapılamıyor"
Bulgu'dur.

> **Geri çekilen itiraz.** İlk inceleme, üründe hâlihazırda bir
> "Recommendations" motoru olduğunu ve dördüncü kavramın gürültü
> üreteceğini söylemişti. Kod tabanı kontrol edildi: pgstat'ta öneri
> motoru **yok** (`recommendation` için sıfır eşleşme, ilgili tablo yok);
> verilen dosya yolları (`New project`, `com.pgobs.platform`) başka bir
> projeye aitti. İncelemeci itirazı geri çekti ve doğru bağlamda **ayrı
> sekme** yönünde görüş bildirdi. Uyarının özü — yüzey çoğaltmamak — yine
> de bu bölümdeki sınır ve örtüşme kurallarına dönüştü.

## 3. Alarm ile Bulgu ayrımı

İlk taslak ayrımı "eşik / örüntü" üzerinden kuruyordu. **Bu yanlıştı:**
alarm da eğilimden üretilebilir, bulgu da eşikten. Dayanıklı tanım:

> **Alarm müdahale ister. Bulgu değerlendirme ister.**

Somut kriter: *bir sonraki planlı incelemeye kadar beklemesi kabul
edilemez* ise alarmdır. Planlı incelemede ele alınabiliyorsa bulgudur.

Aynı olgu ikisine de dönüşebilir — eşik zamandır:

| Durum | Sınıf |
|---|---|
| Disk dolum tahmini 30 gün | Bulgu |
| Disk dolum tahmini 48 saat | Alarm |

| | Alarm | Bulgu |
|---|---|---|
| Talep | Müdahale | Değerlendirme |
| Yaşam döngüsü | Açılır → çözülür | Belirir → sona erer |
| Bildirim | Anlık, tekil | Yok; yalnızca haftalık özet |
| Kullanıcı eylemi | Kapat / onayla | Okur, erteler, "beklenen" işaretler |

## 4. Bulgu kataloğu

Her bulgu için: ne söylediği, hangi veriden hesaplandığı, **neyi
söylemediği**, ve hangi sürüme ait olduğu.

### V1 (ilk sürüm)

#### 4.1 Büyüme gözlemi — ve koşullu projeksiyon

> `fact.pg_index_stat_delta` son 7 günde günde ortalama **+3,1 GiB**
> büyüdü.

Projeksiyon **yalnızca güven kapılarının hepsi geçilirse** eklenir:

- En az 30 günlük pencere, ≥26/30 geçerli gece ölçümü
- Tahmin ufku gözlem penceresinden uzun değil
- Pencerede reset, `VACUUM FULL`, `TRUNCATE`, rewrite, partition
  attach/drop **yok**
- 14 ve 30 günlük robust eğimler **aynı yönde** ve biri diğerinin
  0,5–2 katı aralığında
- **Backtest**: rolling-origin medyan hatası, öngörülen değişimin en fazla
  **%50'si**; en az **3 test penceresi**; yön tutarlılığı. Eşik dedektör
  sürümüne bağlı ve **yapılandırılabilir**
- Tahmin aralığının alt sınırı > 0
- Öngörülen etki `max(1 GiB, mevcut boyutun %10'u)` eşiğini aşıyor

Koşullar geçilmezse **gelecek değeri gösterilmez**; yalnızca geçmiş
gözlem yazılır.

- **Veri:** `fact.pg_relation_size_snapshot` (gece, ~4 ay)
- **Söylemediği:** iş yükü değişirse eğim değişir; bu tahmin, taahhüt değil

**Mantıksal hacim ile fiziksel alan ayrı gösterilir.** İlk taslak
"retention 14 gün olduğu için ~43 GiB'da dengelenir" diyordu; bu iddia
doğrulanmamıştı ve genel olarak yanlıştır. Standart `VACUUM` alanı çoğu
zaman dosya sistemine **iade etmez**, tablo içinde yeniden kullanıma açar;
partition `DROP` ve `TRUNCATE` farklı davranır. Denge iddiası ancak
retention yöntemi bilindiğinde ve **en az iki retention çevrimi
gözlendiğinde** yapılabilir.

#### 4.2 Yazma deseni — satır başına aşırı güncelleme

> `agg.pg_table_stat_hourly_202608`: 121.162 satıra 1.126.780 güncelleme
> (satır başına ~9). Bu desen ölü satır üretir.

- **Veri:** `fact.pg_table_stat_delta` (`n_tup_upd_delta`, `reltuples`)
- **Söylemediği:** desen kasıtlı olabilir (rollup UPSERT'i gibi); gözlem,
  suçlama değil

#### 4.3 Veri güvenilirliği · **V1, ilk yazılacak**

> `etsrooms` veritabanında istatistikler 2026-03-04'te sıfırlanmış
> (176 gün önce). O tarihten beri analiz edilmemiş 4.478 tablo var; bu
> tablolarda satır sayısına dayanan hiçbir hesap yapılamıyor.

**Ölçtüğü:** `last_analyze` ve `last_autoanalyze`'ın ikisinin de boş
olduğu **ve** `reltuples`'ın **bilinmediği** (`NULL` ya da `-1`) tablo
sayısı; ve o veritabanının `stats_reset` tarihi.

> `reltuples = 0` **bilinmiyor değildir** — tablo gerçekten boş olabilir.
> Ayrı ele alınır.

**Söylemediği:**
- Bu tabloların sorunlu olduğunu. Çoğu değişmediği için analiz
  edilmemiştir. *(Önceki taslaktaki "PostgreSQL analiz etmeye değer
  bulmamıştır" ifadesi **kaldırıldı** — sebep ölçülmüyor.)*
- Sıfırlamadan **önce** analiz edilip edilmediğini. `last_analyze`
  sıfırlamada silinir; "hiç" değil "sıfırlamadan beri" demektir.
  *(`stats_reset` bu zaman damgaları için kesin bir alt sınır olarak
  sunulmaz — yalnızca bilinen en erken referanstır.)*
- İstatistiklerin ne kadar yanlış olduğunu — yalnızca **düzeltilmemiş**
  olduğunu.

### Satır uygunluk kapısı

Satır sayısına dayanan bulgular (§4.2, §4.4) yalnızca `reltuples` bilinen
tablolarda hesaplanabilir — ölçümde 12.116'nın **7.638'i**, ~%63.

İki nokta:

1. **Kapı tablo bazında çalışır** ve bu bulgunun *yayımlanmasından
   bağımsızdır.* Eşik aşılmasa bile, satır tahmini güvenilmez **tek bir
   tablo** §4.2/§4.4'e girmez.
2. **§4.1 bastırılmaz.** Büyüme gözlemi fiziksel boyut serisine dayanır,
   satır tahminine değil. Onu susturmak gereksiz bilgi kaybı olurdu.

Kapsam her kartta yazılır: *"7.638/12.116 tablo değerlendirildi"*.

#### 4.4 Kaynak israfı · **V1, ikinci yazılacak**

> `fact.pgss_delta_20260820` 11.740 satırı 637 MB'da tutuyor. Satır başına
> ~54 kB; aynı tablonun geçmişte ölçülen en sıkışık hâli ~870 B/satır.

**Ölçtüğü:** **tahmini satır sayısıyla normalize edilmiş fiziksel heap
boyutu karşılaştırması.** Aynı tablonun geçmişindeki **en yoğun
karşılaştırılabilir gözleme** oranlanır.

> "İki ölçüm arasındaki fark, tahmin değil" ifadesi **kaldırıldı** — payda
> (`reltuples`) katalogdaki bir **tahmin**, ölçüm değil.

> "Tarihsel minimum = sıkışık hâl" varsayımı da **kaldırıldı**. Minimum,
> tablonun sıkışık olduğunu **kanıtlamaz**; yalnızca gözlemlediğimiz en
> yoğun hâldir. Karşılaştırılabilirlik şema ve `fillfactor` rejimiyle
> sınırlıdır; rejim değişince taban bölünmelidir.

**Ön koşullar (hiçbiri sağlanmazsa dedektör susar):**
- Boyut gözlemi ve satır tahmini **aynı ana** ait olmalı; doğrulanmış,
  kesintisiz bir delta zinciri gerekli
- Geçmiş **kimlikle** eşleşmeli (`relid`), adla değil
- Taban ve şimdiki gözlem **aynı `fillfactor` rejiminde** olmalı

**Söylemediği:**
- **TOAST ve indeks şişmesini.** Yalnızca heap (`table_size_bytes`).
- **Satır genişliği değişiminden gelen büyümeyi.** Şema değişikliği, veri
  dağılımının kayması ya da daha geniş değerler yazılması da bayt/satır'ı
  büyütür — bu şişme değildir.
- **Küçük oranlarda güvenilir bir sayı.** Tahmini satır sayısı,
  `reltuples` örneklemesi, düşürülmüş kolonlar ve TOAST dağılımı hata
  biriktirir. *(Önceki taslaktaki "~%30" rakamı **kaldırıldı** — backtest
  sonucu değildi, tahmindi. Gerçek band ilk backtest ile ölçülecek ve
  eşik ona göre konacak.)*
- Tabloyu **karşılaştırılabilir bir hâlde hiç görmediysek** hiçbir şey.
  Uydurulmuş bir taban, yanlış bulgudan daha zararlıdır.

> **Durum:** bu dedektörün canlıdaki öncülü (`table_space_bloat` alarmı)
> yukarıdaki ilk iki ön koşulu sağlamadığı için **devre dışı bırakıldı**
> (PGSTAT-P0-046). Bulgu sürümü, o eksikler giderilmeden yazılmayacak.

#### 4.5 Autovacuum yetişemiyor

> Son 24 saatte bu tabloda 14 autovacuum gözlendi ve ölü satır sayısı
> 1.466'dan 2.310'a yükseldi.

- **Veri:** `autovacuum_count_delta`, `n_dead_tup_estimate` zaman serisi
- **Alarmdan farkı:** alarm eşik aşımında; bulgu eşiğe **varmadan** eğilimi
- **Söylemediği:** sebebi (xmin horizon, worker doygunluğu, iş yükü) — o
  alarmın teşhis katmanının işi
- **Bağlantı:** Insights → Vacuum Lag merceği

#### 4.6 Autovacuum ayarı gözden geçirme adayı

> Tablo-özel autovacuum ayarı sık çalışma örüntüsü oluşturuyor: son 24
> saatte 47 autovacuum ve `scale_factor=0.02` override gözlendi. Bu ayar
> düşük bloat hedefi için kasıtlı olabilir; mevcut iş yüküyle birlikte
> gözden geçirilmeye adaydır.

- **Veri:** `control.table_relopts_snapshot`, `autovacuum_count_delta`
- **Söylemediği:** ayar kasıtlı olabilir — nitekim bu değeri V094'te
  **biz koyduk**

> **İlk taslaktan kaldırıldı:** "her çalışmada ortalama 340 ölü satır
> temizledi." Bu hesap **desteklenmiyor**. `n_dead_tup` anlık bir
> tahmindir, `autovacuum_count` yalnızca çalışma sayısıdır; birini
> diğerine bölmek "vacuum başına temizlenen satır" vermez. Ayrıca vacuum
> insert eşiği veya freeze/wraparound gerekçesiyle de çalışabilir.
> "İsraf", "gereksiz", "worker çalıyor" ifadeleri de kaldırıldı —
> bunlar ancak vacuum süresi, I/O maliyeti veya worker doygunluğu
> **ölçülürse** söylenebilir; hiçbirini ölçmüyoruz.

### V2 (sonraki sürüm)

- **WAL üretim hızı** + arşiv/retention/disk kapasitesi — güçlü aday
- **Kullanılmayan indeks** — uzun ve resetsiz pencere, boyut/yazma
  maliyeti, unique/constraint istisnası ve seyrek sorgu uyarısıyla;
  **"drop et" denmez**
- **Checkpoint** — tek başına sıklık değil; requested checkpoint, WAL ve
  I/O birlikte

### Kapsam dışı

- **Eksik indeks şüphesi** — plan kanıtı olmadan yüksek yanlış pozitif
  riski; bulgu değil teşhis işi
- **Bağlantı havuzu deseni** — ayrı bir alan

## 5. Değerlendirme ve sunum ayrı

İlk taslaktaki "tablo başına mı, en kötü N mi?" **yanlış ikilemdi.**

- **Dedektörler tüm uygun tabloları** set tabanlı değerlendirir
- Veri kalitesi ve anlamlılık eşiğini geçmeyenler elenir
- Geçenler **kararlı bir anahtarla upsert** edilir
- **UI** `finding_code + instance + database` bazında **grup kartı**
  gösterir: toplam sayı, etki, yeni/geri dönen sayısı, ilk beş örnek
- Ayrıntı cursor pagination ile açılır
- Partition'lar parent/family altında gruplanır

4.478 analiz edilmemiş tablo → **4.478 kart değil**, veritabanı düzeyinde
tek kart + drill-down.

**"En kötü N" yalnızca sunum kuralıdır, kalıcılık kuralı değil.** Aksi
hâlde 10'dan 11'e düşen bir kayıt kaybolmuş görünür, tekrar girince "yeni"
sayılır.

## 6. Yaşam döngüsü

Sistem durumu ile kullanıcı kararı **ayrı tutulur**.

**Sistem durumu:**

| Durum | Anlamı |
|---|---|
| `ACTIVE` | Şu an gözleniyor |
| `STALE` | Veri eksik ya da değerlendirme başarısız — **kapatmaz** |
| `ENDED` | Başarılı değerlendirmelerde artık gözlenmiyor |

**Kullanıcı durumu** (ayrı tabloda): `UNSEEN`, `REVIEWED`, `EXPECTED`,
`SNOOZED`.

Kurallar:
- **Başarısız değerlendirme bulguyu kapatmaz.** (Bloat alarmındaki
  `hasRecentData` korumasının aynı sınıfı — toplama boşluğuna denk gelen
  bir tur yanlışlıkla "düzeldi" demeye yol açmıştı.)
- **"Bir daha gösterme" kalıcı değildir** — süreli erteleme ya da "kanıt
  anlamlı değişene kadar gizle"
- Kaybolan bulgu **silinmez**, `ENDED` işaretlenir; yeniden belirirse yeni
  bir *episode* açılır ve "geri döndü" denir
- Giriş ve çıkışta **histerezis**: üç ardışık değerlendirme (flapping'i
  önlemek için — alarm tarafında ısrar sayacıyla aynı yaklaşım)

## 7. Görünürlük

**Tekil ve anlık bulgu bildirimi yok.** Ama hiç görünürlük mekanizması
olmayan bir sekme ziyaret edilmez.

- Ana panelde: *"Son incelemenizden beri 4 yeni, 2 değişen bulgu"*
- **Haftalık, tercihe bağlı özet**: yalnızca yeni, belirgin kötüleşen veya
  geri dönen ilk 3–5 bulgu. **Değişiklik yoksa gönderilmez.**
- Telegram / on-call kanalından **ayrı** tutulur
- Instance ve tablo detaylarında bağlamsal *"2 ilgili bulgu"* bağlantısı

"Yeni" tanımı **kullanıcı bazında "son incelemeden beri"**, sabit "son 24
saat" değil.

**Kanallar:**

| Kanal | Rol |
|---|---|
| **UI** | Kaynak gerçek — bulgular burada yaşar |
| **Haftalık e-posta** | Tercihe bağlı keşif kanalı |
| **Telegram / on-call** | **Kullanılmaz** |

Teslimat kodu sonraya kalabilir; şema ve üretim önce gelir.

## 8. Veri modeli

```
-- Ust kayit MEVCUT ops.job_run kullanilir (job_type='finding_evaluation');
-- ayri bir kosu tablosu acmiyoruz, diger job'larla ayni yerde gorunsun.

ops.finding_evaluation_scope     -- dedektor x kapsam basina SONUC
  scope_id            bigint pk
  job_run_id          bigint      -- fk -> ops.job_run
  finding_code        text
  detector_logic_version int
  instance_pk         bigint
  dbid                bigint null
  status              text        -- success | failed | skipped
  skip_reason         text null   -- 'insufficient_history' | 'no_anchor' | ...
  data_cutoff_at      timestamptz -- bu kapsamda hangi ana kadar veri goruldu
  error_text          text null

ops.finding_signal_state         -- histerezis; bulgudan AYRI
  finding_key         text pk
  positive_streak     int
  negative_streak     int
  pending_since       timestamptz null
  last_scope_id       bigint

ops.finding
  finding_id          bigint pk
  finding_key         text        -- kararli fingerprint (isimden bagimsiz)
  finding_code        text
  -- IKI AYRI SURUM. Ayrim, ertelenmis bir bulgunun ne zaman yeniden
  -- acilacagini belirliyor: mantik degisirse yeniden sorulmali, metin
  -- duzeltilirse sorulmamali.
  detector_logic_version     int  -- hesap/esik degisti (major)
  detector_cosmetic_version  int  -- yalnizca metin/bicim degisti
  instance_pk         bigint
  scope_kind          text        -- 'instance' | 'database' | 'relation'
  subject_identity    text        -- dbid/relid tabanli, ada bagimli degil
  title               text
  body                text
  evidence_json       jsonb       -- hesabin girdileri, denetlenebilirlik icin
  evidence_hash       text        -- kanit anlamli degisti mi
  coverage_num        int         -- kac nesne degerlendirildi
  coverage_den        int         -- kac nesne uygun
  confidence          text        -- 'high' | 'medium' | 'low'
  potential_impact    bigint      -- siralama icin (orn. bayt)
  system_state        text        -- ACTIVE | STALE | ENDED
  episode_no          int
  first_observed_at   timestamptz
  last_observed_at    timestamptz
  last_evaluated_at   timestamptz
  evaluation_run_id   bigint      -- fk -> finding_evaluation_run
  ended_at            timestamptz null

ops.finding_evidence_revision    -- kanit IMMUTABLE, uzerine yazilmaz
  revision_id         bigint pk
  finding_id          bigint
  evidence_json       jsonb
  content_hash        text        -- canonical icerik hash'i
  decision_fingerprint text       -- dedektor uretimli: ANLAMLI degisim
  created_at          timestamptz

ops.finding_disposition          -- kullanici karari AYRI tabloda
  finding_id                      bigint  -- EPISODE'a bagli, finding_key'e degil
  episode_no                      int
  user_id                         text
  state                           text  -- UNSEEN|REVIEWED|EXPECTED|SNOOZED
  note                            text null
  -- Kararin NEYE dayandigi
  detector_compatibility_version  int
  evidence_revision_id            bigint  -- hangi kanit revizyonunda verildi
  decision_fingerprint_at_disposition text
  review_after                    timestamptz
  invalidated_at                  timestamptz null
  invalidation_reason             text null    -- 'evidence_changed'
                                               -- 'detector_logic_changed'
                                               -- 'expired'
  primary key (finding_id, episode_no, user_id)
```

### Bütünlük kuralları

- `unique(finding_key, episode_no)`
- Bulgu başına **tek aktif episode**
- `data_cutoff_at` **monoton** olmalı (geriye giden kapsam kabul edilmez)
- Kapsam bazlı **transaction/advisory lock** — eşzamanlı koşular
  birbirinin streak'ini bozmasın

### Kısmi koşuda yaşam döngüsü

Bir bulgunun **görülmemiş olması**, kaybolduğu anlamına gelmez —
değerlendirilmemiş de olabilir.

**Yalnızca `status='success'` olan kapsam**, pozitif/negatif streak'i
ilerletebilir ve bulgu kapatabilir. `failed` ve `skipped` kapsamlar
bulguyu `STALE` bırakır.

Bu, alarm tarafındaki `hasRecentData` korumasının aynı sınıfı: toplama
boşluğuna denk gelen bir tur, %99 bloat'lı bir tabloyu yanlışlıkla
"düzeldi" saymıştı (2026-08-21).

### Kullanıcı kararı neden `finding_id + episode_no`

`finding_key`'e bağlansa, aylar sonra **yeni bir episode** olarak dönen
bulgu eski `EXPECTED` kararını miras alırdı — oysa §6 dönüşü yeni episode
olarak tanımlıyor. İkisi çelişirdi.

### Kanıt neden immutable

`evidence_json` üzerine yazılırsa, kullanıcının **neye** karar verdiği
kaybolur. Her değerlendirme yeni bir `finding_evidence_revision` yazar;
karar `evidence_revision_id` ile bağlanır.

Kullanıcı eylemi **compare-and-set**: istemci hangi revizyonu gördüğünü
gönderir; kanıt o arada değiştiyse **409** döner ve kullanıcı güncel
kanıtı görür. Aksi hâlde eski kanıta bakarak "beklenen" işaretlenebilir.

Notlar:
- `severity_hint` **kaldırıldı** — yerine `potential_impact` ile sıralama.
  Alarm severity'siyle karışmasın.
- `subject_identity` ada değil kimliğe dayanır (tablo yeniden
  adlandırılınca bulgu kopmasın).
- `coverage_num/den` her kartta gösterilir: *"7.638/12.116 tablo
  değerlendirildi"*.
- `finding_evaluation_run`, gece toplayıcısında eksik olan şeyin aynısını
  önlüyor: "ne kadar sürüyor" sorusu ölçülemiyordu çünkü koşu hiçbir yere
  kaydedilmiyordu (bkz. PGSTAT-P0-045).

### `EXPECTED` neden kalıcı değil

"Bu tabloda satır başına 9 UPDATE normaldir, bir daha sorma" demek
mantıklı. Ama o karar **belirli bir kanıta ve belirli bir hesaba**
dayanıyor. İkisi de değişebilir.

Karar şu üç durumda geçersizleşir ve bulgu yeniden açılır:

| Tetikleyici | `invalidation_reason` |
|---|---|
| Kanıt anlamlı değişti (`evidence_hash` farklı) | `evidence_changed` |
| Dedektörün **mantığı** değişti (logic version arttı) | `detector_logic_changed` |
| `review_after` doldu (örn. 90 gün) | `expired` |

**Yalnızca metin/biçim değişikliği (cosmetic version) kararı
geçersizleştirmez.** Bu ayrım olmasa her mesaj düzeltmesi bütün ertelenmiş
kararları sıfırlardı.

## 9. Üretim ve maliyet

Bulguların hepsi **zaten toplanan** veriden hesaplanıyor; **yeni uzak
toplama yok.**

İlk taslak "maliyeti sıfıra yakın" diyordu — bu fazla iddialıydı. Doğrusu:
**merkezi hesap maliyeti ölçülecek ve sınırlandırılacak.** 25 instance ve
12.116 tablo üzerinde günlük bir değerlendirme koşusu, `ops.job_run`'a
kaydedilerek süresi izlenecek (gece toplayıcısında bu eksikti ve "ne kadar
yük getiriyor" sorusu bu yüzden cevaplanamamıştı).

Sıklık: **günde bir**. Bulguların hepsi yavaş değişkenler.

## 10. Asıl risk

**İkinci bir gürültü kaynağı yaratmak.** Bulgular da gürültülü olursa
kimse ikisine de bakmaz.

Bu hafta alarm tarafında tam bu tuzağa düşüldü: bir senaryo "sorun yok"
teşhisi koyup yine de alarm açıyordu, ve önerdiği komut (`VACUUM ANALYZE`)
sorunu çözmeyecek olandı.

Önlemler:
- Bulgu ancak **bir kararı değiştirebiliyorsa** yayınlanır
- Her bulgu tipi için anlamlılık eşiği
- Grup kartı + drill-down (satır patlaması yok)
- Histerezis (flapping yok)
- Örtüşme kuralı: aynı gerçek iki kart üretmez

## 11. r1'den r2'ye ne değişti

| Değişiklik | Sebep |
|---|---|
| Alarm/bulgu ekseni "eşik/örüntü" → **"müdahale/değerlendirme"** | İlki yanlıştı; alarm da eğilimden üretilebilir |
| Autovacuum bulgusundan **"vacuum başına 340 satır"** kaldırıldı | Hesap desteklenmiyor: `n_dead_tup` anlık tahmin, `autovacuum_count` sayaç; bölünemezler. Vacuum insert/freeze için de çalışabilir |
| "İsraf / gereksiz / worker çalıyor" ifadeleri kaldırıldı | Vacuum süresi, I/O ve worker doygunluğu **ölçülmüyor** |
| Projeksiyona **yedi güven kapısı** eklendi | Kapısız nokta tahmini yanıltıcı |
| **"~43 GiB'da dengelenir"** iddiası kaldırıldı | Doğrulanmamıştı; standart `VACUUM` alanı dosya sistemine iade etmez |
| Yaşam döngüsü **sistem + kullanıcı** olarak ikiye ayrıldı | Başarısız değerlendirme bulguyu kapatmamalı |
| Top-N **sunum kuralı** oldu, kalıcılık değil | 11'e düşen kayıt "kaybolmuş" görünüyordu |
| **Grup kartı + drill-down** | 4.478 tablo 4.478 kart olamaz |
| **Bildirim yok** → *"tekil bildirim yok, haftalık özet var"* | Görünürlüksüz sekme ziyaret edilmez |
| Veri modeline **fingerprint, detector_version, coverage, confidence, potential_impact, evidence_hash** eklendi | Denetlenebilirlik ve kararlı kimlik |
| **Kapsam (%63) her kartta gösterilecek** | Satır-normalize bulgular 7.638/12.116 tabloda hesaplanabiliyor |
| "Maliyet sıfıra yakın" → **"ölçülecek ve sınırlandırılacak"** | Fazla iddialıydı |
| **Mevcut yüzeylerle ilişki** bölümü eklendi | Insights zaten var; "Vacuum Lag" merceğiyle örtüşme çözülmeli |
| Katalog **V1 / V2 / kapsam dışı** olarak bölündü | Hepsi ilk sürüme girmemeli |

## 11b. r2'den r3'e ne değişti

İkinci inceleme turu, birinci turdaki yanlış varsayım düzeldikten sonra
geldi ve tek konuya odaklandı: navigasyon.

| Değişiklik | Sebep |
|---|---|
| **Bulgular ayrı üst seviye sekme** olacak (karar) | Insights altına koymak, sistemin seçtiği inceleme adayını yeniden kullanıcının keşfetmesine bırakırdı |
| Yüzey ekseni "itme/çekme" → **kullanıcı niyeti** | İtme/çekme teknik üretim farkı; ayrımı taşıyan şey niyet |
| Sıra belirlendi: **Alarmlar → Bulgular → Insights → Sistem Sağlığı** | Aciliyetten araştırmaya doğru |
| **Navigasyon kuralları** eklendi (rozet, renk, CTA, derin bağlantı, durum koruma) | Ayrı sekmenin alarm gibi algılanmaması için |
| **İsimlendirme** alt açıklamaları | "Findings" ve "Insights" İngilizcede yakın algılanıyor |
| **Yüzey sınırı** yazıldı: collector sağlığı ≠ veri güvenilirliği | Hangi gözlemin nereye ait olduğu belirsizdi |

> **Not:** ikinci incelemeci r2 dosyasına satır satır erişemedi; bu tur
> değişiklik özetine dayanan bir **navigasyon değerlendirmesiydi**,
> tasarımın tamamının ikinci bir incelemesi değil. Katalog, veri modeli ve
> projeksiyon kapıları henüz ikinci bir gözden geçirmeden geçmedi.

## 11c. r3'ten r4'e ne değişti

Üçüncü tur, açık üç soruyu cevapladı ve ikisinin **şemayı etkilediğini**
gösterdi.

| Değişiklik | Sebep |
|---|---|
| Dedektör sürümü **ikiye ayrıldı**: `detector_logic_version` + `detector_cosmetic_version` | Ertelenmiş karar mantık değişince yeniden açılmalı, metin düzeltilince açılmamalı |
| `finding_disposition`'a **beş alan**: `detector_compatibility_version`, `evidence_hash_at_disposition`, `review_after`, `invalidated_at`, `invalidation_reason` | `EXPECTED` kalıcı olmamalı; kararın neye dayandığı kayıtlı olmalı |
| **`ops.finding_evaluation_run`** tablosu eklendi | Koşu kaydedilmezse maliyeti ölçülemez — gece toplayıcısında tam bu eksikti |
| **Backtest kapısı somutlaştı**: rolling-origin medyan hata ≤ öngörülen değişimin %50'si, ≥3 pencere, yön tutarlılığı, yapılandırılabilir | "Kabul edilebilir sınırda" ölçülebilir değildi |
| **Kanallar netleşti**: UI kaynak gerçek, haftalık e-posta tercihe bağlı, **Telegram yok** | Bulgu bildirimi on-call kanalına girmemeli |
| **Kodlama sırası** yazıldı (§12) ve veri güvenilirliği başa alındı | Güvenilmez satır tahminiyle "satır başına alan" yayımlamak, bu hafta canlıda yaptığımız hatanın aynısı |

## 12. Kodlama sırası

Sıra bilinçli: **güvenilmez satır tahminiyle "satır başına alan" hesabı
yayımlanmamalı.** Bu, bu hafta canlıda yaşadığımız hatanın aynısı —
`n_live_tup` 0 iken %100 bloat raporlandı, gerçek oran %1.7'ydi
(PGSTAT-P0-041). Dedektörler o hatayı tekrarlamamalı.

1. **Kapsam ve sinyal modeli** — `ops.finding`,
   `ops.finding_evaluation_scope`, `ops.finding_signal_state`,
   `ops.finding_evidence_revision`, `ops.finding_disposition`
2. **§4.3 uygunluk kapısı** — tablo bazlı satır-tahmini güvenilirliği
3. **§4.4 için yeni kimlik ve zaman ankrajlı toplama** — `relid`,
   `fillfactor` ve as-of satır tahmini (PGSTAT-P0-046 ile aynı iş)
4. **Backtest** — eşik gerçek veriyle kalibre edilir
5. **§4.4 yayını** — ancak yukarıdakiler bittikten sonra

Sonraki dedektörler (§4.1, §4.2, §4.5, §4.6) bu iskelet oturduktan sonra.

> Sıra r4'te "şema → §4.3 → kapı → §4.4" idi. Dar inceleme, §4.4'ün
> **yeni veri toplama gerektirdiğini** ve backtest yapılmadan
> yayımlanmaması gerektiğini gösterdi; 3. ve 4. adımlar bu yüzden araya
> girdi. Aynı eksikler canlıdaki `table_space_bloat` alarmında da vardı ve
> o kural devre dışı bırakıldı.

## 13. Hâlâ açık

1. **Katalog ve veri modeli ikinci incelemeden geçmedi.** r2'deki
   değişiklikler yalnızca değişiklik özeti üzerinden değerlendirildi;
   dosyanın kendisi incelenmedi.
2. **`review_after` varsayılanı** 90 gün mü olmalı, dedektör başına mı
   ayarlanmalı?
3. **Backtest eşiği** başlangıçta %50 kabul edildi; ilk gerçek veriyle
   kalibre edilecek.

---

## Ek: bu tasarımı besleyen üretim ölçümleri

2026-08-27 – 2026-08-31 arasında gerçek ortamdan alındı.

| Ölçüm | Değer |
|---|---|
| İzlenen instance | 25 |
| İzlenen tablo (**toplam**, tüm instance'lar) | 12.116 |
| `reltuples` bilinen | 7.638 (%63) |
| Hiç analiz edilmemiş | 4.478 |
| Merkezi DB boyutu | 35 GB → 28 GB → 20 GB (`VACUUM FULL` sonrası) |
| Geri kazanılan boşa duran alan | ~8 GB |
| En büyük tek şişme | 2432 MB → 41 MB (%98 boş) |
| Gece toplanan relation | ~6.900 |
| `pg_relation_size_snapshot` | 80 MB / ~4 ay |

*(r1'de 12.116 sayısı instance başına gibi okunabiliyordu — bu toplam
sayıdır.)*

## 11d. r4'ten r5'e ne değişti

Dördüncü tur, ilk kez **kodun kendisine** erişerek yapıldı ve sevk edilmiş
bir hatayı buldu.

| Değişiklik | Sebep |
|---|---|
| **Canlıdaki fillfactor hatası düzeltildi** | Taban zaten aynı rejimde ölçüldüğü için tasarım payını içeriyordu; `(100/fillfactor)` çarpanı onu ikinci kez düşüyor ve şişmeyi **eksik** raporluyordu (3 kat → 2.1 kat) |
| **`table_space_bloat` alarmı devre dışı** | Boyut/satır zaman uyumsuzluğu ve ad-tabanlı geçmiş eşleşmesi giderilene kadar (PGSTAT-P0-046) |
| §4.4'te **"iki ölçüm farkı, tahmin değil"** kaldırıldı | Payda (`reltuples`) katalogda bir tahmin |
| §4.4'te **"tarihsel minimum = sıkışık hâl"** kaldırıldı | Minimum bunu kanıtlamaz; "en yoğun karşılaştırılabilir gözlem" |
| §4.4'e **üç ön koşul** eklendi (zaman ankrajı, kimlik, fillfactor rejimi) | Hiçbiri sağlanmazsa dedektör susmalı |
| §4.4'ten **"~%30 hata bandı"** kaldırıldı | Backtest sonucu değildi, tahmindi |
| §4.4'e **satır genişliği/şema değişimi** eklendi | O da bayt/satır'ı büyütür ve şişme değildir |
| §4.3'te `reltuples = 0` ile `NULL/-1` **ayrıldı** | Sıfır gerçekten boş tablo olabilir |
| §4.3'ten **"PostgreSQL değer bulmadı"** kaldırıldı | Sebep ölçülmüyor — autovacuum bulgusunda kaldırdığımızın aynısı |
| **§4.1 artık bastırılmıyor** | Fiziksel boyut serisine dayanıyor, satır tahminine değil |
| **Uygunluk kapısı tablo bazlı** ve bulgunun yayımlanmasından bağımsız | Eşik aşılmasa bile güvenilmez tek tablo girmemeli |
| `finding_evaluation_run` → **`ops.job_run` + `finding_evaluation_scope`** | Kısmi koşuda hangi kapsamın başarılı olduğu bilinmeden bulgu kapatılamaz |
| **`finding_signal_state`** eklendi | §6 histerezis istiyordu ama saklayacak yer yoktu |
| **`finding_evidence_revision`** eklendi, kanıt immutable | Üzerine yazılırsa kullanıcının neye karar verdiği kaybolur |
| Disposition **`finding_id + episode_no`**'ya bağlandı | `finding_key`'e bağlıyken dönen bulgu eski kararı miras alıyordu |
| **Bütünlük kuralları** yazıldı (tek aktif episode, monoton `data_cutoff_at`, kapsam kilidi) | Eşzamanlı koşular streak'i bozabilirdi |
| **Kodlama sırasına iki adım girdi** (yeni toplama, backtest) | §4.4 yayını bunlardan önce yapılamaz |

> **Not:** bu tur ilk kez gerçek dosya ve satır referanslarıyla geldi
> (`AlertRuleEvaluator.java:842`, `V039:23`, `V006:8`). İki kod iddiası da
> doğrulandı. Önceki turlardaki "erişemedim" sınırı bu turda yoktu.
