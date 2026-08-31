-- V109: boyut anlik goruntusune kimlik, fillfactor rejimi ve satir ankraji
--
-- Dis inceleme (2026-08-31) fiziksel sisme olcumunde iki cozulmemis sorun
-- birakmisti. Ikisi de bu migration'in ekledigi alanlar olmadan cozulemiyor.
--
-- 1) KIMLIK — fact.pg_relation_size_snapshot tablolari ADLA kimlikliyordu
-- ----------------------------------------------------------------------
-- V039 birincil anahtari (snapshot_ts, instance_pk, dbid, schemaname,
-- relname). relid yok. Sonuclari:
--   - ALTER TABLE ... RENAME, tablonun gecmisini ikiye boler; yeni ad icin
--     gecmis yokmus gibi gorunur
--   - DROP + CREATE ya da adin baska bir tabloya verilmesi, IKI FARKLI
--     tablonun olcumlerini tek gecmis gibi birlestirir
--
-- Ikincisi tehlikeli: "tarihsel minimum" baska bir tablonun yogunlugu olur ve
-- saglikli bir tablo sismis gibi raporlanir.
--
-- 2) ZAMAN ANKRAJI — boyut ile satir sayisi ayni ani temsil etmiyordu
-- -------------------------------------------------------------------
-- Pay, T anindaki table_size_bytes. Payda ise reltuples. Ama reltuples T'de
-- degil, o tabloda en son calisan VACUUM/ANALYZE aninda (A) guncellenmistir
-- ve A, T'den aylarca once olabilir.
--
-- Dogru satir sayisi: reltuples + toplam(ins - del)  [A ile T arasi]
--
-- Bunun icin A'nin ne oldugunu BILMEK gerekiyor — bu yuzden dort zaman
-- damgasinin en yenisi ankraj olarak saklaniyor. Delta gecmisimiz A'ya kadar
-- uzanmiyorsa aradaki degisim bilinemez ve dedektor o kaydi ATLAMALI;
-- koprulenemeyen bir farki tahmin etmek, sismeyi uydurmak olur.
--
-- 3) FILLFACTOR REJIMI
-- --------------------
-- Taban (tarihsel en yogun gozlem) hangi fillfactor ile olculduyse, tasarim
-- geregi bos alani zaten icerir. V104'te eklenen (100/fillfactor) carpani bu
-- yuzden ayni payi ikinci kez dusuyordu ve V108'de kaldirildi.
--
-- Ama asil ihtiyac carpan degil: taban ile mevcut gozlem AYNI rejimde
-- olmali. fillfactor degistiyse eski taban karsilastirilamaz. Bunu
-- anlayabilmek icin fillfactor her gozlemle birlikte saklanmali —
-- control.table_relopts_snapshot yalnizca SU ANKI degeri tutuyor, gecmisi
-- yok.

alter table fact.pg_relation_size_snapshot
  add column if not exists relid bigint null,
  add column if not exists fillfactor integer null,
  add column if not exists reltuples_anchor_at timestamptz null;

comment on column fact.pg_relation_size_snapshot.relid is
  'pg_class.oid — tablonun kimligi. Gecmis eslesmesi ADLA degil bununla yapilir: rename gecmisi bolmesin, yeniden kullanilan bir ad iki farkli tabloyu birlestirmesin. NULL = V109 oncesi satir, gecmis eslesmesinde kullanilamaz (V109, PGSTAT-P0-046).';

comment on column fact.pg_relation_size_snapshot.fillfactor is
  'Bu gozlem anindaki etkin fillfactor (reloptions''ta yoksa 100). Taban ile mevcut gozlem AYNI rejimde degilse karsilastirma gecersizdir — carpan olarak degil, rejim ayirici olarak kullanilir (V109, PGSTAT-P0-046).';

comment on column fact.pg_relation_size_snapshot.reltuples_anchor_at is
  'reltuples''in hangi ana ait oldugu: son vacuum/autovacuum/analyze/autoanalyze zamanlarinin en yenisi. reltuples yalnizca bu islemlerde guncellenir, yani snapshot_ts''de degil BURADA olculmustur. Dogru satir sayisi icin bu an ile snapshot_ts arasindaki ins/del delta''lari eklenmelidir; delta gecmisi bu ana kadar uzanmiyorsa kayit atlanmalidir. NULL = tablo hic vacuum/analyze gormemis, reltuples zaten guvenilmez (V109, PGSTAT-P0-046).';

-- Kimlik uzerinden gecmis taramasi
create index if not exists ix_pg_relation_size_identity
  on fact.pg_relation_size_snapshot (instance_pk, dbid, relid, snapshot_ts desc)
  where relid is not null and reltuples is not null and table_size_bytes is not null;
