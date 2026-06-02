-- V069: agg.pg_table_stat_hourly tablosunu mevcut fact.pg_table_stat_delta
-- verisi ile backfill et. V068'de tablo yeni olusturuldu, dolu degil;
-- collector saatlik rollup'i ileri donuk calisir. Bu migration son
-- 7 gunluk (raw retention) veriyi tek seferde aggregate'e dokerek
-- Vacuum Lag 30g pencerelerinin de hemen dolu cikmasini saglar.
--
-- Idempotent: ON CONFLICT DO UPDATE — re-run guvenli.

-- Partition'larin onceden var olmasi gerekir; PartitionManager startup'ta
-- ensureMonthlyPartitions cagirir. Collector restart sonrasi tetiklenir.
-- Manuel calistirma icin (migration sirasinda partition yoksa) once
-- partition olusturmak gerek. Mevcut ay icin one-shot partition guard:

do $$
declare
    cur_month_start date := date_trunc('month', now())::date;
    cur_month_end date := (cur_month_start + interval '1 month')::date;
    prev_month_start date := (cur_month_start - interval '1 month')::date;
    cur_part_name text := format('pg_table_stat_hourly_%s', to_char(cur_month_start, 'YYYYMM'));
    prev_part_name text := format('pg_table_stat_hourly_%s', to_char(prev_month_start, 'YYYYMM'));
begin
    -- Onceki ay partition (eger 7g geriye gidiyorsa ay kaymasi olabilir)
    execute format(
        'create table if not exists agg.%I partition of agg.pg_table_stat_hourly for values from (%L) to (%L)',
        prev_part_name,
        prev_month_start::text,
        cur_month_start::text
    );
    -- Mevcut ay
    execute format(
        'create table if not exists agg.%I partition of agg.pg_table_stat_hourly for values from (%L) to (%L)',
        cur_part_name,
        cur_month_start::text,
        cur_month_end::text
    );
end$$;

-- Mevcut fact verisini bucket'a yigip aggregate'e ekle
insert into agg.pg_table_stat_hourly (
    bucket_start, instance_pk, dbid, relid, schemaname, relname,
    n_tup_ins_sum, n_tup_upd_sum, n_tup_del_sum, n_tup_hot_upd_sum,
    vacuum_count_sum, autovacuum_count_sum,
    analyze_count_sum, autoanalyze_count_sum,
    seq_scan_sum, idx_scan_sum,
    n_live_tup_last, n_dead_tup_last, n_mod_since_analyze_last,
    last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
)
select
    date_trunc('hour', sample_ts) as bucket_start,
    instance_pk, dbid, relid, schemaname, relname,
    sum(coalesce(n_tup_ins_delta, 0))::bigint as n_tup_ins_sum,
    sum(coalesce(n_tup_upd_delta, 0))::bigint as n_tup_upd_sum,
    sum(coalesce(n_tup_del_delta, 0))::bigint as n_tup_del_sum,
    sum(coalesce(n_tup_hot_upd_delta, 0))::bigint as n_tup_hot_upd_sum,
    sum(coalesce(vacuum_count_delta, 0))::bigint as vacuum_count_sum,
    sum(coalesce(autovacuum_count_delta, 0))::bigint as autovacuum_count_sum,
    sum(coalesce(analyze_count_delta, 0))::bigint as analyze_count_sum,
    sum(coalesce(autoanalyze_count_delta, 0))::bigint as autoanalyze_count_sum,
    sum(coalesce(seq_scan_delta, 0))::bigint as seq_scan_sum,
    sum(coalesce(idx_scan_delta, 0))::bigint as idx_scan_sum,
    -- Snapshot LAST: bucket icindeki son sample
    (array_agg(n_live_tup_estimate order by sample_ts desc))[1] as n_live_tup_last,
    (array_agg(n_dead_tup_estimate order by sample_ts desc))[1] as n_dead_tup_last,
    (array_agg(n_mod_since_analyze order by sample_ts desc))[1] as n_mod_since_analyze_last,
    max(last_vacuum) as last_vacuum,
    max(last_autovacuum) as last_autovacuum,
    max(last_analyze) as last_analyze,
    max(last_autoanalyze) as last_autoanalyze
from fact.pg_table_stat_delta
where sample_ts >= now() - interval '7 days'
  and sample_ts <  date_trunc('hour', now())  -- mevcut saati ileride collector dolduracak
group by date_trunc('hour', sample_ts), instance_pk, dbid, relid, schemaname, relname
on conflict (bucket_start, instance_pk, dbid, relid) do update set
    n_tup_ins_sum = excluded.n_tup_ins_sum,
    n_tup_upd_sum = excluded.n_tup_upd_sum,
    n_tup_del_sum = excluded.n_tup_del_sum,
    n_tup_hot_upd_sum = excluded.n_tup_hot_upd_sum,
    vacuum_count_sum = excluded.vacuum_count_sum,
    autovacuum_count_sum = excluded.autovacuum_count_sum,
    analyze_count_sum = excluded.analyze_count_sum,
    autoanalyze_count_sum = excluded.autoanalyze_count_sum,
    seq_scan_sum = excluded.seq_scan_sum,
    idx_scan_sum = excluded.idx_scan_sum,
    n_live_tup_last = excluded.n_live_tup_last,
    n_dead_tup_last = excluded.n_dead_tup_last,
    n_mod_since_analyze_last = excluded.n_mod_since_analyze_last,
    last_vacuum = excluded.last_vacuum,
    last_autovacuum = excluded.last_autovacuum,
    last_analyze = excluded.last_analyze,
    last_autoanalyze = excluded.last_autoanalyze;

comment on table agg.pg_table_stat_hourly is
    'pg_stat_user_tables saatlik rollup. V069 ile son 7 gun backfilled.';
