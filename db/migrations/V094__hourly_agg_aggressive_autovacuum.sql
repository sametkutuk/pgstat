-- V094: agg.pg_table_stat_hourly / agg.pgss_hourly icin daha agresif autovacuum
--
-- Kok neden arastirmasi (2026-08-25): bu iki tablo AggRepository.rollupXxxHourly()
-- tarafindan her ~5 dakikada bir, o anki saatlik bucket icin AYNI satirlar
-- UPSERT (on conflict do update) ile yeniden yaziliyor (bkz. AggRepository.java,
-- JobOrchestrator.java readHourlyRollupIntervalSec). Bu, saatte ~12 kez tekrarlanan
-- gercek UPDATE anlamina gelir — n_live_tup sabit kalirken n_dead_tup surekli
-- birikir (musteri gozlemi: agg.pg_table_stat_hourly_202608 14 gunde 1457MB'tan
-- 2723MB'a cikti, canli veriyle dogrulandi: n_live_tup=7,062,216 sabit,
-- n_dead_tup birkac saatte 1.12M'den 1.19M'ye cikti).
--
-- Varsayilan autovacuum esigi (threshold=50 + scale_factor=0.2 × live_tup) bu
-- olcekte (~7M satir) cok yuksek bir mutlak esige denk geliyor (~1.4M olu
-- satir) — tetiklenmesi gunler surebilir, bu surede tablo gereksiz yere
-- buyumeye devam eder. Bu iki tablo, boyutlarina gore degil, YUKSEK UPDATE
-- SIKLIGINA gore ayarlanmali: kucuk sabit bir esik (scale_factor=0) + dusuk
-- mutlak esik ile her rollup dongusunden sonra (pratikte) autovacuum
-- tetiklenebilir hale getiriliyor.
--
-- ALTER TABLE ... SET (...) partition edilmis parent tabloda calisir ve
-- PG11+'ta hem mevcut hem gelecekte olusturulacak partition'lara otomatik
-- yayilir (create_partition sirasinda inherit edilir) — tek tek partition'lara
-- ayri ayri uygulamaya gerek yok.

alter table agg.pg_table_stat_hourly set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 5000
);

alter table agg.pgss_hourly set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 5000
);

comment on table agg.pg_table_stat_hourly is
  'Saatlik table-stat rollup. autovacuum_vacuum_scale_factor/threshold V094''te dusurulmustur — rollup jobu bu tabloyu ~5dk''da bir UPSERT ile yeniden yazdigi icin varsayilan esik (satir sayisina gore ~1.4M) cok gec tetikleniyordu.';

comment on table agg.pgss_hourly is
  'Saatlik statement rollup. autovacuum_vacuum_scale_factor/threshold V094''te dusurulmustur — pg_table_stat_hourly ile ayni UPSERT deseni, ayni gerekce.';
