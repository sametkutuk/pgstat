-- V054: Snapshot retention default'larını arttır
-- 48 saat WAL grafiği için çok kısa, haftalık/aylık trend görülmez.
-- Yeni default'lar:
--   r3-short:    7 gün (168 saat)
--   r6-default: 30 gün (720 saat)
--   r12-long:   90 gün (2160 saat)
-- Kullanıcı Settings > Retention Politikaları'ndan değiştirebilir.

update control.retention_policy
   set snapshot_retention_hours = 168
 where policy_code = 'r3-short' and snapshot_retention_hours = 24;

update control.retention_policy
   set snapshot_retention_hours = 720
 where policy_code = 'r6-default' and snapshot_retention_hours = 48;

update control.retention_policy
   set snapshot_retention_hours = 2160
 where policy_code = 'r12-long' and snapshot_retention_hours = 72;

-- Yeni eklenen policy'ler için default (mevcut tabloyu etkilemez, sadece ileride)
alter table control.retention_policy
    alter column snapshot_retention_hours set default 720;
