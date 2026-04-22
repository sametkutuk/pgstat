-- =============================================================================
-- V001: Schema oluşturma ve yardımcı fonksiyonlar
-- 5 schema: control, dim, fact, agg, ops
-- =============================================================================

create schema if not exists control;
create schema if not exists dim;
create schema if not exists fact;
create schema if not exists agg;
create schema if not exists ops;

-- updated_at kolonunu otomatik güncelleyen trigger fonksiyonu
create or replace function control.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
