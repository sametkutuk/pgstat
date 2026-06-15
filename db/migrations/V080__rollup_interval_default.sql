-- =============================================================================
-- V080: Saatlik rollup interval default 3600 -> 300 (5 dakika)
-- Rollup eskiden her poll'da (5sn) calisiyordu -> dakikada ~9 kez, gereksiz
-- agg yeniden-yazma + yuksek central DB TPS. JobOrchestrator artik
-- hourly_rollup_interval_seconds'a uyuyor; default 5 dakikaya cekildi.
-- =============================================================================

-- Kolon default'unu degistir (yeni profiller 300 alir)
alter table control.schedule_profile
  alter column hourly_rollup_interval_seconds set default 300;

-- Mevcut profillerden HALA eski default'ta (3600) olanlari 300'e cek.
-- Kullanicinin elle ozellestirdigi degerlere (orn 600, 900) DOKUNMA.
update control.schedule_profile
set hourly_rollup_interval_seconds = 300,
    updated_at = now()
where hourly_rollup_interval_seconds = 3600;
