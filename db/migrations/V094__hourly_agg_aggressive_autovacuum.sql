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
-- DUZELTME (ilk versiyon PG15'te "unrecognized parameter" hatasi verdi):
-- arastirma sonucu (2026-08-25) VACUUM tarafi reloption'larinin
-- (autovacuum_vacuum_scale_factor/threshold) hicbir PostgreSQL surumunde
-- (PG10-17 dahil) partition edilmis PARENT tabloya set edilemedigini
-- gosterdi — sadece ANALYZE tarafi (autovacuum_analyze_*) ve
-- autovacuum_enabled PG14+'ta parent'a set edilebiliyor, VACUUM fiziksel
-- storage uzerinde calistigi icin parent'in (storage'i olmayan) bu
-- ayarlari hic bir zaman desteklenmedi. Resmi dokuman (PG15 CREATE TABLE):
-- "Specifying these parameters for partitioned tables is not supported,
-- but you may specify them for individual leaf partitions."
--
-- Bu yuzden ayar MEVCUT tum partition'lara (leaf) tek tek uygulanir —
-- pg_inherits uzerinden agg.pg_table_stat_hourly/agg.pgss_hourly'nin
-- alt partition'lari bulunup donguyle ALTER TABLE calistirilir. Gelecekte
-- olusturulacak partition'lar icin PartitionManager.java'ya (yeni ay
-- partition'i olustururken WITH (...) ekleyecek sekilde) ayri bir kod
-- degisikligi PGSTAT-P1-010 AC4 olarak takip ediliyor.
--
-- IKINCI DUZELTME (canli deploy 2026-08-25): bazi partition'larin
-- (202606-202608) sahibi migration'i calistiran uygulama kullanicisi
-- (ornegin pgstatuser) degil, gecmiste farkli bir kullanici (ornegin
-- primeit) ile olusturulmus — bu yuzden "must be owner of table" hatasi
-- alindi. ALTER TABLE ... SET (...) calistirmadan once o partition'in
-- sahibi degilsek current_user'a OWNER TO ile sahiplik devrediliyor —
-- boylece hem bu migration hem gelecekteki migration'lar/ALTER'lar
-- tutarli sekilde calisir, sahiplik tutarsizligi kalici olarak giderilir.

do $$
declare
  part record;
begin
  for part in
    select c.relname, o.rolname as owner
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = p.relnamespace
    join pg_roles o on o.oid = c.relowner
    where n.nspname = 'agg' and p.relname in ('pg_table_stat_hourly', 'pgss_hourly')
  loop
    if part.owner <> current_user then
      execute format('alter table agg.%I owner to %I', part.relname, current_user);
    end if;
    execute format(
      'alter table agg.%I set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 5000)',
      part.relname
    );
  end loop;
end $$;

comment on table agg.pg_table_stat_hourly is
  'Saatlik table-stat rollup. autovacuum_vacuum_scale_factor/threshold V094''te dusurulmustur — rollup jobu bu tabloyu ~5dk''da bir UPSERT ile yeniden yazdigi icin varsayilan esik (satir sayisina gore ~1.4M) cok gec tetikleniyordu.';

comment on table agg.pgss_hourly is
  'Saatlik statement rollup. autovacuum_vacuum_scale_factor/threshold V094''te dusurulmustur — pg_table_stat_hourly ile ayni UPSERT deseni, ayni gerekce.';
