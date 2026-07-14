-- V087: Bridge existing monthly aggregate partition gaps caused by mixed
-- local-midnight and UTC-midnight boundaries.
--
-- This migration is intentionally conservative:
-- - it does not drop or rewrite existing partitions;
-- - it creates only gap partitions between adjacent existing partitions;
-- - every CREATE is exception-safe so upgrades do not fail on unexpected
--   live partition layouts.

do $$
declare
    parent_table text;
    parent_oid oid;
    parent_schema text;
    parent_rel text;
    gap record;
    gap_partition text;
    ddl text;
begin
    foreach parent_table in array array[
        'agg.pgss_hourly',
        'agg.pg_table_stat_hourly'
    ]
    loop
        parent_oid := to_regclass(parent_table);
        if parent_oid is null then
            continue;
        end if;

        if not exists (
            select 1
            from pg_partitioned_table
            where partrelid = parent_oid
        ) then
            continue;
        end if;

        select n.nspname, c.relname
          into parent_schema, parent_rel
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.oid = parent_oid;

        for gap in
            with raw_bounds as (
                select
                    child.oid,
                    child.relname,
                    regexp_match(
                        pg_get_expr(child.relpartbound, child.oid),
                        'FROM \(''([^'']+)''\) TO \(''([^'']+)''\)'
                    ) as bound_match
                from pg_inherits i
                join pg_class child on child.oid = i.inhrelid
                where i.inhparent = parent_oid
            ),
            bounds as (
                select
                    oid,
                    relname,
                    (bound_match)[1]::timestamptz as lower_bound,
                    (bound_match)[2]::timestamptz as upper_bound
                from raw_bounds
                where bound_match is not null
            ),
            ordered_bounds as (
                select
                    lower_bound,
                    upper_bound,
                    lag(upper_bound) over (order by lower_bound, upper_bound, oid) as prev_upper
                from bounds
            )
            select
                prev_upper as gap_lower,
                lower_bound as gap_upper
            from ordered_bounds
            where prev_upper is not null
              and prev_upper < lower_bound
        loop
            gap_partition := left(
                parent_rel
                || '_gap_'
                || to_char(gap.gap_lower, 'YYYYMMDDHH24MI')
                || '_'
                || to_char(gap.gap_upper, 'HH24MI'),
                63
            );

            ddl := format(
                'create table if not exists %I.%I partition of %I.%I for values from (%L) to (%L)',
                parent_schema,
                gap_partition,
                parent_schema,
                parent_rel,
                gap.gap_lower,
                gap.gap_upper
            );

            begin
                execute ddl;
            exception when others then
                null;
            end;
        end loop;
    end loop;
end $$;
