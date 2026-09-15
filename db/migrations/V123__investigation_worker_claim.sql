-- =============================================================================
-- V123 — Arastirma kuyrugu icin worker sahipligi
--
-- Asenkron calisma DB tabanli kalir; Redis/Kafka eklenmez (plan bolum 11/M1).
-- Bunun icin eksik olan tek sey isin KIMDE oldugu ve ne zamandir orada
-- oldugudur:
--
--   claimed_by    — isi alan worker kimligi
--   claimed_at    — ne zaman alindi
--   heartbeat_at  — worker hala yasiyor mu; bayat kalirsa is geri alinir
--   attempt_count — kac kez denendi; sonsuz yeniden deneme olmaz
--
-- Sahiplik olmadan iki worker ayni isi alir ve ikisi de sonuc yazar. Daha
-- kotusu: kullanici isi iptal ettikten sonra worker'in yazdigi sonuc iptali
-- ezer. Bu migration o yarisi kapatmak icin gereken alanlari ekler; kurallarin
-- kendisi services/investigationQueue.ts icindedir ve gercek PostgreSQL'e
-- karsi test edilir.
-- =============================================================================

alter table agent.investigation
  add column if not exists claimed_by    text,
  add column if not exists claimed_at    timestamptz,
  add column if not exists heartbeat_at  timestamptz,
  add column if not exists attempt_count integer not null default 0;

alter table agent.investigation
  drop constraint if exists ck_investigation_attempt_count;
alter table agent.investigation
  add constraint ck_investigation_attempt_count check (attempt_count >= 0);

comment on column agent.investigation.claimed_by is
  'Isi yuruten worker kimligi. NULL = is kimsede degil.';
comment on column agent.investigation.heartbeat_at is
  'Worker''in son yasam isareti. Bayatlarsa is geri alinir; bkz. reclaimStaleInvestigations.';
comment on column agent.investigation.attempt_count is
  'Kac kez ise baslandi. Ust sinira ulasinca is timed_out edilir, sonsuz donguye girmez.';

-- Sirali is alma: yalnizca 'queued' olanlar aday. needs_clarification
-- KULLANICIYI bekler, worker'i degil; bu yuzden bu indekse girmez.
create index if not exists ix_agent_investigation_queued
  on agent.investigation (created_at)
  where status = 'queued';

-- Bayat sahiplik taramasi.
create index if not exists ix_agent_investigation_heartbeat
  on agent.investigation (heartbeat_at)
  where status in ('planning', 'collecting_evidence', 'interpreting');
