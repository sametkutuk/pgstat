# Autovacuum Sistem Maliyeti Teşhisi — Tasarım Dokümanı

**Durum:** PGSTAT-P1-011 kapsamında tasarlandı, 2026-08-25. Henüz kodlanmadı.
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

## Teşhis 3: Otomatik "kapat" önerisi engeli

Kod tarafında (yeni bir yardımcı fonksiyon veya `diagnoseBloat()`'un
girişinde) bir assert/test: hiçbir aksiyon string'i `"autovacuum.*=.*off"`
veya `"autovacuum_enabled.*false"` regex'ine uymamalı — CI'da (birim test)
tüm sabit aksiyon metinlerinin bu deseni içermediği doğrulanabilir.

## Uygulama sırası (revize, Teşhis 0 öncelikli)

1. **Teşhis 0'ı (I/O maliyeti) önce kodla** — `fetchAutovacuumIoImpact(instancePk)`,
   `fact.pg_io_stat_delta`'dan `backend_type='autovacuum worker'` vs
   `backend_type='client backend'` karşılaştırması, 24 saatlik pencere.
   Bu, gerçek veriyle doğrulanmış, güvenilir bir sinyal — birincil kanıt
   bu olmalı. `track_io_timing` kapalıysa (zaman metrikleri hep 0) sadece
   `reads_delta`/`writes_delta` sayımına düş, hata verme.
2. Bu kanıtı senaryo 3 (`vacuum_ineffective`) ve senaryo 4.5'in (eşik
   yanlış kalibre) mesajlarına ekle: "Son 24 saatte autovacuum worker'lar
   X okuma/Y yazma yaptı, bu instance'taki uygulama trafiğinin Z katı."
3. Teşhis 2'nin I/O-wait oranını `fetchAutovacuumWorkerStatus()`'a
   (zaten var olan worker sayısı fonksiyonuna) ek bir dönüş değeri olarak
   ekle, ayrı bir sorgu round-trip'i gerektirmez (aynı tablo, aynı filtre).
4. **Teşhis 1'i (gecikme korelasyonu) opsiyonel/ikincil olarak ekle** —
   sadece her iki tarafta da yeterli örnek (≥10 bucket) varsa hesapla ve
   göster, aksi halde hiç gösterme; asla tek başına bir aksiyon önerisine
   dayanak yapma, sadece "ek bağlam, kesin değil" ifadesiyle sun.
5. Görselleştirme (opsiyonel, daha sonra): `InstanceDetail.tsx`'e
   "autovacuum I/O payı" mini-grafiği — autovacuum'un toplam I/O
   içindeki oranını zaman içinde gösteren bir alan grafiği.

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
