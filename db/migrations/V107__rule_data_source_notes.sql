-- V107: kural aciklamalarina veri kaynagi ve tazelik bilgisi
--
-- Musteri sorusu (2026-08-31): "bu alert hangi istatistiklere gore calisiyor
-- ve ne siklikla toplaniyor, bunlar alert bilgilendirmesinde de yaziyor mu".
-- Yazmiyordu.
--
-- Bu bir detay degil, alarmi dogru okumak icin gerekli: fiziksel sisme
-- olcumunun dayandigi boyut anlik goruntusu GECE aliniyor, yani rapor edilen
-- sayi 24 saate kadar eski olabilir. Operator alarmi gorup tabloya baktiginda
-- farkli bir durum bulabilir ve bunu bilmeden "alarm yanlis" sonucuna varir.
--
-- Alarm mesajinda degil KURAL aciklamasinda duruyor: mesaj kisa kalmali
-- (musteri talebi 2026-08-31), ama kurali yapilandiran kisi neyin ne siklikla
-- olculdugunu gormeli.

update control.alert_rule
   set description = description || E'\n\n' ||
     'Veri kaynağı ve tazelik:' || E'\n' ||
     '• Değişen satır sayısı, satır sayısı tahmini ve analiz zamanları: her ~30 dakikada bir toplanır (DB nesne toplaması).' || E'\n' ||
     '• autovacuum_analyze_threshold / scale_factor: gece 03:00''te, ayrıca 3 saatte bir tazelenir. Henüz toplanmadıysa PostgreSQL varsayılanları (50 / 0.1) kullanılır.' || E'\n' ||
     'Yani bu alarmın verisi en fazla yarım saat eskidir.'
 where evaluation_type = 'stale_statistics';

update control.alert_rule
   set description = description || E'\n\n' ||
     'Veri kaynağı ve tazelik:' || E'\n' ||
     '• Tablo boyutu ve satır sayısı tahmini: GECE 03:00''te alınan anlık görüntüden gelir. Bu, alarmın en kısıtlayıcı verisidir — rapor edilen ölçüm 24 saate kadar eski olabilir.' || E'\n' ||
     '• Satır sayısı düzeltmesi (eklenen/silinen satırlar): her ~30 dakikada bir toplanır; son gece görüntüsünden bu yana olan büyüme bu sayede hesaba katılır.' || E'\n' ||
     '• fillfactor: her ~30 dakikada bir tazelenir.' || E'\n' ||
     'Sıkışık hâl referansı, aynı tablonun geçmiş gece görüntülerindeki en düşük satır başına alandır; bu yüzden alarmın çalışabilmesi için en az iki gece görüntüsü gerekir.'
 where evaluation_type = 'table_space_bloat';
