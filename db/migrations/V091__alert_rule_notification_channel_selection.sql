-- V091: kural bazli bildirim kanali secimi
--
-- Musteri istegi (2026-08-24): "isteyen telegramda isteyen uida isteyen
-- ikisinde de gorsun" — su ana kadar her alert kurali, aktif olan TUM
-- notification_channel kayitlarina (severity/instance filtreleri disinda)
-- gonderiliyordu; kural bazinda "bu kural sadece UI'da gorunsun, o kanala
-- gitmesin" secimi yoktu.
--
-- Tasarim: many-to-many join tablosu. Bir alert_rule'un bu tabloda HIC
-- satiri yoksa, eski davranis devam eder (tum aktif kanallara gonderilir —
-- geriye donuk uyumluluk, mevcut kurallar hicbir sey secmemis sayilir).
-- Bir kural en az bir satir eklerse, SADECE o kanallara gonderilir; UI
-- (ops.alert) her durumda guncellenir, bu tablo sadece bildirim kanallarini
-- (Telegram/email/slack/vb) filtreler.

create table if not exists control.alert_rule_notification_channel (
  rule_id bigint not null references control.alert_rule(rule_id) on delete cascade,
  channel_id integer not null references control.notification_channel(channel_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (rule_id, channel_id)
);

comment on table control.alert_rule_notification_channel is
  'Kural bazli bildirim kanali secimi (many-to-many). Bir rule_id icin hic satir yoksa, o kural tum aktif kanallara gonderilir (eski/varsayilan davranis). Satir varsa sadece belirtilen kanallara gonderilir.';
