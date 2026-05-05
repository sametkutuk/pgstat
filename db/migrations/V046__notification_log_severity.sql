-- =========================================================================
-- V046: ops.notification_log'a severity kolonu ekle
-- =========================================================================
-- Sebep:
--   NotificationService.notifyIfNeeded() severity escalation kontrolu yapiyordu:
--   "eger ayni alert icin daha onceden ayni veya yuksek severity'de bildirim
--    gonderildiyse atla". Ama karsilastirma `ops.alert.severity` uzerinden
--    yapiliyordu — alert.severity her upsert'te yeni severity'ye guncelleniyor,
--    bu yuzden karsilastirma her zaman "ayni" sonuc veriyor → escalation
--    hicbir zaman tetiklenmiyordu.
--
-- Fix:
--   Bildirim gonderilirken kullanilan severity'yi notification_log'a yaz.
--   Karsilastirmayi bu kolon uzerinden yap (NotificationService).
-- =========================================================================

alter table ops.notification_log
    add column if not exists severity varchar(20);

-- Eski kayitlara default 'warning' yaz (bu degerin escalation karsilastirmasinda
-- en cok gorulen seviye olmasi nedeniyle pratikte minimum ihlal).
update ops.notification_log set severity = 'warning' where severity is null;

alter table ops.notification_log
    alter column severity set not null,
    alter column severity set default 'warning';

create index if not exists ix_notification_log_alert_severity
    on ops.notification_log (alert_id, severity);
