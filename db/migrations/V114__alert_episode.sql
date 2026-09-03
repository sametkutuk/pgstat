-- =============================================================================
-- V114 — Alarm ihlal epizodu (PGSTAT-P0-048, Adim 1)
--
-- ops.alert bir OLAY tablosu gibi kullaniliyor ama aslinda bir DURUM tablosu.
-- Bir ihlalin ne zaman basladigini, kac kez teyit edildigini, arada
-- degerlendirilemedigi bir aralik olup olmadigini ve kullanicinin onayinin
-- hangi duruma verildigini tutan hicbir alan yok. Sonuclari:
--   - kidem yanlis olculuyor (son ANALYZE'dan beri gecen sure, esik asimindan
--     beri gecen sure yerine)
--   - onay siliniyor (upsert acknowledged_at'i null yapiyor)
--   - occurrence_count olay sayisi saniliyor (637 degerlendirme, 9 bildirim)
--
-- Bu migration yalnizca SEMA kurar. Bu surumde epizot GOLGE olarak yazilir,
-- hicbir karar epizoda dayanmaz; mevcut alarm/bildirim/UI davranisi degismez.
-- Tasarim: docs/alert-lifecycle-design.md
-- =============================================================================

create table if not exists ops.alert_episode (
  episode_id bigint generated always as identity primary key,

  -- Kimlik. alert_key beş ureticinin de bugun kullandigi dogal kimlik ve
  -- ops.alert.uq_alert_key ile birebir ortusur; golge karsilastirma sorgusu
  -- bu ortusmeye dayanir.
  alert_key text not null,
  alert_code text not null,
  alert_source text not null,
  instance_pk bigint null,

  -- Iliskisel kimlik parcalari. Yalnizca tablo bazli kurallar doldurur.
  -- relid TEK BASINA benzersiz DEGIL, yalnizca bir veritabani icinde
  -- benzersiz: instance 18'de relid 7887268 hem dbid 7886849'da hem
  -- 6327213'te var (dogrulandi 2026-09-02). Bu yuzden dbid ayri tutulur.
  dbid bigint null,
  relid bigint null,

  -- Fiziksel nesil = (relfilenode, reltablespace) ciftinin metin gosterimi.
  -- AKTIF TEKILLIK ANAHTARINA GIRMEZ. Dis inceleme girmesini onerdi; niyeti
  -- dogru (VACUUM FULL sonrasi tablo baska bir fiziksel nesnedir) ama anahtara
  -- koymak ayni alert_key icin iki acik epizodu mumkun kilar ve ops.alert ile
  -- 1:1 eslemeyi bozar — karsilastirma sorgusu da o noktada yalan soyler.
  -- Bunun yerine OZNITELIK olarak tutulur ve DEGISTIGINDE eski epizot
  -- close_reason='identity_changed' ile kapanip yenisi acilir. Niyet korunur,
  -- tekillik bozulmaz.
  relation_generation text null,

  -- Kimlik beklenip gelmediyse epizot ACILMAZ, bu bayrakla kaydedilir.
  -- Uydurulmus kimlikle acilan bir epizot, gercek kimlik sonradan geldiginde
  -- cakisir ve iki ayri ihlali birbirine karistirir.
  identity_status text not null default 'complete',

  -- Durum. 'unknown' bu tasarimin merkezinde: instance'a ulasilamadiginda veya
  -- sorgu hata verdiginde mevcut kod HICBIR SEY yazmiyor ve veri yoklugu
  -- sessizce "iyilesti" gibi okunuyor. VERI YOKLUGU SAGLIK KANITI DEGILDIR:
  -- 'unknown' epizodu kapatmaz ve ihlal saatini ilerletmez.
  state text not null,

  severity text null,
  -- Epizot boyunca goruldugu en yuksek severity. Dusen severity kidemi
  -- silmemeli; "bu bir ara critical olmustu" cumlesi kurulabilir kalmali.
  max_severity text null,

  opened_at timestamptz not null default now(),

  -- YALNIZCA yanlis->dogru gecisinde yazilir, yeniden degerlendirme tarafindan
  -- ASLA uzerine yazilmaz. Kidem severity'si bundan hesaplanir (Adim 2).
  first_observed_breaching_at timestamptz null,

  -- Seyrek yazilir (varsayilan 1 saat). Her degerlendirmede yazilan bir damga
  -- HOT guncellemeyi imkansiz kilip tabloyu sisiriyordu: dim.statement_series
  -- bu yuzden 942 MB olmustu (V112). Bu kolon INDEKSLENMEZ.
  last_confirmed_at timestamptz not null default now(),

  -- Gozlemin ait oldugu an. Gec gelen veya tekrarlanan ornek durumu
  -- ILERLETMEZ; guncelleme sample_ts > last_sample_ts kosuluna bagli.
  last_sample_ts timestamptz not null,

  observation_count integer not null default 1,

  closed_at timestamptz null,
  close_reason text null,

  -- ONAY. Silinmez, GECERSIZLESTIRILIR: severity yukselirse acknowledged_at
  -- yerinde kalir, ack_invalidated_at yazilir. "Kullanici bunu warning'ken
  -- onaylamisti, sonra critical oldu" cumlesi kurulabilir olmali.
  acknowledged_at timestamptz null,
  acknowledged_by text null,
  ack_severity text null,
  ack_invalidated_at timestamptz null,
  ack_invalidated_reason text null,

  -- Bu epizot, gecmisi olmayan bir alarm uzerine acildi. Mevcut acik alarmlar
  -- epizotlarini ilk degerlendirmede alir ve first_observed_breaching_at o an
  -- damgalanir; yani KIDEMLERI OLDUGUNDAN GENC gorunur. Alternatif
  -- first_seen_at'i geriye tasimakti, o da yanlis olurdu: first_seen_at
  -- alarmin ilk yazildigi an, ihlalin basladigi an degil. Yanlis bir kidem
  -- uydurmaktansa genc gorunmesi tercih edildi ve burada isaretlenir.
  backfilled boolean not null default false,

  created_at timestamptz not null default now(),

  constraint ck_alert_episode_state
    check (state in ('confirmed_breaching', 'confirmed_healthy', 'unknown')),
  constraint ck_alert_episode_identity_status
    check (identity_status in ('complete', 'missing_identity')),
  constraint ck_alert_episode_close_reason
    check (close_reason is null or close_reason in
           ('resolved', 'identity_changed', 'superseded', 'stale_timeout')),
  constraint ck_alert_episode_severity
    check (severity is null or severity in ('info', 'warning', 'error', 'critical')),
  constraint ck_alert_episode_max_severity
    check (max_severity is null or max_severity in ('info', 'warning', 'error', 'critical')),
  constraint ck_alert_episode_observation_count check (observation_count > 0),
  -- Kapali epizodun kapanma sebebi olmali; sebepsiz kapanma "neden kapandi"
  -- sorusunu cevapsiz birakir ve tam da kacindigimiz belirsizligi uretir.
  constraint ck_alert_episode_closed_has_reason
    check ((closed_at is null) = (close_reason is null))
)
-- Her degerlendirmede her acik alarm icin guncellenecek: V112'de duzelttigimiz
-- yazma amplifikasyonu deseninin ta kendisi. Bastan HOT dostu kuruluyor.
with (fillfactor = 85);

-- AKTIF TEKILLIK: alert_key basina en fazla bir acik epizot. ops.alert'in
-- uq_alert_key kisitiyla ortusur; cift yonlu karsilastirma sorgusu buna dayanir.
create unique index if not exists uq_alert_episode_active
  on ops.alert_episode (alert_key)
  where closed_at is null;

-- Kapali epizot tarihcesi ve purge icin. closed_at epizot omrunde BIR KEZ
-- degisir, dolayisiyla bu indeks sicak yolda degil.
create index if not exists ix_alert_episode_closed_at
  on ops.alert_episode (closed_at)
  where closed_at is not null;

create index if not exists ix_alert_episode_instance_opened
  on ops.alert_episode (instance_pk, opened_at desc)
  where instance_pk is not null;

-- Tablo bazli kurallarin (Adim 2/4) kimlik aramasi icin.
create index if not exists ix_alert_episode_relation
  on ops.alert_episode (instance_pk, dbid, relid)
  where relid is not null;

-- NOT: last_confirmed_at, last_sample_ts, observation_count ve state
-- INDEKSLENMEZ. Bunlar her degerlendirmede degisir; indekslenmeleri HOT'u
-- oldurur. Ihtiyac durumunda seq scan kabul edilir — tablo acik alarm sayisi
-- mertebesinde kalir.

comment on table ops.alert_episode is
  'Alarm ihlal epizodu: bir ihlalin kimligi belli tek surekliligi. Bir kez '
  'acilir, yeniden degerlendirmelerden sag cikar, kosul gectiginde kapanir; '
  'sonraki ihlal yeni bir epizottur. PGSTAT-P0-048 Adim 1: golge yazim, '
  'hicbir karar buna dayanmaz.';

comment on column ops.alert_episode.state is
  'confirmed_breaching = degerlendirildi, kosul dogru. confirmed_healthy = '
  'degerlendirildi, kosul yanlis (kapatir). unknown = DEGERLENDIRILEMEDI '
  '(kapatmaz, ihlal saatini ilerletmez).';

comment on column ops.alert_episode.first_observed_breaching_at is
  'Esigin asildigi an. Yalnizca yanlis->dogru gecisinde yazilir. Kidem '
  'severity''si bundan hesaplanir — son basarili bakimin uzerinden gecen '
  'sureden DEGIL; bunlar farkli saatler ve yalnizca biri aciliyet soyler.';

comment on column ops.alert_episode.relation_generation is
  '(relfilenode, reltablespace) cifti. Aktif tekillik anahtarinda DEGIL; '
  'degistiginde eski epizot identity_changed ile kapanir.';

-- =============================================================================
-- Onay gecmisi
--
-- Bugun iki kod yolunun ACK politikasi BIRBIRININ TERSI (tasarim sirasinda
-- bulundu): AlertRepository'nin uc upsert'i de acknowledged_at'i null yapip
-- durumu open'a cevirir; AlertService ise ikisini de korur. Yani sistem
-- alarmlarinda onay yasiyor, kullanici kurali alarmlarinda oluyor. Ikisi de
-- yazili bir karar degil, upsert'in yan etkisi.
--
-- Bu tablo onayi bir OLAY dizisi olarak tutar: kim, ne zaman, hangi
-- severity'deyken onayladi ve neden gecersizlesti.
-- =============================================================================

create table if not exists ops.alert_episode_ack (
  ack_id bigint generated always as identity primary key,
  episode_id bigint not null
    references ops.alert_episode(episode_id) on delete cascade,
  action text not null,
  actor text null,
  severity_at_action text null,
  reason text null,
  note text null,
  created_at timestamptz not null default now(),
  constraint ck_alert_episode_ack_action
    check (action in ('acknowledge', 'unacknowledge', 'invalidate'))
);

create index if not exists ix_alert_episode_ack_episode
  on ops.alert_episode_ack (episode_id, created_at desc);

comment on table ops.alert_episode_ack is
  'Onay gecmisi. Onay SILINMEZ, gecersizlestirilir — severity yukseldiginde '
  'invalidate kaydi dusulur ve epizodun acknowledged_at alani yerinde kalir.';
