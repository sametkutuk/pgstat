# pgstat İzlenen Veritabanlarına Etkisi

> "pgstat'ı kurarsam veritabanlarımı yorar mı, yavaşlatır mı?"
> Bu doküman bu sorunun kanıtlı cevabıdır.

## Kısa cevap (yönetici özeti)

pgstat izlenen veritabanlarında **yalnızca okuma (SELECT) yapar**, veri
değiştirmez, kimseyi bekletmez. Tipik yük, veritabanının toplam sorgu
işleme süresinin **%1-5'i** seviyesindedir — ihmal edilebilir. Gerçek
ölçüm UI'da "Instances → Yük Güvencesi" kartında canlı görülebilir.

## pgstat kaynak DB'de NE YAPAR

- **Sadece SELECT** — `pg_stat_*`, `pg_settings`, `pg_class`,
  `pg_replication_slots`, `pg_stat_activity`, `pg_locks`,
  `pg_stat_progress_*`, `pg_database`, `pg_stat_statements` gibi sistem
  view'larını okur.
- **Session ayarı** — her bağlantıda `SET statement_timeout`,
  `SET lock_timeout`, `application_name = 'pgstat_collector'` (veri
  değişmez, sadece koruma + izlenebilirlik).

## pgstat kaynak DB'de NE YAPMAZ

- ❌ INSERT / UPDATE / DELETE — veri değiştirmez
- ❌ DDL (CREATE / ALTER / DROP)
- ❌ VACUUM / ANALYZE — sadece **gözlemler**, çalıştırmaz
- ❌ `pg_stat_statements_reset()` — istatistik sıfırlamaz
- ❌ `CREATE EXTENSION` — extension'ı siz kurarsınız, pgstat kurmaz

## Veritabanını yavaşlatır / bekletir mi?

**Hayır.** Nedenleri:

1. **Salt-okuma → AccessShareLock.** Collector sorguları yalnızca
   `AccessShareLock` alır. Bu lock, normal okuma/yazma sorgularıyla
   **çakışmaz**. Yalnızca biri o tabloda `ACCESS EXCLUSIVE` (DDL) tutuyorsa
   kısa süreli etkileşim olabilir — o da nadirdir.

2. **statement_timeout koruması.** Collector sorgusu beklenenden uzun
   sürerse (varsayılan 30sn) otomatik kesilir. Kaynak DB'yi süresiz meşgul
   etmez.

3. **lock_timeout koruması.** Collector bir kilit bekliyorsa (varsayılan
   10sn) bekleme süresi sınırlıdır, sonra çekilir. Kaynak DB'yi kilitlemez.

4. **Hafif sorgular.** pg_stat_* view'ları milisaniye seviyesinde döner.
   Collector çok **sayıda** ama çok **hafif** sorgu yapar.

## Gereken yetki

- `CONNECT` (admin DB + izlenen database'ler)
- **`pg_monitor`** rolü — PostgreSQL'in yerleşik salt-okuma izleme rolü
- **Superuser GEREKMEZ.** `pg_monitor` yeterli ve güvenlidir.

```sql
-- Kaynak DB'de collector kullanicisi olusturma ornegi:
create role pgstats_collector login password '***';
grant pg_monitor to pgstats_collector;
-- pg_stat_statements extension'i onceden kurulu olmali:
create extension if not exists pg_stat_statements;
```

## Toplama sıklığı (ayarlanabilir)

`control.schedule_profile` ile her instance için ayarlanır:

| Job | Varsayılan sıklık | Ne toplar |
|-----|-------------------|-----------|
| cluster | 60 sn | bgwriter, wal, io, activity, locks, replication, slots, progress |
| statements | 300 sn | pg_stat_statements (sorgu istatistikleri) |
| db_objects | 1800 sn (30 dk) | tablo/index istatistikleri |
| nightly / 6 saatlik | gece + 6 saat | pg_settings, freeze age, boyutlar |

Bir DB'de pgstat yükü yüksek çıkarsa (UI'da görülür), o instance'ın
schedule profilini seyrekleterek pgstat payı düşürülebilir.

## Nasıl doğrularım / izlerim?

1. **UI — Yük Güvencesi kartı** (Instances sayfası): fleet geneli pgstat
   sorgu yükü payı, canlı.
2. **UI — Collector Ayak İzi** (Instance detayı): o DB'de pgstat'ın
   çalıştırdığı her sorgu + süresi + pgstat-vs-uygulama dağılımı.
3. **Kaynak DB'de doğrudan**:
   ```sql
   -- Collector su an ne yapiyor:
   select pid, state, query_start, left(query, 100)
   from pg_stat_activity
   where application_name = 'pgstat_collector';

   -- Collector'un toplam sorgu yuku (pg_stat_statements'ten):
   select sum(total_exec_time) as collector_total_ms, sum(calls) as collector_calls
   from pg_stat_statements s
   join pg_roles r on r.oid = s.userid
   where r.rolname = 'pgstats_collector';
   ```

## Önemli not — "DB sorgu yükü" vs "makine CPU/RAM"

UI'daki yüzdeler **DB sorgu işleme yükü** payıdır (`pg_stat_statements`
exec time / buffer). Bu, "makine CPU/RAM yüzdesi" **değildir** —
PostgreSQL sorgu başına OS kaynağı raporlamaz. Makine düzeyi CPU/RAM
izleme ayrı bir araç gerektirir (node_exporter vb.). pgstat'ın etkisini
"DB sorgu yükünün %X'i" olarak okuyun; bu, collector'un DB üzerindeki
gerçek yük payını gösterir.
