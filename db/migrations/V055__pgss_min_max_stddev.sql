-- =============================================================================
-- V055: pg_stat_statements tum kolonlarini topla (eksik metrikler)
--
-- Mantik: TUM PG versiyonlarinin TUM pg_stat_statements kolonlari tek
-- merkezi tabloda toplanir. Versiyonda olmayan kolon NULL kalir.
-- Kolon isimleri PG13+ konvansiyonunu kullanir (min_exec_time vs min_time);
-- collector tarafinda PG11/12 alias ile mapleniyor.
--
-- Kolonlar:
--   - min/max/stddev exec/plan time (PG11+/PG13+)
--   - temp_blk_read/write_time (PG15+)
--   - wal_buffers_full (PG17+)
--   - jit_functions, jit_deform_count, jit_deform_time (PG14+/PG16+)
--   - stats_since, minmax_stats_since (PG15+)
--   - parallel_workers_to_launch/launched (PG18+)
-- =============================================================================

alter table fact.pgss_delta
  -- min/max/stddev exec time — tum versiyonlarda var (PG11/12'de min_time,
  -- PG13+'da min_exec_time olarak gelir, ayni kolona yazilir)
  add column if not exists min_exec_time_ms double precision null,
  add column if not exists max_exec_time_ms double precision null,
  add column if not exists stddev_exec_time_ms double precision null,

  -- min/max/stddev plan time — sadece PG13+'da var, eskiler null
  add column if not exists min_plan_time_ms double precision null,
  add column if not exists max_plan_time_ms double precision null,
  add column if not exists stddev_plan_time_ms double precision null,

  -- temp blk read/write time — PG15+ (delta deger)
  add column if not exists temp_blk_read_time_ms_delta double precision null,
  add column if not exists temp_blk_write_time_ms_delta double precision null,

  -- WAL buffers full — PG17+ (delta deger)
  add column if not exists wal_buffers_full_delta bigint null,

  -- JIT detail — PG14+ functions count, PG16+ deform
  add column if not exists jit_functions_delta bigint null,
  add column if not exists jit_deform_count_delta bigint null,
  add column if not exists jit_deform_time_ms_delta double precision null,

  -- Stats since — PG15+ (timestamp, delta degil)
  add column if not exists stats_since timestamptz null,
  add column if not exists minmax_stats_since timestamptz null,

  -- Parallel workers — PG18+ (delta deger)
  add column if not exists parallel_workers_to_launch_delta bigint null,
  add column if not exists parallel_workers_launched_delta bigint null;

comment on column fact.pgss_delta.min_exec_time_ms is
  'Periyot icindeki en hizli calisma (ms) — pg_stat_statements snapshot degeri';
comment on column fact.pgss_delta.max_exec_time_ms is
  'Periyot icindeki en yavas calisma (ms) — outlier tespiti';
comment on column fact.pgss_delta.stddev_exec_time_ms is
  'Calisma suresi standart sapma (ms) — degiskenlik gostergesi';
comment on column fact.pgss_delta.temp_blk_read_time_ms_delta is
  'Periyot icinde temp tablo okuma suresi delta (ms) — PG15+';
comment on column fact.pgss_delta.wal_buffers_full_delta is
  'WAL buffers full event sayisi (PG17+) — wal_buffers parametresi yetersiz mi?';
comment on column fact.pgss_delta.parallel_workers_launched_delta is
  'Baslatilan paralel worker sayisi (PG18+)';
