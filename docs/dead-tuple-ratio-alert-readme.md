# `dead_tuple_ratio` Alarmı — Kullanım Kılavuzu

Bu doküman, bir `dead_tuple_ratio` (ölü satır oranı) alarmı aldığında
**ne anlama geldiğini ve ne yapman gerektiğini** anlatır. Alarmın
teknik karar mantığı için `docs/bloat-diagnosis-decision-tree.md`,
autovacuum kanıt katmanının tasarımı için
`docs/autovacuum-cost-diagnosis-design.md`.

## Bu alarm neyi söyler, neyi söylemez

**Söyler:** Bir tabloda ölü satır (dead tuple) sayısı, belirlediğin
eşiği aşmış durumda — ve bunun **neden** böyle olduğuna dair kanıta
dayalı bir teşhis.

**Söylemez:**
- "Diskte X MB israf var." Ölü satır sayısı `pg_stat_user_tables`'ın
  istatistiksel bir **tahminidir**, fiziksel disk israfının ölçümü
  değil (onun için `pgstattuple` gibi bir extension gerekir).

### İstatistikler güvenilmezse oran hesaplanmaz

`n_live_tup` ve `n_dead_tup` yalnızca `ANALYZE` veya `VACUUM` sırasında
gerçek sayımla düzeltilir. İkisi de hiç çalışmamışsa değerler
insert/delete sayaçlarından türetilir ve `pg_stat_database.stats_reset`
sonrasında gerçekle ilişkisi kalmayabilir — sayaçlar sıfırlanırken
tablodaki mevcut satırlar sayılmaz.

Bu yüzden alarm, karar ağacına girmeden önce şunu sorar: **bu tablo hiç
`ANALYZE` veya `VACUUM` gördü mü?** Dördü de (`last_analyze`,
`last_autoanalyze`, `last_vacuum`, `last_autovacuum`) boşsa oran
hesaplanmaz; onun yerine "istatistikler güvenilmez, önce `ANALYZE`
çalıştır" teşhisi verilir.

Kapı **canlı satır sayısına bakmaz**. Gerçekten az canlı + çok ölü
satırlı tablolar vardır (kuyruk ve staging tabloları) ve istatistikleri
güncel olduğu sürece normal şekilde alarm üretmeye devam ederler.

Üretimde ölçülen (2026-08-27, `etsrooms`): `security.user` 6 canlı /
3224 ölü satır bildiriyordu — %99.81 oran ve kritik alarm. Gerçek satır
sayısı **26.257**, gerçek oran **%11**, yani %20'lik uyarı eşiğinin bile
altında. Aynı instance'ta beş tablo için beş yanlış alarm üretilmişti;
`ANALYZE` sonrası oranlar %0.06 ile %11 arasına indi.

Üretilen teşhis metni çelişkiyi kendisi yazıyordu — "eşik (50 = 50 +
0.20 × **0 canlı satır**) çoktan aşılmış (**1.233.280 ölü satır**)" —
ama hiçbir kontrol bunu durdurmuyordu.
- "Bu tablo için doğru autovacuum eşiği şudur." Alarm somut bir ayar
  önerebilir, ama bu tablonun ölçülen güncelleme hızından
  **hesaplanmış** bir değer değil — genel bir tavsiyedir.

## Her tablo kendi alarmını alır

Eşiği aşan her tablo **ayrı** bir alarm açar ve bağımsız kapanır. Birini
`VACUUM`'ladığında yalnızca onun alarmı çözülür, diğerleri açık kalır.

Önceden instance başına tek alarm vardı ve yalnızca listenin ilk kaydı
değerlendiriliyordu. Bu iki yönde de yanlış sonuç veriyordu: bozuk
tablolardan sadece biri görünüyordu, ve daha kötüsü, listenin başındaki
tablo eşiğin **altına** düştüğünde altındakiler hiç değerlendirilmediği
için bütün instance susuyordu. Üretimde (2026-08-28) tam olarak bu oldu —
`security.user` en çok ölü satıra sahip olduğu için listenin başındaydı
ama oranı %11'e düştüğü için alarm üretmiyordu; altındaki dört tablonun
üçü kritik eşiğin üstündeydi ve hiçbiri bildirilmedi.

**Bildirim tek mesajda toplanır.** Beş tablo aynı anda eşiği aşarsa beş
ayrı alarm açılır ama tek özet bildirim gider:

```
dev-etsrooms-140-52 — Dead Tuple Oranı: 4 kayit esigin ustunde

• [CRITICAL] DB=etsrooms public.t_ext_hotel_content_general — 93.6
• [CRITICAL] DB=etsrooms public.t_ext_hotel_quota_room — 74.9
• [CRITICAL] DB=etsrooms security.user_token — 55.2
...
```

Bir instance için bir değerlendirmede en fazla **10** kayıt alarm açar.
Daha fazlası varsa collector log'una uyarı yazılır — sessizce kırpılmaz.

## Alarm mesajını okuma

Mesaj üç parçadan oluşur:

```
[1] Neyin eşiği aştığı        → "agg.pg_table_stat_hourly: 1.2M ölü satır (%17)"
[2] Teşhis (neden)             → "Autovacuum kronik olarak çalışıyor ama trend hâlâ artıyor..."
[3] Aksiyon (ne yapmalı)       → "Bu tablo için scale_factor'ü düşür..."
```

**Teşhis kısmı sabit değildir** — sistem 8 farklı senaryoyu ayırt eder
ve hangisi geçerliyse ona uygun teşhis + aksiyon üretir:

| Senaryo | Ne bulundu | Tipik aksiyon |
|---|---|---|
| 1a | Instance genelinde `autovacuum = off` | `autovacuum = on` yap, manuel VACUUM çek |
| 1b-i | Bu tabloda `autovacuum_enabled = false` override'ı var | Override'ı kaldır |
| 1b-ii | Eşik aşılmış, override yok, ama worker doygunluğu var | `autovacuum_max_workers` artır |
| 1c/1d | Eşik henüz aşılmamış / tablo yeni | Aksiyon yok, bilgi amaçlı |
| 4 | Autovacuum çalışıyor, trend artıyor, ama henüz ısrar etmiyor | **Alarm açılmaz** — bkz. aşağıdaki not |
| 2 | Uzun transaction veya pasif replication slot xmin horizon'u tutuyor | Transaction'ı/slot'u temizle |
| 3 | Autovacuum çalışıyor ama etkisiz | Eşik ayarına bak |
| 3.5 | Son vacuum 24 saatten eski, bloat artıyor | Worker/eşik ayarına bak |
| 4.5 | Autovacuum kronik çalışıyor, trend hâlâ artıyor | Eşik yanlış kalibre — düşür |

Sıra önemlidir: en kesin/en acil senaryo önce değerlendirilir, ilk
eşleşen kazanır.

### Neden bazı durumlar alarm üretmez (senaryo 4)

Bir tablo eşiği aştığında, autovacuum zaten çalışıyorsa ve trend
artıyorsa bu **çoğu zaman toplama anına denk gelmiş geçici bir
birikimdir** — autovacuum bir-iki döngüde temizler. Bu duruma her
seferinde alarm üretmek gürültü yaratır.

Bu yüzden senaryo 4'te alarm hemen açılmaz. Bunun yerine
`control.bloat_scenario_streak` tablosunda bir ısrar sayacı tutulur:

- Her değerlendirmede aynı tabloda aynı senaryo görülüyorsa sayaç artar.
- Sayaç **3**'e ulaşınca durum artık "geçici" sayılmaz, alarm açılır ve
  mesajda kaç değerlendirmedir sürdüğü + ne zamandır fark edildiği yazar.
- Sayaç yalnızca ölü satır sayısı **gerilediğinde** sıfırlanır — bu, kısmi
  bir vacuum'un işe yaradığı anlamına gelir. Sabit kalması ısrarın bittiği
  anlamına gelmez.
- Tablo eşiği aşmayı bırakır ya da başka bir senaryoya geçerse kayıt
  tamamen silinir; kendi kendine düzelen durum sayacı doldurmaya fırsat
  bulamaz.

Sayaç önceleri "ölü satır artmaya devam ediyor mu" kuralını kullanıyordu.
Bu, dibe vurup orada duran tabloları kalıcı olarak görünmez yapıyordu:
üretimde `security.user` (6 canlı / 3224 ölü, hiç vacuum edilmemiş) her
değerlendirmede aynı sayıyı gösterdiği için sayaç sürekli 1'e dönüyor ve
eşik hiç aşılmıyordu. Hiç vacuum edilmemiş bir tablo, artmayı bıraksa da
düzeltilmesi gereken bir durumdur.

### Bastırma açık bir alarmı dondurmaz

Bastırma **yeni** alarm açmamak içindir. Zaten açık bir alarm varsa
bastırılan değerlendirmede o alarm kapatılır (`auto_resolve` açıksa) —
güncellenmeden açık bırakılmaz.

Önceki hali açık alarmı dokunmadan geçiyordu ve alarm "zombi" hale
geliyordu: üretimde bir alarm 21 Ağustos'ta açılmış, sonra bastırma
devreye girmiş, ve mesaj iki saat boyunca kullanıcının çoktan
`VACUUM`'ladığı bir tabloyu göstermeye devam etmişti. Bastırma sırasında
`alert_rule_last_eval`'e severity yazılmaz (null yazılır); severity
yazmak hem cooldown'u yanlış tetikliyor hem de bir sonraki döngüde
resolve koşulunu yanıltıyordu.

**Bu, gerçek sorunları kaçırmaz.** Senaryo 4, karar ağacında senaryo 2
(xmin horizon), 3 (vacuum yetersiz), 3.5 (24 saattir vacuum yok) ve 4.5
(eşik yanlış kalibre) senaryolarından **sonra** gelir. Gerçekten
yetişemeyen bir tablo zaten o daha kesin testlere takılır ve **anında**
alarm üretir. Senaryo 4'e düşen bir kayıt, tanımı gereği onların
hiçbirine takılmamış demektir.

Sayaç kalıcı bir tabloda tutulur, bellekte değil — collector her
deploy'da yeniden başlar ve bellekteki bir sayaç her seferinde
sıfırlanırdı; o zaman ısrarlı bir sorun eşiğe hiç ulaşamazdı.

## Autovacuum kanıt katmanı (PGSTAT-P1-011 — planlandı, henüz kodlanmadı)

Senaryo 3 ve 4.5'in mesajlarına, autovacuum'un o an **gözlemlenen
durumunu** anlatan ek cümleler eklenecek. Amacı: "eşiği düşür"
önerisinin doğru öneri olup olmadığını, elle sorgu yazmadan
görebilmek.

Eklenecek kanıtlar:

| Kanıt | Ne söyler | Hangi PG sürümleri |
|---|---|---|
| I/O bekleme oranı | Worker örneklemelerinin ne kadarında bir I/O tamamlanması bekleniyordu | Tümü (25/25 instance) |
| Throttle uykusu oranı + cost ayarı | Worker ne kadar `VacuumDelay`'de uyudu, ayar varsayılan mı | PG13+ (20/25 instance) |
| I/O işlem sayısı | Autovacuum worker'lar uygulama trafiğine kıyasla kaç kat okuma/yazma işlemi yaptı | PG16+ (10/25 instance) |
| Etkin worker kapasitesi | `autovacuum_max_workers` ile `autovacuum_worker_slots`'un küçüğü | PG18 (3/25 instance) |

Örnek çıktı:

```
agg.pg_table_stat_hourly: 1.2M ölü satır (%17). Autovacuum kronik olarak
çalışıyor ama ölü satır sayısı hâlâ artıyor — tetikleme eşiği yüksek kalmış.

Ek gözlem: son 2 saatte autovacuum worker'ları 16 farklı anda örneklendi,
15'inde throttle uykusundaydı; cost ayarları varsayılan değerde. Son 24 saatte
autovacuum worker'lar 5.1M okuma işlemi yaptı (client backend'in ~30 katı).
```

### Bu kanıtların dili neden ihtiyatlı

Kanıt cümleleri bilinçli olarak **gözlemsel**, nedensel değil:

- "Worker throttle uykusunda gözlemlendi" denir, "throttling tabloyu
  yavaşlatıyor" denmez — anlık örnekleme bunu kanıtlamaz.
- "I/O tamamlanması bekleniyordu" denir, "disk yavaş" denmez —
  PostgreSQL bu ayrımı yapmaz (OS cache'i de olabilir).
- Yüksek throttle oranı bir **sorun göstergesi değildir**: `VacuumDelay`,
  worker cost bütçesini **doldurduğu için** oluşur, dolduramadığı için
  değil. Varsayılan ayarlarda yüksek çıkması normaldir.

### Ne zaman "cost_delay'i düşür" önerisi çıkar

Sadece **üç koşul birden** sağlanırsa:
1. Throttle uykusu oranı yüksek, **ve**
2. Yeterli örneklem var (en az 10 farklı toplama anı), **ve**
3. Etkin `cost_delay` sürüm varsayılanından **büyük** (PG11: 20ms,
   PG12+: 2ms) — yani biri kasıtlı yükseltmiş.

`0ms`/`1ms` gibi varsayılandan **düşük** değerler "varsayılan değil" ama
öneriyi tetiklemez. Ayar okunamıyorsa (eksik/bozuk/bayat veri) öneri
bastırılır — bilinmeyen bir değer "yüksek" sayılmaz.

## Bu alarm neyi ayırt EDEMEZ

Kanıt katmanı bir semptom raporudur, kök neden teşhisi değil. Şu
nedenler aynı görüntüyü üretebilir ve alarm bunları birbirinden
ayırmaz:

- Worker doygunluğu (`max_workers` yetersiz)
- Uzun süren transaction / prepared transaction (xmin horizon)
- Pasif replication slot (aynı etki)
- Wraparound/freeze baskısı (agresif vacuum **gerekli** olabilir)
- Lock/BufferPin beklemesi
- Tabloya özel `reloptions` override'ı

Ayrıca kanıtlar **cluster genelidir** — hangi worker'ın hangi tabloyu
vacuum ettiği `pg_stat_activity`'den bilinemez. Yani "autovacuum
worker'lar meşgul" bilgisi, alarm edilen tabloya değil, instance'ın
tamamına aittir.

## Sistem asla ne önermez

**"Autovacuum'u kapat."** Bu hiçbir koşulda doğru çözüm değildir —
kapatmak ölü satır birikimini durdurmaz, sadece transaction ID
wraparound riskini büyütür (nihayetinde veritabanı read-only moda
zorlanabilir). Sistem sadece **ayar değiştirmeyi** önerir. Bu, kodda
bir birim testle korunur: hiçbir aksiyon metni `autovacuum = off`
veya `autovacuum_enabled = false` deseniyle eşleşemez.

## Eşiği değiştirme

Alarm eşiği (varsayılan %20) `control.system_alert_config.threshold_value`
üzerinden, instance bazında override edilebilir. Alarm kuralının
kendisi UI'da **Alert Rules** sayfasından yönetilir.

## İlgili dokümanlar

- `docs/bloat-diagnosis-decision-tree.md` — 8 senaryonun tam karar
  mantığı, SQL'ler, kaynak araştırması
- `docs/autovacuum-cost-diagnosis-design.md` — kanıt katmanının
  tasarımı, durum modelleri, test sözleşmesi
- `docs/alert-reference.md` — tüm built-in alarmların özet tablosu
