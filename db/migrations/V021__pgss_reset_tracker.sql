-- V021: pg_stat_statements reset tracking ve pre-reset snapshot scheduling
-- Reset pattern tespiti ve otomatik pre-reset data toplama

-- Reset geçmişi
create table if not exists control.pgss_reset_history (
  reset_id        bigserial primary key,
  instance_pk     bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  
  detected_at     timestamptz not null default now(),  -- collector'ın tespit ettiği zaman
  reset_epoch_key text,                                 -- yeni epoch key
  prev_epoch_key  text,                                 -- önceki epoch key
  
  -- Reset öncesi son bilinen değerler
  pre_reset_query_count   integer,
  pre_reset_total_calls   bigint,
  pre_reset_total_exec_ms double precision,
  
  -- Kayıp penceresi
  last_collect_before_reset timestamptz,  -- son başarılı statements collect
  data_loss_seconds         integer       -- tahmini kayıp süresi (saniye)
);

create index if not exists idx_pgss_reset_history_instance
  on control.pgss_reset_history (instance_pk, detected_at desc);

-- Reset pattern (tespit edilen periyodik reset schedule)
create table if not exists control.pgss_reset_schedule (
  instance_pk     bigint primary key references control.instance_inventory(instance_pk) on delete cascade,
  
  -- Tespit edilen pattern
  reset_hour      integer not null,       -- UTC saat (0-23)
  reset_minute    integer not null,       -- dakika (0-59)
  confidence      integer not null,       -- kaç ardışık reset pattern'e uydu
  tolerance_minutes integer default 5,    -- ±5 dakika tolerans
  
  -- Pre-reset snapshot ayarları
  pre_snapshot_offset_seconds integer default 30,  -- reset'ten kaç saniye önce snapshot al
  is_active       boolean default true,
  
  -- Doğrulama
  last_validated_at   timestamptz,        -- son pattern doğrulama zamanı
  missed_count        integer default 0,  -- pattern'e uymayan ardışık reset sayısı
  
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

comment on table control.pgss_reset_history is 'pg_stat_statements reset geçmişi — her tespit edilen reset kaydedilir';
comment on table control.pgss_reset_schedule is 'Tespit edilen periyodik reset pattern — pre-reset snapshot scheduling';
