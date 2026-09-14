-- =============================================================================
-- V117 — Kapali epizot aramasi icin indeks (PGSTAT-P0-048, Adim 2 duzeltme)
--
-- Yeni bir epizot acilirken, ayni alert_key'in EN SON kapanmis epizoduna
-- bakiliyor: kapanis dogrulanmamissa (manual / superseded / stale_timeout)
-- ihlal saati devralinir, sifirlanmaz.
--
-- Neden gerekli: kullanici "Coz"e bastiginda epizot 'manual' ile kapaniyor ama
-- kosul hala dogru; sonraki degerlendirme yeni epizot acip ihlal saatini
-- SIFIRLIYORDU. Alti gundur bayat bir tablo, bir dugmeye basildigi icin taze
-- gorunuyor ve alarm yeniden ciktiginda "24 saat" diyordu — duzeltmeye
-- calistigimiz "178 saat" hatasinin tersten aynisi.
--
-- Bu arama her gozlemde calisiyor. Mevcut indeksler yetmiyor:
--   - uq_alert_episode_active yalnizca ACIK satirlari kapsiyor (closed_at is null)
--   - ix_alert_episode_closed_at yalnizca closed_at'e gore, alert_key yok
-- Indekssiz kalirsa her gozlem seq scan olur. Tablo kucuk degil: olculen hiz
-- gunde ~118 epizot ve retention 90 gun, yani ~10.000 satir mertebesi.
--
-- closed_at epizot omrunde BIR KEZ degisir, dolayisiyla bu indeks sicak
-- guncelleme yolunda degil (HOT'u bozmaz).
-- =============================================================================

create index if not exists ix_alert_episode_key_closed
  on ops.alert_episode (alert_key, closed_at desc)
  where closed_at is not null;

comment on index ops.ix_alert_episode_key_closed is
  'Yeni epizot acilirken ayni anahtarin en son kapanmis epizodunu bulmak icin. '
  'Dogrulanmamis kapanistan sonra ihlal saati devralinir.';
