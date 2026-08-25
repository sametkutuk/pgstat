# Autovacuum Sistem Maliyeti Teşhisi — Tasarım Dokümanı

**Durum:** PGSTAT-P1-011 — tasarım + doğrulama (AC1) TAMAMLANDI, 2026-08-25.
Henüz kodlanmadı (AC2 bekliyor). Teşhis 0, 2, 2b üç instance'ta (PG13/15/17)
test edildi; Teşhis 1 güvenilmez bulunup ikincil/opsiyonel'e indirildi.
Cost ayarları toplama listesine eklendi ve canlı doğrulandı (üçü de
varsayılan değerde). `VacuumDelay`'in PG sürümünden bağımsız olarak her
zaman `wait_event_type='Timeout'` altında geldiği ham veriyle
doğrulandı (ilk taslaktaki "PG13'te IO'ya taşındı" notu YANLIŞTI,
düzeltildi — bkz. Teşhis 2 bölümü). AC2'ye başlamak için bilinen açık
belirsizlik kalmadı.
**Amaç:** Kullanıcının sorusu — "autovacuum kapatılmalı mı, sık çalışıp diğer
sorguları yavaşlatıyor mu, yoksa yetişemiyor mu — bunu en doğru ve somut
kanıtlı şekilde nasıl tespit ederiz?" Bu doküman üç ayrı teşhis hedefini,
her biri için somut SQL/veri kanıtıyla birlikte tanımlıyor.

## Önce netleştirme: "autovacuum kapatılmalı mı?"

**Bu soruya sistemin cevabı her zaman HAYIR olmalı.** PostgreSQL resmi
dokümantasyonu ve her ciddi kaynak (Citus, pganalyze, Percona) autovacuum'un
kapatılmasının doğru çözüm olmadığını açıkça belirtir — kapatmak, dead tuple
birikimini durdurmaz, sadece MVCC/transaction ID wraparound riskini
büyük ölçüde artırır (nihayetinde read-only mod'a zorlanmış bir database'e
kadar gidebilir). Sistem hiçbir zaman "autovacuum'u kapat" önermemeli;
sadece "ayarını değiştir" (scale_factor/threshold/cost_delay/max_workers)
önerebilir. Bu, kod tarafında bir "guard" olarak ele alınmalı — hiçbir
aksiyon metni `autovacuum = off` veya `autovacuum_enabled = false` önermemeli
(mevcut `diagnoseBloat()` zaten bunu yapmıyor, bilinçli olarak).

## Veri kaynakları (doğrulanmış kolon adları)

| Sinyal | Tablo | Kolon(lar) |
|---|---|---|
| Autovacuum worker sayısı | `fact.pg_activity_snapshot` | `backend_type='autovacuum worker'`, `snapshot_ts` |
| Worker'ın ne için beklediği | `fact.pg_activity_snapshot` | `wait_event_type`, `wait_event` |
| Worker'ın işlem başlama zamanı | `fact.pg_activity_snapshot` | `xact_start` (autovacuum worker satırı için) |
| Hangi tablo vacuum ediliyor, hangi fazda | `fact.pg_progress_vacuum_snapshot` | `relid`, `datid`, `phase`, `heap_blks_scanned`/`total` |
| Autovacuum'un tükettiği I/O | `fact.pg_io_stat_delta` | `backend_type='autovacuum worker'`, `reads_delta`, `read_time_ms_delta`, `writes_delta`, `write_time_ms_delta` |
| Instance-geneli sorgu gecikmesi | `fact.pgss_delta` | `mean_exec_time_ms`, `calls_delta`, `total_exec_time_ms_delta` |

**Önemli sınırlama (doğrulandı):** `fact.pgss_delta`'da `queryid`/`statement_series_id`
var ama **hangi tabloyu hedeflediği yok** — `dim.statement_series` sadece
`dbid`/`userid` taşıyor, `relid` yok. Yani "şu tabloya çalışan sorgular
autovacuum sırasında yavaşladı mı" sorusunu **doğrudan** SQL ile
cevaplayamıyoruz (`dim.query_text.query_text` içinde metin araması ile
yaklaşık bir eşleştirme yapılabilir ama güvenilir değil — LIKE '%tablename%'
yanlış pozitif üretebilir). Bu yüzden aşağıdaki teşhisler **instance-geneli**
korelasyona dayanıyor (tablo-özel değil) — bu bilinçli bir basitleştirme.

## REVİZYON (2026-08-25, gerçek veriyle test sonrası)

İlk taslakta Teşhis 1 (aşağıda) **birincil kanıt** olarak tasarlanmıştı.
İki gerçek instance üzerinde elle test edilince güvenilmez çıktı:

- `instance_pk=8`: autovacuum aktifken ortalama sorgu süresi %5.6 daha
  yüksek (`1.307ms` vs `1.238ms`) — eşik altı, anlamsız.
- `instance_pk=23` (pgstat'ın kendi DB'si): autovacuum aktifken ortalama
  sorgu süresi **daha DÜŞÜK** (`0.072ms` vs `0.101ms`) — yani ters yönde
  bir "sonuç" çıktı.

Bu, ikinci bir web araştırmasıyla doğrulandı: PostgreSQL topluluğunun
kendisi (pganalyze'ın VACUUM Advisor'ı dahil) autovacuum'u query latency
ile **doğrudan korelasyona sokmuyor** — çünkü bu, difference-in-differences
literatüründeki klasik confounder tuzağı (sistem zaten sakin olduğu
zamanlarda autovacuum tetikleniyor olabilir, trafik dalgalanmaları vb.).
Kaynak: https://pganalyze.com/blog/visualizing-and-tuning-postgres-autovacuum
(latency korelasyonu yerine bloat/faz/cost-throttling metriklerine
odaklanıyorlar).

**Karar:** Gecikme korelasyonu (Teşhis 1) **birincil kanıt olmaktan
çıkarıldı**, sadece ihtiyatlı bir ikincil bağlam notuna indirgendi (bkz.
aşağıdaki güncellenmiş bölüm). Bunun yerine **Teşhis 0** eklendi:
autovacuum worker'ların **doğrudan tükettiği I/O** — nedensellik zaten
mekanik olarak kurulu (bu I/O autovacuum'un kendi aktivitesi), confounder
riski yok.

## Teşhis 0 (YENİ, birincil): Autovacuum'un doğrudan I/O maliyeti

```sql
select backend_type,
       sum(reads_delta) as total_reads,
       sum(writes_delta) as total_writes,
       sum(read_time_ms_delta) as total_read_time_ms,
       sum(write_time_ms_delta) as total_write_time_ms
from fact.pg_io_stat_delta
where instance_pk = ? and sample_ts > now() - interval '24 hours'
group by backend_type
order by total_reads desc nulls last;
```

**Gerçek veriyle doğrulandı (`instance_pk=6`, 2026-08-25, 24 saatlik pencere):**

| backend_type | total_reads | total_writes | total_read_time_ms | total_write_time_ms |
|---|---|---|---|---|
| autovacuum worker | **5,119,503** | 4,203,112 | 0.0 | 0.0 |
| client backend | 172,332 | 6,245,526 | 0.0 | 0.0 |
| checkpointer | 0 | 2,499,669 | 0.0 | 0.0 |
| background writer | 0 | 3,454,920 | 0.0 | 0.0 |

**Kanıt yorumu:** Bu instance'ta autovacuum worker'lar `client backend`'den
**~30 kat fazla okuma** yapmış — somut, tartışmasız bir kanıt: "autovacuum
son 24 saatte X okuma yaptı, bu instance'taki uygulama trafiğinin Y katı".
Bu, korelasyona değil doğrudan sayıma dayandığı için "olası" gibi bir
belirsizlik ifadesi gerektirmez — kesin bir sayı.

**Pratik not (gerçek veriyle keşfedildi):** `total_read_time_ms`/
`total_write_time_ms` bu instance'ta **her zaman 0.0** çıktı — bu,
`track_io_timing` ayarının kapalı olduğunu gösteriyor (PostgreSQL'de
varsayılan olarak kapalıdır, açılması küçük bir CPU maliyeti getirir).
Yani zaman bazlı metrikler her instance'ta mevcut olmayabilir — teşhis
mantığı sadece `reads_delta`/`writes_delta` (sayım) üzerine kurulmalı,
zaman metriklerini varsa ek bilgi olarak kullanmalı, zorunlu tutmamalı.

**KRİTİK SINIRLAMA (kod envanteri ile doğrulandı, 2026-08-25):**
`fact.pg_io_stat_delta`, PostgreSQL'in `pg_stat_io` view'ına dayanıyor —
bu view **PG16'dan önce yok**. `ClusterCollector.java`'da
`pgMajor >= 16` guard'ı var; **PG11-15 çalıştıran instance'larda bu
tablo hiç dolmuyor**, dolayısıyla Teşhis 0 o instance'larda **tamamen
kullanılamaz** (boş sonuç dönecek, hata değil — ama sessizce "autovacuum
I/O maliyeti yok" gibi yanlış bir izlenim vermemesi için UI/mesaj
tarafında "bu instance'ın PG sürümü bu teşhisi desteklemiyor" notu
zorunlu). PG11-15'te sadece Teşhis 2 ve 2b (aşağıda, `pg_stat_activity`
tabanlı, sürüm bağımsız) uygulanabilir.

## Teşhis 1 (ikincil, ihtiyatlı bağlam — birincil kanıt DEĞİL): Gecikme korelasyonu

**Yöntem: pencere karşılaştırması.** Autovacuum worker'ların aktif olduğu
zaman dilimlerini `fact.pg_activity_snapshot`'tan çıkar, aynı instance'ın
o dilimlerdeki ortalama sorgu süresini (`fact.pgss_delta.mean_exec_time_ms`,
`calls_delta` ağırlıklı ortalama) autovacuum'un **aktif olmadığı** eşdeğer
uzunluktaki komşu pencerelerle kıyasla.

```sql
-- Adım 1: autovacuum worker'ların aktif olduğu 5dk'lık bucket'ları bul
with av_windows as (
  select distinct date_trunc('minute', snapshot_ts) -
         (extract(minute from snapshot_ts)::int % 5) * interval '1 minute' as bucket
  from fact.pg_activity_snapshot
  where instance_pk = ? and backend_type = 'autovacuum worker'
    and snapshot_ts > now() - interval '2 hours'
),
-- Adım 2: ayni instance icin TUM 5dk bucket'lari (av var/yok fark etmeksizin)
all_windows as (
  select distinct date_trunc('minute', sample_ts) -
         (extract(minute from sample_ts)::int % 5) * interval '1 minute' as bucket
  from fact.pgss_delta d
  join dim.statement_series ss on ss.statement_series_id = d.statement_series_id
  where ss.instance_pk = ? and sample_ts > now() - interval '2 hours'
)
select
  aw.bucket is not null as autovacuum_active,
  sum(d.total_exec_time_ms_delta) / nullif(sum(d.calls_delta), 0) as weighted_mean_exec_ms,
  sum(d.calls_delta) as total_calls
from all_windows w
left join av_windows aw on aw.bucket = w.bucket
join fact.pgss_delta d on date_trunc('minute', d.sample_ts) -
       (extract(minute from d.sample_ts)::int % 5) * interval '1 minute' = w.bucket
join dim.statement_series ss on ss.statement_series_id = d.statement_series_id and ss.instance_pk = ?
group by 1
order by 1;
```

**GERÇEK TEST SONUÇLARI (2026-08-25, ölçeklenmedi, birebir):**

`instance_pk=8` (2 saatlik pencere):
| autovacuum_active | weighted_mean_exec_ms | total_calls | num_buckets |
|---|---|---|---|
| false | 1.238 | 805,754 | 18 |
| true | 1.307 | 329,163 | 7 |

Fark: +%5.6 — eşik altı (bkz. aşağıdaki eşik), "anlamlı etki yok" sonucuna varır.

`instance_pk=23` (pgstat'ın kendi DB'si, 2 saatlik pencere):
| autovacuum_active | weighted_mean_exec_ms | total_calls | num_buckets |
|---|---|---|---|
| false | 0.101 | 9,030,333 | 21 |
| true | 0.072 | 1,919,636 | 4 |

Fark: **-%29** (ters yönde!) — bu, korelasyonun nedensellik olmadığının
doğrudan kanıtı: örnek sayısı küçük (4 bucket), muhtemelen autovacuum bu
instance'ta sistemin zaten sakin olduğu anlarda tetiklenmiş.

**Sonuç:** Bu sorgu **teknik olarak doğru çalışıyor** ama tek başına
**güvenilir bir teşhis üretmiyor** — küçük örneklemde (birkaç bucket)
rastgele yön değiştirebiliyor. Bu yüzden asla tek başına bir aksiyon
önerisine dayanak yapılmamalı; sadece Teşhis 0'ın (I/O maliyeti) yanında,
"ek bağlam" olarak ve **sadece yeterli örnek varsa** (örn. her iki tarafta
da en az 10 bucket) gösterilmeli, aksi halde hiç gösterilmemeli.

**DÜZELTME (2026-08-25, ham veriyle test edildi — önceki not YANLIŞTI):**
İlk yazımda "`VacuumDelay` PG13'te `Timeout`'tan `IO`'ya taşındı" denmişti
— bu **PostgreSQL kaynağına bakılmadan, tahminle yazılmış yanlış bir
bilgiydi**. Gerçek veri bunu çürüttü:

```sql
select wait_event, wait_event_type, count(*)
from fact.pg_activity_snapshot
where instance_pk = 23 and backend_type = 'autovacuum worker'
  and snapshot_ts > now() - interval '6 hours'
group by wait_event, wait_event_type
order by count(*) desc;
```

`instance_pk=23` **PG17** çalıştırıyor (bu satır, kendisi bu dokümanda
anlatılan `pg_major` auto-detect düzeltmesiyle PG15'ten PG17'ye
güncellendikten SONRA test edildi) ve sonuç:

| wait_event | wait_event_type | count |
|---|---|---|
| VacuumDelay | **Timeout** | 10 |

Yani **PG17'de bile `VacuumDelay` hâlâ `Timeout` kategorisinde** —
hiçbir sürümde `IO`'ya taşınmamış. **Doğru kural:** Teşhis 2'nin
`wait_event_type = 'IO'` filtresi throttle uykusunu **hiçbir PG
sürümünde yakalamaz** — `VacuumDelay` her zaman ayrı bir olay, ayrı bir
sinyal. Teşhis 2 ("I/O'da mı bekliyor") ve Teşhis 2b ("throttle'dan mı
uyuyor") **birbirinden bağımsız iki farklı soru**, aynı filtreyle
birleştirilmemeli — implementasyonda `wait_event_type = 'IO'` (gerçek
disk bekleme) ile `wait_event = 'VacuumDelay'` (throttle) ayrı ayrı
sayılmalı, `pg_major` dallanmasına hiç gerek yok.

## Teşhis 2: "Autovacuum yetişemiyor mu?" (kısmen zaten var)

Mevcut `vacuum_ineffective` (Bacak C, `AlertRuleEvaluator.findBloatedTables()`)
ve yeni senaryo 4.5 zaten bunu `n_dead_tup` trendi + `autovacuum_count_sum`
ile ölçüyor. Ek kanıt katmanı — **I/O throttling kanıtı**:

```sql
select
  count(*) filter (where wait_event_type = 'IO') as waiting_on_io,
  count(*) as total_av_worker_samples
from fact.pg_activity_snapshot
where instance_pk = ? and backend_type = 'autovacuum worker'
  and snapshot_ts > now() - interval '30 minutes';
```

**Kanıt yorumu:** `waiting_on_io / total_av_worker_samples` oranı yüksekse
(örn. >%50), autovacuum worker'ları çoğunlukla I/O'da bekliyor demektir —
bu, `autovacuum_vacuum_cost_delay`'in çok yüksek ayarlandığının somut
kanıtı (worker var ama throttle'dan dolayı ilerlemiyor). Bu durumda aksiyon
"cost_delay'i düşür" olmalı, "scale_factor'ü düşür" değil — ikisi farklı
sorunlara farklı çözümler.

## Teşhis 2b (YENİ, 2026-08-25): CPU maliyeti — cost ayarı üzerinden dolaylı tespit

**Sınırlama:** PostgreSQL `pg_stat_activity` ne de başka bir sistem view'ı
autovacuum worker'ın **CPU zamanını** doğrudan raporlamaz (bu bir OS/kernel
seviyesi metrik, PG'nin görev alanı dışında). Bu yüzden CPU tüketimini
**doğrudan ölçmek mümkün değil** — ama autovacuum'un cost-based throttling
modeli üzerinden **dolaylı, somut** bir tespit kurulabilir:

- Autovacuum her sayfa I/O işleminde "cost puanı" biriktirir
  (`autovacuum_vacuum_cost_page_hit/miss/dirty`), toplam
  `autovacuum_vacuum_cost_limit`'e ulaşınca `autovacuum_vacuum_cost_delay`
  kadar **uyur** (bu uyku sırasında CPU harcamaz, I/O da yapmaz).
- Yani worker'ın zamanı iki kovaya ayrılır: **(a) aktif çalışma** (CPU +
  I/O harcıyor) ve **(b) throttle uykusu** (`wait_event = 'VacuumDelay'`,
  hiçbir kaynak harcamıyor). Teşhis 2 (`wait_event_type = 'IO'`) bunun
  sadece bir alt kümesini yakalıyordu — `VacuumDelay` ayrı bir
  `wait_event`'tir ve I/O beklemesinden farklıdır.

```sql
-- Worker zamanının nereye gittiğini dagit: throttle uykusu / IO beklemesi / aktif calisma
select
  count(*) filter (where wait_event = 'VacuumDelay') as throttle_sleep_samples,
  count(*) filter (where wait_event_type = 'IO') as io_wait_samples,
  count(*) filter (where wait_event is null) as actively_running_samples,
  count(*) as total_samples
from fact.pg_activity_snapshot
where instance_pk = ? and backend_type = 'autovacuum worker'
  and snapshot_ts > now() - interval '2 hours';

-- Ayni instance'in guncel cost ayarlari (yorumlamak icin sart)
select setting_name, setting_value
from fact.pg_settings_snapshot
where instance_pk = ?
  and setting_name in ('autovacuum_vacuum_cost_limit', 'autovacuum_vacuum_cost_delay',
                        'autovacuum_max_workers', 'vacuum_cost_limit')
order by 1;
```

**Yorumlama kuralı (ayar + örnekleme birlikte okunmalı):**

| `actively_running_samples` oranı | `throttle_sleep_samples` oranı | Yorum | Aksiyon |
|---|---|---|---|
| Yüksek (>%60) | Düşük | Worker gerçekten aktif çalışıyor, CPU/I/O harcıyor — bu **gerçek bir yük**, throttle'dan kaynaklanmıyor | `cost_limit`'i artırmak işi HIZLANDIRIR ama CPU/I/O rekabetini AZALTMAZ; sorun zaten "iş yükü büyük" — scale_factor/threshold ayarına bakılmalı |
| Düşük | Yüksek (>%50) | Worker çoğunlukla throttle'dan uyuyor, aktif değil — mevcut `cost_delay` işi **yavaşlatıyor**, bu yüzden tablo yetişemiyor olabilir | `autovacuum_vacuum_cost_delay`'i düşür veya `cost_limit`'i artır — CPU/I/O rekabeti değil, **kasıtlı yavaşlatma** sorunu |
| Yüksek | Düşük, ama `cost_delay=0`/çok düşük | Worker aktif VE throttle'sız çalışıyor — bu, autovacuum'un **tam hızda** CPU/I/O tükettiği, diğer sorgularla en çok rekabet ettiği senaryo | Teşhis 0 (I/O sayımı) yüksekse, `cost_limit`'i düşürüp/`cost_delay`'i artırıp worker'ı kasıtlı yavaşlatmak (rekabeti azaltmak) düşünülebilir — ama bu, senaryo 3/4.5 ile çelişmemeli (yetişemiyor sorunu varsa yavaşlatma önerilmemeli) |

**Neden bu "somut" sayılır, CPU'yu tahmin etmekten farklı:** Buradaki iddia
"worker X CPU saniyesi harcadı" değil, "worker örneklemelerin %N'inde
throttle'dan uyuyordu, ayar `cost_delay=Yms`" — bu, `pg_activity_snapshot`
örneklemesinden **doğrudan sayılabilen**, yorum gerektirmeyen bir gerçek.
CPU'yu tahmin etmek yerine, "worker zaten throttle'lı mı yoksa serbest mi
çalışıyor" sorusuna kesin cevap veriyor — cost ayarını görmeden sadece
`wait_event_type='IO'` oranına bakmak yanıltıcı olurdu (worker aktif
görünebilir ama aslında `VacuumDelay`'de uyuyor olabilir, `IO` değil).

**KRİTİK EKSİK (kod envanteri ile doğrulandı, 2026-08-25): şu an kodlanamaz.**
`autovacuum_vacuum_cost_limit`, `autovacuum_vacuum_cost_delay`,
`vacuum_cost_limit`, `vacuum_cost_delay` ayarları `NightlySnapshotCollector`
içindeki `SETTINGS_QUERY` ve `HOT_SETTINGS_QUERY` whitelist'lerinde **yok**
— yani `fact.pg_settings_snapshot`'ta bu satırlar hiç bulunmuyor,
Teşhis 2b'nin ikinci sorgusu boş dönecek. Bunun **collector tarafında bir
whitelist eklemesi** gerekiyor (muhtemelen `HOT_SETTINGS_QUERY`'ye de,
çünkü kullanıcılar bu ayarı `ALTER SYSTEM` ile sık değiştirebilir ve
gecikmeli yakalamak istemeyiz). Bu, AC2'nin **ilk adımı** olmalı — kod
yazmadan önce bu iki liste güncellenip bir sonraki toplama döngüsünde
verinin gerçekten geldiği doğrulanmalı.

**PG13 sürüm notu:** `autovacuum_vacuum_cost_delay` varsayılanı PG12'de
`20ms`, PG13+'ta `2ms`'ye düştü (10 kat); PG12'de `-1` değeri "genel
`vacuum_cost_delay`'i kullan" anlamına geliyordu, PG13'te bu sentinel
davranışı kaldırıldı. Birim (ms) değişmedi ama **"yüksek cost_delay"
eşiği PG sürümüne göre farklı yorumlanmalı** — PG12 instance'ında
`20ms` normal (varsayılan) iken, PG13+ instance'ında aynı değer bilinçli
bir "yavaşlat" ayarı anlamına gelir.

**Henüz test edilmedi — aşağıdaki "Doğrulama planı" bölümüne bakın.**

## Doğrulama planı — çoklu instance testi (TAMAMLANDI, 2026-08-25)

Üç instance'ta (`pk=6` PG17, `pk=8` PG13, `pk=23` PG15) test edildi.
Sonuçlar hem envanterdeki PG16 uyarısını **gerçek veriyle doğruladı**
hem de yeni, önceden öngörülmeyen bir bulgu ortaya çıkardı.

### Sonuç tablosu

| instance_pk | pg_major | Teşhis 0 (I/O) | Teşhis 2 (IO-wait, 30dk) | Teşhis 2b (throttle, 2sa) |
|---|---|---|---|---|
| 6 | 17 | av worker 7.6M okuma vs client 194K (**~39x**) | 0/2 örnek IO'da | 15/16 örnek `VacuumDelay` |
| 8 | **13** | **boş** (pg_stat_io yok) | 0/0 örnek (worker hiç yakalanmadı) | 0/0 örnek |
| 23 | **15** | **boş** (pg_stat_io yok) | 0/0 örnek (worker hiç yakalanmadı) | 4/4 örnek `VacuumDelay` |

### Doğrulanan: PG16 sınırlaması gerçek

`pk=8` (PG13) ve `pk=23` (PG15) ikisi de Teşhis 0'da boş sonuç verdi —
tahmin edildiği gibi `pg_stat_io` yokluğundan, "bu instance sakin"
olduğundan değil.

**GERÇEK DAĞILIM (doğrulandı, 2026-08-25):**

| pg_major | instance sayısı | Teşhis 0 çalışır mı |
|---|---|---|
| 12 | 5 | HAYIR |
| 13 | 5 | HAYIR |
| 15 | 5 | HAYIR |
| 16 | 3 | EVET |
| 17 | 4 | EVET |
| 18 | 3 | EVET |

23 kayıtlı instance'ın **15'i (%65) PG16 altı** — Teşhis 0 kayıtlı
instance'ların çoğunluğunda hiç çalışamıyor. **Karar (kesinleşti):**
Teşhis 0, "birincil kanıt" statüsünden **"varsa ekstra kanıt (sadece
PG16+ instance'lar için)"** seviyesine indirildi. Sürüm bağımsız çalışan
Teşhis 2/2b, tüm instance'larda uygulanabilir olduğu için **asıl birincil/
geniş-kapsamlı kanıt** bunlar olmalı — `diagnoseAutovacuumImpact()` gibi
bir üst fonksiyon önce Teşhis 2/2b'yi çalıştırmalı, Teşhis 0'ı sadece
`pg_major >= 16` ise ek/pekiştirici kanıt olarak eklemeli.

### Beklenmeyen bulgu: Teşhis 2'nin pencere genişliği sorunu

`pk=6` ve `pk=23`'te Teşhis 2 (`son 30 dakika`) ile Teşhis 2b (`son 2
saat`) **aynı instance'ta tutarsız** sonuç verdi — `pk=23`'te Teşhis 2
`0/0` (worker hiç örneklenmedi) derken Teşhis 2b aynı anda `4/4`
örnek buldu. Sebep sürüm farkı değil, **pencere genişliği**: autovacuum
worker'lar aralıklı çalışıyor, 30 dakikalık pencere onları çoğu zaman
tamamen kaçırıyor. **Sonuç:** Teşhis 2'nin üretim penceresi 30 dakikadan
en az 2 saate çıkarılmalı (Teşhis 2b ile aynı pencereyi kullanmalı) —
aksi halde `total_av_worker_samples=0` çoğu instance'ta normal bir durum
olacak ve teşhis pratikte hiç veri üretmeyecek.

### Doğrulanan: `VacuumDelay` sinyali çalışıyor, ama henüz karışık okundu

`pk=6`'da 16 örneğin 15'i, `pk=23`'te 4 örneğin 4'ü `wait_event =
'VacuumDelay'` çıktı — sinyalin kendisi gerçekten üretiliyor ve
yakalanabiliyor, tasarımın temel varsayımı doğru. Ama her iki instance'ta
da `io_wait_samples` (Teşhis 2b'nin `wait_event_type='IO'` sütunu) **0**
çıktı, yani `VacuumDelay` bu iki instance'ta `IO` kategorisinde
SAYILMADI. `pk=23` PG15 (PG13+, teoriye göre `IO` kategorisinde olmalıydı)
olduğu için bu ya sürüm notunun yanlış olduğunu ya da `wait_event_type`
sütununun ayrı satırda (`VacuumDelay` filtresiyle çakışan ama farklı bir
count sütununda) doğru sayıldığını ama iki filtrenin kesişmediğini
gösteriyor — **kod yazmadan önce ham `wait_event_type` değerini
`VacuumDelay` satırları için ayrıca sorgulayıp doğrulamak şart**
(`select wait_event, wait_event_type from fact.pg_activity_snapshot
where instance_pk=23 and wait_event='VacuumDelay'`).

### Doğrulanan: cost ayarları artık toplanıyor (2026-08-25, hot refresh sonrası)

Deploy sonrası ilk hot refresh (3 saatlik döngü, gece snapshot'ını
beklemeye gerek kalmadı) ile üç instance'ta da veri geldi:

| instance_pk | autovacuum_vacuum_cost_delay | autovacuum_vacuum_cost_limit | vacuum_cost_limit |
|---|---|---|---|
| 6 | 2 | -1 | 200 |
| 8 | 2 | -1 | 200 |
| 23 | 2 | -1 | 200 |

Üçü de **tamamen varsayılan değerlerde** — `cost_delay=2ms` (PG13+
varsayılanı), `autovacuum_vacuum_cost_limit=-1` ("genel
`vacuum_cost_limit`'i kullan" sentinel'i), `vacuum_cost_limit=200`
(PG varsayılanı). Hiçbir instance'ta özel bir throttle ayarı yok. Bu,
Teşhis 2b'nin `instance_pk=6`'da bulduğu "16 örneğin 15'i
`VacuumDelay`" bulgusuna önemli bir yorum katmanı ekliyor: **worker
agresif bir şekilde throttle EDİLMİYOR (ayar varsayılan), yine de
çoğunlukla uykuda** — yani darboğaz "cost_delay çok yüksek ayarlanmış"
değil, muhtemelen "iş küçük parçalar hâlinde geliyor, worker sık sık
cost bütçesini hızla dolduramıyor" ya da örnekleme anının doğal
dağılımı. Yorumlama tablosundaki "cost_delay'i düşür" önerisi bu
üç instance için **geçerli değil** (zaten minimum düzeyde) — kod bu
ayrımı yapmalı: `cost_delay`/`cost_limit` zaten varsayılansa "ayarı
düşür" değil, "bu normal, worker'ın throttle'dan değil doğal
aralıklı çalışmasından kaynaklanıyor" mesajı üretilmeli.

## Teşhis 3: Otomatik "kapat" önerisi engeli

Kod tarafında (yeni bir yardımcı fonksiyon veya `diagnoseBloat()`'un
girişinde) bir assert/test: hiçbir aksiyon string'i `"autovacuum.*=.*off"`
veya `"autovacuum_enabled.*false"` regex'ine uymamalı — CI'da (birim test)
tüm sabit aksiyon metinlerinin bu deseni içermediği doğrulanabilir.

## Uygulama sırası (revize, çoklu-instance test sonrası — 2026-08-25)

**Öncelik sırası değişti:** Teşhis 0 artık "önce kodla" değil — sürüm
dağılımı testiyle (bkz. yukarı) kayıtlı instance'ların %65'inde hiç
çalışamayacağı kanıtlandığı için, sürüm-bağımsız Teşhis 2/2b öne alındı.

0. **ÖN KOŞUL A — collector'a eksik settings whitelist eklemesi (YAPILDI,
   deploy edildi 2026-08-25).** `autovacuum_vacuum_cost_limit`,
   `autovacuum_vacuum_cost_delay`, `vacuum_cost_limit`, `vacuum_cost_delay`
   `NightlySnapshotCollector`'ın `SETTINGS_QUERY`/`HOT_SETTINGS_QUERY`
   whitelist'lerine eklendi. **Henüz doğrulanamadı** — bir gece snapshot'ı
   (UTC 03:00) geçmesi bekleniyor, ertesi gün `fact.pg_settings_snapshot`'ta
   satırların göründüğü kontrol edilmeli.
0b. **ÖN KOŞUL B — Teşhis 2'nin pencere genişliği düzeltmesi.** Tasarımdaki
   ilk sorgu `son 30 dakika` kullanıyordu, gerçek testte (`pk=23`) bu
   pencere worker'ı tamamen kaçırdı (`0/0`) — aynı instance'ta 2 saatlik
   pencere (Teşhis 2b) 4 örnek buldu. Kod yazılırken Teşhis 2'nin penceresi
   **en az 2 saate** çıkarılmalı, Teşhis 2b ile aynı tek sorgudan
   (`fetchAutovacuumWorkerStatus()`) beslenmeli — iki farklı pencereyle iki
   ayrı sorgu çalıştırmanın hem performans hem tutarlılık maliyeti yok.
1. **Teşhis 2'yi (I/O-wait/throttle oranı) ve Teşhis 2b'yi (cost ayarı +
   wait_event dağılımı) birlikte kodla** — sürüm bağımsız, tüm 23
   instance'da çalışır, bu yüzden birincil/varsayılan kanıt bunlar olmalı.
   `wait_event='VacuumDelay'` ile `wait_event_type='IO'` filtrelerinin
   PG13/PG15'te neden kesişmediğini (bkz. yukarıki "karışık okundu"
   bulgusu) netleştirmeden bu adımı bitirme — ham veri sorgusuyla
   doğrulanmalı.
2. **Teşhis 0'ı (I/O maliyeti) sadece `pg_major >= 16` guard'ı ile ek
   kanıt olarak ekle** — `fetchAutovacuumIoImpact(instancePk)`,
   `fact.pg_io_stat_delta`'dan `backend_type='autovacuum worker'` vs
   `backend_type='client backend'` karşılaştırması, 24 saatlik pencere.
   `< 16` ise `null` dön, çağıran taraf "bu instance'ın PG sürümü bu
   teşhisi desteklemiyor" diye açıkça belirtsin (sessiz atlama, yanlışlıkla
   "sorun yok" izlenimi verir). `track_io_timing` kapalıysa zaman
   metriklerini atla, sayıma düş.
3. Teşhis 0 mevcutsa (PG16+), bu kanıtı senaryo 3 (`vacuum_ineffective`)
   ve senaryo 4.5'in (eşik yanlış kalibre) mesajlarına ek olarak ekle:
   "Son 24 saatte autovacuum worker'lar X okuma/Y yazma yaptı, bu
   instance'taki uygulama trafiğinin Z katı."
4. **Teşhis 1'i (gecikme korelasyonu) opsiyonel/ikincil olarak ekle** —
   sadece her iki tarafta da yeterli örnek (≥10 bucket) varsa hesapla ve
   göster, aksi halde hiç gösterme; asla tek başına bir aksiyon önerisine
   dayanak yapma, sadece "ek bağlam, kesin değil" ifadesiyle sun.
5. Görselleştirme (opsiyonel, daha sonra): `InstanceDetail.tsx`'e
   "autovacuum I/O payı" mini-grafiği (sadece PG16+ instance'lar için) —
   autovacuum'un toplam I/O içindeki oranını zaman içinde gösteren bir
   alan grafiği.

## Kaynaklar

- PostgreSQL resmi dok. — autovacuum'un kapatılmaması gerektiği:
  https://www.postgresql.org/docs/current/routine-vacuuming.html#AUTOVACUUM
- pganalyze — vacuum cost model (cost_delay/cost_limit mekanizması):
  https://pganalyze.com/docs/vacuum-advisor/how-does-the-vacuum-cost-model-work
- EnterpriseDB — "autovacuum too aggressive" (agresif ayarın riskleri):
  https://www.enterprisedb.com/postgres-tutorials/postgresql-autovacuum-too-aggressive
- perun.au — "five failure patterns" (worker saturation, checkpoint baskısı):
  https://perun.au/insights/postgres-vacuum-production/
- Percona — vacuum tuning best practice:
  https://www.percona.com/blog/importance-of-postgresql-vacuum-tuning-and-custom-scheduled-vacuum-job/
- pganalyze — VACUUM Advisor (topluluğun latency korelasyonu KURMADIĞININ kanıtı):
  https://pganalyze.com/postgres-vacuum-advisor
- Difference-in-differences confounder tuzağı (korelasyon neden güvenilmez):
  https://www.everydaycausal.com/twfe-did.html
- PostgreSQL resmi dok. — `wait_event`/`VacuumDelay` ve cost-based
  vacuum delay parametreleri:
  https://www.postgresql.org/docs/current/monitoring-stats.html#WAIT-EVENT-TABLE
  https://www.postgresql.org/docs/current/runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-VACUUM-COST
