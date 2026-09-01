# Yeniden yazma tespiti — tasarım (r2)

**Tarih:** 2026-09-01
**İlgili:** PGSTAT-P0-046 (fiziksel şişme kuralı), PGSTAT-P1-015 (Bulgular ekranı)
**Durum:** r1 incelendi; Faz 1 kodlandı, Faz 2–3 bekliyor

> **r2 notu — inceleme sonucu.** r1'deki iki iddia yanlış çıktı, üç şey
> atlanmıştı. Ayrıntı §7'de. Özet:
> - **Ankraj yönü r1'de tersti.** "Önceki gözleme ankraj koymak güvenli taraf"
>   iddiası yanlış; deneyin kendi sayılarıyla ağır yanlış pozitif üretiyor.
> - **"Tek kolon, iki problem" iddiası güvenli değil.** `relfilenode` değişimi
>   "sıkışık" demek değil, yalnızca "fiziksel nesil değişti" demek.
> - Sinyalin adı `physical_generation_changed` olmalı; tek başına ne ankraj ne
>   taban sayılmalı.
>
> **Faz 1 (kodlandı):** ölçülen ankraj hatası, yeni sinyal olmadan kapatıldı.
> Faz 2 (`physical_generation` + sınıflandırma) ve Faz 3 (kapsam bulgusu)
> bekliyor.

---

## 1. Bağlam

pgstat, izlenen PostgreSQL instance'larında **fiziksel şişme**yi tespit eden bir
kural içeriyor: tablo, satırlarının gerektirdiğinden fazla yer kaplıyor mu?

Bu, ölü satır sayan kuraldan farklı bir şey. Autovacuum yetişip ölü satırları
temizlediği hâlde boşalan alan yeniden kullanılmıyorsa, ölü satır oranı **tanımı
gereği düşük** kalır ve o kural kör olur. Üretimde tam olarak bu yaşandı: bir
partition %98'i boş alan olacak şekilde 2432 MB'a çıkmıştı, ölü satır alarmı ise
eşiğin tam sınırında %20.00 ile tetiklenip **yanlış aksiyon** önerdi
(`VACUUM ANALYZE` — o komut bu alanı geri getirmez).

**Kısıt:** izlenen makinelere extension kurulamıyor. `pgstattuple` ve
`pg_freespacemap` kullanılamaz. Ayrıca `pg_stats.avg_width`'e dayanan klasik
tahmin sorgusu da reddedildi: hiç `ANALYZE` edilmemiş tabloda `avg_width = 0`
olduğu için sonuç %0 bloat çıkar — yani en az bildiğimiz yerde kör.

**Mevcut yöntem:** tablonun **satır başına kapladığı alan** ölçülür ve kendi
geçmişiyle karşılaştırılır.

```
şişme oranı = güncel bayt/satır ÷ taban bayt/satır
bayt/satır  = table_size_bytes / reltuples
```

Taban hesaplanmıyor, **gözleniyor**: tablonun kendi geçmişinde en sıkışık olduğu
hâl. Sıkışık hâl kendiliğinden oluşur — `VACUUM FULL` sonrası, partition ilk
açıldığında, tablo boşken.

Kural şu an **kapalı**. Geçerli bir taban için 21 farklı gece ve 28 günlük
yayılım isteniyor; `reltuples` toplaması 2026-08-31'de başladığı için kural
2026-09-29'dan önce konuşamaz.

---

## 2. İki problem

### 2.1 Taban, umuda dayanıyor

Bugünkü taban "28 günde gördüğüm en düşük değer". Bu bir **umut**: tabloyu
sıkışıkken yakalamış olmayı umuyoruz.

Kör noktası: gözlem penceresinde hiç sıkışık olmamış bir tablo için taban da
şişkin çıkar, oran 1'e yakın görünür ve **gerçek şişme kaçırılır**. Bekleme
süresi bu ihtimali azaltır ama **garanti etmez** — 28 gün boyunca sürekli şişkin
kalmış bir tablo hâlâ yanlış değerlendirilir.

### 2.2 `VACUUM FULL` sonrası ankraj bozuluyor — ölçülmüş hata

`reltuples`, ölçüm anında değil **son vacuum/analyze anında** güncellenir. Bu
yüzden ankraj tutuyoruz:

```sql
reltuples_anchor_at = greatest(last_vacuum, last_autovacuum,
                               last_analyze, last_autoanalyze)
```

Satır sayısı, ankraj ile boyut ölçümü arasındaki `n_tup_ins - n_tup_del`
delta'larıyla düzeltiliyor.

**Kontrollü deney (2026-09-01):**

```sql
create table public.vf_probe as
  select g as i, repeat('x',100) as pad from generate_series(1,100000) g;
delete from public.vf_probe where i % 2 = 0;
vacuum full public.vf_probe;
```

| | Önce | Sonra |
|---|---|---|
| `relfilenode` | 87035068 | **87035078** — değişti |
| `reltuples` | 100.000 | **50.000** — tazelendi |
| `last_vacuum` | NULL | **NULL** — değişmedi |
| `vacuum_count` | 0 | **0** — değişmedi |

**Sonuç: `VACUUM FULL` `reltuples`'ı günceller ama `last_vacuum`'u güncellemez.**

Bu iki gerçek birlikte bir hata üretiyor:

```
est_rows = reltuples + (ankraj → ölçüm arası delta'lar)
             ↑ zaten güncel     ↑ VACUUM FULL ÖNCESİNİ de kapsıyor
```

Delta'lar iki kez sayılıyor → satır sayısı yüksek çıkıyor → beklenen boyut
yüksek çıkıyor → **şişme olduğundan az görünüyor**.

Bu hata en çok `VACUUM FULL` çalıştırılan tablolarda oluşur; yani en çok şişen
tablolarda. Tam olarak izlemek istediğimiz yerde körüz. Ve yanlış **negatif**
olduğu için sessiz: kural açılsaydı fark edilmezdi.

---

## 3. Önerilen çözüm: `relfilenode` takibi

> ⚠️ **Bu bölüm r1'den kalma ve kısmen çürütüldü.** §3.2'deki "iki işi birden
> görüyor" iddiası güvenli değil (`SET TABLESPACE` şişmeyi koruyarak filenode
> değiştirir) ve §3.3'teki tazelik gerekçesi `relpages` kullanılırsa büyük ölçüde
> gereksiz. Geçerli hâli §7.2 ve §7.4'te. Aşağısı, kararın nasıl evrildiğini
> göstermek için bırakıldı.

`VACUUM FULL` tabloyu yeni bir dosyaya yeniden yazar; `pg_class.relfilenode`
değişir. `relid` (oid) değişmez, yani kimlik korunur.

Deneyde doğrulandı. Şu an **hiçbir yerde toplanmıyor**.

### 3.1 Nerede toplanacak

`db_objects` döngüsünde — **30 dakikada bir**, gecelik toplamada değil.

Gerekçe: gece toplarsak yeniden yazmayı 24 saate kadar geç fark ederiz. O sürede
tabloya yazılır, hem taban bozulur hem ankraj hatası sürer. 30 dakikalık döngüde
sapma 30 dakikayla sınırlı kalır.

Maliyet ihmal edilebilir: `pg_class`'tan zaten sorgu çekiliyor (`reloptions`
için), tek kolon ekleniyor. Ölçülen mevcut maliyet: `db_objects` çağrı başına
15–107 ms, kaynak makinede neredeyse tamamı cache'ten.

### 3.2 İki işi birden görüyor

| Amaç | Nasıl |
|---|---|
| **Ankraj düzeltmesi** | `reltuples_anchor_at = greatest(...dört damga..., relfilenode değişiminin görüldüğü an)`. Delta'lar iki kez sayılmaz. |
| **Kanıtlı taban** | Yeniden yazma tespit edilince o andaki ölçüm **tanımı gereği** sıkışık hâldir. İstatistiksel tahmine gerek kalmaz. |

İkincisi, 21 gece / 28 gün kapısını böyle bir tablo için gereksiz kılar — taban
umut değil, kanıt olur.

### 3.3 Tazelik koşulu

Yeniden yazmayı tespit etmek, ölçümümüzün ona **yakın** olduğunu kanıtlamaz.
Collector bir gün kapalı kaldıysa `relfilenode` değişmiş görünür ama tablo bu
arada yeniden şişmiş olabilir.

Bu yüzden: bir gözlem "kanıtlı taban" sayılabilmesi için, bir önceki gözlemle
arasındaki boşluk küçük olmalı (öneri: ≤ 1 saat). Boşluk büyükse yeniden yazma
**ankraj için** yine kullanılır (o bilgi doğru), ama **taban için** kullanılmaz.

Bu, kuralda hâlihazırda bulunan `SPACE_BLOAT_MAX_DELTA_GAP_SECONDS` korumasıyla
aynı mantık.

### 3.4 `relfilenode` başka sebeplerle de değişir

`CLUSTER`, `TRUNCATE`, bazı `ALTER TABLE`'lar, restore. Hepsi tabloyu sıkışık
bırakır, dolayısıyla aynı muamele **doğru**. `TRUNCATE` sonrası tablo boşalır ve
`reltuples > 0` filtresi zaten eler.

Not: `relfilenode <> oid` karşılaştırması **işe yaramaz** — olgun bir
veritabanında neredeyse her tabloda `true` çıkıyor (merkezi DB'de 20/20).
Kullanılacak sinyal, kendi iki gözlemimiz arasındaki **değişim**.

---

## 4. Kapsam bulgusu (müşteri önerisi)

> ⚠️ **Daraltma önerisi yetersiz bulundu.** Geçerli hâli §7.6'da: taban durumu
> önce modellenmeli (`WARMING_UP` ve `DATA_GAP` bulgu değil), boyut tabanı
> türetilmeli (8 MiB değil ~150 MiB), ve bulgu **sonlanabilir** olmalı.

Yeniden yazması hiç görülmemiş tablolar için bir uyarı üretilsin — ama
**Telegram'a değil, ekranda**.

**Bu bir alarm değil, bulgu.** Alarm "şimdi müdahale et" der, açılır ve kapanır.
Buradaki ise duran bir durum: "bu tabloyu fiziksel şişme açısından
değerlendiremiyorum." Müdahale gerektirmiyor, çözülmüyor, bildirim istemiyor.
PGSTAT-P1-015'te tanımlanan Bulgular ekranının tam konusu.

**Gürültü riski — açıkça:** tabloların büyük çoğunluğuna hiç `VACUUM FULL`
çalıştırılmaz. "Yeniden yazma görülmedi" bulgusu binlerce tabloda doğru olur ve
ekranı kullanılmaz hâle getirir. Daraltılmadan yayınlanamaz.

Önerilen daraltma (üçü birden):
- Tablo yeterince büyük (kuralın 8 MB alt sınırı)
- İstatistiksel kapı da sağlanamıyor (yeterli gece yok, ya da sıkışık gözlem yok)
- Şişmeden şüphelenmek için gerekçe var (update/delete trafiği yüksek)

Yani bulgunun ifadesi "yeniden yazma görmedik" değil, **"bu tablo şişmiş
olabilir ama söyleyemiyoruz, sebebi şu"** olmalı.

---

## 5. İnceleyene sorular

1. **Ankraj hangi ana konmalı?** `relfilenode` değişimini iki gözlem arasında
   yakalıyoruz; gerçek yeniden yazma anı o aralıkta bir yerde.
   - Tespit ânına koymak: aradaki satırlar sayılmaz → satır sayısı düşük →
     şişme **fazla** görünür (yanlış pozitif riski).
   - Bir önceki gözleme koymak: yeniden yazma öncesi delta'lar da sayılır →
     şişme **az** görünür (yanlış negatif riski).
   Bu kuralın geçmişteki hatalarının hepsi yanlış pozitif tarafındaydı. Bu,
   ikinciyi tercih etmek için yeterli gerekçe mi, yoksa 30 dakikalık aralıkta
   fark ihmal edilebilir mi?

2. **Tek bir yeniden yazma sonrası gözlem, tabanı belirlemek için yeterli mi?**
   Tanımı gereği sıkışık hâl, ama tek ölçüm ve paydası (`reltuples`) yine bir
   tahmin. 21 gece kapısını tamamen atlamak mı, yoksa "kanıtlı taban + en az N
   gözlem" mi?

3. **Kapsam bulgusu nasıl daraltılmalı** ki %90 tabloda doğru olan bir cümle
   olmaktan çıksın? §4'teki üçlü yeterli mi, fazla mı?

4. **Kaçırdığımız bir yeniden yazma sinyali var mı?** `pg_stat_file` denendi:
   yetki var ama `modification` **son yazma** zamanını veriyor, dosya oluşturma
   zamanını değil — aktif tabloda işe yaramıyor. Başka bir yol?

5. **Geriye dönük hiçbir şey kurtarılamıyor** (`relfilenode` geçmişi yok,
   `reltuples` 2026-08-31 öncesi hiç toplanmamış). Bu doğru mu, yoksa
   düşünmediğimiz bir kaynak var mı?

---

## 7. r1 → r2 (inceleme sonrası)

### 7.1 Ankraj yönü r1'de tersti

r1 §5'te "tespit ânına ankraj → yanlış pozitif, önceki gözleme ankraj → yanlış
negatif" yazmıştım ve ikincisini güvenli taraf saymıştım. **Yanlış.** Kendi
deneyimizin sayılarıyla (`R=50k`, silinen `D=50k`, sonrasında DML yok):

| Ankraj | `est_rows` | Sonuç |
|---|---|---|
| Tespit ânı (t1) | `50k + 0 = 50k` | doğru |
| Önceki gözlem (t0) | `50k + (0 − 50k) = 0` | **oran patlar** |

Rewrite sonrası `reltuples` zaten düşmüş; üstüne rewrite **öncesi** silmeleri bir
daha düşmek çift sayma. "Güvenli" dediğim seçenek en ağır yanlış pozitifi
üretiyor.

Doğru cevap tek bir an seçmek değil, **aralık**: gerçek rewrite zamanı
`[t0, t1]` arasında bilinmiyor, dolayısıyla

```
N_low  = max(0, R - D)     N_high = R + I
```

Yanlış pozitifi önceleyen karar `N_high` kullanır ve **alt sınır** eşiği
geçiyorsa alarm üretir:

```
ratio_lower_bound  = current_bytes / (baseline_bpr * N_high)
wasted_lower_bound = current_bytes - baseline_bpr * N_high
```

Aralık eşiği kesiyorsa `indeterminate_anchor_window` ile bir sonraki ölçüm
beklenir. Olay `event_window_start = t0`, `event_observed_at = t1` olarak
saklanmalı; tek bir kesin rewrite zamanı **uydurulmamalı**.

### 7.2 `relfilenode` değişimi "sıkışık" demek değil

Atladığım karşı örnek: `ALTER TABLE ... SET TABLESPACE` yeni bir filenode ayırıp
fork'ları **blok blok kopyalar** — mevcut şişme aynen korunur. Bu olay ne
tabandır ne ankraj.

Gereken durum makinesi:

```
physical_generation_changed
    -> compacting_rewrite_candidate -> rewrite_baseline_confirmed
    -> storage_move | truncate | unknown
```

Ayırt edici: tablespace değişmişse taşımadır. `(effective_tablespace,
relfilenode)` birlikte izlenmeli.

### 7.3 İkinci ankraj hatası: index build

`CREATE INDEX` ve `REINDEX`, heap'i tararken `pg_class.relpages`/`reltuples`
değerlerini yeniler. Heap'in `relfilenode`'u **ve dört zaman damgası
değişmez**. Yani `relfilenode` takibi bu vakayı hiç görmez.

Faz 1'deki epoch kontrolü ("`reltuples` değişti, ankraj değişmedi") **her ikisini
de** yakalıyor — `VACUUM FULL` ve index build. Bu yüzden Faz 1, `relfilenode`
gerektirmeden yazıldı.

### 7.4 Taban için daha iyi kaynak: `relpages`

`pg_relation_size` yerine:

```
baseline_bpr = relpages * block_size / reltuples
```

Çünkü rewrite sonunda PostgreSQL `relpages` ve `reltuples`'ı **birlikte** yeni
heap'ten üretir — tutarlı bir çift. Bizim 30 dakika sonra okuduğumuz büyümüş
`pg_relation_size` ile karışmaz. Bu, r1'deki "tespit 30 dakikada bir olmalı"
baskısını büyük ölçüde kaldırıyor. Kapsam yalnız main fork.

### 7.5 Doğrulanan üç kod bulgusu

**(a) `relid` instance genelinde benzersiz değil — DOĞRULANDI.** Sorgu
`instance_pk` ile filtreleyip `relid` ile gruplarken `dbid`'yi anahtar olarak
kullanmıyordu. Canlı çakışma kendi verimizde bulundu: instance 18'de
`dbid 7886849` ve `dbid 6327213` içindeki `management.payment_types_currencies`
tablolarının ikisi de `relid 7887268`. İki ayrı tablonun geçmişi birleşiyordu.
Kapsam kontrol edildi: hata **yalnızca bu sorguda**; `pg_table_stat_delta` PK'sı,
`AggRepository` rollup'ı, `dim.relation_ref` unique'i ve ölü satır kuralı doğru
anahtarlıyor. **Faz 1'de düzeltildi.**

**(b) Tarihsel taban ham, güncel gözlem delta-düzeltilmiş — DOĞRULANDI.**
`obs.bytes_per_row = table_size_bytes / reltuples` ham; güncel ise
`reltuples + net_rows`. Payda iki tarafta farklı anlam taşıyor. Her tarihsel
gözlem kendi ankrajından taşınmalı, köprülenemeyen geceler coverage'a
sayılmamalı. **Faz 2.**

**(c) 30 dakikalık yol tüm tabloları kapsamıyor — DOĞRULANDI.**
`fact.pg_relation_size_snapshot` yalnızca gece ve izleme listesinden yazılıyor;
genel 30 dakikalık tablo döngüsü fiziksel durumu değil yalnız `reloptions`
upsert ediyor. Yani oraya tek kolon eklemek tüm tablolar için tespit sağlamaz.
Ayrı bir current-state tablosu + yalnız değişimde append edilen event gerekiyor.
**Faz 2.**

### 7.6 Kapsam bulgusu — inceleme daraltmayı yetersiz buldu

r1 §4'teki üçlü yeterli değil. Önce taban durumu açıkça modellenmeli:
`REWRITE_CONFIRMED` / `HISTORY_21_28` / `UNAVAILABLE` / `WARMING_UP` /
`DATA_GAP`. İlk 28 gün bulgu değil **warm-up**; collector boşluğu bloat bulgusu
değil **sistem sağlığı**. `HISTORY_21_28` varsa "değerlendiremiyorum" demek
yanlış — sonuç yalnızca `history_only` provenance etiketi taşımalı.

Bulgu yalnız `UNAVAILABLE` + `NO_TRUSTED_BASELINE` + 28 gün izleme + 21 sağlıklı
gün + taze veri + `turnover_28d >= 1.0` + 3 ardışık başarılı değerlendirme ile
üretilmeli. `turnover` insert'i **içermemeli** (insert meşru büyümedir).

Boyut tabanı 8 MiB çok düşük; türetilmiş eşik:

```
material_size_floor = max(8 MiB, min_wasted_bytes / (1 - 1/warning_ratio))
```

Mevcut ayarlarla (`ratio=3`, `min_wasted=100 MiB`) → **150 MiB**.

Bulgu metni "şişme tespit edildi" / "X alan kurtarılır" / "VACUUM FULL çalıştır"
**dememeli**. Güvenilir taban oluşunca `ENDED`, veri kaybolunca `STALE` olmalı —
r1'deki "hiç çözülmez" ifadesi yanlıştı. **Faz 3.**

### 7.7 Geriye dönük kurtarma — r1'deki cevap doğrulandı

Canlı kataloglardan kanıtlı biçimde kurtarılamaz; `relfilenode`, `relpages` ve
`reltuples` yalnız güncel durumu taşır, kalıcı "son rewrite" geçmişi yoktur.
Harici kaynaklar (audit log, eski katalog snapshot'ları, arşiv WAL forensics)
kısmi ipucu verebilir ama bunlar yalnız `inferred_historical_compaction`
üretmeli, kanıtlı taban sayılmamalı.

---

## 8. Fazlar

| Faz | Kapsam | Durum |
|---|---|---|
| **1** | Epoch kırılması ile ankraj geçersizleştirme + `(instance_pk, dbid, relid)` anahtarı | **kodlandı** |
| **2** | `physical_generation` (filenode + tablespace + relpages), sınıflandırma, event tablosu, aralık aritmetiği, tarihsel gözlemlerin de delta-düzeltilmesi | bekliyor |
| **3** | Kapsam bulgusu (Bulgular ekranı, PGSTAT-P1-015) | bekliyor |

Faz 1 öne alındı çünkü ikisi de **canlıdaki koda düzeltme**: `relid` çakışması
şu anda yanlış geçmiş üretiyor ve ankraj hatası kural açıldığında sessizce
yanlış negatif verecekti. İkisi de yeni toplama gerektirmiyor.

---

## 9. Kapsam dışı

- Toplama sıklığı **değişmiyor**. `statements_interval` 300 saniye, `insights.ts`
  altı saatten kısa pencereleri beş dakikalık adımlarla çizdiği için buna bağlı.
- Kimlik eşleştirmesi `relid` üzerinden kalıyor. `relfilenode` kimlik **değil**,
  yalnızca "yeniden yazıldı" sinyali.
- TOAST ve indeks şişmesi hâlâ kapsam dışı; ölçüm yalnızca heap.
