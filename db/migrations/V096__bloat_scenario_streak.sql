-- V096: senaryo israr sayaci — "birazdan temizlenecek" durumlarini alert
-- yapmamak icin
--
-- Musteri talebi (2026-08-27): "bazi alertlerde birazdan calisacak diyor,
-- bloat oranini yeni astigini soyluyor. Bunu alert olarak vermeyelim, takip
-- edelim; gercekten yetisemedigini tespit edersek alert olsun."
--
-- Sorun: diagnoseBloat()'un senaryo 4'u ("bloat yeni olusmus/artiyor,
-- autovacuum henuz yetismemis olabilir") aksiyon gerektirmeyen, kendi
-- kendine duzelen bir durumu anlatiyor — cogu zaman toplama anina denk
-- gelmis gecici bir olu satir birikimi. Ama ayni gorunum ISRAR ederse
-- gercekten "yetisemiyor" demektir. Ikisi tek bir olcumde ayirt edilemez;
-- sadece zaman icinde ayrisirlar.
--
-- Cozum: senaryo 4 gorulunce alert acmak yerine bir sayac tut. Ust uste
-- STREAK_THRESHOLD (kod tarafinda 3) degerlendirmede ayni tabloda senaryo 4
-- + artan trend gorulurse, artik gecici degil kalici bir sorun kabul edilip
-- alert acilir.
--
-- Neden kalici tablo (in-memory degil): collector her deploy'da yeniden
-- baslar; in-memory bir sayac her restart'ta sifirlanir ve israrli bir sorun
-- surekli ertelenir — PGSTAT-P1-009'da belgelenen ayni tuzak.
--
-- Kacirma riski YOK: senaryo 4, karar agacinda 3 (vacuum_ineffective),
-- 3.5 (24 saattir vacuum yok) ve 2 (xmin horizon) senaryolarindan SONRA
-- gelir. Gercekten yetisemeyen bir tablo zaten o daha kesin testlere takilir
-- ve aninda alert uretir; senaryo 4'e dusen kayit, tanimi geregi onlarin
-- hicbirine takilmamis demektir.

create table if not exists control.bloat_scenario_streak (
  instance_pk bigint not null,
  dbid oid not null,
  relid oid not null,
  scenario text not null,              -- su an sadece 'scenario_4', ileride baskalari eklenebilir
  streak_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_dead_tup bigint null,           -- trend karsilastirmasi icin son gorulen deger
  primary key (instance_pk, dbid, relid, scenario),
  constraint ck_bloat_streak_count check (streak_count > 0)
);

comment on table control.bloat_scenario_streak is
  'dead_tuple_ratio karar agacinda "kendi kendine duzelebilir" senaryolarin ust uste kac degerlendirmede gorulduguni sayar. Esik asilinca gecici birikim degil kalici sorun kabul edilir ve alert acilir. Delta degil, upsert edilen bir durum tablosu (V096, PGSTAT-P1-011 devami).';

comment on column control.bloat_scenario_streak.streak_count is
  'Ust uste ayni senaryonun gorulme sayisi. Senaryo degisirse veya sorun duzelirse satir silinir (sayac sifirlanir).';

comment on column control.bloat_scenario_streak.last_dead_tup is
  'Son degerlendirmedeki olu satir sayisi — trendin gercekten artmaya devam ettigini dogrulamak icin. Trend artmiyorsa streak ilerletilmez.';

-- Purge: cok eski satirlar (artik degerlendirilmeyen tablolar) birikmesin.
create index if not exists ix_bloat_scenario_streak_last_seen
  on control.bloat_scenario_streak (last_seen_at);
