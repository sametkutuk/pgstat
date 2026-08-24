-- V093: tablo-ozel reloptions (autovacuum_enabled override) anlik durumu
--
-- Musteri talebi (2026-08-24): dead_tuple_ratio "hic vacuum edilmemis"
-- teshisinde, global autovacuum ayari acik ve esik asilmis oldugu halde
-- hala vacuum calismamissa, tek aciklama tabloya ozel
-- autovacuum_enabled=false override'i (pg_class.reloptions) olabilir.
-- Bu "olabilir" ifadesini "kesin" hale getirmek icin, bu override'in
-- kendisini toplamamiz gerekiyor — kullanici "bunu da kontrol edebilirsin,
-- neden autovacuum tetiklenmemis onu tespit et" dedi.
--
-- reloptions bir delta degil, nadiren degisen bir konfigurasyon —
-- fact.pg_table_stat_delta'nin 33 parametreli insert metoduna eklemek
-- yerine ayri, kucuk bir tabloda tutuluyor (instance_pk, dbid, relid) UPSERT
-- ile guncellenir, her toplama donguesunde yeni satir eklenmez.

create table if not exists control.table_relopts_snapshot (
  instance_pk bigint not null,
  dbid oid not null,
  relid oid not null,
  schemaname text not null,
  relname text not null,
  autovacuum_enabled boolean null,  -- reloptions'ta hic gecmiyorsa null (varsayilan: acik)
  reloptions_raw text null,          -- ham reloptions dizisi, virgulle ayrilmis, teshis/debug icin
  updated_at timestamptz not null default now(),
  primary key (instance_pk, dbid, relid)
);

comment on table control.table_relopts_snapshot is
  'Tablo duzeyinde autovacuum_enabled override durumu (pg_class.reloptions). Delta degil, her toplama donguesunde UPSERT edilir. dead_tuple_ratio "hic vacuum edilmemis" teshisinde kesin sonuc icin kullanilir (V093, PGSTAT-P0-036).';

create index if not exists ix_table_relopts_snapshot_lookup
  on control.table_relopts_snapshot (instance_pk, schemaname, relname);
