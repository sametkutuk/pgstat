-- V105: kural bazli degerlendirme sikligi
--
-- AlertRuleEvaluator.evaluate() her orchestrator cycle'inda calisiyor —
-- uretim loglarinda ~7 saniyede bir. Bu, verisi saniyeler icinde degisen
-- kurallar icin dogru, ama V101 (stale_statistics) ve V103
-- (table_space_bloat) icin degil: ikisinin de dayandigi veri en fazla GECEDE
-- BIR degisiyor.
--
-- Olcek: 25 instance x 2 kural x 7 saniye = dakikada ~430 sorgu, ustelik
-- pencere fonksiyonlu agir sorgular — kucuk tutmaya calistigimiz merkezi DB
-- uzerinde. Sonuc degismeyecegi icin bu isin tamami israf.
--
-- Musteri talebi (2026-08-31): "bu alert ne siklikla gelecek, kullanici
-- ayarlayabiliyor mu". Cevap artik evet, ve varsayilan da makul.
--
-- NULL = her cycle (mevcut davranis). Boylece migration hicbir kuralin
-- davranisini sessizce degistirmiyor; yalnizca yeni iki kurala deger veriliyor.

alter table control.alert_rule
  add column if not exists evaluation_interval_minutes integer null;

comment on column control.alert_rule.evaluation_interval_minutes is
  'Bu kural en az kac dakikada bir degerlendirilsin. NULL = her orchestrator cycle''inda (~7sn) — verisi hizli degisen kurallar icin dogru olan bu. Verisi gece toplanan kurallarda (stale_statistics, table_space_bloat) sik degerlendirme sonucu degistirmez, sadece yuk uretir (V105, PGSTAT-P0-043).';

alter table control.alert_rule
  add constraint ck_alert_rule_eval_interval
  check (evaluation_interval_minutes is null or evaluation_interval_minutes > 0);

-- Verisi gece toplanan kurallar. Degerler bilinçli olarak "veri ne siklikla
-- degisiyorsa ondan biraz sik": gece toplamasi kacirildiysa ya da manuel
-- tetiklendiyse gun icinde de yakalansin.
update control.alert_rule
   set evaluation_interval_minutes = 60
 where evaluation_type = 'stale_statistics'
   and evaluation_interval_minutes is null;

update control.alert_rule
   set evaluation_interval_minutes = 360
 where evaluation_type = 'table_space_bloat'
   and evaluation_interval_minutes is null;

-- Kural aciklamalari: Alert Rules ekraninda kullanici bunlari okuyacak.
-- Musteri talebi (2026-08-31): "bu alertlerin aciklamalarini, kurallarini ve
-- bilgilendirmesini alert kurali ayarlama ekraninda sade ve acik yazmamiz
-- lazim".
update control.alert_rule
   set description =
     'Ne yapar: PostgreSQL''in kendi autoanalyze eşiği aşıldığı hâlde ANALYZE''ın uzun süredir çalışmadığı tabloları bildirir.' || E'\n\n' ||
     'Eşik nasıl hesaplanır: sabit bir sayı yoktur. Instance''ın kendi ayarlarından hesaplanır — autovacuum_analyze_threshold + autovacuum_analyze_scale_factor × tablo satır sayısı. Yani tablo büyüdükçe eşik de büyür.' || E'\n\n' ||
     'Uyarı/Kritik değerleri SAAT cinsindendir: eşik aşıldıktan sonra ANALYZE''ın çalışmamasına ne kadar tahammül edileceği.' || E'\n\n' ||
     'Neden önemli: bayat istatistik sorgu planlarını bozar. Planner join boyutlarını bu sayılardan hesaplar; gerçekte milyonlarca satırı olan bir tablo az satırlı sanılırsa sorgu saatlerce sürebilir.' || E'\n\n' ||
     'Eşik aşılmamışsa alarm üretilmez — o durumda PostgreSQL de tabloyu analiz etmeye değer bulmuyordur.'
 where evaluation_type = 'stale_statistics';

update control.alert_rule
   set description =
     'Ne yapar: tablonun satır başına kapladığı alanı, aynı tablonun kendi geçmişindeki en düşük değerle karşılaştırır. Fark büyükse tablo fiziksel olarak şişmiştir.' || E'\n\n' ||
     'Ölü satır alarmından farkı: bu alarm ölü satır saymaz. Autovacuum yetişse ve ölü satırları temizlese bile, boşalan alan yeniden kullanılmıyorsa tablo şişmeye devam eder — ölü satır alarmı bunu göremez.' || E'\n\n' ||
     'Uyarı/Kritik değerleri ŞİŞME KATIdır (3 = tablo olması gerekenin 3 katı yer kaplıyor). Ayrıca MB alt sınırı aranır: küçük bir tabloda 3 kat şişme birkaç MB''dır ve müdahaleye değmez.' || E'\n\n' ||
     'Doğruluk: ölçüm tahmine değil, aynı tablonun iki gözlemi arasındaki farka dayanır; extension gerektirmez. 2 katın üstündeki şişmeyi güvenilir yakalar, 1.2-1.5 kat aralığında güvenilir değildir — bu yüzden eşiği 2''nin altına indirmek önerilmez.' || E'\n\n' ||
     'Kapsam: yalnızca tablonun kendisi (heap). TOAST ve indeks şişmesi bu sayıya dâhil değildir. fillfactor ayarlıysa tasarım gereği boş bırakılan pay hesaptan düşülür.'
 where evaluation_type = 'table_space_bloat';
