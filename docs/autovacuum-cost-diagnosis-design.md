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

## Teşhis 1: "Autovacuum sık çalışıyor, diğer sorguları yavaşlatıyor mu?"

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

**Kanıt yorumu:** İki satır çıkar — `autovacuum_active=true` ve `false`.
`weighted_mean_exec_ms` autovacuum aktifken **anlamlı ölçüde** (örn. %20+)
yüksekse, bu somut bir kanıt: "autovacuum çalışırken instance genelinde
ortalama sorgu süresi %X arttı". Küçük bir fark (~%5 içi) gürültü sayılabilir
— eşik alert kuralına parametre olarak eklenmeli.

**Sınırlama:** Korelasyon, nedensellik değil — aynı pencerede başka bir
sebepten (örn. trafik artışı) da gecikme artmış olabilir. Bu yüzden teşhis
metni "olası" ifadesi kullanmalı ama **sayıyla**: "olası" + "%X fark
gözlendi" — ikisi birlikte, ne kör tahmin ne de sahte kesinlik.

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

## Uygulama sırası (öneri)

1. Teşhis 1'in sorgusunu `AlertRuleEvaluator`'da yeni bir yardımcı metod
   (`fetchAutovacuumImpactOnLatency(instancePk)`) olarak kodla, sadece
   **alert tetiklenirken** çağır (maliyeti sınırlamak için — Teşhis 1'in
   sorgusu 2 saatlik pencerede `pgss_delta` join'i yapıyor, ucuz değil).
2. Bu kanıtı, senaryo 3 (`vacuum_ineffective`) ve senaryo 4.5'in (eşik
   yanlış kalibre) mesajlarına **ek bir cümle** olarak ekle: "Bu süre
   zarfında instance genelinde ortalama sorgu süresi %X arttı/değişmedi."
3. Teşhis 2'nin I/O-wait oranını `fetchAutovacuumWorkerStatus()`'a
   (zaten var olan worker sayısı fonksiyonuna) ek bir dönüş değeri olarak
   ekle, ayrı bir sorgu round-trip'i gerektirmez (aynı tablo, aynı filtre).
4. Görselleştirme (opsiyonel, daha sonra): `InstanceDetail.tsx`'e
   "autovacuum etkisi" mini-grafiği — autovacuum aktif pencereleri
   sorgu gecikmesi grafiğinin üzerine bindirilmiş şekilde.

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
