-- V049: Workload classification — uzun vade (90g) görünümü
-- 24h kısa vade (saatte 1) yanında 90g uzun vade (günde 1) profili tutulur.
alter table dim.database_ref
    add column if not exists workload_label_long varchar(20),
    add column if not exists workload_scores_long jsonb,
    add column if not exists workload_classified_long_at timestamptz;

-- Eşik konfigürasyonuna uzun-vade pencere genişliği eklendi
alter table control.workload_classification_config
    add column if not exists long_window_days smallint not null default 90
        check (long_window_days between 7 and 365);
