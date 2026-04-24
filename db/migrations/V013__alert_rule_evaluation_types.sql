-- Alert kural tipleri ve alert tablosu iyileştirmeleri

-- evaluation_type: hangi karşılaştırma yöntemi kullanılacak
-- threshold      → sabit eşik (mevcut davranış)
-- alltime_high   → tüm zamanlar rekoru aşıldı mı
-- alltime_low    → tüm zamanlar en düşüğün altına düştü mü
-- day_over_day   → dünün aynı saatine göre % değişim
-- week_over_week → geçen haftanın aynı gününe göre % değişim
alter table control.alert_rule
  add column if not exists evaluation_type text not null default 'threshold',
  add column if not exists change_threshold_pct numeric null,
  -- day_over_day / week_over_week için: "% kaç değişince tetiklensin"
  -- örn: 50 → dünden %50 daha fazla olunca tetikle
  add column if not exists min_data_days integer not null default 7;
  -- alltime_high/low için: en az kaç günlük data olsun (false positive önlemi)

alter table control.alert_rule
  add constraint ck_alert_rule_eval_type check (
    evaluation_type in ('threshold', 'alltime_high', 'alltime_low',
                        'day_over_day', 'week_over_week')
  );

-- day_over_day / week_over_week kullanıyorsa change_threshold_pct zorunlu
alter table control.alert_rule
  add constraint ck_alert_rule_change_pct check (
    evaluation_type not in ('day_over_day', 'week_over_week')
    or change_threshold_pct is not null
  );

-- ops.alert: hangi kuraldan geldiği + acknowledge notu
alter table ops.alert
  add column if not exists rule_id bigint null references control.alert_rule(rule_id) on delete set null,
  add column if not exists acknowledge_note text null;

create index if not exists ix_alert_rule_id on ops.alert (rule_id) where rule_id is not null;
