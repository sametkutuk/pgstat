# Bulgular (Findings) — Tasarım

**Durum:** revize edildi (r2), inceleme sonrası
**Tarih:** 2026-08-31
**Değişiklik:** dış inceleme geldi; bu sürüm o eleştirilerin çoğunu
uyguluyor. Neyin neden değiştiği §11'de.

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

| Yüzey | Etkileşim | Soru |
|---|---|---|
| **Alarmlar** | Sistem beni çağırır | "Şimdi müdahale gerekli mi?" |
| **Insights** | Ben gidip mercek seçerim | "Şunu incelemek istiyorum" |
| **Sistem Sağlığı** | Sistem kendi durumunu bildirir | "Toplama çalışıyor mu?" |
| **Bulgular** *(yeni)* | Sistem bana söyler, eylem istemez | "Bilmem gereken ne var?" |

Ayırt edici olan **itme/çekme** ekseni: Insights *çekme*dir — gidip
bakarsınız, ne arayacağınızı bilmeniz gerekir. Bulgular *itme*dir — sistem
söyler, ama sizi çağırmaz.

**Örtüşme çözülmeli.** `Insights` içinde zaten "Vacuum Lag" merceği var ve
önerdiğimiz "autovacuum yetişemiyor" bulgusuyla aynı olguya bakıyor.
Kural: **aynı gerçek iki kart üretmez.** Bulgu, ilgili Insights merceğine
*bağlantı verir*; merceğin kendisini kopyalamaz.

> **Not:** dış inceleme, üründe hâlihazırda bir "Recommendations" motoru
> olduğunu ve dördüncü kavramın gürültü üreteceğini söyledi. Kod tabanı
> kontrol edildi: pgstat'ta öneri motoru **yok** (`recommendation` için
> sıfır eşleşme, ilgili tablo yok). İncelemede verilen dosya yolları
> (`New project`, `com.pgobs.platform`) başka bir projeye ait. Ancak
> uyarının özü — yüzey çoğaltmamak — geçerli kabul edildi ve yukarıdaki
> ayrım ile örtüşme kuralı bu yüzden eklendi.

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
- Backtest hatası kabul edilebilir sınırda
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

#### 4.3 Veri güvenilirliği

> `etsrooms` veritabanında istatistikler 2026-03-04'te sıfırlanmış
> (176 gün önce). O tarihten beri analiz edilmemiş 4.478 tablo var.

- **Veri:** `pg_stat_database.stats_reset`, `last_analyze/autoanalyze`
- **Söylemediği:** hepsi sorunlu değil; çoğu hiç değişmediği için analiz
  edilmemiş

**Bu bulgu diğerlerini bastırır.** Satır sayısına dayanan bulgular
(§4.1, §4.2, §4.4) yalnızca `reltuples` bilinen tablolarda hesaplanabilir
— ölçümde 12.116'nın **7.638'i**, yani ~%63. Kapsam her kartta yazılır ve
güvenilmez satır tahmini olan tablolarda diğer dedektörler **otomatik
susar**.

#### 4.4 Kaynak israfı

> `fact.pgss_delta_20260820` 11.740 satırı 637 MB'da tutuyor.

- **Veri:** boyut + `reltuples`, tablonun kendi tarihsel minimumuna oran
- **Söylemediği:** `fillfactor` ayarlıysa boşluğun bir kısmı tasarım
  gereğidir (düşülür); TOAST ayrıdır

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

## 8. Veri modeli

```
ops.finding
  finding_id          bigint pk
  finding_key         text        -- kararli fingerprint (isimden bagimsiz)
  finding_code        text
  detector_version    int         -- dedektor degisince eski bulgu karismasin
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
  evaluation_run_id   bigint
  ended_at            timestamptz null

ops.finding_disposition          -- kullanici karari AYRI tabloda
  finding_key, user_id, state, until_at, note
```

Notlar:
- `severity_hint` **kaldırıldı** — yerine `potential_impact` ile sıralama.
  Alarm severity'siyle karışmasın.
- `subject_identity` ada değil kimliğe dayanır (tablo yeniden
  adlandırılınca bulgu kopmasın).
- `coverage_num/den` her kartta gösterilir: *"7.638/12.116 tablo
  değerlendirildi"*.

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

## 12. Hâlâ açık

1. **Bulgular ayrı sekme mi, Insights içinde bir sekme mi?** İtme/çekme
   ayrımı ayrı sekmeyi haklı çıkarıyor, ama dördüncü bir üst seviye
   navigasyon öğesi de bir maliyet.
2. **Haftalık özet kanalı.** Telegram'dan ayrı denildi — e-posta mı,
   yalnızca UI mı?
3. **Backtest eşiği** ne olmalı (projeksiyon kapılarından biri)?
4. **`EXPECTED` işareti kalıcı mı?** "Bu tabloda 9 UPDATE/satır normal,
   bir daha sorma" demek mantıklı; ama dedektör sürümü değişince yeniden
   sorulmalı mı?

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
