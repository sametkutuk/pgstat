-- V112: dim tablolarinda HOT update'in onunu ac (PGSTAT-P0-047)
--
-- OLCUM (merkezi DB, 2026-09-01)
-- ------------------------------
--   dim.statement_series   942 MB   1.761.565 canli satir
--     n_tup_ins        92.902
--     n_tup_upd   721.732.172      -> eklenen satir basina ~7.800 guncelleme
--     n_tup_hot_upd         0      -> %0.0
--
--   dim.relation_ref        30 MB
--     n_tup_ins         2.801
--     n_tup_upd    27.529.066
--     n_tup_hot_upd         0      -> %0.0
--
-- Sebep, ayni veritabanindaki kontrol grubuyla belirlendi, tahminle degil:
--   dim.database_ref  n_tup_upd 37.840, n_tup_hot_upd 18.916 -> %50 HOT
-- Uc tablonun tek farki, database_ref'in last_seen_at'inin INDEKSLI OLMAMASI.
-- HOT update'in sarti, guncellemenin hicbir indeksli kolona dokunmamasi ve
-- sayfada yer bulunmasidir. Indeksli last_seen_at her donguede degistigi icin
-- her guncelleme hem heap'e hem indekse yeni satir yaziyordu.
--
-- Olu satir orani %4.6'da kaliyordu: ne autovacuum bunu sorun sayar, ne de
-- dead_tuple_ratio alarmi gorebilir. Alan hicbir zaman geri verilmiyordu.
--
-- INDEKSLERI KALDIRMAK NEDEN GUVENLI
-- ----------------------------------
-- Kod tarafi tarandi, varsayilmadi:
--   - collector: dim last_seen_at HIC OKUNMUYOR, yalnizca yaziliyor.
--   - api/statements.ts: "order by ss.last_seen_at desc" var, ama ayni sorgu
--     "where qt.query_text ilike $1" ile filtreliyor; bastan tarama yapiyor,
--     indeksi kullanmiyor.
--   - api/insights.ts: dim.relation_ref join'leri (instance_pk, dbid, relid)
--     uzerinden, yani uq_relation_ref ile.
--   - api/instances.ts: "order by d.last_seen_at" dim.database_ref'e ait,
--     bu tablonun boyle bir indeksi zaten yok.
-- Geriye kalan tek musteri, eski satirlari bulacak olan purge (PGSTAT-P0-023).
-- Saatte bir kosan bir is icin 1.7M satirlik tarama kabul edilebilir.
--
-- dim.query_text'e DOKUNULMUYOR: olcumu 6.810 guncelleme ve 569 olu satir,
-- yani orada churn yok. Onun 316 MB'i gercek sorgu metni ve sorunu retention
-- (PGSTAT-P0-023), sisme degil.

drop index if exists dim.ix_statement_series_last_seen;
drop index if exists dim.ix_relation_ref_last_seen;

-- fillfactor: HOT zincirinin sayfada yer bulabilmesi icin bosluk birakir.
-- Indeks kalksa bile sayfa doluysa HOT olmaz; ikisi birlikte gerekli.
--
-- NOT: fillfactor yalnizca BUNDAN SONRA yazilan sayfalar icin gecerlidir.
-- Mevcut dolu sayfalar tablo yeniden yazilana kadar oyle kalir. Birikmis
-- sismenin geri alinmasi ayri bir adim (PGSTAT-P0-047 AC6) ve yazma hizi
-- duzeldigi olculmeden yapilmamali; once yapilirsa birkac haftada geri siser.
alter table dim.statement_series set (fillfactor = 85);
alter table dim.relation_ref     set (fillfactor = 85);

comment on column dim.statement_series.last_seen_at is
  'Serinin en son goruldugu an. BIR SAATE KADAR ESKI OLABILIR: her toplama dongusunde degil, bayatladiginda tazelenir (PGSTAT-P0-047). Her donguede yazmak, satir basina gunde 288 kopya demekti ve tabloyu 1.76M satir icin 942 MB yapmisti. Collector bu kolonu okumaz; okuyan tek yer API arama sonucu siralamasidir ve orada bir saatlik kayma fark edilmez. Toplama sikligi DEGISMEDI, yalnizca damganin yeniden yazilmasi seyreldi.';

comment on column dim.relation_ref.last_seen_at is
  'Relation''in en son goruldugu an. BIR SAATE KADAR ESKI OLABILIR; ayni gerekce, bkz. dim.statement_series.last_seen_at (PGSTAT-P0-047). Sema/tablo adi degistiginde damga beklemeden yazilir, cunku ad degisikligi kaydedilmek zorundadir.';
