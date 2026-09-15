-- =============================================================================
-- V122 — Arastirma hedefi zorunlu olmaktan cikiyor
--
-- AI DBA bir sohbet arayuzudur: kullanicinin soru sormadan once listeden
-- instance secmek zorunda kalmasi akisi bozuyor. Hedef artik su sirayla
-- cozulur:
--
--   1. Istek instance_pk tasiyorsa o kullanilir.
--   2. Tasimiyorsa ve sistemde TEK aktif instance varsa o secilir; secimin
--      otomatik yapildigi konusma gecmisine yazilir.
--   3. Aksi halde arastirma 'needs_clarification' durumunda acilir ve
--      kullaniciya hangi instance'i kastettigi sorulur.
--
-- agent.investigation.instance_pk zaten nullable idi; eksik olan yalnizca
-- "kullaniciyi bekliyor" durumuydu. Bu durum worker'in bekleyen is indeksine
-- (ix_agent_investigation_pending) DAHIL EDILMEZ: is kullaniciyi bekliyor,
-- worker'i degil.
-- =============================================================================

-- V120'deki kisitlama isimsiz tanimlanmisti; PostgreSQL ona
-- investigation_status_check adini uretir. Isimli surumle degistiriyoruz ki
-- sonraki migration'lar tahmin yurutmek zorunda kalmasin.
alter table agent.investigation
  drop constraint if exists investigation_status_check;
alter table agent.investigation
  drop constraint if exists ck_investigation_status;

alter table agent.investigation
  add constraint ck_investigation_status check (
    status in (
      'needs_clarification',
      'queued', 'planning', 'collecting_evidence', 'interpreting',
      'completed', 'insufficient_evidence', 'failed', 'cancelled', 'timed_out'
    )
  );

comment on column agent.investigation.instance_pk is
  'Hedef instance. NULL + status=needs_clarification: kullaniciya hangi instance oldugu soruldu, cevap bekleniyor.';

-- Kullaniciyi bekleyen arastirmalari listelemek icin.
create index if not exists ix_agent_investigation_clarification
  on agent.investigation (created_at desc)
  where status = 'needs_clarification';
