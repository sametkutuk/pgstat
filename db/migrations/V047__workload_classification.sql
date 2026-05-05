-- V047: DB workload classification (OLTP/Analitik/Toplu/Karma/Boşta)
alter table dim.database_ref
    add column if not exists workload_label varchar(20),
    add column if not exists workload_label_auto varchar(20),
    add column if not exists workload_scores jsonb,
    add column if not exists workload_classified_at timestamptz;

-- Eşik konfigürasyonu (singleton)
create table if not exists control.workload_classification_config (
    config_id           smallint primary key default 1 check (config_id = 1),
    window_hours        smallint not null default 24,
    -- Eşikler — tunable. Burada sezgisel default'lar.
    oltp_min_tps        numeric  not null default 1.0,    -- < bu değerin altında OLTP olamaz
    oltp_max_avg_ms     numeric  not null default 50,     -- avg_exec_ms bunun altı OLTP
    analytic_min_avg_ms numeric  not null default 500,    -- avg_exec_ms bunun üstü analitik
    analytic_min_rows   numeric  not null default 5000,   -- rows/call bunun üstü analitik
    bulk_min_rows_write numeric  not null default 50000,  -- ins+upd/call bunun üstü bulk
    idle_max_calls      bigint   not null default 100,    -- pencere içinde calls bunun altı = idle
    mixed_max_dominant  numeric  not null default 50,     -- en yüksek skor bunun altıysa mixed
    updated_at          timestamptz not null default now()
);
insert into control.workload_classification_config (config_id) values (1)
on conflict (config_id) do nothing;

drop trigger if exists trg_workload_cfg_updated_at on control.workload_classification_config;
create trigger trg_workload_cfg_updated_at
    before update on control.workload_classification_config
    for each row execute function control.set_updated_at();

create index if not exists ix_db_ref_workload on dim.database_ref (instance_pk, workload_label_auto);
