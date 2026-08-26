# Autovacuum Sistem Maliyeti Teşhisi — Tasarım Dokümanı

**Durum:** PGSTAT-P1-011 — tasarım aşaması, 2026-08-26. Henüz kodlanmadı
(AC2 bekliyor). Bu doküman dört inceleme turundan geçti (canlı testler,
üç bağımsız dış inceleme — resmi PostgreSQL dokümanları defalarca
çekilip doğrulandı). Önceki sürümler her düzeltmeyi eski metnin yanına
yeni bir not olarak ekliyordu, bu da çelişkili katmanlar yarattı. **Bu
sürüm tekrar sıfırdan konsolide edildi** — yanlış/eski metin silindi,
her konu için tek, güncel, doğru bir açıklama bırakıldı.

**Açık tasarım kararı KALMADI.** Bir önceki sürüm "iki açık madde"
diyordu; her ikisi de aslında açık karar değildi:

- **Timestamp tipi** bir tasarım kararı değil, bir **implementasyon
  test gereksinimi**: karar zaten net (kod hem `OffsetDateTime` hem
  `java.sql.Timestamp` değerini güvenli normalize edecek), sadece
  hangisinin geldiği runtime'da test edilerek doğrulanacak.
- **AC3 hedef instance seçimi** bir tasarım kararı değil, bir
  **doğrulama prosedürü**: hedefler AC3 çalıştırılırken güncel
  `control.instance_capability` sorgusuyla seçilecek (bir instance
  zaten görev sırasında PG15'ten PG17'ye yükseltildi, sabit liste
  bayatlar).

Yani AC2'ye geçiş için bekleyen bir tasarım sorusu yok; kalan iş
implementasyon ve doğrulama.

**Terminoloji notu:** Bu dokümanda ve `AlertRuleEvaluator`'da "bloat"
kelimesi `n_dead_tup`/`n_live_tup` **tahminine** dayanır —
`pg_stat_user_tables`'ın istatistiksel bir tahminidir, fiziksel disk
alanı israfının (gerçek bloat, `pgstattuple` gibi bir extension'la
ölçülür) doğrudan eşdeğeri değildir. Mevcut kod tabanında "bloat"
terimi zaten yaygın kullanıldığı için (`findBloatedTables()`,
`diagnoseBloat()`) burada tutarlılık adına korunuyor.

**Amaç:** Kullanıcının sorusu — "autovacuum kapatılmalı mı, sık çalışıp
diğer sorguları yavaşlatıyor mu, yoksa yetişemiyor mu — bunu en doğru
ve somut kanıtlı şekilde nasıl tespit ederiz?" Bu doküman dört ayrı
teşhis sinyalini, her biri için somut SQL/veri kanıtıyla tanımlıyor.

## Önce netleştirme: "autovacuum kapatılmalı mı?"

**Bu soruya sistemin cevabı her zaman HAYIR olmalı.** PostgreSQL resmi
dokümantasyonu ve her ciddi kaynak (Citus, pganalyze, Percona)
autovacuum'un kapatılmasının doğru çözüm olmadığını açıkça belirtir —
kapatmak dead tuple birikimini durdurmaz, sadece MVCC/transaction ID
wraparound riskini artırır. Sistem hiçbir zaman "autovacuum'u kapat"
önermemeli, sadece "ayarını değiştir" (scale_factor/threshold/
cost_delay/max_workers) önerebilir. Bu bir kod guard'ı olarak ele
alınmalı — hiçbir aksiyon metni `autovacuum = off` veya
`autovacuum_enabled = false` önermemeli, CI'da bir birim test tüm
sabit aksiyon metinlerinin `"autovacuum.*=.*off"` veya
`"autovacuum_enabled.*false"` deseniyle eşleşmediğini doğrulamalı.

## Veri kaynakları

| Sinyal | Tablo | Kolon(lar) |
|---|---|---|
| Autovacuum worker örnekleri | `fact.pg_activity_snapshot` | `backend_type='autovacuum worker'`, `snapshot_ts`, `pid` |
| Worker'ın ne için beklediği | `fact.pg_activity_snapshot` | `wait_event_type`, `wait_event` |
| Autovacuum'un doğrudan I/O işlem sayısı | `fact.pg_io_stat_delta` | `backend_type='autovacuum worker'`, `object`, `reads_delta`, `writes_delta`, `read_time_ms_delta`, `write_time_ms_delta` (PG16+ only) |
| Instance-geneli sorgu gecikmesi (opsiyonel/ikincil) | `fact.pgss_delta` | `mean_exec_time_ms`, `calls_delta`, `total_exec_time_ms_delta` |
| Cost ayarları (instance-geneli) | `fact.pg_settings_snapshot` | `autovacuum_vacuum_cost_limit`, `autovacuum_vacuum_cost_delay`, `vacuum_cost_limit`, `vacuum_cost_delay` |
| Cost ayarları (tablo override) | `control.table_relopts_snapshot` | `reloptions_raw` (ham metin, henüz ayrıştırılmamış — bkz. Kod önkoşulları) |
| Worker slot kapasitesi (PG18+) | `fact.pg_settings_snapshot` | `autovacuum_worker_slots` — henüz toplanmıyor, bkz. Kod önkoşulları |

**Sınırlama — tablo ilişkilendirmesi yok:** `fact.pgss_delta`'da
`queryid` var ama hangi tabloyu hedeflediği yok (`dim.statement_series`
sadece `dbid`/`userid` taşır, `relid` yok). `fact.pg_activity_snapshot`
de (Teşhis 2/2b'nin kaynağı) cluster genelinde `backend_type`
filtreleniyor, hangi worker'ın hangi tabloyu vacuum ettiği bu
sorgularda yok — bu bilgi `fact.pg_progress_vacuum_snapshot.relid`'de
var ama şu an `pid` üzerinden eşleştirilmiyor (gelecekteki bir
iyileştirme, bu görevin kapsamı dışında). Sonuç: bu doküman
"cluster genelinde autovacuum ne kadar throttle'lı/I/O bekliyor"
sorusuna cevap veriyor, "BU tablonun vacuum'u ne kadar throttle'lı"
sorusuna değil.

**Alternatif kök nedenler — bu teşhisler bunları AYIRT ETMEZ:** Yüksek
dead-tuple oranı veya yüksek autovacuum aktivitesi şu nedenlerden
herhangi birinden kaynaklanabilir; alert metni "kesin neden X" değil
"gözlemlenen kanıt Y" dili kullanmalı:
- Worker doygunluğu (`autovacuum_max_workers` yetersiz; PG18'de ayrıca
  `autovacuum_worker_slots` etkin kapasiteyi sınırlayabilir — bkz.
  "PG18: worker slot kapasitesi" bölümü)
- Uzun süren transaction/prepared transaction (xmin horizon ilerlemiyor)
- Pasif/unutulmuş replication slot (aynı xmin horizon etkisi)
- Wraparound/freeze baskısı (agresif vacuum bilinçli tetiklenmiş olabilir)
- Lock/BufferPin/LWLock bekleme (worker `IO` veya `VacuumDelay` değil,
  başka bir wait kategorisinde bekliyor olabilir — bkz. Teşhis 2b'deki
  "dört kova" notu)
- Tablo/TOAST'a özel `reloptions` override'ı

## Neden gecikme korelasyonu birincil kanıt DEĞİL (Teşhis 1, opsiyonel)

İlk tasarımda "autovacuum aktifken sorgu gecikmesi artıyor mu"
sorusunu bir pencere karşılaştırmasıyla (autovacuum aktif/pasif
dilimlerde `fact.pgss_delta.mean_exec_time_ms` kıyaslaması) cevaplamak
birincil kanıt olarak planlanmıştı. İki gerçek instance'ta elle test
edildi:

- `instance_pk=8`: autovacuum aktifken ortalama sorgu süresi %5.6 daha
  yüksek (`1.307ms` vs `1.238ms`) — eşik altı, anlamsız.
- `instance_pk=23`: autovacuum aktifken ortalama sorgu süresi **daha
  DÜŞÜK** çıktı (`0.072ms` vs `0.101ms`, -%29) — ters yönde bir sonuç,
  örnek sayısı küçüktü (4 bucket).

Bu, difference-in-differences literatüründeki klasik confounder
tuzağı (sistem zaten sakin olduğu zamanlarda autovacuum tetikleniyor
olabilir). pganalyze'ın kendi VACUUM Advisor'ının da autovacuum'u
query latency ile doğrudan korelasyona sokmadığı doğrulandı.

**Karar:** Gecikme korelasyonu (Teşhis 1) birincil kanıt DEĞİL — sadece
opsiyonel, düşük güvenilirlikli bir ikincil bağlam notu, hiçbir zaman
tek başına bir aksiyon önerisine dayanak yapılmaz.

**Yeterlilik kapısı (Teşhis 1'e özel — Teşhis 2/2b'nin `distinct
snapshot_ts` kapısından FARKLI):** Autovacuum aktif ve pasif tarafların
her ikisinde de **en az 10 farklı 5 dakikalık bucket** olmalı (yukarıdaki
sorgudaki `num_buckets`), `distinct snapshot_ts` değil — çünkü burada
karşılaştırılan birim zaman pencereleri (bucket), tekil toplama anları
değil. 10'un altında bucket varsa hiç gösterilmemeli.

```sql
with av_windows as (
  select distinct date_trunc('minute', snapshot_ts) -
         (extract(minute from snapshot_ts)::int % 5) * interval '1 minute' as bucket
  from fact.pg_activity_snapshot
  where instance_pk = ? and backend_type = 'autovacuum worker'
    and snapshot_ts > now() - interval '2 hours'
),
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
  sum(d.calls_delta) as total_calls,
  count(distinct w.bucket) as num_buckets
from all_windows w
left join av_windows aw on aw.bucket = w.bucket
join fact.pgss_delta d on date_trunc('minute', d.sample_ts) -
       (extract(minute from d.sample_ts)::int % 5) * interval '1 minute' = w.bucket
join dim.statement_series ss on ss.statement_series_id = d.statement_series_id and ss.instance_pk = ?
group by 1
order by 1;
```

## Teşhis 0: Autovacuum'un doğrudan I/O işlem sayısı (PG16+ bonus kanıt)

**Statü: BONUS kanıt, PG16+ ile sınırlı — birincil kanıt DEĞİL.**
Kayıtlı 25 instance'ın 15'i (%60) PG16'nın altında (bkz. "PG sürüm
dağılımı" bölümü) — bu teşhis, filodaki instance'ların çoğunda hiç
çalışamıyor. Birincil/geniş-kapsamlı kanıt Teşhis 2 ve 2b'dir (aşağıda).

Sorgu, sadece toplamları değil **durum kararını verebilmek için gereken
meta bilgiyi de** döndürmeli — aksi hâlde "sıfır" ile "veri yok"
ayrımı koddan yapılamaz:

```sql
select backend_type,
       sum(reads_delta)                                as total_reads,
       sum(writes_delta)                               as total_writes,
       sum(read_time_ms_delta)                         as total_read_time_ms,
       sum(write_time_ms_delta)                        as total_write_time_ms,
       count(*)                                        as source_row_count,
       count(*) filter (where reads_delta is not null) as reads_metric_valid_count,
       count(*) filter (where writes_delta is not null) as writes_metric_valid_count,
       max(sample_ts)                                  as latest_sample_ts
from fact.pg_io_stat_delta
where instance_pk = ? and object = 'relation'
  and sample_ts > now() - interval '24 hours'
group by backend_type
order by total_reads desc nulls last;
```

- `source_row_count` — bu pencerede hiç fact satırı var mı? **`NO_FRESH_DATA`
  kararı bu sayıya dayanmalı, sayaç değerine değil.**
- `*_metric_valid_count` — kaç satırda ilgili sayaç gerçekten `NOT NULL`?
  (Kod önkoşulu 9 düzeltilmeden bu her zaman `source_row_count`'a eşit
  çıkar, çünkü NULL'lar `0.0`'a çevriliyor — düzeltme sonrası anlamlı olur.)
- `latest_sample_ts` — en son satır ne kadar taze? Tazelik eşiği
  collector'ın cluster cycle cadence'ine göre hesaplanmalı (bkz.
  "Tazelik eşikleri" bölümü), sabit bir sayı değil.

`object = 'relation'` filtresi zorunlu — `pg_stat_io` ayrıca `object IN
('temp relation')` gibi başka kategoriler de içerir, filtresiz sorgu
autovacuum'un tablo/index I/O'sunu diğer kategorilerle karıştırabilir.
**Bu sorgu `object='relation'` filtresiyle henüz canlı olarak yeniden
çalıştırılmadı** — aşağıdaki tablo, filtre eklenmeden önceki (2026-08-25)
bir testin sonucu; sayılar muhtemelen değişmez (autovacuum zaten
öncelikle `relation` nesnelerinde çalışır) ama bu, AC2/AC3'te filtreli
sorguyla yeniden doğrulanmadan "kanıtlanmış" sayılmamalı.

**Önceki testten (`instance_pk=6`, PG17, 24 saatlik pencere, filtresiz sorgu):**

| backend_type | total_reads | total_writes | total_read_time_ms | total_write_time_ms |
|---|---|---|---|---|
| autovacuum worker | 5,119,503 | 4,203,112 | 0.0 | 0.0 |
| client backend | 172,332 | 6,245,526 | 0.0 | 0.0 |
| checkpointer | 0 | 2,499,669 | 0.0 | 0.0 |
| background writer | 0 | 3,454,920 | 0.0 | 0.0 |

**Kapsam ve dil sınırlamaları (kesin, implementasyonda uygulanmalı):**

- `reads_delta`/`writes_delta` **byte veya gerçek disk IOPS değil** —
  `pg_stat_io`'nun saydığı **sayfa işlemi sayısıdır**. Doğru ifade:
  "autovacuum worker'lar son 24 saatte X okuma/Y yazma işlemi yaptı,
  bu N kat client backend'den fazla" — "sisteme X maliyeti oldu" gibi
  bir maliyet iddiası kurulmamalı. Bu yüzden bu teşhisin başlığı
  bilerek "I/O maliyeti" değil "I/O işlem sayısı" — "cost" kelimesi
  kod/mesaj tarafında kullanılmamalı.
  - **Nüans:** `pg_stat_io`'da PG16/17'de `op_bytes` sütunu, PG18'de
    ise doğrudan byte sayaçları (`read_bytes`/`write_bytes`/
    `extend_bytes`) mevcut ve pgstat'ın kendisi bunları zaten
    `ClusterCollector.java` içinde topluyor (satır 408-410). Yani
    "PostgreSQL'e istek edilen I/O hacmi" (kaç byte okuma/yazma talep
    edildiği) teknik olarak türetilebilir. Ama bu HÂLÂ **gerçek disk
    throughput/IOPS değildir** — OS sayfa cache'i, dosya sistemi
    tamponlaması gibi katmanlar arada olduğu için "PostgreSQL'in talep
    ettiği I/O hacmi" ile "diskin gerçekte gördüğü yük" aynı şey
    değildir. Bu doküman kapsamında (Teşhis 0) bilinçli olarak sadece
    **işlem sayısı** kullanılıyor — byte-hacmi metriği eklemek ayrı bir
    scope kararı gerektirir (bkz. "Scope kararı: byte-hacmi metriği"
    bölümü).
- Bu sayaç sadece worker'ın **kendi** işlemidir — checkpointer'ın
  sonradan aynı kirli sayfaları diske yazması (checkpoint I/O) ayrı bir
  `backend_type` satırında görünür, worker'a atfedilmez.
- `total_read_time_ms`/`total_write_time_ms` `track_io_timing` kapalı
  instance'larda her zaman `0.0` çıkar (PostgreSQL'de varsayılan
  kapalıdır) — teşhis mantığı sadece `reads_delta`/`writes_delta`
  (sayım) üzerine kurulmalı, zaman metriklerini varsa ek bilgi olarak
  kullanmalı, zorunlu tutmamalı.
- **`client backend` okuma sayısı 0 ise oran hesaplanmamalı** (sıfıra
  bölme/sonsuz oran riski) — bu durumda "client backend hiç okuma
  yapmadı, autovacuum X okuma yaptı" şeklinde mutlak sayı raporlanmalı,
  oran üretilmemeli.
**Diagnosis 0 durum modeli (kesin, sırayla değerlendirilir — ilk eşleşen
kazanır):**

| # | Durum | Koşul | Anlamı / mesaj |
|---|---|---|---|
| 1 | `UNKNOWN_CAPABILITY` | `control.instance_capability` satırı yok, `pg_major` null, VEYA capability kaydı bayat (bkz. tazelik) | "Bu instance'ın sürüm bilgisi henüz bilinmiyor" — `UNSUPPORTED` ile aynı şey DEĞİL |
| 2 | `UNSUPPORTED` | `pg_major < 16` VEYA `instance_capability.has_pg_stat_io = false` | "Bu PG sürümü bu kanıtı desteklemiyor" — sorgu hiç çalıştırılmaz |
| 3 | `INSTANCE_UNREACHABLE` | `instance_capability.is_reachable = false` | "Instance'a ulaşılamıyor, veri güncel olmayabilir" — eski veriyi güncelmiş gibi sunma |
| 4 | `NO_FRESH_DATA` | `source_row_count = 0` VEYA `latest_sample_ts` tazelik eşiğinin dışında | "Bu pencerede taze fact verisi yok" — collector yeni başlamış, cycle atlamış veya durmuş olabilir. **"Autovacuum çalışmadı" DEĞİL.** |
| 5 | `ZERO_IO_WITH_FRESH_DATA` | Taze satır var, ama `autovacuum worker` için toplam read+write = 0 | "Bu pencerede sayılan `relation` okuma/yazma işlemi yok" — bu da **"autovacuum hiç çalışmadı" demek DEĞİL**: worker çalışmış ama tüm sayfaları shared buffers'ta bulmuş (hit), ya da sadece `temp relation` gibi filtrelenen bir `object` üzerinde çalışmış olabilir |
| 6 | `AVAILABLE` | Yukarıdakilerin hiçbiri | Sayılar mevcut ve yorumlanabilir |

Durum adı bilerek `ZERO_WITH_FRESH_DATA` değil **`ZERO_IO_WITH_FRESH_DATA`**
— "sıfır" olan şey autovacuum aktivitesi değil, sadece bu filtreyle
(`object='relation'`, bu zaman penceresi) sayılan I/O işlemi.

**`NO_FRESH_DATA` kararı sayaç değerine değil, `source_row_count`'a
dayanmalı.** `ClusterCollector`'ın NULL→0 dönüşümü (Kod önkoşulu 9)
fact satırını ortadan kaldırmaz — sadece o satırdaki metriğin "N/A"
bilgisini sıfıra çevirir. Yani "sayaç 0 geldi" ile "hiç satır yok"
tamamen farklı iki durumdur; birincisi bir ölçüm, ikincisi ölçümün
yokluğudur.

## Teşhis 2: I/O bekleme oranı (birincil, her PG sürümünde)

Worker örneklemelerinin ne kadarında **bir I/O işleminin tamamlanmasının
beklendiğini** sayar. (Bilerek "gerçek disk I/O'sunda bekleme" denmiyor —
PostgreSQL bu wait event için sadece "bir I/O tamamlanması bekleniyor"
garantisi verir; bekleme OS sayfa cache'inden, dosya sistemi katmanından
veya gerçek diskten kaynaklanabilir, bu view ayırt etmez.) Sürüm
bağımsız — tüm 25 kayıtlı instance'ta çalışır.

```sql
select
  count(*) filter (where wait_event_type = 'IO') as io_wait_samples,
  count(*) as total_samples,
  count(distinct snapshot_ts) as distinct_snapshots
from fact.pg_activity_snapshot
where instance_pk = ? and backend_type = 'autovacuum worker'
  and snapshot_ts > now() - interval '2 hours';
```

**Pencere genişliği:** 30 dakikalık bir ilk tasarım denemesi, gerçek
testte (`instance_pk=23`) worker'ı tamamen kaçırdı (`0/0` örnek) —
autovacuum worker'lar aralıklı çalışır. Pencere **en az 2 saat**
olmalı, aynı sorgudan Teşhis 2b ile birlikte beslenmeli (ayrı bir
round-trip gerektirmez).

**`wait_event_type = 'IO'`, worker'ın gerçek fiziksel disk/donanım
gecikmesi yaşadığının kanıtı DEĞİLDİR — sadece bir I/O isteğinin
tamamlanmasının beklendiğinin kanıtıdır.** PostgreSQL'in resmi
dokümantasyonu bu wait event kategorisini "bir I/O işleminin
tamamlanmasını bekliyor" olarak tanımlar — bu bekleme OS sayfa cache'i
gecikmesinden, dosya sistemi kilidinden veya gerçek disk donanımından
kaynaklanabilir, `wait_event_type='IO'` bunların hangisi olduğunu
ayırt etmez. Mesaj metninde "diskin yavaş olduğu" gibi donanım-özel
bir iddia kurulmamalı — sadece "worker I/O tamamlanmasını bekliyor
gözlemlendi" denmeli.

**Kritik: yüksek `io_wait_samples` oranı, `cost_delay`'in yüksek
ayarlandığının KANITI DEĞİLDİR.** `wait_event_type = 'IO'` ile
`wait_event = 'VacuumDelay'` (Teşhis 2b, kasıtlı throttle uykusu)
**bağımsız sinyallerdir** — biri I/O tamamlanmasını bekler, diğeri
konfigürasyondan kaynaklanan kasıtlı bir uykudur. Yüksek I/O-wait
oranı, `cost_delay` ayarı ne olursa olsun gerçekleşebilir.
`"cost_delay'i düşür"` aksiyonu SADECE Teşhis 2b'nin kanıtına
dayanmalı, Teşhis 2 tek başına bu aksiyona gerekçe olmamalı — sadece
"worker I/O tamamlanmasını ne kadar bekliyor" bağlamını verir.

## Teşhis 2b: Throttle-sleep oranı (birincil, PG13+)

**Statü: PG13+ ile sınırlı.** `wait_event = 'VacuumDelay'` **PG13'te
eklendi ve PostgreSQL'in resmi wait-event tablosunda o günden bu yana
her zaman `wait_event_type = 'Timeout'` kategorisindedir** (PostgreSQL
13 dokümantasyonu doğrudan çekilip doğrulandı: *"VacuumDelay — Waiting
in a cost-based vacuum delay point"*, `Timeout` tablosunda listeleniyor).
Bu iki bilgi birbirinden bağımsız: (a) sinyalin kendisi PG13 öncesinde
hiç yok, (b) var olduğu her sürümde kategorisi hep `Timeout`, hiçbir
zaman `IO` olmadı. "Her PG sürümünde `Timeout`" demek yerine doğru
ifade: **"var olduğu sürümlerde (PG13+) her zaman `Timeout`"** — PG13
öncesi sürümler için bu kategori sorusu anlamsız, çünkü sinyal hiç yok.

PG12 instance'larında (kayıtlı 25'in 5'i) bu teşhis `UNSUPPORTED`
dönmeli, sessizce `0` göstermemeli — "throttle yok" ile "bu sürümde
sinyal yok" birbirine karıştırılmamalı.

```sql
-- Worker orneklerinin wait_event dagilimi
select
  count(*) filter (where wait_event = 'VacuumDelay') as throttle_sleep_samples,
  count(*) filter (where wait_event_type = 'IO') as io_wait_samples,
  count(*) filter (where wait_event is null) as no_wait_event_samples,
  count(*) as total_samples,
  count(distinct snapshot_ts) as distinct_snapshots
from fact.pg_activity_snapshot
where instance_pk = ? and backend_type = 'autovacuum worker'
  and snapshot_ts > now() - interval '2 hours';

-- Ayni instance'in EN GUNCEL etkin cost ayarlari (latest-per-setting + freshness)
select distinct on (setting_name)
       setting_name, setting_value, snapshot_ts
from fact.pg_settings_snapshot
where instance_pk = ?
  and setting_name in ('autovacuum_vacuum_cost_limit', 'autovacuum_vacuum_cost_delay',
                        'vacuum_cost_limit', 'vacuum_cost_delay', 'autovacuum_max_workers',
                        'autovacuum_worker_slots')
order by setting_name, snapshot_ts desc;
```

**Settings sorgusu `DISTINCT ON` + `ORDER BY snapshot_ts DESC`
kullanmak ZORUNDA — ilk taslakta bu eksikti.** `fact.pg_settings_snapshot`
partition'lı bir zaman serisi tablosu, her toplama döngüsünde yeni
satır ekleniyor — bir `ORDER BY`/`LIMIT`/`DISTINCT ON` olmadan sorgu
her ayar için TÜM geçmiş satırları döndürür, sadece en son değeri
değil. Ayrıca dönen `snapshot_ts` bir **tazelik kontrolü** için
kullanılmalı — eğer en son satır makul bir eşikten (örn. son 25 saat,
hot refresh 3 saatte bir + gece snapshot'ı 24 saatte bir olduğu için)
daha eskiyse, ayar değeri "muhtemelen güncel değil" olarak
işaretlenmeli, sessizce eski bir değer kesin diye sunulmamalı.

**Üç adlandırılmış kova + bir residual = `total_samples` (tam olarak):**
Sorgu üç kovayı açıkça sayıyor — `IO` (I/O tamamlanması bekleniyor),
`VacuumDelay` (`Timeout` kategorisinde, throttle uykusu) ve
`no_wait_event` (wait event raporlanmadı). Ama worker `Lock`,
`BufferPin`, `LWLock`, `Client`, `Extension` gibi başka wait
kategorilerinde de bekleyebilir — bu üçü `total_samples`'ı tüketmez.
Kalan fark **residual** olarak açıkça taşınmalı:

```
otherWaitSamples = total_samples - io_wait_samples
                   - throttle_sleep_samples - no_wait_event_samples
```

Residual bu şekilde tanımlandığı için **dördünün toplamı tanımı gereği
her zaman `total_samples`'a eşittir** — bu bir varsayım değil, aritmetik
bir kimlik, ve bir birim testle doğrulanmalı (regresyon koruması: biri
sorguya yeni bir `filter` eklerse ya da residual hesabını unutursa test
yakalar). Önemli olan nokta `otherWaitSamples`'ın **sıfır olmayabileceği**
ve yok sayılmaması gerektiğidir — "worker zamanı ya aktif ya throttle'da"
gibi iki kutuplu bir model yanlış bir basitleştirmedir.

**Uyarı — kovalar örtüşmez ama mantıksal olarak dışlayıcı da değil:**
`wait_event = 'VacuumDelay'` her zaman `wait_event_type = 'Timeout'`
olduğu için `io_wait_samples` ile `throttle_sleep_samples` fiilen
kesişmez; yine de sorgu yazılırken bu varsayıma güvenilmemeli, üç
`filter` ifadesi birbirini dışlayacak şekilde yazılmalı (aksi hâlde
residual negatif çıkabilir — bu da test edilmeli).

**`no_wait_event_samples`, "aktif çalışıyor" DEĞİL — sadece "wait event
raporlanmadı" demektir.** `wait_event IS NULL`, PostgreSQL'in o anki
örneklemede hiçbir wait event raporlamadığı anlamına gelir; bu genelde
worker'ın CPU'da aktif çalıştığına işaret eder ama kesin kanıt değildir.

**Yüksek `throttle_sleep_samples` oranı bir "sorun" değildir — bu,
cost bütçesine ULAŞILDIĞININ göstergesidir.** PostgreSQL'in cost-based
throttling mekanizması: worker her sayfa işleminde (`vacuum_cost_page_hit`/
`vacuum_cost_page_miss`/`vacuum_cost_page_dirty` — bu üç parametre
önekisiz, hem normal `VACUUM` hem `autovacuum` için ortak, autovacuum'a
özel bir override'ı yok) puan biriktirir; toplam etkin `cost_limit`'e
ULAŞINCA etkin `cost_delay` kadar uyur. Yani `VacuumDelay`, worker
bütçeyi **dolduramadığı** için değil, tam tersine **doldurduğu** için
oluşur. `instance_pk=6` ve `instance_pk=23`'te (varsayılan cost
ayarlarıyla) bu oran yüksek gözlendi — `instance_pk=8`'de ise aynı
pencerede **worker hiç örneklenemedi** (`0/0`, sinyal yok, "düşük
throttle" değil, veri eksikliği). Üç instance'ın "hepsinde aynı
davranış gözlendi" demek yanlıştır — bu doğru bir genelleme olamayacak
kadar küçük ve tutarsız bir örneklem, sadece iki instance'ta (`6`, `23`)
gerçek gözlem var.

**Yorumlama ve aksiyon kuralı:**

| Sinyal | Aksiyon |
|---|---|
| `throttle_sleep_samples` oranı yüksek, etkin `cost_delay` == sürüm varsayılanı (`2ms` PG12+, `20ms` PG11) | Sadece gözlemi raporla: "worker örneklemelerin %N'inde throttle uykusunda gözlemlendi; cost_delay ayarı varsayılan değerde." Bir "sorun" ya da "normal" yorumu ekleme, aksiyon önerme. |
| `throttle_sleep_samples` oranı yüksek, **etkin `cost_delay` > sürüm varsayılanı** (kasıtlı yükseltilmiş) | `cost_delay`'i düşürmeyi öner — bu, `effectiveCostDelay > versionDefault` kanıtlandığında geçerli. `0ms`/`1ms` gibi varsayılandan DÜŞÜK "non-default" değerlerde bu öneri asla üretilmemeli — kapı "non-default" değil, açıkça `effectiveCostDelay > versionDefault` olmalı. |
| `io_wait_samples` oranı yüksek | Teşhis 0 (varsa, PG16+) ile birlikte bağlam olarak sun; tek başına bir aksiyona dayanak yapma (Teşhis 2 bölümüne bkz.). |

**Etkin cost ayarı çözümleme zinciri (her parametre için ayrı ayrı,
sırayla):**

`autovacuum_vacuum_cost_delay` ve `autovacuum_vacuum_cost_limit`'in her
biri için **bağımsız olarak** şu zincir uygulanır (biri tablo
override'ından, diğeri global'den gelebilir — ikisi aynı kaynaktan
gelmek zorunda değil):

```
1. Tablo override (control.table_relopts_snapshot, parse edilmiş sütun):
   - Değer var ve >= 0        -> ETKİN DEĞER budur, zincir biter.
   - Değer var ve == -1       -> adım 2'ye devam (sentinel, "global'i kullan").
   - Sütun yok / tablo satırı yok -> adım 2'ye devam.
   - Değer malformed (parse edilemedi) -> SONUÇ: UNKNOWN, zincir biter.

2. Global autovacuum_* ayarı (fact.pg_settings_snapshot, en güncel satır):
   - Değer var ve >= 0        -> ETKİN DEĞER budur, zincir biter.
   - Değer var ve == -1       -> adım 3'e devam.
   - Satır yok / bayat / malformed -> SONUÇ: UNKNOWN, zincir biter.

3. Global vacuum_* fallback (fact.pg_settings_snapshot, en güncel satır):
   - Değer var                -> ETKİN DEĞER budur.
   - Satır yok / bayat / malformed -> SONUÇ: UNKNOWN.
```

**`UNKNOWN` sonucu bir aksiyonu ASLA tetiklemez.** Zincirin herhangi bir
adımında eksik, bozuk veya bayat bir değerle karşılaşılırsa etkin değer
`UNKNOWN` olur; bu durumda "cost_delay'i düşür" önerisi **bastırılır**
(bilinmeyen bir değeri "varsayılandan yüksek" sayamayız). Mesajda
"etkin cost ayarı okunamadı" şeklinde açıkça belirtilir, sessizce
varsayılan varsayılmaz.

**`-1` sentinel davranışı** PG11'de zaten mevcuttu (resmi
`postgresql.org/docs/11/runtime-config-autovacuum.html` sayfası çekilip
doğrulandı: *"If -1 is specified, the regular `vacuum_cost_delay` value
will be used."*), hiçbir sürümde kaldırılmadı, her sürümde aynı
yorumlanır. Tek gerçek sürüm eşiği **varsayılan değerdir**: PG11'de
`20ms`, PG12'den itibaren (PG12-18) `2ms`.

## Tazelik eşikleri (sabit sayı değil, cadence tabanlı)

Hiçbir tazelik kontrolü sabit bir saat sayısına ("25 saat" gibi)
dayanmamalı — her veri kaynağının kendi toplama sıklığı farklı, ve bu
sıklık `control.schedule_profile` üzerinden instance başına
değişebilir. Doğru formül her kaynak için:

```
tazelik_eşiği = (o kaynağın cadence'i) × 2 + grace
```

| Veri kaynağı | Cadence | Not |
|---|---|---|
| `fact.pg_activity_snapshot` | cluster cycle interval (instance'ın `schedule_profile`'ından) | `runningWorkers`'ın "en güncel genel snapshot" tazelik kontrolü buna dayanır |
| `fact.pg_io_stat_delta` | cluster cycle interval (aynı) | Diagnosis 0'ın `latest_sample_ts` kontrolü |
| `fact.pg_settings_snapshot` — hot yenilenen ayarlar | 3 saat (`HOT_SETTINGS_QUERY`) | `autovacuum_vacuum_cost_delay`/`limit` bu gruptadır → eşik ≈ 6-7 saat |
| `fact.pg_settings_snapshot` — sadece gece yenilenen ayarlar | 24 saat (`SETTINGS_QUERY`) | `vacuum_cost_delay`/`vacuum_cost_limit` şu an bu gruptadır (Kod önkoşulu 7 bunları hot listeye taşıyacak) → eşik ≈ 50 saat, taşındıktan sonra ≈ 6-7 saat |
| `control.instance_capability` | discovery/bootstrap + her cluster cycle'daki sürüm kontrolü | Bayat capability → `UNKNOWN_CAPABILITY` |

`×2` çarpanı bir cycle atlanmasına tolerans tanır; `grace` (örn. 10
dakika) saat kayması ve toplama süresi için pay bırakır. Aynı ayar
farklı listelerdeyse (hot vs. nightly) **kendi listesinin cadence'i**
kullanılmalı — hepsine tek bir eşik uygulamak, hot yenilenen bir ayarın
6 saat bayat olduğunu gizler.

## PG18: worker slot kapasitesi (yeni, filoda 3 instance PG18)

PostgreSQL 18 dokümantasyonu çekilip doğrulandı: `autovacuum_worker_slots`
adında yeni bir parametre var (*"Specifies the number of backend slots
to reserve for autovacuum worker processes... default is typically 16
slots"*), ve **`autovacuum_max_workers` bu değerden yüksek ayarlanırsa
hiçbir etkisi olmaz** (*"a setting for this value which is higher than
autovacuum_worker_slots will have no effect, since autovacuum workers
are taken from the pool of slots"*). Ayrıca `autovacuum_vacuum_cost_limit`
**çalışan worker'lar arasında orantılı olarak dağıtılır** (*"the value
is distributed proportionally among the running autovacuum workers"*)
— yani worker sayısı arttıkça her worker'ın etkin cost bütçesi düşer.

**Etkilenen kısım:** Worker doygunluğu değerlendirmesi (`runningWorkers`
vs. `autovacuum_max_workers` karşılaştırması) PG18'de yanıltıcı
olabilir — gerçek etkin kapasite `min(autovacuum_max_workers,
autovacuum_worker_slots)`. `autovacuum_worker_slots` şu an hiç
toplanmıyor (ne `SETTINGS_QUERY`'de ne `HOT_SETTINGS_QUERY`'de) — bu,
"Kod önkoşulları" bölümüne yeni bir madde olarak eklendi (madde 8).

**Balancing'in KRİTİK istisnası — bu proje için doğrudan önemli:**
PostgreSQL 18 `routine-vacuuming` dokümantasyonu çekilip doğrulandı:

> *"When multiple workers are running, the autovacuum cost delay
> parameters are 'balanced' among all the running workers... **However,
> any workers processing tables whose per-table
> `autovacuum_vacuum_cost_delay` or `autovacuum_vacuum_cost_limit`
> storage parameters have been set are not considered in the balancing
> algorithm.**"*

Yani **tablo düzeyinde cost override'ı olan bir tabloyu vacuum eden
worker, balancing hesabının tamamen DIŞINDADIR** — kendi ayarıyla,
diğer worker'lardan bağımsız çalışır. Bu, bu proje için özellikle
önemli çünkü Teşhis 2b zaten `control.table_relopts_snapshot`'tan
tablo-özel override okuyor: eğer alert edilen tablonun bir cost
override'ı varsa, "cost_limit worker'lar arasında paylaştırılıyor,
o yüzden her worker'ın etkin bütçesi `cost_limit / runningWorkers`"
şeklindeki bir akıl yürütme **o tablo için geçersizdir** — o worker
paylaştırmaya dahil değildir, tam `cost_limit`'iyle çalışır. Mesaj
metni bu ayrımı yapmalı veya (daha güvenlisi) worker başına etkin
bütçe hesabı yapmaktan tamamen kaçınıp sadece gözlemlenen oranları
raporlamalı.

## PG sürüm dağılımı (Teşhis 0/2b'nin kapsamını belirler)

Kayıtlı **25** instance'ta gerçek `pg_major` dağılımı çıkarıldı:

| pg_major | instance sayısı | Teşhis 0 çalışır mı | Teşhis 2b çalışır mı |
|---|---|---|---|
| 12 | 5 | HAYIR | HAYIR |
| 13 | 5 | HAYIR | EVET |
| 15 | 5 | HAYIR | EVET |
| 16 | 3 | EVET | EVET |
| 17 | 4 | EVET | EVET |
| 18 | 3 | EVET | EVET (+ worker_slots dikkate alınmalı) |

25 kayıtlı instance'ın **15'i (%60) PG16 altı** — Teşhis 0 çoğunlukta
çalışamıyor, bu yüzden bonus/opsiyonel statüsünde. **5'i (%20) PG12** —
Teşhis 2b'nin throttle-sleep kısmı bu instance'larda desteklenmiyor.
Teşhis 2, tüm 25 instance'ta çalışır — asıl birincil/geniş-kapsamlı
kanıt budur.

## Örnekleme ve yeterlilik (kapatılmış karar)

Örnek sayısı azsa yorum güvenilmez. **Yeterlilik kapısı (Teşhis 2/2b
için):** `count(distinct snapshot_ts) >= 10` — ham satır sayısı
(`count(*)`) DEĞİL, çünkü aynı worker'ın (aynı `pid`) art arda birkaç
toplama cycle'ında görünmesi tek bir olayı fazla sayabilir; `distinct
snapshot_ts` kaç farklı toplama anında örneklendiğini ölçer, doğru
birim budur. 10'un altında `distinct snapshot_ts` varsa teşhis
"yetersiz veri" dönmeli, zorla bir oran/yorum üretmemeli. (Teşhis 1'in
kendi, farklı bir "≥10 bucket" kapısı var — bkz. ilgili bölüm, bu
ikisi karıştırılmamalı.)

**Güncel worker sayısı** (`fetchAutovacuumWorkerStatus()`'ın
`runningWorkers` dönüş değeri) şu iki adımla hesaplanmalı:

1. **Önce** `fact.pg_activity_snapshot`'ta bu instance için **tüm
   satırların** (worker filtresi olmadan, instance'ın genel toplama
   döngüsünün) en son `snapshot_ts`'ini bul, ve bu değerin makul bir
   tazelik penceresinde (örn. son 5 dakika) olduğunu doğrula.
2. **Sonra** o `snapshot_ts` değerinde, `backend_type='autovacuum
   worker'` filtresiyle `count(distinct pid)` hesapla.

Bu iki adımlı yaklaşım önemli — sadece "worker satırlarının en son
`snapshot_ts`'i" kullanılırsa, eğer o cycle'da hiç worker yoksa bu
sorgu **eski bir zamana** denk gelir (worker'ın en son görüldüğü an),
"şu anda 0 worker var" doğru sonucunu VERMEZ, bunun yerine "worker'ın
son görüldüğü anda kaç worker vardı" yanlış sorusuna cevap verir.
İnstance'ın genel en son toplama anını kullanmak, "o anda 0 worker
varsa 0 dönsün" davranışını garanti eder.

Tersine, tek bir toplama anında çok sayıda worker görülmesi (örn. 5
worker aynı anda) `distinct snapshot_ts >= 10` yeterlilik kapısını
sağlamış SAYILMAZ — "kaç farklı zamanda örneklendi" sorusu, "şu an kaç
worker çalışıyor" sorusundan bağımsız, ikisi karıştırılmamalı.

**Oranların paydası** toplam worker observation satır sayısı olmalı
(`total_samples`, yani `count(*)`), payı ise ilgili `wait_event`
filtresi — sadece yeterlilik kapısı (`distinct snapshot_ts >= 10`)
`distinct` kullanır, oranın kendisi ham satır sayılarıyla hesaplanır.

## Worker evidence dönüş sözleşmesi (typed, DÖRT ayrı status)

**Dönüş tipi typed bir record olmalı, `Object[]` değil.** Alanlar:

| Alan | Tip | Açıklama |
|---|---|---|
| `runningWorkers` | `Integer` | En güncel genel snapshot'taki `count(distinct pid)` (bkz. iki adımlı tanım) |
| `maxWorkers` | `Integer` | `autovacuum_max_workers` ayarı |
| `workerSlots` | `Integer` | `autovacuum_worker_slots` (PG18+; öncesinde `null`) |
| `effectiveWorkerCapacity` | `Integer` | PG18+: `min(maxWorkers, workerSlots)`; öncesinde `maxWorkers` |
| `totalSamples` | `long` | Penceredeki toplam worker observation satırı |
| `distinctSnapshots` | `int` | Kaç farklı `snapshot_ts` (yeterlilik kapısının birimi) |
| `ioWaitSamples` | `long` | `wait_event_type = 'IO'` |
| `throttleSleepSamples` | `Long` | `wait_event = 'VacuumDelay'`; PG13 altında `null` |
| `noWaitEventSamples` | `long` | `wait_event IS NULL` |
| `otherWaitSamples` | `long` | Residual (yukarıdaki kimlik) |
| `latestSnapshotTs` | `OffsetDateTime` | Tazelik değerlendirmesi için |

**TEK bir status enum'u YETERSİZDİR — dört bağımsız status alanı
gerekir.** Aynı çağrıda farklı kanıtlar farklı durumlarda olabilir; tek
bir alana sıkıştırmak bilgi kaybettirir. Somut örnekler:

- **PG12 instance:** `ioWaitStatus = AVAILABLE` (bu sinyal her sürümde
  var) ama `throttleStatus = UNSUPPORTED_VERSION` (`VacuumDelay` PG13'te
  eklendi). Tek enum olsaydı ya IO kanıtı gereksiz yere gizlenir ya da
  throttle "0" gibi yanlış sunulurdu.
- **Sadece 9 farklı snapshot varsa:** oranlar `INSUFFICIENT_DATA`
  (`ioWaitStatus`/`throttleStatus`), ama `currentWorkerStatus` yine
  `AVAILABLE` olabilir — "şu an kaç worker çalışıyor" sorusu tek bir
  güncel snapshot'a dayanır, 10 farklı örneğe ihtiyaç duymaz.
- **PG18 instance'ta `autovacuum_worker_slots` toplanmamışsa:** sadece
  `capacityStatus = UNKNOWN` olur; wait-event kanıtları etkilenmez.

Dört status alanı:

| Status alanı | Neyi kapsar | Olası değerler |
|---|---|---|
| `currentWorkerStatus` | `runningWorkers` güvenilir mi | `AVAILABLE`, `NO_FRESH_SNAPSHOT`, `UNKNOWN_VERSION` |
| `ioWaitStatus` | IO-wait oranı yorumlanabilir mi | `AVAILABLE`, `INSUFFICIENT_DATA`, `NO_FRESH_SNAPSHOT` |
| `throttleStatus` | Throttle oranı yorumlanabilir mi | `AVAILABLE`, `INSUFFICIENT_DATA`, `NO_FRESH_SNAPSHOT`, `UNSUPPORTED_VERSION` (PG < 13), `UNKNOWN_VERSION` |
| `capacityStatus` | Etkin worker kapasitesi bilinebiliyor mu | `AVAILABLE`, `UNKNOWN` (ayar toplanmamış/bayat), `NOT_APPLICABLE` (PG < 18, `maxWorkers` tek başına yeterli) |

## Scope kararı: byte-hacmi metriği bu görevin kapsamında DEĞİL

PG16/17'nin `op_bytes` ve PG18'in doğrudan byte sayaçları teknik olarak
"PostgreSQL'in istediği I/O hacmini" (byte cinsinden) türetmeyi mümkün
kılıyor — ama bu, bu görevin (PGSTAT-P1-011) kapsamına dahil
EDİLMİYOR. Gerekçe: (a) bu hâlâ gerçek disk throughput/IOPS değil,
sadece PostgreSQL'in talep ettiği I/O hacmi — ek bir yanlış anlama
riski taşıyor, dikkatli bir terminoloji gerektirir; (b) mevcut kanıt
(işlem sayısı) zaten "autovacuum client backend'den N kat fazla I/O
işlemi yapıyor" sorusunu somut şekilde cevaplıyor; (c) bir "X MB/s"
grafiği/metriği eklemek ayrı bir tasarım ve UI çalışması gerektirir.
Byte-hacmi metriği ve `InstanceDetail.tsx`'teki olası görselleştirme,
**ayrı bir gelecek görev** olarak ele alınmalı, bu görevin
`requirements`/AC'lerine dahil değil.

## Kod önkoşulları (AC2'nin ilk adımı, zorunlu)

Kod denetimiyle doğrulanan, bu teşhisler kodlanmadan ÖNCE düzeltilmesi
gereken **10 madde** — bunlar üzerine inşa edilecek temelin kendisindeki
hatalar, "iyi olur" maddeleri değil:

1. **`fetchAutovacuumWorkerStatus()` (`AlertRuleEvaluator.java:2811-2815`)
   `count(*)` kullanıyor, `count(distinct pid)` değil.** Yukarıdaki
   "Örnekleme ve yeterlilik" bölümündeki iki adımlı tanıma göre yeniden
   yazılmalı, typed record dönmeli.
2. **`findBloatedTables()`'ın SELECT listesinde `relid` yok**
   (`AlertRuleEvaluator.java:2648-2676`). Tablo-özel cost override
   okuması `(instance_pk, dbid, relid)` anahtarına ihtiyaç duyuyor —
   `relid` bu sorguya eklenmeli, aksi hâlde tablo-özel override hiç
   okunamaz (schema/name eşleştirmesi güvenilmez).
3. **`control.table_relopts_snapshot` (V093) sadece ham `reloptions_raw
   text` tutuyor, cost ayarları için ayrıştırılmış sütun yok.** Yeni
   bir migration (V095 önerilir) ile `autovacuum_vacuum_cost_delay`/
   `autovacuum_vacuum_cost_limit` nullable sütunlar eklenmeli,
   `reloptions_raw`'dan ayrıştırılıp yazılmalı (ayrı, test edilmiş bir
   parser fonksiyonuyla — regex'le enline parse etmek kırılgan).
4. **`diagnoseBloat()`'un mesaj template'i bulunamazsa (render hatası),
   kanıt/aksiyon metni tamamen kayboluyor.** `renderWithCode()`
   (`AlertRuleEvaluator.java:1969-1981`) başarısız render'da
   `buildPerRecordThresholdMessage()`'ın ürettiği generic mesaja
   düşüyor — bu fallback `diagnosis`/`bloat_action` alanlarını
   içermiyor. Yeni evidence sentence'ların bu fallback yolunda da
   korunduğu doğrulanmalı.
5. **`previousIoSamples` cache'i (`ClusterCollector.java:415`) `stats_reset`'i
   okuyor ama karşılaştırmada kullanmıyor.** `pg_stat_reset_shared('io')`
   çağrılırsa, sayaç sıfırlanıp yeniden büyürken eski baseline'a göre
   delta hesaplanır — reset sonrası ilk cycle'da yanlış bir I/O sayısı
   üretebilir. `stats_reset` değiştiğinde cache sıfırlanıp yeni bir
   baseline'dan başlamalı.
6. **`autovacuum` (açık/kapalı parametresi) HİÇBİR settings listesinde
   yok** (`NightlySnapshotCollector.java:37-55` ve `119-129` — ne
   günlük `SETTINGS_QUERY`'de ne 3 saatlik `HOT_SETTINGS_QUERY`'de).
   Teşhis 3'ün ("autovacuum kapatılmış mı" guard'ı) ayarın kendisini
   okuyabilmesi için `autovacuum` her iki listeye de eklenmeli.
7. **`vacuum_cost_delay`/`vacuum_cost_limit` sadece günlük
   `SETTINGS_QUERY`'de var, `HOT_SETTINGS_QUERY`'de YOK**
   (`autovacuum_vacuum_cost_delay`/`autovacuum_vacuum_cost_limit` ise
   her iki listede de zaten var, bunlarla karıştırılmamalı).
   `ALTER SYSTEM SET vacuum_cost_limit = ...` gibi bir değişiklik 3
   saatlik hot refresh'te yakalanmaz, en fazla 24 saat gecikebilir. Bu
   iki ayar `HOT_SETTINGS_QUERY`'ye de eklenmeli.
8. **`autovacuum_worker_slots` (PG18+) hiç toplanmıyor** — filoda 3
   PG18 instance var, bu parametre etkin worker kapasitesini
   `autovacuum_max_workers`'dan daha sıkı sınırlayabiliyor (bkz. "PG18:
   worker slot kapasitesi" bölümü). Her iki settings listesine de
   eklenmeli.
9. **`ClusterCollector.java`'daki `getDoubleOrZero()` helper'ı kaynak
   NULL değerleri sessizce `0.0`'a çeviriyor** (satır 463-466,
   `reads`/`writes`/`read_time`/`write_time` dahil çoğu I/O sayacı
   için kullanılıyor — istisna: `op_bytes` ayrı, NULL-safe okunuyor).
   Bu, Teşhis 0'ın "veri yok" (`NO_FRESH_DATA`) ile "gerçek sıfır"
   (`ZERO_IO_WITH_FRESH_DATA`) ayrımını koddan imkansız hâle getiriyor —
   NULL bir kez 0'a döndükten sonra geri ayırt edilemez. `NO_FRESH_DATA`/
   `ZERO_IO_WITH_FRESH_DATA` ayrımının çalışması için ya bu helper'ın
   I/O sayaçları için NULL-safe hâle getirilmesi (nullable `Long`/
   `Double` dönmesi) ya da NULL bilgisinin ayrı bir flag ile
   korunması gerekiyor — bu, Teşhis 0'ın "beş durum" modelinin ön
   koşulu, atlanamaz.

10. **I/O sample cache'i typed hâle getirilmeli — ZORUNLU, opsiyonel
    değil.** Şu an `previousIoSamples` bir
    `ConcurrentHashMap<Long, Map<String, Map<String, Double>>>` ve
    sayaçlar `Double` olarak tutulup `.longValue()` ile çevriliyor.
    Bu, üç ayrı önkoşulun (5: `stats_reset` farkındalığı, 9: NULL
    koruma, ve Diagnosis 0'ın beş durumlu modeli) **hepsinin aynı veri
    yapısına dokunmasını** gerektiriyor — üçünü ayrı ayrı `Map<String,
    Double>` üzerine yamamaya çalışmak kırılgan olur. Gerekli değişiklik:
    - **Sayaçlar** (`reads`, `writes`, `extends`, `hits`, `fsyncs`,
      `evictions`, `reuses`, `writebacks`, byte sayaçları): nullable
      `Long` (veya çok büyük değer riski varsa `BigDecimal`) — `Double`
      DEĞİL. (Not: binary64 tamsayıları yalnızca **2^53**'e kadar kesin
      taşır, ~9×10^15 değil; pratikte PG sayaçları bu sınırın altında
      kalsa da doğru tip zaten `Long`.)
    - **Süre metrikleri** (`read_time_ms`, `write_time_ms`): nullable
      `Double` (bunlar gerçekten kesirli).
    - **`stats_reset` değeri, önceki sample ile AYNI typed kayıtta**
      tutulmalı — ayrı bir map'te değil, aksi hâlde ikisi arasında
      tutarsızlık oluşabilir.
    - **Reset algılandığında** (yeni `stats_reset` != cache'teki):
      o key için **o cycle'da delta YAZILMAZ**, sadece yeni baseline
      alınır. Yeni sayaç eski değerden büyük olsa bile — reset sonrası
      artış eski baseline'a göre ölçülemez.
    - **`DeltaCalculator` null-aware olmalı**: girdilerden biri `null`
      ise sonuç `null` (0 değil), böylece "ölçüm yok" bilgisi
      `fact.pg_io_stat_delta`'ya kadar korunur ve Diagnosis 0'ın
      `*_metric_valid_count` sayımı anlamlı olur.

## AC2 implementasyon sırası

0. Yukarıdaki 10 kod önkoşulunu (madde 1-10) düzelt.
1. `fetchAutovacuumWorkerStatus()`'u genişlet — tek SQL round-trip'te
   Teşhis 2 (`ioWaitSamples`) ve Teşhis 2b (`throttleSleepSamples`,
   `noWaitEventSamples`, `otherWaitSamples`, `distinctSnapshots`)
   verilerini typed bir record olarak döndür, iki-adımlı
   `runningWorkers` hesabını uygula, `>= 10 distinct snapshot_ts`
   yeterlilik kapısını uygula, PG13 altı için Teşhis 2b'yi
   `UNSUPPORTED_VERSION` işaretle.
2. Etkin cost ayarını (tablo override → instance ayarı → `-1`
   fallback, `DISTINCT ON` + tazelik kontrollü) okuyan bir yardımcı
   fonksiyon yaz, `effectiveCostDelay > versionDefault` kapısını
   uygula (PG11: `20ms`, PG12+: `2ms`) — "non-default" değil, kesin
   bu karşılaştırma.
3. `fetchAutovacuumIoImpact(instancePk)` yaz (Teşhis 0) — `pg_major >= 16`
   guard'ı, `object='relation'` filtresi, client-read=0 durumunda oran
   üretmeme, beş durumlu (`UNSUPPORTED`/`UNKNOWN_CAPABILITY`/
   `NO_FRESH_DATA`/`ZERO_IO_WITH_FRESH_DATA`/`AVAILABLE`) dönüş modeli — bu,
   madde 9'daki NULL-safe I/O okuması olmadan doğru çalışamaz.
4. `autovacuum_worker_slots`'u okuyup `min(autovacuum_max_workers,
   autovacuum_worker_slots)` ile etkin kapasiteyi hesapla (PG18+ için).
5. Tüm bunları senaryo 3 (`vacuum_ineffective`) ve senaryo 4.5'in
   (eşik yanlış kalibre) mesajlarına ek kanıt cümlesi olarak ekle —
   mevcut `dead_tuple_ratio` alert'inin (`AlertCode.USER_DEFINED_RULE`)
   üzerine, yeni bir alert tipi DEĞİL, adaptive alerting'e bağlama.
6. Opsiyonel: Teşhis 1 (gecikme korelasyonu) yardımcı fonksiyonunu
   (kendi `≥10 bucket` gate'iyle, Teşhis 2/2b'nin `distinct
   snapshot_ts` kapısıyla karıştırılmadan) ekle.
7. Bu görevin kapsamı DIŞINDA (ayrı görev): byte-hacmi metriği veya
   `InstanceDetail.tsx`'e görselleştirme.

**Test sözleşmesi (AC2'nin bir parçası, en az bunlar):**

*Dört bağımsız status alanı:*
- PG12'de `ioWaitStatus = AVAILABLE` **ve aynı anda**
  `throttleStatus = UNSUPPORTED_VERSION` — tek enum'a çökmüyor,
  throttle sessizce `0` gösterilmiyor.
- 9 farklı snapshot varken `ioWaitStatus`/`throttleStatus =
  INSUFFICIENT_DATA` **ama** `currentWorkerStatus = AVAILABLE` —
  güncel worker sayısı 10 örnek şartına tabi değil.
- PG18'de `autovacuum_worker_slots` toplanmamışken sadece
  `capacityStatus = UNKNOWN`; wait-event kanıtları etkilenmiyor.
- PG < 18'de `capacityStatus = NOT_APPLICABLE`, `effectiveWorkerCapacity
  = maxWorkers`; PG18'de `min(maxWorkers, workerSlots)`.
- Bilinmeyen `pg_major` → ilgili alanlar `UNKNOWN_VERSION`.

*Örnekleme ve kova matematiği:*
- 9 distinct snapshot yetersiz, tam 10 yeterli.
- Tek snapshot'ta 10 worker görülmesi yeterlilik kapısını GEÇMEZ.
- `runningWorkers`, instance'ın en güncel **genel** snapshot'ındaki
  distinct pid — worker satırlarının kendi en son snapshot'ı DEĞİL;
  o cycle'da 0 worker varsa `0` döner, eski bir sayı değil.
- Üç adlandırılmış kova + `otherWaitSamples` toplamı **her zaman**
  `totalSamples`'a eşit (aritmetik kimlik); `otherWaitSamples` asla
  negatif değil (kovalar örtüşmüyor).
- IO-wait ve VacuumDelay ayrı sayılıyor, birbirine karışmıyor.

*Diagnosis 0 durum modeli:*
- `source_row_count = 0` → `NO_FRESH_DATA` (sayaç değerine bakılmadan).
- Taze satır var, autovacuum read+write toplamı 0 →
  `ZERO_IO_WITH_FRESH_DATA` — `NO_FRESH_DATA` ile karışmıyor, ve
  mesajı "autovacuum çalışmadı" demiyor.
- `latest_sample_ts` tazelik eşiğinin dışında → `NO_FRESH_DATA`.
- `has_pg_stat_io = false` → `UNSUPPORTED`; `is_reachable = false` →
  `INSTANCE_UNREACHABLE`; capability satırı yok/bayat →
  `UNKNOWN_CAPABILITY` (üçü ayrı durumlar).
- `pg_major < 16` → `UNSUPPORTED`, sorgu hiç çalıştırılmıyor.
- Client reads = 0 → oran üretilmiyor, mutlak sayı raporlanıyor.
- NULL kaynak sayaç (Kod önkoşulu 9/10 sonrası) `*_metric_valid_count`
  ile ayırt ediliyor, `0` ölçümüyle karışmıyor.

*Etkin cost ayarı zinciri:*
- Tablo override `>= 0` → zincir orada biter, global okunmaz.
- Tablo override `-1` → global `autovacuum_*`'a düşer.
- Global `autovacuum_*` `-1` → `vacuum_*`'a düşer.
- Zincirin herhangi bir adımında eksik/malformed/bayat değer →
  `UNKNOWN`, ve **"cost_delay düşür" önerisi bastırılıyor**.
- `effectiveCostDelay > versionDefault` iken öneri var; `0ms`/`1ms`
  gibi varsayılandan düşük "non-default" değerlerde öneri YOK;
  varsayılana eşitken öneri YOK.
- `cost_delay` ve `cost_limit` bağımsız çözümleniyor (biri tablo
  override'ından, diğeri global'den gelebilir).

*Tazelik:*
- Tazelik eşiği ilgili kaynağın cadence'ine göre hesaplanıyor (sabit
  saat değil); hot-yenilenen ve nightly-yenilenen ayarlar farklı
  eşiklere tabi.
- Settings sorgusu her ayar için yalnız en güncel satırı dönüyor
  (`DISTINCT ON`), tarihsel satırlar karışmıyor.

*Diğer:*
- `stats_reset` değişiminde o key için delta YAZILMIYOR (yeni sayaç
  eski değerden büyük olsa bile), yeni baseline alınıyor.
- Aynı isimli tablo farklı `dbid`'lerde karışmıyor (`relid` bazlı).
- Senaryo 3/4.5 yeni kanıt içeriyor; diğer senaryolar değişmiyor.
- Template render başarısız olduğunda kanıt metni kaybolmuyor.
- Hiçbir aksiyon metninde autovacuum kapatma önerisi yok.
- `queryForList()`'in timestamp kolonları için döndürdüğü Java tipi
  (`OffsetDateTime` **ve** `java.sql.Timestamp`) — her iki tip de
  test edilip güvenli normalize ediliyor.

## Kaynaklar

- PostgreSQL resmi dok. — autovacuum'un kapatılmaması gerektiği:
  https://www.postgresql.org/docs/current/routine-vacuuming.html#AUTOVACUUM
- PostgreSQL 11 resmi dok. — `-1` sentinel davranışının PG11'de zaten
  mevcut olduğunun kanıtı (canlı çekilip doğrulandı):
  https://www.postgresql.org/docs/11/runtime-config-autovacuum.html
- PostgreSQL 13 resmi dok. — `VacuumDelay`'in `Timeout` kategorisinde
  olduğunun ve PG13'te eklendiğinin kanıtı (canlı çekilip doğrulandı):
  https://www.postgresql.org/docs/13/monitoring-stats.html
- PostgreSQL 18 resmi dok. — `autovacuum_worker_slots` ve cost-limit
  dağıtımının kanıtı (canlı çekilip doğrulandı):
  https://www.postgresql.org/docs/18/runtime-config-autovacuum.html
- pganalyze — vacuum cost model (cost_delay/cost_limit mekanizması):
  https://pganalyze.com/docs/vacuum-advisor/how-does-the-vacuum-cost-model-work
- pganalyze — VACUUM Advisor (topluluğun latency korelasyonu KURMADIĞININ kanıtı):
  https://pganalyze.com/postgres-vacuum-advisor
- EnterpriseDB — "autovacuum too aggressive" (agresif ayarın riskleri):
  https://www.enterprisedb.com/postgres-tutorials/postgresql-autovacuum-too-aggressive
- perun.au — "five failure patterns" (worker saturation, checkpoint baskısı):
  https://perun.au/insights/postgres-vacuum-production/
- Percona — vacuum tuning best practice:
  https://www.percona.com/blog/importance-of-postgresql-vacuum-tuning-and-custom-scheduled-vacuum-job/
- Difference-in-differences confounder tuzağı:
  https://www.everydaycausal.com/twfe-did.html
- PostgreSQL resmi dok. — `wait_event`/`VacuumDelay` ve cost-based
  vacuum delay parametreleri:
  https://www.postgresql.org/docs/current/monitoring-stats.html#WAIT-EVENT-TABLE
  https://www.postgresql.org/docs/current/runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-VACUUM-COST
