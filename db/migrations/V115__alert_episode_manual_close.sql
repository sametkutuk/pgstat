-- =============================================================================
-- V115 — Epizot icin 'manual' kapanma sebebi (PGSTAT-P0-048, Adim 1 duzeltme)
--
-- Inceleme, API'deki manuel "Coz" dugmesinin ve database-cleanup akisinin
-- ops.alert'i kapatip epizodu ACIK biraktigini gosterdi. Boyle kalirsa cift
-- yonlu karsilastirma sorgusu 'epizot_var_alarm_yok' dondurur — yani
-- kullanicinin bir dugmeye basmasi, dogrulama kapisini kendi basina kirar.
--
-- V114'un "kanca noktasi iki sinif" tespiti alarm ACILISI icin dogruydu;
-- yasam dongusunun KAPANISINDA API de bir uretici. Bu, ikisini ayirt edebilmek
-- icin gereken sebebi ekliyor.
--
-- Neden 'resolved' kullanilmiyor: 'resolved' kosulun gectiginin DOGRULANDIGI
-- anlamina geliyor ve o kapanislarda state='confirmed_healthy' yaziliyor.
-- Manuel kapatmada kosulun gectigini kimse dogrulamadi; yalnizca kullanici
-- alarmi kapatti. Ikisini ayni sebeple kaydetmek, veri yoklugunu saglik
-- kaniti saymak olurdu — bu tasarimin tam da onlemeye calistigi sey.
--
-- V114 pushlanmis oldugu icin duzenlenmedi; kisit burada yeniden kuruluyor.
-- =============================================================================

alter table ops.alert_episode
  drop constraint if exists ck_alert_episode_close_reason;

alter table ops.alert_episode
  add constraint ck_alert_episode_close_reason
  check (close_reason is null or close_reason in
         ('resolved', 'identity_changed', 'superseded', 'stale_timeout', 'manual'));

comment on column ops.alert_episode.close_reason is
  'resolved = kosulun gectigi dogrulandi (state confirmed_healthy olur). '
  'manual = kullanici kapatti, kosul dogrulanmadi. '
  'identity_changed = fiziksel nesil degisti, eski nesil artik ayni nesne degil. '
  'superseded = izleme kapsamindan cikarildi (orn. veritabani takipten cikti). '
  'stale_timeout = alarm tazelenmedi, kosul hakkinda hicbir sey ogrenilmedi.';
