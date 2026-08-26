# Autovacuum Sistem Maliyeti Teşhisi — Tasarım Dokümanı

**Durum:** PGSTAT-P1-011 — tasarım aşaması, 2026-08-26. Henüz kodlanmadı
(AC2 bekliyor). Bu doküman dört inceleme turundan geçti (canlı testler,
üç bağımsız dış inceleme — resmi PostgreSQL dokümanları defalarca
çekilip doğrulandı). Önceki sürümler her düzeltmeyi eski metnin yanına
yeni bir not olarak ekliyordu, bu da çelişkili katmanlar yarattı. **Bu
sürüm tekrar sıfırdan konsolide edildi** — yanlış/eski metin silindi,
her konu için tek, güncel, doğru bir açıklama bırakıldı.

**AC2'de çözülmesi gereken, hâlâ AÇIK iki madde** (kapatılmış kararlar
"Örnekleme ve yeterlilik" bölümünde, açık olanlar burada):

1. **Timestamp tipi:** `AlertRuleEvaluator`'daki `queryForList()`
   tabanlı sorguların zaman damgası alanlarının gerçek Java tipi
   (`OffsetDateTime` mi `java.sql.Timestamp` mi) doğrudan kanıtlanmadı.
   Kod her iki tipi de güvenli normalize etmeli, ikisi de birim testle
   kapsanmalı.
2. **AC3'ün canlı doğrulama hedef instance'ları:** AC2 tamamlandığında
   güncel `control.instance_capability` sorgusuyla yeniden seçilmeli
   (bir instance zaten görev sırasında PG15'ten PG17'ye yükseltildi,
   sabit bir liste vermek yanıltıcı olur).

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

```sql
select backend_type,
       sum(reads_delta) as total_reads,
       sum(writes_delta) as total_writes,
       sum(read_time_ms_delta) as total_read_time_ms,
       sum(write_time_ms_delta) as total_write_time_ms
from fact.pg_io_stat_delta
where instance_pk = ? and object = 'relation'
  and sample_ts > now() - interval '24 hours'
group by backend_type
order by total_reads desc nulls last;
```

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
- **Beş farklı durum birbirinden ayrılmalı, hepsi `null`/"N/A" gibi
  tek bir göstergeye indirgenmemeli:**
  1. `UNSUPPORTED` — `pg_major < 16`, `pg_stat_io` bu sürümde yok, sorgu
     hiç çalıştırılmamalı.
  2. `UNKNOWN_CAPABILITY` — instance'ın `pg_major`'ı henüz keşfedilmemiş
     (`control.instance_capability`'de satır yok/`null`), desteklenip
     desteklenmediği bilinmiyor. `UNSUPPORTED` ile aynı gösterge
     DEĞİL — biri "kesin desteklenmiyor", diğeri "henüz bilinmiyor".
  3. `NO_DATA` — PG16+ ama `fact.pg_io_stat_delta`'da bu instance için
     hiç satır yok (örn. collector henüz bir cycle tamamlamamış, ya da
     `ClusterCollector`'ın NULL→0 dönüşümü nedeniyle kaynak NULL
     değerlerin ayırt edilemediği bir durum — bkz. "Kod önkoşulları"
     madde 7). Bu, "autovacuum hiç çalışmadı" ile KARIŞTIRILMAMALI.
  4. `ZERO_WITH_FRESH_DATA` — PG16+, veri var (collector güncel bir
     cycle tamamlamış), ama autovacuum worker satırı gerçekten 0 —
     yani autovacuum bu pencerede hiç çalışmamış. Bu "gerçek sıfır".
  5. `AVAILABLE` — normal durum, sayılar mevcut ve anlamlı.

## Teşhis 2: I/O bekleme oranı (birincil, her PG sürümünde)

Worker örneklemelerinin ne kadarının gerçek disk I/O'sunda beklediğini
sayar. Sürüm bağımsız — tüm 25 kayıtlı instance'ta çalışır.

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

**Dört kova, iki değil — ve dördü de `total_samples`'ı tüketmeyebilir:**
`IO`, `VacuumDelay` (`Timeout` kategorisinde) ve `no_wait_event`
(muhtemelen aktif CPU, ama kesin kanıt değil) yanında, worker `Lock`,
`BufferPin`, `LWLock` gibi başka wait kategorilerinde de bekleyebilir.
Dört kovanın toplamı `total_samples`'a eşit olmayabilir — kalan fark
açıkça bir `otherWaitSamples` alanı olarak taşınmalı
(`total_samples - io_wait_samples - throttle_sleep_samples -
no_wait_event_samples`), yok sayılmamalı. "Worker zamanı ya aktif ya
throttle'da" gibi iki kutuplu bir model yanlış bir basitleştirme.

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

**Etkin cost ayarı önceliği (tablo override → instance ayarı → `-1`
fallback):**

1. `control.table_relopts_snapshot`'taki tablo-özel override (varsa) —
   PostgreSQL `ALTER TABLE ... SET (autovacuum_vacuum_cost_delay = ...)`
   ile instance-geneli ayarı ezebilir. Şu an bu tablo sadece ham
   `reloptions_raw` text tutuyor, ayrıştırılmış sütun yok (bkz. "Kod
   önkoşulları").
2. Tablo override yoksa `fact.pg_settings_snapshot`'taki en güncel
   `autovacuum_vacuum_cost_delay`/`autovacuum_vacuum_cost_limit`
   (yukarıdaki `DISTINCT ON` + tazelik kontrollü sorgu).
3. Bu değer `-1` ise genel `vacuum_cost_delay`/`vacuum_cost_limit`'e
   düş — bu `-1` sentinel davranışı **PG11'de zaten mevcuttu** (resmi
   `postgresql.org/docs/11/runtime-config-autovacuum.html` sayfası
   çekilip doğrulandı: *"If -1 is specified, the regular
   vacuum_cost_delay value will be used."*), hiçbir sürümde
   kaldırılmadı, her sürümde aynı şekilde yorumlanmalı. Tek gerçek
   sürüm eşiği **varsayılan değerdir**: PG11'de `20ms`, PG12'den
   itibaren (PG12-18) `2ms` — bu, PG12 release notes ile doğrulanmış.

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

**Dönüş tipi typed olmalı, `Object[]` değil:** `fetchAutovacuumWorkerStatus()`
şu alanları taşıyan typed bir record dönmeli: `runningWorkers`,
`maxWorkers`, `totalSamples`, `distinctSnapshots`, `ioWaitSamples`,
`throttleSleepSamples`, `noWaitEventSamples`, `otherWaitSamples`
(yukarıdaki "dört kova" notundaki kalan fark), ve bir durum enum'u
(`AVAILABLE`, `INSUFFICIENT_DATA`, `UNSUPPORTED_VERSION`,
`UNKNOWN_VERSION`).

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
gereken **9 madde** — bunlar üzerine inşa edilecek temelin kendisindeki
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
   Bu, Teşhis 0'ın "veri yok" (`NO_DATA`) ile "gerçek sıfır"
   (`ZERO_WITH_FRESH_DATA`) ayrımını koddan imkansız hâle getiriyor —
   NULL bir kez 0'a döndükten sonra geri ayırt edilemez. `NO_DATA`/
   `ZERO_WITH_FRESH_DATA` ayrımının çalışması için ya bu helper'ın
   I/O sayaçları için NULL-safe hâle getirilmesi (nullable `Long`/
   `Double` dönmesi) ya da NULL bilgisinin ayrı bir flag ile
   korunması gerekiyor — bu, Teşhis 0'ın "beş durum" modelinin ön
   koşulu, atlanamaz.

**Opsiyonel, AC2'nin zorunlu kapsamı DEĞİL:** I/O sayaçları
`previousIoSamples`'ta `Double` olarak tutulup `long`'a `.longValue()`
ile çevriliyor — gerçekçi PG sayaç büyüklüklerinde pratik bir
hassasiyet kaybı riski yok (`Double`'ın 52-bit tam sayı hassasiyeti
~9×10^15), ama tip uyuşmazlığı bir tasarım kusuru. Madde 5 (stats_reset
farkındalığı) düzeltilirken aynı yerde `Long`/`BigDecimal` tabanlı
typed bir sample sınıfına geçmek verimli olabilir, ama tek başına bu
görevin şartı değil.

## AC2 implementasyon sırası

0. Yukarıdaki 9 kod önkoşulunu (madde 1-9) düzelt.
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
   `NO_DATA`/`ZERO_WITH_FRESH_DATA`/`AVAILABLE`) dönüş modeli — bu,
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

**Testler (AC2'nin bir parçası, en az):** PG12'de Teşhis 2b
`UNSUPPORTED_VERSION` (sıfır değil); PG13/15'te Teşhis 2b var ama
Teşhis 0 `UNSUPPORTED`; PG16+'ta tüm teşhisler kullanılabilir;
bilinmeyen `pg_major` → `UNKNOWN_VERSION`; 9 distinct snapshot
yetersiz, tam 10 yeterli; tek snapshot'ta çok worker yeterli sayılmaz;
`runningWorkers` instance'ın en güncel genel snapshot'ındaki distinct
pid (worker satırlarının kendi en son snapshot'ı DEĞİL); IO-wait ve
VacuumDelay birbirine karıştırılmıyor; dört kova + `otherWaitSamples`
toplamı `totalSamples`'a eşit; varsayılan `cost_delay`'de "düşür"
önerisi yok; `effectiveCostDelay > versionDefault` iken öneri var,
`0ms`/`1ms` gibi düşük non-default değerlerde öneri YOK; `-1` fallback
yolları; aynı isimli tablo farklı `dbid`'lerde karışmıyor; `stats_reset`
değişiminde delta yazılmıyor; client reads=0 davranışı; NULL kaynak
değer `NO_DATA` üretiyor, `ZERO_WITH_FRESH_DATA`'yla karışmıyor;
settings sorgusu her ayar için en güncel satırı dönüyor (eski satırlar
karışmıyor); eski/taze olmayan settings verisi işaretleniyor;
`autovacuum_worker_slots` etkin kapasiteyi doğru sınırlıyor; scenario
3/4.5 kanıt içeriyor, diğer senaryolar değişmiyor; hiçbir aksiyon
metninde autovacuum kapatma önerisi yok; `queryForList()`'in timestamp
kolonları için döndürdüğü Java tipi (`OffsetDateTime` veya
`Timestamp`) her ikisi de test edilip güvenli normalize ediliyor.

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
