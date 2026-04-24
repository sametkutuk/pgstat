-- Smart alert altyapisi:
-- 1. alert_rule_last_eval'a baseline kolonlari
-- 2. alert_rule'a alert_category (smart | threshold)
-- 3. Yeni evaluation_type degerlerini constraint'e ekle

-- Baseline: periyodik olarak hesaplanan referans deger.
-- Son 4 haftalik saatlik ortalama veya tum zamanlarin ozeti.
alter table control.alert_rule_last_eval
  add column if not exists baseline_value        numeric,
  add column if not exists baseline_updated_at   timestamptz;

-- Kural kategorisi: 'smart' = esik gerektirmez, 'threshold' = manuel esik
alter table control.alert_rule
  add column if not exists alert_category text not null default 'threshold';

-- alert_category check constraint'i (idempotent)
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ck_alert_rule_category'
      and conrelid = 'control.alert_rule'::regclass
  ) then
    alter table control.alert_rule
      add constraint ck_alert_rule_category
      check (alert_category in ('smart', 'threshold'));
  end if;
end $$;

-- Smart kural icin: yeterli veri yoksa mutlak spike'a gecis esigi (opsiyonel)
-- Orn: %300 artis her zaman spike sayilir, veri az da olsa
alter table control.alert_rule
  add column if not exists spike_fallback_pct numeric;

-- Mevcut evaluation_type constraint'ini genislet
alter table control.alert_rule
  drop constraint if exists ck_alert_rule_eval_type;
alter table control.alert_rule
  drop constraint if exists alert_rule_evaluation_type_check;

alter table control.alert_rule
  add constraint ck_alert_rule_eval_type
    check (evaluation_type in (
      'threshold',
      'alltime_high', 'alltime_low',
      'day_over_day', 'week_over_week',
      'spike',        -- ani sicrama: son N dk vs onceki N dk
      'flatline',     -- counter N suredir hic artmadi
      'hourly_pattern' -- bu saatin 4 haftalik ortalamasiyla karsilastir
    ));

-- flatline icin: kac dakika hareketsizlik = alert (default 30)
alter table control.alert_rule
  add column if not exists flatline_minutes integer not null default 30;

comment on column control.alert_rule.alert_category    is 'smart: esik girmeden izleme, threshold: manuel esik';

-- Smart kurallar icin threshold zorunlulugunu kaldir
-- (V011'deki ck_alert_rule_threshold: warning OR critical NOT NULL)
alter table control.alert_rule
  drop constraint if exists ck_alert_rule_threshold;

alter table control.alert_rule
  add constraint ck_alert_rule_threshold check (
    alert_category = 'smart'
    or (warning_threshold is not null or critical_threshold is not null)
  );

comment on column control.alert_rule.spike_fallback_pct is 'Yeterli veri yokken mutlak spike esigi (%). Null = smart mod kapatilir';
comment on column control.alert_rule.flatline_minutes   is 'flatline: kac dakika hareketsizlik alert tetikler';
comment on column control.alert_rule_last_eval.baseline_value       is 'Son hesaplanan baseline referans degeri';
comment on column control.alert_rule_last_eval.baseline_updated_at  is 'Baseline en son ne zaman guncellendi';
