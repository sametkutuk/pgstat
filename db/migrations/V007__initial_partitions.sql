-- =============================================================================
-- V007: İlk partition oluşturma
-- Fact tabloları: 7 gün geçmiş + 14 gün gelecek (günlük)
-- agg.pgss_hourly: mevcut ay + 2 sonraki ay (aylık)
-- agg.pgss_daily: mevcut yıl + 1 sonraki yıl (yıllık)
-- =============================================================================

do $$
declare
  -- Günlük partition oluşturulacak fact tabloları
  daily_tables text[] := array[
    'fact.pgss_delta',
    'fact.pg_database_delta',
    'fact.pg_table_stat_delta',
    'fact.pg_index_stat_delta',
    'fact.pg_cluster_delta',
    'fact.pg_io_stat_delta',
    'fact.pg_activity_snapshot',
    'fact.pg_lock_snapshot',
    'fact.pg_progress_snapshot',
    'fact.pg_replication_snapshot'
  ];
  tbl text;
  d date;
  part_name text;
  start_val text;
  end_val text;
begin
  -- =========================================================================
  -- 1. Günlük fact partition'ları: 1 gün geçmiş + 3 gün gelecek
  -- =========================================================================
  foreach tbl in array daily_tables loop
    for d in select generate_series(
      current_date - interval '1 days',
      current_date + interval '3 days',
      interval '1 day'
    )::date loop
      -- Partition adı: schema.tablo_YYYYMMDD
      part_name := tbl || '_' || to_char(d, 'YYYYMMDD');
      start_val := d::text;
      end_val := (d + interval '1 day')::date::text;

      -- Partition yoksa oluştur
      execute format(
        'create table if not exists %s partition of %s for values from (%L) to (%L)',
        part_name, tbl, start_val, end_val
      );
    end loop;
  end loop;

  -- =========================================================================
  -- 2. Aylık agg.pgss_hourly partition'ları: mevcut ay + 2 sonraki ay
  -- =========================================================================
  for d in select generate_series(
    date_trunc('month', current_date)::date,
    (date_trunc('month', current_date) + interval '2 months')::date,
    interval '1 month'
  )::date loop
    part_name := 'agg.pgss_hourly_' || to_char(d, 'YYYYMM');
    start_val := d::text;
    end_val := (d + interval '1 month')::date::text;

    execute format(
      'create table if not exists %s partition of agg.pgss_hourly for values from (%L) to (%L)',
      part_name, start_val, end_val
    );
  end loop;

  -- =========================================================================
  -- 3. Yıllık agg.pgss_daily partition'ları: mevcut yıl + 1 sonraki yıl
  -- =========================================================================
  for d in select generate_series(
    date_trunc('year', current_date)::date,
    (date_trunc('year', current_date) + interval '1 year')::date,
    interval '1 year'
  )::date loop
    part_name := 'agg.pgss_daily_' || to_char(d, 'YYYY');
    start_val := d::text;
    end_val := (d + interval '1 year')::date::text;

    execute format(
      'create table if not exists %s partition of agg.pgss_daily for values from (%L) to (%L)',
      part_name, start_val, end_val
    );
  end loop;

  raise notice 'Partition oluşturma tamamlandı.';
end;
$$;
