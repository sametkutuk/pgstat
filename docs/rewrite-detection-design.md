# Yeniden yazma tespiti — tasarım (r1)

**Tarih:** 2026-09-01
**İlgili:** PGSTAT-P0-046 (fiziksel şişme kuralı), PGSTAT-P1-015 (Bulgular ekranı)
**Durum:** inceleme bekliyor, kodlanmadı

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

## 6. Kapsam dışı

- Toplama sıklığı **değişmiyor**. `statements_interval` 300 saniye, `insights.ts`
  altı saatten kısa pencereleri beş dakikalık adımlarla çizdiği için buna bağlı.
- Kimlik eşleştirmesi `relid` üzerinden kalıyor. `relfilenode` kimlik **değil**,
  yalnızca "yeniden yazıldı" sinyali.
- TOAST ve indeks şişmesi hâlâ kapsam dışı; ölçüm yalnızca heap.
