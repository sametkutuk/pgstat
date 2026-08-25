# Bloat/Vacuum Teşhis Karar Ağacı — Referans Doküman

**Durum:** PGSTAT-P0-036 AC6 kapsamında tasarlandı ve uygulandı, 2026-08-24.
**Amaç:** `dead_tuple_ratio` alert mesajına, sabit "tablo istatistiklerine ve
autovacuum/index ihtiyacına bak" yerine, kanıta dayalı — neden buna göre
değişen — bir teşhis + aksiyon çifti eklemek. Bu doküman, ileride başka bir
metrik/alert için benzer bir karar ağacı kurulacaksa referans olsun diye
yazıldı.

## Veri kaynakları (hepsi zaten toplanıyor, ek collector değişikliği gerekmedi)

| Sinyal | Kaynak | Kolon |
|---|---|---|
| Ölü/canlı satır sayısı | `fact.pg_table_stat_delta` | `n_dead_tup_estimate`, `n_live_tup_estimate` |
| Son autovacuum zamanı | `fact.pg_table_stat_delta` | `last_autovacuum` |
| Son manuel vacuum zamanı | `fact.pg_table_stat_delta` | `last_vacuum` |
| Pencerede autovacuum kaç kez çalıştı | `fact.pg_table_stat_delta` | `autovacuum_count_delta` (toplanır) |
| Uzun süren transaction / xmin horizon | `fact.pg_activity_snapshot` | `backend_xmin`, `xact_start`, `state` |
| Kullanılmayan/eski replication slot | `fact.pg_replication_slot_snapshot` | `xmin_int`, `catalog_xmin_int`, `active` |
| Trend (büyüyor/sabit/yeni) | `fact.pg_table_stat_delta` (zaman serisi) | `n_dead_tup_estimate` geçmiş örnekler |

## Kaynaklar (piyasa araştırması, 2026-08-24)

1. Autovacuum tetikleme eşiği: `autovacuum_vacuum_threshold` + `autovacuum_vacuum_scale_factor × n_live_tup`.
   https://www.postgresql.org/docs/current/runtime-config-vacuum.html
2. Autovacuum throttling (`cost_limit`/`cost_delay`) ve worker yetersizliği teşhisi (`pg_stat_progress_vacuum`, `pg_stat_activity`).
   https://www.citusdata.com/blog/2022/07/28/debugging-postgres-autovacuum-problems-13-tips/
3. Xmin horizon — açık transaction/idle-in-transaction veya replication slot'ların ölü satır temizliğini engellemesi.
   https://pganalyze.com/blog/5mins-postgres-autovacuum-dead-tuples-not-yet-removable-postgres-xmin-horizon
4. Trend bazlı aciliyet (sürekli artan vs. yeni/kısa süreli spike).
   https://pganalyze.com/blog/visualizing-and-tuning-postgres-autovacuum
5. check_postgres'in `check_bloat` mesaj formatı (referans, doğrudan kopyalanmadı).
   https://github.com/bucardo/check_postgres/blob/master/check_postgres.pl

## Karar ağacı

Sıra önemli — üstteki koşul true ise altındakiler değerlendirilmez (en kesin/aksiyona en çok ihtiyaç duyulan senaryo önce gelir):

```
1. last_autovacuum IS NULL VE last_vacuum IS NULL
   → fact.pg_settings_snapshot'tan autovacuum/autovacuum_vacuum_scale_factor/
     autovacuum_vacuum_threshold okunur (gece toplanır, V039), eşik
     n_live_tup ile birlikte KESİN hesaplanır — "kontrol et" değil,
     doğrudan sonuç söylenir (musteri talebi 2026-08-24: "bizde tüm
     veriler var, kontrol et diyorsun ama biliyoruz olmalı"):

   1a. autovacuum = 'off' (global)
       → TEŞHİS: "Bu tablo hiç vacuum edilmemiş — instance genelinde
                  autovacuum kapalı (autovacuum=off)."
       → AKSİYON: "postgresql.conf'ta autovacuum=on yap ve reload et;
                   manuel VACUUM ANALYZE ile mevcut bloat'u hemen temizle."

   1b. eşik (threshold + scale_factor × live_tup) dead_tup tarafından
       AŞILMIŞ ama hâlâ hiç vacuum çalışmamış — control.table_relopts_snapshot'tan
       (V093, pg_class.reloptions, her toplama döngüsünde upsert edilir) KESİN
       override durumu okunur, "olabilir" denmez:

       1b-i. Tabloya özel autovacuum_enabled=false override'ı VAR (kesin)
             → TEŞHİS: "Autovacuum genel olarak açık ve eşik çoktan aşılmış
                        — ama bu TABLOYA ÖZEL autovacuum_enabled=false
                        override'ı var, bu yüzden hiç çalışmadı."
             → AKSİYON: "ALTER TABLE <şema.tablo> RESET (autovacuum_enabled);
                         ile override'ı kaldır, ardından manuel VACUUM ANALYZE
                         çalıştır."

       1b-ii. Override yok, autovacuum açık, eşik aşılmış ama hâlâ çalışmamış
             — fact.pg_activity_snapshot'tan (backend_type='autovacuum worker')
             gerçek çalışan worker sayısı ve fact.pg_settings_snapshot'tan
             autovacuum_max_workers okunur, "olası nedenler" değil KESİN
             sonuç verilir:

       1b-ii-a. Çalışan worker sayısı >= autovacuum_max_workers (doygunluk KESİN)
             → TEŞHİS: "Şu an X/Y autovacuum worker çalışıyor, TÜM WORKER'LAR
                        DOLU, bu yüzden bu tablo sıraya girip beklemiş."
             → AKSİYON: "autovacuum_max_workers ayarını artır veya diğer
                         tabloların vacuum yükünü azalt; bu tabloyu şimdi
                         manuel VACUUM ANALYZE ile öne al."

       1b-ii-b. Çalışan worker sayısı < autovacuum_max_workers (doygunluk YOK, KESİN)
             → TEŞHİS: "Şu an X/Y worker çalışıyor (doygunluk yok, boş
                        kapasite var), yani eşiği ÇOK YAKIN ZAMANDA aştı ve
                        autovacuum'un bir sonraki tarama döngüsünü (naptime)
                        henüz beklemiyor."
             → AKSİYON: "Bir sonraki autovacuum_naptime (varsayılan 1dk)
                         döngüsünü bekle; birkaç döngü sonra da
                         tetiklenmezse manuel VACUUM ANALYZE çalıştır."

       1b-ii-c. Worker durumu okunamadı (veri henüz toplanmamış)
             → TEŞHİS: "Worker durumu okunamadı."
             → AKSİYON: "Manuel VACUUM ANALYZE çalıştır; bir toplama
                         döngüsü sonrası netleşecek."

   1c. eşik henüz aşılmamış (gerçekten normal, henüz sıra gelmemiş)
       → TEŞHİS: "Henüz gerekmiyor olabilir — eşik henüz aşılmamış,
                  bu tablo mutlak dead-tuple eşiğiyle (Bacak B) yakalandı."
       → AKSİYON: "Düşük satır sayılı ama kritik bir tablo olabilir;
                   manuel VACUUM ANALYZE ile temizle."

   1d. pg_settings_snapshot henüz toplanmamış (yeni instance, gece
       toplaması henüz olmamış)
       → TEŞHİS: "Hiç vacuum edilmemiş; global ayarlar henüz
                  toplanmadığı için kesin eşik hesabı yapılamadı."
       → AKSİYON: "Manuel VACUUM ANALYZE çalıştır; gece toplaması
                   sonrası eşik hesabı netleşecek."

2. xmin horizon engeli var (pg_activity_snapshot'ta bu instance için
   xact_start çok eski (>10dk) açık bir transaction VAR, veya
   pg_replication_slot_snapshot'ta inactive bir slot VAR)
   VE autovacuum_count_delta > 0 (yani autovacuum ÇALIŞIYOR)
   → TEŞHİS: "Autovacuum çalışıyor ama uzun süren bir transaction/kullanılmayan
              replication slot ölü satırların temizlenmesini engelliyor
              (xmin horizon)."
   → AKSİYON: "pg_stat_activity'de xact_start'ı eski olan bağlantıları ve
               pg_replication_slots'ta aktif olmayan slot'ları kontrol et;
               gerekirse sonlandır/sil."

3. vacuum_ineffective = true (autovacuum sık çalışmış — eşik aşılmış — ama
   dead_tup hâlâ yüksek, Bacak C sinyali)
   → TEŞHİS: "Autovacuum çalışıyor ama yeterince hızlı temizleyemiyor
              (muhtemelen I/O throttling veya yüksek yazma hızı)."
   → AKSİYON: "autovacuum_vacuum_cost_limit/cost_delay ve
               autovacuum_max_workers ayarlarını gözden geçir;
               pg_stat_progress_vacuum ile şu an çalışan vacuum'un
               ilerleyişini izle."

3.5. last_autovacuum ESKİ (>24 saat önce) VE trend artıyor — "hiç vacuum
     edilmemiş" değil (senaryo 1), "bir süredir çalışmıyor ve bloat
     büyümeye devam ediyor" (müşteri talebi 2026-08-24). Aynı worker
     durumu kontrolü (fetchAutovacuumWorkerStatus) burada da kullanılır:

   3.5-a. Worker doygunluğu KESİN var
       → TEŞHİS: "Son autovacuum X saat önce çalışmış, o zamandan beri
                  bir daha çalışmadı ve ölü satır sayısı artmaya devam
                  ediyor — şu an Y/Z worker çalışıyor, TÜM WORKER'LAR
                  DOLU."
       → AKSİYON: "autovacuum_max_workers ayarını artır veya diğer
                   tabloların vacuum yükünü azalt; bu tabloyu şimdi
                   manuel VACUUM ANALYZE ile öne al."

   3.5-b. Worker doygunluğu KESİN yok
       → TEŞHİS: "Son autovacuum X saat önce çalışmış, o zamandan beri
                  bir daha çalışmadı ve ölü satır sayısı artmaya devam
                  ediyor — worker doygunluğu yok; olası nedenler:
                  tetikleme eşiği hâlâ aşılmamış olabilir, ya da
                  autovacuum_naptime uzun ayarlanmış olabilir."
       → AKSİYON: "postgresql.conf'ta autovacuum_naptime ayarını
                   kontrol et; sürekli artış devam ediyorsa manuel
                   VACUUM ANALYZE ile hemen temizle."

4.5. last_autovacuum son 24 saat içinde VE trend yükseliyor VE autovacuum bu
   pencerede KRONİK olarak çalışmış (autovacuum_count_sum > 1) — müşteri
   olayı 2026-08-25: pgstat'ın kendi DB'sinde `agg.pg_table_stat_hourly`
   (rollup job'ı tarafından ~5dk'da bir UPSERT'lenen bir tablo)
   sürekli büyüyordu, autovacuum ara sıra çalışıyordu ama tablonun
   güncelleme hızına yetişemiyordu — sistem bunu hiç tespit edip
   önermedi, kullanıcı manuel araştırmayla buldu. Bu senaryo, "henüz
   yetişmedi, bekle" (senaryo 4) ile "eşik yanlış kalibre edilmiş"
   (bu senaryo) arasındaki farkı ayırt eder: autovacuum sadece 1 kez
   değil, tekrar tekrar çalışmasına rağmen trend hâlâ artıyorsa, sorun
   "henüz sırası gelmedi" değil "eşik bu tablo için yapısal olarak
   yanlış".
   → TEŞHİS: "Autovacuum kronik olarak çalışıyor (bu pencerede N kez)
              ve son çalışması yakın zamanda oldu, ama ölü satır sayısı
              hâlâ artmaya devam ediyor — tetikleme eşiği bu tablonun
              güncelleme hızına göre çok yüksek kalmış."
   → AKSİYON: "ALTER TABLE <şema.tablo> SET (autovacuum_vacuum_scale_factor
               = 0.02, autovacuum_vacuum_threshold = 5000); gibi daha
               düşük bir eşik ayarla."

4. last_autovacuum son 24 saat içinde VE trend yükseliyor (bu örnek önceki
   örnekten daha yüksek), ama autovacuum kronik olarak çalışmamış (4.5'in
   şartını sağlamıyor — muhtemelen tek/az sayıda çalışma)
   → TEŞHİS: "Bloat yeni oluşmuş/artıyor, autovacuum henüz yetişmemiş olabilir."
   → AKSİYON: "Kısa süre gözlemle — autovacuum döngüsü kendiliğinden
               düzeltebilir; düzelmezse manuel VACUUM ANALYZE çalıştır."

5. (default — hiçbiri eşleşmezse)
   → TEŞHİS: "Autovacuum ayarları veya iş yükü tabloyu dengede tutmaya
              yetmiyor."
   → AKSİYON: "Manuel VACUUM ANALYZE çalıştır; sürekli tekrarlıyorsa
               autovacuum_vacuum_scale_factor'ü düşürmeyi değerlendir."
```

## Uygulama notu

Xmin-horizon kontrolü (senaryo 2) ek bir sorgu gerektirir (`fact.pg_activity_snapshot`/
`fact.pg_replication_slot_snapshot`), bu yüzden yalnızca alert **tetiklenirken**
(bir tablo eşiği aştığında) çalıştırılır — her evaluator döngüsünde değil, maliyeti
sınırlamak için. Trend kontrolü (senaryo 4) `fact.pg_table_stat_delta`'nın aynı
tablo için önceki örneğine bakar (pencere dışına taşan, ek bir sorgu).

## Sınırlamalar / bilinçli basitleştirmeler

- Xmin horizon kontrolü instance-geneldir (hangi transaction'ın hangi tabloyu
  etkilediği ayrıştırılmaz) — "bu instance'ta uzun transaction var" diyebiliriz,
  "bu spesifik tabloyu engelliyor" diyemeyiz. Yanlış pozitif riski var ama
  yanlış negatiften daha az zararlı (aksiyon önerisi, zorunlu emir değil).
- `autovacuum_vacuum_cost_limit`/`cost_delay`'in gerçek DB-spesifik değerlerini
  okumuyoruz (bu, `pg_settings`'ten ayrı bir sorgu gerektirir) — senaryo 3'ün
  aksiyon metni jenerik ayar isimlerini anıyor, gerçek değerleri göstermiyor.
  İleride `pg_settings` toplama genişletilirse buraya eklenebilir.
- Tablo-özel `autovacuum_enabled` override'ı artık **V093** ile toplanıyor
  (`control.table_relopts_snapshot`, `DbObjectsCollector` her toplama
  döngüsünde `pg_class.reloptions`'ı okuyup upsert ediyor) — senaryo 1b bu
  yüzden "olabilir" demez, kesin sonuç verir (1b-i: override kesin var,
  1b-ii: override kesin yok). Bu, ilk versiyonda ("bu araç henüz
  toplamıyor") bilinen bir sınırlamaydı; müşteri "bunu da kontrol
  edebilirsin, tespit et" dediği için aynı oturumda kapatıldı.
- `autovacuum_max_workers` doygunluğu (senaryo 1b-ii) artık `fact.pg_activity_snapshot`
  (`backend_type='autovacuum worker'`) ve `fact.pg_settings_snapshot`'tan
  gerçek zamanlı KESİN olarak doğrulanıyor (1b-ii-a/b/c) — ilk versiyonda
  ("olası nedenler... kontrol et") bilinen bir sınırlamaydı, müşteri "bu
  net teşhis değil" dediği için aynı oturumda kapatıldı.
