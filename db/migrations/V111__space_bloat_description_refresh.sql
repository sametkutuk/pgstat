-- V111: fiziksel sisme kuralinin aciklamasi V109/V110 ile hizalaniyor
--
-- V103'teki aciklama "kendi gecmisindeki EN DUSUK degerle karsilastirir"
-- diyordu. V110'dan sonra bu dogru degil: taban artik en dusuk UC GUNUN
-- MEDYANI ve yalnizca planli gece gozlemlerinden seciliyor.
--
-- Aciklamalari olculene sadik tutmak bu hafta tekrar tekrar dogrulugu
-- etkiledi (kaldirilan "vacuum basina 340 satir", "43 GiB'da dengelenir",
-- "%30 hata bandi" iddialari). Kullanicinin ekranda okudugu metin, kodun
-- gercekte yaptigi sey olmali.

update control.alert_rule
   set description =
     'Ne yapar: tablonun satır başına kapladığı alanı, aynı tablonun kendi geçmişindeki en yoğun gözlemlerle karşılaştırır. Fark büyükse tablo fiziksel olarak şişmiştir.' || E'\n\n' ||
     'Ölü satır alarmından farkı: bu alarm ölü satır saymaz. Autovacuum yetişse ve ölü satırları temizlese bile, boşalan alan yeniden kullanılmıyorsa tablo şişmeye devam eder — ölü satır alarmı bunu göremez.' || E'\n\n' ||
     'Uyarı/Kritik değerleri ŞİŞME KATIdır (3 = tablo olması gerekenin 3 katı yer kaplıyor). Ayrıca MB alt sınırı aranır: küçük bir tabloda 3 kat şişme birkaç MB''dır ve müdahaleye değmez.' || E'\n\n' ||
     'Taban nasıl seçilir: yalnızca planlı GECE ölçümlerinden, en az 21 farklı gece ve en az 28 günlük yayılım gerekir. Taban, en düşük üç günün MEDYANIdır — tek bir gürültülü ölçüm tabanı belirlemesin diye. Gün içi ölçümler (açık alarmı olan tablolar için 30 dakikada bir alınan) tabana GİRMEZ; onlar yalnızca güncel durumu doğrular, çünkü tablo zaten alarmlı olduğu için toplanırlar.' || E'\n\n' ||
     'Ne zaman susar: taban koşulları sağlanmazsa, tablo yeniden adlandırılmış/yeniden oluşturulmuşsa, fillfactor değişmişse, ya da satır sayısı tahmini ile boyut ölçümü arasındaki dönem gözlem boşluğu yüzünden köprülenemiyorsa hiçbir şey söylemez. Geçersiz bir taban, sessizlikten daha zararlıdır.' || E'\n\n' ||
     'Kapsam: yalnızca tablonun kendisi (heap). TOAST ve indeks şişmesi bu sayıya dâhil değildir. Satır genişliğinin veya şemanın değişmesi de satır başına alanı büyütür; bu şişme değildir.' || E'\n\n' ||
     'Veri kaynağı ve tazelik:' || E'\n' ||
     '• Tablo boyutu, satır sayısı tahmini, fillfactor ve satır tahmininin ankraj zamanı: GECE 03:00''te alınan anlık görüntüden.' || E'\n' ||
     '• Satır sayısı düzeltmesi: ankraj ile boyut ölçümü arasındaki eklenen/silinen satırlar, her ~30 dakikada bir toplanan delta''lardan.' || E'\n' ||
     '• Açık alarmı olan tablolarda boyut ayrıca ~30 dakikada bir tazelenir.'
 where evaluation_type = 'table_space_bloat';
