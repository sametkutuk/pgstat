# Bulgular (Findings) Ekranı — Tasarım Taslağı

**Durum:** taslak, dış inceleme için
**Tarih:** 2026-08-31
**Amaç:** Bu doküman eleştirilmek için yazıldı. Açık sorular sonda.

---

## 1. Problem

pgstat bugün **alarm** üretiyor: bir eşik aşıldığında açılan, çözülünce
kapanan, bildirim gönderen kayıtlar. Bu, "şu an müdahale gerekli mi?"
sorusunu cevaplıyor.

Ama izleme sırasında ortaya çıkan değerli gözlemlerin çoğu bu kalıba
uymuyor. Son bir haftada üretilen ve **hepsi elle SQL yazılarak** bulunan
gözlemler:

| Gözlem | Neden alarm değil |
|---|---|
| `reltuples` 30.404.328 diyor, `n_live_tup` 0 — istatistikler güvenilmez | Acil değil, ama her hesabı bozuyor |
| Bir partition 11.740 satırı 637 MB'da tutuyor | Eşik yok; sorun tasarımsal |
| `pg_index_stat_delta` günde 3 GB üretiyor | Büyüme normal, ama sonucu bilinmeli |
| 574 tablonun 547'si hiç analiz edilmemiş | Çoğu masum; hangisi değil? |
| Bir tabloda satır başına 9 UPDATE | Yavaş biriken tasarım sorunu |
| `agg.pg_table_stat_hourly` 2432 MB → 41 MB (VACUUM FULL) | %98'i boş alandı, ölü satır oranı bunu göstermiyordu |

Hiçbiri gece 3'te kimseyi uyandırmamalı. Hepsi bilinmeye değer. Şu an
**yalnızca birisi elle sorgu yazarsa** görünüyorlar.

## 2. Bulgu ile Alarm farkı

Bu ayrım tasarımın çekirdeği ve en çok eleştiri isteyen kısmı.

| | Alarm | Bulgu |
|---|---|---|
| Cevapladığı soru | "Şimdi müdahale gerekli mi?" | "Bilmen gereken bir şey var" |
| Tetikleyici | Eşik aşımı | Örüntü / eğilim |
| Yaşam döngüsü | Açılır → çözülür | Belirir → kaybolur |
| Bildirim | Gider (Telegram vb.) | **Gitmez** |
| Aciliyet | Var | Yok |
| Kullanıcı eylemi | Kapat / onayla | Sadece okur |

**Kural olarak önerilen ayrım:** bir gözlem, *bugün yapılması gereken bir
şeye* işaret ediyorsa alarmdır. *Bir karara girdi* sağlıyorsa bulgudur.

## 3. Bulgu kataloğu

Her bulgu için: ne söylediği, hangi veriden hesaplandığı, ve **neyi
söylemediği**.

### 3.1 Büyüme projeksiyonu

> `fact.pg_index_stat_delta` son 7 günde günde ortalama 3,1 GB büyüdü.
> Bu hızla 30 gün sonra 93 GB olurdu; retention 14 gün olduğu için
> ~43 GB'da dengelenmesi bekleniyor.

- **Veri:** `fact.pg_relation_size_snapshot` (gece, ~4 ay geçmiş)
- **Hesap:** son N günün doğrusal eğimi + retention penceresiyle denge
  noktası
- **Söylemediği:** iş yükü değişirse eğim değişir; bu bir tahmin, taahhüt
  değil

### 3.2 Yazma deseni — satır başına aşırı güncelleme

> `agg.pg_table_stat_hourly_202608`: 121.162 satıra 1.126.780 güncelleme
> (satır başına ~9). Bu desen ölü satır üretir ve tablo şişer.

- **Veri:** `fact.pg_table_stat_delta` (`n_tup_upd_delta`, `reltuples`)
- **Hesap:** pencere içindeki toplam UPDATE / satır sayısı
- **Söylemediği:** desen kasıtlı olabilir (rollup UPSERT'i gibi); bulgu
  suçlama değil, gözlem

### 3.3 Veri güvenilirliği

> `etsrooms` veritabanında istatistikler 2026-03-04'te sıfırlanmış
> (176 gün önce). O tarihten beri analiz edilmemiş 4.478 tablo var;
> bunların satır sayısı tahminleri gerçekle ilgisiz olabilir.

- **Veri:** `pg_stat_database.stats_reset`, `last_analyze/autoanalyze`,
  `reltuples`
- **Hesap:** sıfırlamadan beri düzeltilmemiş tablo sayısı + en büyükleri
- **Söylemediği:** hepsi sorunlu değil; çoğu hiç değişmediği için analiz
  edilmemiş

### 3.4 Kaynak israfı

> `fact.pgss_delta_20260820` 11.740 satırı 637 MB'da tutuyor. Satır başına
> ~54 kB; bu tablonun sıkışık hâli ~10 MB olmalı.

- **Veri:** `pg_relation_size_snapshot` (boyut + `reltuples`)
- **Hesap:** satır başına alan / tablonun kendi tarihsel minimumu
- **Söylemediği:** `fillfactor` ayarlıysa boşluğun bir kısmı tasarım
  gereğidir (hesaptan düşülür); TOAST ayrı

### 3.5 Autovacuum yetişemiyor

> `public.t_ext_hotel_content_general` üzerinde son 24 saatte autovacuum
> 14 kez çalıştı, ölü satır sayısı yine de 1.466'dan 2.310'a çıktı.

- **Veri:** `autovacuum_count_delta`, `n_dead_tup_estimate` zaman serisi
- **Hesap:** yüksek autovacuum sayısı **ve** artan ölü satır eğilimi
- **Alarmdan farkı:** alarm eşik aşımında tetiklenir; bulgu eşik
  aşılmadan önce **eğilimi** gösterir
- **Söylemediği:** sebebi (xmin horizon, worker doygunluğu, iş yükü) —
  onu alarmın teşhis katmanı yapar

### 3.6 Autovacuum fazla ayarlanmış

> `agg.pgss_hourly_202609` tablosunda `autovacuum_vacuum_scale_factor=0.02`
> ayarlı. Son 24 saatte 47 kez vacuum çalıştı ve her seferinde ortalama
> 340 ölü satır temizledi. Bu tablo için ayar gereğinden agresif olabilir.

- **Veri:** `control.table_relopts_snapshot`, `autovacuum_count_delta`,
  `n_dead_tup_estimate`
- **Hesap:** yüksek çalışma sıklığı **ve** her çalışmada düşük kazanım
- **Neden önemli:** her vacuum I/O harcar; boşuna çalışan autovacuum,
  gerçekten ihtiyacı olan tablolardan worker çalar
- **Söylemediği:** ayar kasıtlı olabilir. (Bizzat biz V094'te bu tabloya
  `0.02` koyduk — bulgu, kararın gözden geçirilmesini önerir, hata ilan
  etmez)
- **Ters yön de var:** `autovacuum_max_workers` yükseltilip
  `autovacuum_vacuum_cost_limit` yükseltilmemişse, worker başına bütçe
  bölünür ve hepsi yavaşlar — bu da bir bulgu

## 4. Veri modeli (öneri)

```
ops.finding
  finding_id      bigint pk
  finding_code    text        -- 'growth_projection', 'excessive_updates', ...
  instance_pk     bigint
  dbid            bigint null
  schemaname      text null
  relname         text null
  severity_hint   text        -- 'info' | 'notice' — alarm severity'si DEĞİL
  title           text
  body            text
  details_json    jsonb       -- hesabın girdileri, denetlenebilirlik için
  first_seen_at   timestamptz
  last_seen_at    timestamptz
  disappeared_at  timestamptz null
```

**Alarm tablosundan ayrı**, çünkü:
- Bildirim yolu yok
- "Çözüldü" kavramı yok — bulgu ya hâlâ geçerlidir ya değildir
- Yaşam döngüsü farklı: her değerlendirmede yeniden hesaplanır, kaybolursa
  `disappeared_at` işaretlenir

## 5. Üretim ve sıklık

Bulguların hepsi **zaten toplanan** veriden hesaplanıyor; yeni toplama
gerekmiyor.

Sıklık: günde bir kez yeterli. Bulgular gün içinde değişmiyor (büyüme
eğilimi, yazma deseni, istatistik güvenilirliği hepsi yavaş değişkenler).
Bu aynı zamanda maliyeti sıfıra yakın tutuyor.

## 6. UI

Alarmlardan **ayrı bir sekme**. Öneri:

- Kategoriye göre gruplu liste (büyüme / desen / güvenilirlik / israf /
  autovacuum)
- Her bulgu: başlık + tek paragraf + "hesabın girdileri" açılır bölümü
- Instance ve veritabanına göre filtre
- Yeni beliren bulgular işaretli (son 24 saat)

**Bildirim yok.** Bilinçli: ikinci bir bildirim akışı, ilkini de
değersizleştirir.

## 7. Asıl risk ve önlemi

**İkinci bir gürültü kaynağı yaratmak.** Bulgular da gürültülü olursa
kimse ikisine de bakmaz.

Bu hafta alarm tarafında tam bu tuzağa düşüldü: bir senaryo "sorun yok"
teşhisi koyup yine de alarm açıyordu, ve önerdiği komut sorunu
çözmeyecek olan `VACUUM ANALYZE`'dı.

**Önerilen kural:** bir bulgu, *bir kararı değiştirebiliyorsa* yayınlanır.
"Tablo büyüyor" bulgu değildir. "Tablo bu hızla 30 günde diski
dolduracak" bulgudur.

Pratik uygulama: her bulgu tipi için **üst sınır** (instance başına en
fazla N) ve **anlamlılık eşiği** (örn. projeksiyon yalnızca 1 GB'ın
üstündeki tablolar için).

## 8. Bilinçli olarak kapsam dışı

- **Bildirim.** Bulgular okunmak içindir, uyandırmak için değil.
- **Otomatik düzeltme.** Bulgu öneri verir, uygulamaz.
- **Yeni veri toplama.** İlk sürüm yalnızca mevcut veriyi kullanır.
- **Alarmların bulguya dönüştürülmesi.** İkisi yan yana yaşar; mevcut
  alarm mantığı değişmez.

## 9. İnceleme için açık sorular

1. **Ayrım doğru mu?** "Alarm = bugün yap, bulgu = kararına gir" ayrımı
   pratikte tutar mı, yoksa kullanıcılar bulguları da alarm gibi mi
   algılar?

2. **Bildirim gerçekten olmamalı mı?** Hiç bildirim olmazsa ekran
   ziyaret edilmez ve bulgular ölü yatırım olur mu? Haftalık özet bir
   orta yol mu?

3. **Yaşam döngüsü.** Bir bulgu kaybolduğunda ne olmalı — silinmeli mi,
   arşivlenmeli mi? "Bu bulguyu gördüm, bir daha gösterme" gerekli mi?

4. **Projeksiyon güvenilirliği.** Doğrusal ekstrapolasyon yeterli mi,
   yoksa yanıltıcı mı? Hangi durumda projeksiyon göstermemeliyiz?

5. **"Fazla ayarlanmış" bulgusu haksız mı olur?** Ayarı bilinçli koyan
   birine "gereksiz" demek yanlış anlaşılabilir. Nasıl ifade edilmeli?

6. **Eksik kategori var mı?** Aşağıdakiler düşünüldü ama listeye
   alınmadı — alınmalı mı: kullanılmayan indeksler, eksik indeks şüphesi,
   bağlantı havuzu deseni, checkpoint sıklığı, WAL üretim hızı.

7. **Ölçek.** 25 instance × ~12.000 tablo. Bulgu üretimi tablo başına mı
   olmalı, yoksa yalnızca "en kötü N" mi? Tablo başına olursa ekran
   kullanılamaz hâle gelir mi?

---

## Ek: bu tasarımı besleyen üretim ölçümleri

Aşağıdakiler 2026-08-27 ile 2026-08-31 arasında gerçek ortamdan alındı ve
yukarıdaki bulgu tiplerinin hepsi bunlardan türetildi.

| Ölçüm | Değer |
|---|---|
| İzlenen instance | 25 |
| İzlenen tablo (son 2 saat) | 12.116 |
| `reltuples` bilinen | 7.638 |
| Hiç analiz edilmemiş | 4.478 |
| Merkezi DB boyutu | 35 GB → 28 GB → 20 GB (VACUUM FULL sonrası) |
| Geri kazanılan boşa duran alan | ~8 GB |
| En büyük tek şişme | 2432 MB → 41 MB (%98 boş) |
| Gece toplanan relation | ~6.900 |
| `pg_relation_size_snapshot` boyutu | 80 MB / ~4 ay |
