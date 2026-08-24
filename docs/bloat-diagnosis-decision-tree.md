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
   → TEŞHİS: "Bu tablo hiç vacuum edilmemiş (otomatik veya manuel)."
   → AKSİYON: "autovacuum_enabled ayarını (tablo düzeyinde ve postgresql.conf'ta)
               kontrol et; ölü satır eşiği (autovacuum_vacuum_threshold +
               autovacuum_vacuum_scale_factor × canlı satır) henüz aşılmamış
               olabilir — manuel VACUUM ANALYZE ile hemen düzelt."

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
