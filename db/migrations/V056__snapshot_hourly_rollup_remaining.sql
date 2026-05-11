-- V056: Activity / Lock / Replication / SLRU için hourly rollup (V055 devamı)

-- Activity: state bazlı sayım + max query duration
create table if not exists agg.pg_activity_hourly (
    hour_ts                       timestamptz not null,
    instance_pk                   bigint      not null,
    sample_count                  integer     not null,
    active_count_max              integer     null,
    idle_count_max                integer     null,
    idle_in_tx_count_max          integer     null,
    waiting_count_max             integer     null,
    total_sessions_max            integer     null,
    max_query_duration_seconds    integer     null,
    max_xact_duration_seconds     integer     null,
    primary key (hour_ts, instance_pk)
);
create index if not exists ix_pg_activity_hourly_instance_ts
    on agg.pg_activity_hourly (instance_pk, hour_ts desc);

-- Lock: kilitlenme sayısı + max bekleme
create table if not exists agg.pg_lock_hourly (
    hour_ts                  timestamptz not null,
    instance_pk              bigint      not null,
    sample_count             integer     not null,
    waiting_locks_max        integer     null,    -- granted=false max sayı
    granted_locks_max        integer     null,
    max_wait_seconds         integer     null,    -- max waitstart farkı
    primary key (hour_ts, instance_pk)
);
create index if not exists ix_pg_lock_hourly_instance_ts
    on agg.pg_lock_hourly (instance_pk, hour_ts desc);

-- Replication: standby sayısı + max lag
create table if not exists agg.pg_replication_hourly (
    hour_ts                    timestamptz not null,
    instance_pk                bigint      not null,
    sample_count               integer     not null,
    standby_count_max          integer     null,
    max_replay_lag_bytes       bigint      null,
    max_replay_lag_seconds     numeric     null,
    primary key (hour_ts, instance_pk)
);
create index if not exists ix_pg_replication_hourly_instance_ts
    on agg.pg_replication_hourly (instance_pk, hour_ts desc);

-- SLRU: cache bazlı saatlik delta (her name için ayrı satır)
create table if not exists agg.pg_slru_hourly (
    hour_ts             timestamptz not null,
    instance_pk         bigint      not null,
    name                text        not null,
    sample_count        integer     not null,
    blks_hit_delta      bigint      null,
    blks_read_delta     bigint      null,
    blks_written_delta  bigint      null,
    flushes_delta       bigint      null,
    primary key (hour_ts, instance_pk, name)
);
create index if not exists ix_pg_slru_hourly_instance_ts
    on agg.pg_slru_hourly (instance_pk, hour_ts desc);
