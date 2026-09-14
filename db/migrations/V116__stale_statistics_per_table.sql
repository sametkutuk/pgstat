-- =============================================================================
-- V116 — Bayat istatistik alarmlari tablo basina (PGSTAT-P0-048, Adim 2)
--
-- stale_statistics kurali instance basina TEK anahtar kullaniyordu:
--   rule:{ruleId}:instance:{instancePk}
-- Artik her tablo kendi alarmini aciyor (granular kurallarin 2026-08-28'de
-- gectigi desen; bu kural o duzeltmenin disinda kalmisti):
--   rule:{ruleId}:instance:{instancePk}:rec:db:{dbid}:rel:{relid}
--
-- Anahtar semasi degistigi icin ESKI SATIRLAR YETIM KALIR: kod artik o
-- anahtarlari hic uretmeyecegi icin ne guncellenir ne de auto-resolve edilir.
-- Kullanicinin alarm listesinde sonsuza kadar acik kalirlardi — ve hicbiri
-- hangi tablo hakkinda oldugunu soylemiyor, ki sikayetin basladigi yer tam
-- olarak buydu.
--
-- Yeni anahtarlar ilk degerlendirmede acilacagi icin burada karsiliklarini
-- OLUSTURMUYORUZ: ihlal hala suruyorsa kural onu birkac dakika icinde yeniden
-- acar, surmuyorsa zaten acilmamali. Uydurma bir kapanis tarihi ya da uydurma
-- bir ihlal baslangici yazmaktansa, gercek olcumun gelmesini bekliyoruz.
-- =============================================================================

-- Eski instance-anahtarli bayat istatistik alarmlarini kapat.
-- Yalnizca stale_statistics kurallarina ait olanlar; ayni anahtar semasini
-- kullanan diger kurallara DOKUNULMAZ (alert_key deseni tek basina yeterli
-- ayirt edici degil, o yuzden rule_id uzerinden kurala baglaniyor).
update ops.alert a
set status = 'resolved',
    resolved_at = now(),
    last_seen_at = now()
from control.alert_rule r
where a.rule_id = r.rule_id
  and r.evaluation_type = 'stale_statistics'
  and a.status in ('open', 'acknowledged')
  -- Eski sema: ':rec:' ICERMEYEN anahtarlar. Yeni per-record anahtarlar
  -- ':rec:' tasir, yani bu kosul yenileri korur.
  and a.alert_key not like '%:rec:%';

-- Ayni islem epizot tarafinda. 'superseded': kosulun gectigi dogrulanmadi,
-- kimlik semasi degisti. 'resolved' yazmak "iyilesti" iddiasi olurdu.
update ops.alert_episode e
set closed_at = now(),
    close_reason = 'superseded',
    last_confirmed_at = now()
where e.closed_at is null
  and e.alert_key not like '%:rec:%'
  and exists (
    select 1
      from ops.alert a
      join control.alert_rule r on r.rule_id = a.rule_id
     where a.alert_key = e.alert_key
       and r.evaluation_type = 'stale_statistics'
  );

-- SAVUNMACI KAPATMA (en az bir surum boyunca).
--
-- Yukaridaki tek seferlik temizlik yalnizca migration anindaki satirlari
-- yakalar. Eski surumu calistiran bir collector kopyasi (kademeli deploy,
-- geri alma, unutulmus bir ikinci kopya) bu anahtarlardan yenilerini
-- uretmeye devam edebilir. Bu fonksiyon purge dongusunden cagrilir ve
-- sizanlari kapatir.
--
-- Bir surum sonra SILINECEK: kalici bir savunma, eski kodun hala calisiyor
-- olabilecegini kalici olarak kabul etmek demek olurdu.
create or replace function ops.close_legacy_stale_statistics_alerts()
returns integer
language plpgsql
as $$
declare
  kapanan integer;
begin
  update ops.alert a
  set status = 'resolved',
      resolved_at = now(),
      last_seen_at = now()
  from control.alert_rule r
  where a.rule_id = r.rule_id
    and r.evaluation_type = 'stale_statistics'
    and a.status in ('open', 'acknowledged')
    and a.alert_key not like '%:rec:%';
  get diagnostics kapanan = row_count;

  update ops.alert_episode e
  set closed_at = now(),
      close_reason = 'superseded',
      last_confirmed_at = now()
  where e.closed_at is null
    and e.alert_key not like '%:rec:%'
    and exists (
      select 1 from ops.alert a
        join control.alert_rule r on r.rule_id = a.rule_id
       where a.alert_key = e.alert_key
         and r.evaluation_type = 'stale_statistics'
    );

  return kapanan;
end;
$$;

comment on function ops.close_legacy_stale_statistics_alerts() is
  'GECICI (PGSTAT-P0-048 Adim 2). Instance-anahtarli eski bayat istatistik '
  'alarmlarini kapatir. Eski surumu calistiran bir collector kopyasi yenilerini '
  'uretmeye devam edebilecegi icin bir surum boyunca purge dongusunden '
  'cagrilir; sonra bu fonksiyon ve cagrisi SILINMELIDIR.';
