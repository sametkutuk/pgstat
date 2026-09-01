-- V113: fiziksel nesil takibi (PGSTAT-P0-046 Faz 2)
--
-- NEDEN
-- -----
-- Fiziksel sisme kuralinin tabani su an bir UMUT: "28 gunde gordugum en dusuk
-- deger, umarim tablonun sikisik halidir". Gozlem penceresinde hic sikisik
-- olmamis bir tablo icin taban da siskin cikar, oran 1'e yakin gorunur ve
-- gercek sisme KACIRILIR.
--
-- VACUUM FULL / CLUSTER tabloyu yeni bir dosyaya yeniden yazar ve
-- pg_class.relfilenode degisir (kontrollu deney 2026-09-01: 87035068 ->
-- 87035078). O andaki olcum, TANIMI GEREGI sikisik haldir. Yani taban umut
-- degil kanit olabilir.
--
-- AMA relfilenode DEGISIMI "SIKISTI" DEMEK DEGIL
-- -----------------------------------------------
-- Dis inceleme hakli olarak uyardi: ALTER TABLE ... SET TABLESPACE yeni bir
-- filenode ayirip fork'lari BLOK BLOK kopyalar; mevcut sisme aynen korunur.
-- Bu olay ne tabandir ne ankraj. Bu yuzden ham sinyalin adi
-- "physical_generation_changed" ve siniflandirilmadan kullanilmaz.
--
-- TABAN NEDEN pg_relation_size DEGIL relpages
-- --------------------------------------------
-- Rewrite sonunda PostgreSQL relpages ve reltuples degerlerini BIRLIKTE yeni
-- heap'ten uretir — tutarli bir cift. Bizim 30 dakika sonra okudugumuz
-- pg_relation_size ise o arada buyumus olabilir ve event-time reltuples ile
-- karisir. relpages * block_size / reltuples, tespit gecikmesinden bagimsiz
-- olarak sikisik yogunlugu verir. Kapsam yalniz main fork.
--
-- YAZMA MALIYETI
-- --------------
-- Durum tablosuna her donguede DEGIL, yalnizca fiziksel nesil DEGISTIGINDE
-- yazilir. Aksi halde bugun PGSTAT-P0-047'de duzelttigimiz yazma cogaltmasinin
-- aynisini yeni bir tabloda uretirdik: 30 dakikada bir, on binlerce tablo icin
-- satir kopyalamak.

-- Fiziksel durumun son bilinen hali. Satir yalnizca degisimde guncellenir,
-- yani observed_at "en son gordugumuz an" degil, "bu nesli ILK gordugumuz an".
create table if not exists fact.pg_relation_physical_state (
  instance_pk   bigint      not null,
  dbid          oid         not null,
  relid         oid         not null,
  schemaname    text        not null,
  relname       text        not null,
  relfilenode   bigint      null,
  reltablespace oid         not null default 0,
  relpages      bigint      null,
  reltuples     bigint      null,
  first_seen_at timestamptz not null default now(),
  observed_at   timestamptz not null,
  primary key (instance_pk, dbid, relid)
);

comment on table fact.pg_relation_physical_state is
  'Her relation''in son bilinen fiziksel nesli. YALNIZCA nesil degistiginde yazilir; her toplama dongusunde degil (PGSTAT-P0-046 Faz 2). Bu tercih bilincli: her donguede yazmak, PGSTAT-P0-047''de duzeltilen yazma cogaltmasinin aynisini uretirdi.';

comment on column fact.pg_relation_physical_state.observed_at is
  'Bu fiziksel nesli ILK gordugumuz an. "En son gorulme" DEGIL — satir yalnizca nesil degistiginde yazildigi icin.';

comment on column fact.pg_relation_physical_state.reltablespace is
  'pg_class.reltablespace; 0 = veritabaninin varsayilan tablespace''i. relfilenode ile BIRLIKTE izlenir, cunku tablespace degisimi (SET TABLESPACE) sismeyi koruyarak filenode degistirir ve sikistirma sayilmamalidir.';

-- Nesil degisimleri. Append-only; yalnizca degisimde satir eklenir.
create table if not exists fact.pg_relation_rewrite_event (
  event_id         bigint generated always as identity primary key,
  instance_pk      bigint      not null,
  dbid             oid         not null,
  relid            oid         not null,
  schemaname       text        not null,
  relname          text        not null,
  -- Gercek rewrite ani BILINMIYOR; [window_start, observed_at] arasinda bir yerde.
  -- Tek bir kesin zaman UYDURULMAZ. Aralik aritmetigi (N_low = R - D,
  -- N_high = R + I) bu iki damgayi kullanacak.
  window_start     timestamptz null,
  observed_at      timestamptz not null,
  prev_relfilenode bigint      null,
  new_relfilenode  bigint      null,
  prev_tablespace  oid         null,
  new_tablespace   oid         null,
  new_relpages     bigint      null,
  new_reltuples    bigint      null,
  block_size       integer     null,
  -- relpages * block_size / reltuples. Rewrite'in kendi yazdigi tutarli cift.
  -- Yalnizca compacting_rewrite_candidate icin doldurulur.
  baseline_bytes_per_row numeric null,
  classification   text        not null,
  -- N=2 dogrulamasi: bir sonraki gozlemde nesil VE (relpages, reltuples) cifti
  -- ayni kaldiysa event tuple'i tutarlidir. Ortalama almak icin degil,
  -- olcumun kendi icinde tutarli oldugunu dogrulamak icin.
  confirmed_at     timestamptz null,
  constraint ck_rewrite_event_classification check (classification in (
    'compacting_rewrite_candidate',  -- ayni tablespace, filenode degisti, satir var
    'storage_move',                  -- tablespace degisti: sisme KORUNUR, taban degil
    'truncate',                      -- satir kalmadi
    'unknown'
  ))
);

comment on table fact.pg_relation_rewrite_event is
  'Fiziksel nesil degisimleri. Bir compacting_rewrite_candidate, dogrulandiginda (confirmed_at) fiziksel sisme kuralina KANITLI taban verir ve 21 gece / 28 gun istatistiksel kapisini gereksiz kilar (PGSTAT-P0-046 Faz 2).';

comment on column fact.pg_relation_rewrite_event.window_start is
  'Eski nesli en son gordugumuz an. Gercek rewrite [window_start, observed_at] arasindadir; tek bir an uydurulmaz.';

create index if not exists ix_rewrite_event_lookup
  on fact.pg_relation_rewrite_event (instance_pk, dbid, relid, observed_at desc);

create index if not exists ix_rewrite_event_unconfirmed
  on fact.pg_relation_rewrite_event (instance_pk, dbid)
  where confirmed_at is null;
