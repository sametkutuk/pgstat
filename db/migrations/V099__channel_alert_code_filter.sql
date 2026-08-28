-- V099: kanal bazli alert-kodu filtresi
--
-- Musteri talebi (2026-08-28): "hangi kanala hangi bildirimler gitmeli".
-- Mevcut iki mekanizma bu ihtiyaci tam karsilamiyordu:
--
--   1. control.notification_channel.min_severity — sadece SEVIYE'ye bakar.
--      Ayni seviyedeki iki farkli alarm tipi (orn. bloat ve replication lag,
--      ikisi de critical) ayrilamaz.
--
--   2. control.alert_rule_notification_channel — kural bazli kanal secimi,
--      ama yalnizca KURAL kaynakli alarmlar icin calisir. AlertCode enum'undaki
--      21 kodun 20'si (alert_source = 'system' ya da 'adaptive') rule_id
--      tasimadigi icin bu filtreden hic gecmiyor; onlar sadece severity
--      esigine tabiydi. Uretimde bunun somut sonucu, adaptive
--      long_running_query alarmlarinin susturulamamasiydi.
--
-- Bu tablo eksigi kapatiyor: bir kanal icin satir varsa, o kanal YALNIZCA
-- listelenen alarm kodlarini alir. Hic satir yoksa kanal butun kodlari alir
-- (mevcut davranis korunur, yani migration hicbir kurulumu sessizce
-- degistirmez).
--
-- Iki filtre birbiriyle CAKISMAZ, birlikte uygulanir:
--   - kural->kanal esleme, bir KURALIN hangi kanallara gidecegini kisitlar
--   - kanal->kod esleme, bir KANALIN hangi kodlari kabul ettigini kisitlar

create table if not exists control.alert_code_notification_channel (
  channel_id integer not null
    references control.notification_channel(channel_id) on delete cascade,
  alert_code text not null,
  created_at timestamptz not null default now(),
  primary key (channel_id, alert_code)
);

comment on table control.alert_code_notification_channel is
  'Kanal bazli alert-kodu filtresi: bir kanal icin satir varsa o kanal yalnizca listelenen kodlari alir, hic satir yoksa hepsini alir. min_severity seviyeye, bu tablo alarm TIPINE gore filtreler; ozellikle rule_id tasimayan system/adaptive alarmlari icin tek yol (V099).';

comment on column control.alert_code_notification_channel.alert_code is
  'AlertCode enum degeri (orn. long_running_query, system_disk_full, user_defined_rule). Foreign key yok: kodlar kodda tanimli, tabloda degil.';

-- Bildirim yolunda her alarm icin sorgulanir; kanal bazli arama hizli olmali.
create index if not exists ix_alert_code_notif_channel_code
  on control.alert_code_notification_channel (alert_code);
