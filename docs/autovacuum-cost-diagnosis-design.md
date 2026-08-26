# Autovacuum Sistem Maliyeti Teşhisi — Tasarım Dokümanı

**Durum:** PGSTAT-P1-011 — tasarım aşaması, 2026-08-26. Henüz kodlanmadı
(AC2 bekliyor). Bu doküman üç inceleme turundan geçti (canlı testler,
iki bağımsız dış inceleme — biri resmi PostgreSQL dokümanları çekilerek
doğrulandı) ve her turda gerçek hatalar bulunup düzeltildi. Önceki
sürümler her düzeltmeyi eski metnin yanına yeni bir not olarak
ekliyordu; bu, dokümanı çelişkili katmanlara böldü. **Bu sürüm sıfırdan
konsolide edildi** — yanlış metin silindi, her konu için tek, güncel,
doğru bir açıklama bırakıldı. Sürüm geçmişi artık burada değil, git
commit geçmişinde.

**AC2'de çözülmesi gereken, hâlâ AÇIK üç madde:**

1. Örnekleme yeterlilik eşiği: `count(distinct snapshot_ts) >= 10`
   olarak tanımlandı (bkz. "Örnekleme ve yeterlilik" bölümü) — bu artık
   kapalı bir karar, implementasyonda bu şekilde uygulanmalı.
2. Timestamp tipi: `AlertRuleEvaluator`'daki `queryForList()` tabanlı
   sorguların zaman damgası alanlarının gerçek Java tipi (`OffsetDateTime`
   mi `java.sql.Timestamp` mi) doğrudan kanıtlanmadı. Kod her iki tipi
   de güvenli normalize etmeli, ikisi de birim testle kapsanmalı.
3. AC3'ün canlı doğrulama hedef instance'ları — AC2 tamamlandığında
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
- Worker doygunluğu (`autovacuum_max_workers` yetersiz)
- Uzun süren transaction/prepared transaction (xmin horizon ilerlemiyor)
- Pasif/unutulmuş replication slot (aynı xmin horizon etkisi)
- Wraparound/freeze baskısı (agresif vacuum bilinçli tetiklenmiş olabilir)
- Lock/BufferPin/LWLock bekleme (worker `IO` veya `VacuumDelay` değil,
  başka bir wait kategorisinde bekliyor olabilir — bkz. aşağıdaki
  "wait_event dağılımı tam değil" notu)
- Tablo/TOAST'a özel `reloptions` override'ı

## Neden gecikme korelasyonu birincil kanıt DEĞİL

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
query latency ile doğrudan korelasyona sokmadığı doğrulandı
(kaynak: pganalyze VACUUM Advisor dokümantasyonu).

**Karar:** Gecikme korelasyonu birincil kanıt DEĞİL — sadece opsiyonel,
düşük güvenilirlikli bir ikincil bağlam notu. Sadece her iki tarafta
da `count(distinct snapshot_ts) >= 10` olduğunda hesaplanıp gösterilir,
aksi hâlde hiç gösterilmez; hiçbir zaman tek başına bir aksiyon
önerisine dayanak yapılmaz. SQL'i teknik olarak doğru çalışıyor:

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

**Gerçek veriyle doğrulandı (`instance_pk=6`, PG17, 24 saatlik pencere):**

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
  bu N kat client backend'den fazla" — "X MB I/O tüketti" ya da
  "sisteme X maliyeti oldu" gibi bir hacim/maliyet iddiası kurulmamalı.
  Bu yüzden bu teşhisin başlığı bilerek "I/O maliyeti" değil "I/O
  işlem sayısı" — "cost" kelimesi kod/mesaj tarafında kullanılmamalı.
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
- **Veri yok / gerçek sıfır / desteklenmiyor üçü birbirinden
  ayrılmalı:** PG16 altı instance'larda sorgu hiç çalıştırılmamalı,
  çağıran taraf açıkça "bu PG sürümü bu teşhisi desteklemiyor" almalı
  (`null` dönüp UI'da "unsupported" gösterilmeli). PG16+ bir instance'ta
  sorgu gerçekten 0 satır dönerse (autovacuum hiç çalışmamış) bu "veri
  yok" değil "gerçek sıfır" — farklı bir mesaj gerektirir. İkisi asla
  aynı "N/A" göstergesiyle karıştırılmamalı.

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

**Kritik: yüksek `io_wait_samples` oranı, `cost_delay`'in yüksek
ayarlandığının KANITI DEĞİLDİR.** `wait_event_type = 'IO'` (gerçek
disk gecikmesi) ile `wait_event = 'VacuumDelay'` (Teşhis 2b, kasıtlı
throttle uykusu) **bağımsız sinyallerdir** — biri donanımdan, diğeri
konfigürasyondan kaynaklanır. Yüksek I/O-wait oranı, `cost_delay` ayarı
ne olursa olsun (default, düşük, throttling tamamen kapalı olsa bile)
gerçekleşebilir, disk gerçekten yavaşsa. `"cost_delay'i düşür"`
aksiyonu SADECE Teşhis 2b'nin kanıtına dayanmalı, Teşhis 2 tek başına
bu aksiyona gerekçe olmamalı — sadece "worker disktan ne kadar
etkileniyor" bağlamını verir.

## Teşhis 2b: Throttle-sleep oranı (birincil, PG13+)

**Statü: PG13+ ile sınırlı.** `wait_event = 'VacuumDelay'` PG13'te
eklendi — öncesinde autovacuum'un cost-based uyku durumu
`pg_stat_activity`'de ayrı bir `wait_event` olarak görünmüyordu. PG12
instance'larında (kayıtlı 25'in 5'i) bu teşhis `null`/"desteklenmiyor"
dönmeli, sessizce `0` göstermemeli — "throttle yok" ile "bu sürümde
sinyal yok" birbirine karıştırılmamalı.

**`VacuumDelay`'in kategorisi:** Ham veriyle (canlı PG17 instance'ta)
doğrulandı — `VacuumDelay`, **her PG sürümünde** `wait_event_type =
'Timeout'` kategorisindedir, `'IO'` değil. Bu, Teşhis 2'nin
`wait_event_type = 'IO'` filtresinin throttle uykusunu hiçbir sürümde
yakalamadığı anlamına gelir — Teşhis 2 ve 2b tamamen ayrı filtrelerle
hesaplanmalı, `pg_major`'a göre kategori dallanmasına gerek yok (sadece
2b'nin PG13 alt sınırına ihtiyaç var, kategori sorunu değil).

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

-- Ayni instance'in etkin cost ayarlari (yorumlamak icin sart)
select setting_name, setting_value
from fact.pg_settings_snapshot
where instance_pk = ?
  and setting_name in ('autovacuum_vacuum_cost_limit', 'autovacuum_vacuum_cost_delay',
                        'vacuum_cost_limit', 'vacuum_cost_delay', 'autovacuum_max_workers')
order by 1;
```

**Dört kova, iki değil:** `IO`, `VacuumDelay` (`Timeout` kategorisinde)
ve `no_wait_event` (muhtemelen aktif CPU, ama kesin kanıt değil) yanında,
worker `Lock`, `BufferPin`, `LWLock` gibi başka wait kategorilerinde de
bekleyebilir. `total_samples`'ın tamamı bu üç kovaya bölünmez — kalan
fark (`total_samples - io_wait - throttle_sleep - no_wait_event`)
raporlanmalı veya en azından yok sayılmamalı, "worker zamanı ya aktif
ya throttle'da" gibi iki kutuplu bir model yanlış bir basitleştirme.

**`no_wait_event_samples`, "aktif çalışıyor" DEĞİL — sadece "wait event
raporlanmadı" demektir.** `wait_event IS NULL`, PostgreSQL'in o anki
örneklemede hiçbir wait event raporlamadığı anlamına gelir; bu genelde
worker'ın CPU'da aktif çalıştığına işaret eder ama kesin kanıt değildir.
Kod ve mesaj metninde "aktif çalışıyor" değil "wait event raporlanmadı"
ifadesi kullanılmalı.

**Yüksek `throttle_sleep_samples` oranı bir "sorun" değildir — bu,
cost bütçesine ULAŞILDIĞININ göstergesidir.** PostgreSQL'in cost-based
throttling mekanizması: worker her sayfa işleminde (`vacuum_cost_page_hit`/
`vacuum_cost_page_miss`/`vacuum_cost_page_dirty` — bu üç parametre
önekisiz, hem normal `VACUUM` hem `autovacuum` için ortak, autovacuum'a
özel bir override'ı yok) puan biriktirir; toplam etkin `cost_limit`'e
ULAŞINCA etkin `cost_delay` kadar uyur. Yani `VacuumDelay`, worker
bütçeyi **dolduramadığı** için değil, tam tersine **doldurduğu** için
oluşur. Varsayılan `cost_delay=2ms` gibi kısa bir sürede bu oranın
yüksek çıkması beklenen, normal bir davranıştır — üç test instance'ının
(`6`, `8`, `23`) hepsinde varsayılan ayarlarda bu gözlendi.

**Yorumlama ve aksiyon kuralı:**

| Sinyal | Aksiyon |
|---|---|
| `throttle_sleep_samples` oranı yüksek, etkin `cost_delay` == sürüm varsayılanı (`2ms` PG12+, `20ms` PG11) | Sadece gözlemi raporla: "worker örneklemelerin %N'inde throttle uykusunda gözlemlendi; cost_delay ayarı varsayılan değerde." Bir "sorun" ya da "normal" yorumu ekleme, aksiyon önerme. |
| `throttle_sleep_samples` oranı yüksek, **etkin `cost_delay` > sürüm varsayılanı** (kasıtlı yükseltilmiş) | `cost_delay`'i düşürmeyi öner — bu, ayarın gerçekten sürümün varsayılanından yüksek olduğu kanıtlandığında geçerli, "non-default" (örn. `0ms` veya `1ms`, varsayılandan DÜŞÜK) durumunda bu öneri asla üretilmemeli. |
| `io_wait_samples` oranı yüksek | Teşhis 0 (varsa, PG16+) ile birlikte bağlam olarak sun; tek başına bir aksiyona dayanak yapma (Teşhis 2 bölümüne bkz.). |

**Etkin cost ayarı önceliği (tablo override → instance ayarı → `-1`
fallback):**

1. `control.table_relopts_snapshot`'taki tablo-özel override (varsa) —
   PostgreSQL `ALTER TABLE ... SET (autovacuum_vacuum_cost_delay = ...)`
   ile instance-geneli ayarı ezebilir. Şu an bu tablo sadece ham
   `reloptions_raw` text tutuyor, ayrıştırılmış sütun yok (bkz. "Kod
   önkoşulları").
2. Tablo override yoksa `fact.pg_settings_snapshot`'taki
   `autovacuum_vacuum_cost_delay`/`autovacuum_vacuum_cost_limit`.
3. Bu değer `-1` ise genel `vacuum_cost_delay`/`vacuum_cost_limit`'e
   düş — bu `-1` sentinel davranışı **PG11'de zaten mevcuttu** (resmi
   `postgresql.org/docs/11/runtime-config-autovacuum.html` sayfası
   çekilip doğrulandı: *"If -1 is specified, the regular
   vacuum_cost_delay value will be used."*), hiçbir sürümde
   kaldırılmadı, her sürümde aynı şekilde yorumlanmalı. Tek gerçek
   sürüm eşiği **varsayılan değerdir**: PG11'de `20ms`, PG12'den
   itibaren (PG12-18) `2ms` — bu, PG12 release notes ile doğrulanmış.

## PG sürüm dağılımı (Teşhis 0'ın kapsamını belirler)

Kayıtlı **25** instance'ta gerçek `pg_major` dağılımı çıkarıldı:

| pg_major | instance sayısı | Teşhis 0 çalışır mı | Teşhis 2b çalışır mı |
|---|---|---|---|
| 12 | 5 | HAYIR | HAYIR |
| 13 | 5 | HAYIR | EVET |
| 15 | 5 | HAYIR | EVET |
| 16 | 3 | EVET | EVET |
| 17 | 4 | EVET | EVET |
| 18 | 3 | EVET | EVET |

25 kayıtlı instance'ın **15'i (%60) PG16 altı** — Teşhis 0 çoğunlukta
çalışamıyor, bu yüzden bonus/opsiyonel statüsünde. **5'i (%20) PG12** —
Teşhis 2b'nin throttle-sleep kısmı bu instance'larda desteklenmiyor.
Teşhis 2, tüm 25 instance'ta çalışır — asıl birincil/geniş-kapsamlı
kanıt budur.

## Örnekleme ve yeterlilik (kapatılmış karar)

Örnek sayısı azsa yorum güvenilmez. **Yeterlilik kapısı:**
`count(distinct snapshot_ts) >= 10` — ham satır sayısı (`count(*)`)
DEĞİL, çünkü aynı worker'ın (aynı `pid`) art arda birkaç toplama
cycle'ında görünmesi tek bir olayı fazla sayabilir; `distinct
snapshot_ts` kaç farklı toplama anında örneklendiğini ölçer, doğru
birim budur. 10'un altında `distinct snapshot_ts` varsa teşhis
"yetersiz veri" dönmeli, zorla bir oran/yorum üretmemeli.

**Güncel worker sayısı** (`fetchAutovacuumWorkerStatus()`'ın
`runningWorkers` dönüş değeri) **en son `snapshot_ts`'teki `count(distinct
pid)`** olarak hesaplanmalı — pencere boyunca `count(*)` DEĞİL. Aksi
hâlde aynı worker birden fazla cycle'da sayılıp sahte "worker
doygunluğu" sonucu üretebilir; tersine, tek bir toplama anında çok
sayıda worker görülmesi de (örn. 5 worker aynı anda) "yeterli örneklem"
sayılmamalı — bu, "kaç farklı zamanda örneklendi" (`distinct
snapshot_ts`) sorusundan bağımsız bir "şu an kaç worker çalışıyor"
sorusu, ikisi karıştırılmamalı.

**Oranların paydası** toplam worker observation satır sayısı olmalı
(`total_samples`, yani `count(*)`), payı ise ilgili `wait_event`
filtresi — sadece yeterlilik kapısı (`distinct snapshot_ts >= 10`)
`distinct` kullanır, oranın kendisi ham satır sayılarıyla hesaplanır.

## Kod önkoşulları (AC2'nin ilk adımı, zorunlu)

Kod denetimiyle doğrulanan, bu teşhisler kodlanmadan ÖNCE düzeltilmesi
gereken 5 madde — bunlar üzerine inşa edilecek temelin kendisindeki
hatalar, "iyi olur" maddeleri değil:

1. **`fetchAutovacuumWorkerStatus()` (`AlertRuleEvaluator.java:2811-2815`)
   `count(*)` kullanıyor, `count(distinct pid)` değil.** Yukarıdaki
   "Örnekleme ve yeterlilik" bölümündeki tanıma göre yeniden yazılmalı.
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
6. **`HOT_SETTINGS_QUERY`'de (`NightlySnapshotCollector.java:119-129`)
   `autovacuum`, `vacuum_cost_delay`, `vacuum_cost_limit` yok** —
   sadece günlük `SETTINGS_QUERY`'de var. `ALTER SYSTEM SET
   vacuum_cost_limit = ...` gibi bir değişiklik 3 saatlik hot refresh'te
   yakalanmaz, en fazla 24 saat gecikebilir. Bu üç ayar
   `HOT_SETTINGS_QUERY`'ye de eklenmeli. `autovacuum_vacuum_cost_delay`/
   `autovacuum_vacuum_cost_limit` zaten her iki listede de var.

**Opsiyonel, AC2'nin zorunlu kapsamı DEĞİL:** I/O sayaçları
`previousIoSamples`'ta `Double` olarak tutulup `long`'a `.longValue()`
ile çevriliyor — gerçekçi PG sayaç büyüklüklerinde pratik bir
hassasiyet kaybı riski yok (`Double`'ın 52-bit tam sayı hassasiyeti
~9×10^15), ama tip uyuşmazlığı bir tasarım kusuru. Fırsat varsa
`Long`/`BigDecimal` tabanlı typed bir sample sınıfına geçilebilir.

## AC2 implementasyon sırası

0. Yukarıdaki 6 kod önkoşulunu (madde 1-6) düzelt.
1. `fetchAutovacuumWorkerStatus()`'u genişlet — tek SQL round-trip'te
   Teşhis 2 (`io_wait_samples`) ve Teşhis 2b (`throttle_sleep_samples`,
   `no_wait_event_samples`, `distinct_snapshots`) verilerini döndür,
   `>= 10 distinct snapshot_ts` yeterlilik kapısını uygula, PG13 altı
   için Teşhis 2b'yi `null`/"desteklenmiyor" işaretle.
2. Etkin cost ayarını (tablo override → instance ayarı → `-1` fallback)
   okuyan bir yardımcı fonksiyon yaz, `effectiveCostDelay > versionDefault`
   kapısını uygula (PG11: `20ms`, PG12+: `2ms`).
3. `fetchAutovacuumIoImpact(instancePk)` yaz (Teşhis 0) — `pg_major >= 16`
   guard'ı, `object='relation'` filtresi, client-read=0 durumunda oran
   üretmeme, "veri yok / gerçek sıfır / desteklenmiyor" ayrımı.
4. Tüm bunları senaryo 3 (`vacuum_ineffective`) ve senaryo 4.5'in
   (eşik yanlış kalibre) mesajlarına ek kanıt cümlesi olarak ekle —
   mevcut `dead_tuple_ratio` alert'inin (`AlertCode.USER_DEFINED_RULE`)
   üzerine, yeni bir alert tipi DEĞİL, adaptive alerting'e bağlama.
5. Opsiyonel: gecikme korelasyonu yardımcı fonksiyonunu (≥10 bucket
   gate'li) ekle.
6. Opsiyonel, daha sonra: `InstanceDetail.tsx`'e PG16+ instance'lar için
   bir "autovacuum I/O payı" mini-grafiği.

**Testler (AC2'nin bir parçası, en az):** PG12'de Teşhis 2b unsupported
(sıfır değil); PG13/15'te Teşhis 2b var ama Teşhis 0 unsupported; PG16+'ta
tüm teşhisler kullanılabilir; bilinmeyen `pg_major`; 9 distinct snapshot
yetersiz, tam 10 yeterli; tek snapshot'ta çok worker yeterli sayılmaz;
`runningWorkers` sadece en son snapshot'taki distinct pid; IO-wait ve
VacuumDelay birbirine karıştırılmıyor; varsayılan `cost_delay`'de
"düşür" önerisi yok; tablo override + yeterli throttle gözleminde
öneri var; `-1` fallback yolları; aynı isimli tablo farklı `dbid`'lerde
karışmıyor; `stats_reset` değişiminde delta yazılmıyor; client
reads=0 davranışı; scenario 3/4.5 kanıt içeriyor, diğer senaryolar
değişmiyor; hiçbir aksiyon metninde autovacuum kapatma önerisi yok;
`queryForList()`'in timestamp kolonları için döndürdüğü Java tipi
(`OffsetDateTime` veya `Timestamp`) her ikisi de test edilip güvenli
normalize ediliyor.

## Kaynaklar

- PostgreSQL resmi dok. — autovacuum'un kapatılmaması gerektiği:
  https://www.postgresql.org/docs/current/routine-vacuuming.html#AUTOVACUUM
- PostgreSQL 11 resmi dok. — `-1` sentinel davranışının PG11'de zaten
  mevcut olduğunun kanıtı (canlı çekilip doğrulandı):
  https://www.postgresql.org/docs/11/runtime-config-autovacuum.html
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
