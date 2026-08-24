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
       AŞILMIŞ ama hâlâ hiç vacuum çalışmamış
       → TEŞHİS: "Autovacuum açık ama tetikleme eşiği çoktan aşılmış,
                  normalde tetiklenmiş olmalıydı — tabloya özel
                  autovacuum_enabled=off override'ı olabilir (pg_class.reloptions,
                  bu araç henüz toplamıyor — bilinen sınırlama, aşağıya bak)."
       → AKSİYON: "SELECT reloptions FROM pg_class WHERE oid = '<şema.tablo>'::regclass;
                   ile kontrol et; varsa kaldır veya manuel VACUUM ANALYZE çalıştır."

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

4. last_autovacuum son 24 saat içinde VE trend yükseliyor (bu örnek önceki
   örnekten daha yüksek)
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
- Tablo-özel `autovacuum_enabled` override'ı (`pg_class.reloptions`) şu an
  toplanmıyor — sadece **global** `autovacuum`/`autovacuum_vacuum_scale_factor`/
  `autovacuum_vacuum_threshold` (`fact.pg_settings_snapshot`, gece toplanır,
  V039) kullanılıyor. Senaryo 1b bu sınırlamayı teşhis metninde açıkça
  belirtir ve kullanıcıya kontrol edeceği tam SQL sorgusunu (`SELECT
  reloptions FROM pg_class ...`) verir — "kontrol et" demekten kaçınmak
  için elimizdeki veriyle gidebildiğimiz en uzak noktaya kadar gidip, gerçek
  sınırı da saklamadan söylüyoruz.
