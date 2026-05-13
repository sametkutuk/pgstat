-- V064: user_defined_rule icin global cooldown default
--
-- alert_rule.cooldown_minutes zaten V011'de var (default 15) — per-rule override
-- icin kullanilacak. Burada system_alert_config'e user_defined_rule kodu icin
-- global default (60dk) eklenir; per-rule cooldown null/0 ise bu kullanilir.
--
-- Onceki bug: notifyIfNeeded user_defined_rule icin spam korumayi zaman kisitsiz
-- yapiyordu -> ilk bildirimden sonra ayni alert bir daha bildirilmezdi.

insert into control.system_alert_config
    (alert_code, is_enabled, cooldown_minutes, instance_pk)
values
    ('user_defined_rule', true, 60, null)
on conflict (alert_code) where instance_pk is null do nothing;
