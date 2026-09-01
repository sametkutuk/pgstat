# Alert Reference

Bu tablo built-in alertlerin nasil calistigini ozetler. Degistirilebilir esikler
`control.system_alert_config.threshold_value` alanindan okunur; instance override
varsa global degerin onune gecer.

| Alert code | Ne zaman calisir | Ana parametre/esik | Varsayilan | Kaynak/pencere | Resolve |
| --- | --- | --- | --- | --- | --- |
| `connection_failure` | Source PostgreSQL'e baglanti kurulamazsa | Baglanti hatasi | Esik yok | Collector connection attempt | Baglanti duzelince manuel/sonraki akista resolve |
| `authentication_failure` | Kimlik dogrulama/parola hatasi olursa | Auth hatasi | Esik yok | Collector connection/bootstrap | Auth duzelince manuel/sonraki akista resolve |
| `permission_denied` | Monitoring icin gereken yetki yoksa | Yetki hatasi | Esik yok | Bootstrap/discovery | Yetki duzelince manuel/sonraki akista resolve |
| `extension_missing` | `pg_stat_statements` bulunamazsa | Extension var/yok | Esik yok | Bootstrap/discovery | Extension kurulup bootstrap basarili olunca resolve |
| `secret_ref_error` | `secret_ref` dosya/env cozumlenemezse | Secret cozumleme hatasi | Esik yok | Bootstrap | Secret duzelince retry ile resolve |
| `bootstrap_failed` | Bootstrap adimlarindan biri hata alirsa | `phase`, `error_message` | Esik yok | Bootstrap | Bootstrap basarili olunca resolve/manuel |
| `stale_data` | Hazir instance'ta metrik uzun sure gelmezse | Son cluster collect yasi | 10 dakika kod ici | `control.instance_state` | Veri tekrar gelince auto-resolve akisi |
| `stats_reset_detected` | `pg_stat_statements` reset/epoch degisimi yakalanirsa | Epoch/reset farki | Esik yok | Statements collector | Bilgi alerti; yeni baseline baslar |
| `lock_contention` | Bir lock beklemesi esikten uzun surerse | Bekleme suresi, saniye | 300 sn | Son lock snapshot | Lock bekleme bitince sonraki akista resolve/manuel |
| `high_connection_usage` | `numbackends / max_connections` esigi asarsa | Kullanim yuzdesi | 80% | Son 5 dk icindeki son DB snapshot | Oran normale donunce resolve/manuel |
| `long_running_query` | Aktif client backend query esikten uzun surerse | Query suresi, saniye | 300 sn | Her instance icin son activity snapshot | Query bitince resolve/manuel |
| `replication_lag` | Primary'de replay lag byte esigi asarsa | Lag MB | 50 MB warning, critical=10x | Replication snapshot | Lag normale donunce resolve/manuel |
| `high_bloat_ratio` | Tablo dead tuple orani esigi asarsa | Dead tuple yuzdesi | 20% | Son table stat snapshot | Oran normale donunce resolve/manuel |
| `index_suspect_missing` | Seq scan/idx scan orani yuksek ve tablo anlamli buyukse | Seq/idx oran | 100x | Son 24 saat table delta + relation size | Kosul kalkinca resolve/manuel |
| `index_unused` | Index tam gozlem penceresinde hic scan edilmezse | Esik yok; boyut bilgi amacli | Esik yok | Son 30 gun tam gozlem, cluster-aware | Index kullanilirsa veya drop edilirse resolve/manuel |
| `index_invalid` | Index invalid veya not-ready durumdaysa | Esik yok | Esik yok | Son index stat snapshot | Index valid/ready olunca veya drop edilince resolve/manuel |
| `high_temp_files` | DB temp file sayisi esigi asarsa | Temp file sayisi/saat | 100/saat | Son 1 saat database delta | Temp file normale donunce resolve/manuel |
| `high_temp_files_daily` | DB temp file sayisi gunluk esigi asarsa | Temp file sayisi/24s | 1000/24s | Son 24 saat database delta | Temp file normale donunce resolve/manuel |
| `high_temp_sqls_daily` | 24 saatte cok sayida SQL 100MB+ temp yazarsa | SQL sayisi/24s | 10 SQL | Son 24 saat pg_stat_statements delta | SQL sayisi normale donunce resolve/manuel |
| `idle_in_tx_time_high` | Idle-in-transaction sure orani esigi asarsa | Idle/session yuzdesi | 30% | Son 1 saat database delta, PG14+ | Oran normale donunce resolve/manuel |
| `replication_slot_inactive` | Slot 1 saat inactive kalip WAL tutarsa | Slot lag MB | 1024 MB | Son 1 saat slot snapshot | Slot active olur/drop edilirse resolve/manuel |
| `job_partial_failure` | Job run'da bazi instance'lar fail olursa | Failed/total sayisi | Esik yok | Job orchestrator | Sonraki basarili job/manuel |
| `job_failed` | Job tamamen fail olursa veya genel job exception olursa | Job error | Esik yok | Job orchestrator | Sonraki basarili job/manuel |
| `advisory_lock_skip` | Ayni job icin advisory lock alinamazsa | Lock skip olayi | Esik yok | Job orchestrator | Sonraki job akisi/manuel |
| `system_instance_unreachable` | (a) `consecutive_failures >= 3` olan instance'lar icin `SystemHealthEvaluator` tarafindan periyodik (5 dk); (b) daha once `ready` olan bir instance connect/auth hatasi (ornegin pg_hba.conf yetkisinin kaldirilmasi) yuzunden `degraded`'a dusunce `JobOrchestrator.handleSecretOrAuthError` tarafindan aninda (P0-024, 2026-07-17) | `consecutive_failures` esigi (a) / degrade anlik (b) | 3 basarisizlik (a) | `control.instance_state` (a) / cluster-statements job hatasi (b) | (a) `consecutive_failures` sifirlaninca; (b) instance tekrar `bootstrap_state='ready'`'ye donunce `BootstrapHandler` auto-resolve |

## Custom Rule Template'leri

Bu alertler `ops.alert.alert_code = user_defined_rule` olarak yazilir; text
template secimi metric tipine gore yapilir.

| Template code | Ne zaman kullanilir | Ana parametreler |
| --- | --- | --- |
| `user_defined_rule` | Genel custom rule, granular olmayan metricler | `metric`, `value`, `operator`, `threshold`, `window`, `aggregation` |
| `statement_threshold` | Statement metric threshold rule | `queryid`, `database`, `user`, `current_value`, `threshold`, `window` |
| `statement_spike` | Statement metric spike rule | `previous_value`, `current_value`, `change_pct`, `query_text` |
| `table_threshold` | Table metric threshold rule | `table`, `database`, `metric`, `current_value`, `threshold` |
| `table_spike` | Table metric spike rule | `table`, `previous_value`, `current_value`, `change_pct` |
| `index_threshold` | Index metric threshold rule | `index`, `table`, `metric`, `current_value`, `threshold` |
| `index_spike` | Index metric spike rule | `index`, `table`, `previous_value`, `current_value`, `change_pct` |

## Work Mem Notu

`high_temp_files` query/session seviyesinde `SET LOCAL work_mem` onerisi verir.
Oneri once temp yazan sorgu ihtiyacindan hesaplanir, sonra `max_connections`,
`shared_buffers` ve `effective_cache_size` ile konservatif ust sinira cekilir:
`(effective_cache_size - shared_buffers) / max_connections / 2`.
`effective_cache_size` gercek host RAM degil, PostgreSQL planner cache tahmini/proxy
degeridir; bu nedenle global `ALTER SYSTEM SET work_mem` degisikligi otomatik
onerilmez. `high_temp_sqls_daily` icin SQL basina minimum temp yazimi ilk fazda
sabit 100MB'dir; `threshold_value` sadece kac SQL'den sonra alert uretilecegini
belirler.

## Hangi bildirim nereye gider

Bir alarmın **açılması** ile **bildirilmesi** ayrı şeylerdir. Alarm her
zaman `ops.alert`'e yazılır ve UI'da görünür; bildirim gönderilip
gönderilmeyeceğini dört ayrı mekanizma belirler. Hepsi bugün mevcut ve
UI'dan ayarlanabilir.

### 1. Kanal bazlı severity eşiği

`control.notification_channel.min_severity` — o kanal yalnızca bu
seviyeden **itibaren** bildirim alır. Sıralama:
`info < warning < error < critical < emergency`.

**Bildirim Kanalları** ekranından ayarlanır. Tipik kullanım:

| Kanal | `min_severity` | Amaç |
|---|---|---|
| Telegram | `critical` | Anında müdahale gerektirenler |
| E-posta | `warning` | Günlük gözden geçirme |

Bu ayarla warning'ler UI'da görünmeye devam eder, sadece telefona
düşmez. `NULL` bırakılırsa kanal her seviyeyi alır.

### 2. Kural bazlı kanal seçimi

`control.alert_rule_notification_channel` — bir kuralın bildirimleri
yalnızca seçilen kanallara gider. **Alert Rules** ekranında kuralı
düzenlerken seçilir. Hiç kanal seçilmezse kural tüm uygun kanallara
gider (severity filtresine tabi).

**Sınır:** bu eşleme yalnızca kural kaynaklı alarmlar için çalışır.
Sistem alarmlarının (`alert_source = 'system'`) bir `rule_id`'si
olmadığı için bu filtreden geçmezler; onlar sadece severity eşiğine
tabidir.

### 3. Kanal bazlı alarm tipi filtresi

`control.alert_code_notification_channel` — bir kanalın hangi alarm
**tiplerini** kabul ettiğini sınırlar. **Bildirim Kanalları** ekranında,
kanalı düzenlerken "Alarm Tipleri" listesinden seçilir.

Hiçbiri seçilmezse kısıtlama yoktur; kanal tüm tipleri alır. Yani boş
liste "hiçbirini alma" değil **"hepsini al"** demektir.

Bu filtre 2 numaralı mekanizmanın kapsamadığı boşluk için var:
`AlertCode` enum'undaki 21 kodun 20'si `system` ya da `adaptive`
kaynaklı olduğu için `rule_id` taşımaz ve kural→kanal eşlemesinden hiç
geçmez. Onlar için alarm tipine göre yönlendirmenin tek yolu budur.

Üç filtre birlikte uygulanır: severity **seviyeyi**, kural→kanal bir
kuralın **hangi kanallara** gideceğini, kanal→kod bir kanalın **hangi
tipleri** kabul ettiğini sınırlar.

### 4. Susturma (snooze)

`control.alert_snooze` — belirli bir `alert_key`, `alert_code` veya
instance için bildirimleri geçici olarak durdurur. Çözülme bildirimleri
susturmadan **etkilenmez**.

### 5. Bakım penceresi

`control.maintenance_window` — belirtilen gün/saat aralığında, seçilen
instance'lar için bildirim gönderilmez.

### Ayrıca her zaman geçerli olan spam koruması

Aynı alarm için cooldown süresi içinde aynı veya daha düşük severity'de
zaten bildirim gönderilmişse tekrar gönderilmez
(`ops.notification_log` üzerinden). Severity yükselirse bu koruma
otomatik devre dışı kalır — kötüleşen bir durum susturulmaz.

Çözülme bildirimleri (`Resolved:` önekli) cooldown'ı bilerek **bypass
eder**: bir sorunun düzeldiği her zaman bildirilmelidir.

### Granular kurallarda toplama

Tablo/indeks/sorgu bazlı kurallar kayıt başına ayrı alarm açar ama
değerlendirme başına **tek** bildirim gönderir — beş bozuk tablo beş
alarm, bir mesaj. Çözülme tarafı da aynı şekilde toplanır.

## `stale_statistics` — Bayat İstatistik

Sorgu planları istatistiklerden hesaplanır: planner join boyutlarını
`n_live_tup`/`reltuples` üzerinden tahmin eder. İstatistik gerçeği
yansıtmıyorsa plan da yanlış olur — üretimde 62 satır sanılan bir tablo
gerçekte 4.593.352 satırdı; böyle bir tablo nested loop'un iç tarafına
konur ve sorgu saatlerce sürer.

### Eşik sabit değil

Kural kendi sabitini taşımaz. Bir tablonun istatistiklerinin bayat
sayılıp sayılmayacağına **PostgreSQL'in kendi autoanalyze eşiği** karar
verir:

```
eşik = autovacuum_analyze_threshold + autovacuum_analyze_scale_factor × reltuples
```

Kural şunu sorar: **eşik aşıldığı hâlde ANALYZE ne kadar süredir
çalışmadı?** Eşik aşılmamışsa ortada sorun yoktur.

Bu ayrım deneyimle öğrenildi. `t_ets_hotel_transaction_log` 29 gündür
analiz görmemişti ve bu tamamen normaldi: gerçek eşiği 1.520.266, birikmiş
değişim 516.298 — eşiğin %34'ü. Sabit bir "10.000 satır / 7 gün" kuralı
onu yanlışlıkla işaretlerdi.

Kural böylece kendi kendini kalibre eder: instance'ın kendi
`autovacuum_analyze_*` ayarlarını kullanır, tablo boyutuna göre ölçeklenir,
ayar değişince eşik de değişir.

### Neden `n_mod_since_analyze`

Bu sayaç `ANALYZE` tarafından sıfırlanır, yani uyarmak istediğimiz bozuk
`n_live_tup`/`n_dead_tup` tahminlerinden bağımsızdır. Kuralı canlı satır
tahminine dayandırmak, ölçmeye çalıştığı hatanın kendisine dayanmak
olurdu.

`reltuples` bilinmiyorsa (PG14+ `-1`, ya da hiç vacuum/analyze görmemiş
tablo) eşik `autovacuum_analyze_threshold`e iner — PostgreSQL de pratikte
aynı yere varır. Bu tablolar kapsam dışı bırakılmaz: hiç analiz edilmemiş,
eşiği aşmış ve uzun süredir bekleyen bir tablo tam da yakalanmak istenen
durumdur.

### Eşikler

`warning_threshold` ve `critical_threshold` **saat** cinsindendir: eşik
aşıldıktan sonra `ANALYZE`'ın çalışmamasına ne kadar tahammül edileceği.
Varsayılan 24 / 72 saat, Alert Rules ekranından değiştirilebilir.

### Alarm ve aksiyon

Instance başına **tek** alarm açılır, çünkü çözüm zaten instance geneli
tek komuttur. Mesaj en uzun süre bekleyen tabloları, kaç satırın
değiştiğini ve aştıkları eşiği listeler; sığmayanlar "… ve N tablo daha"
olarak görünür.

Aksiyon tek tabloda `ANALYZE şema.tablo;`, birden fazlada
`vacuumdb --analyze-only -d <db>` olur.

## `table_space_bloat` — Fiziksel Tablo Şişmesi

`dead_tuple_ratio` **ölü satır** sayar. Bu, "autovacuum yetişemiyor"
durumunu yakalar ama tersini **yapısal olarak göremez**: autovacuum
yetişiyor, ölü satırları temizliyor, ama boşalan alan yeniden
kullanılmıyor. O durumda ölü satır sayısı tanımı gereği düşüktür.

Üretim vakası (2026-08-31): `agg.pg_table_stat_hourly_202608` %98'i boş
alan olacak şekilde 2432 MB'a şişmişti. `dead_tuple_ratio` ancak %20.00
ile — eşiğin tam sınırında — tetiklendi ve **yanlış aksiyon** önerdi:
`VACUUM ANALYZE`. O komut bu alanı geri getirmez.

### Neye dayanıyor

Alanın gerçekten ne kadarının boş olduğunu kesin ölçmenin tek yolu
`pgstattuple` ya da `pg_freespacemap` — ikisi de extension, ve izlenen
her instance'a kurulamaz. Klasik alternatif `pg_stats.avg_width`'e
dayanan tahmin sorgusudur; onun da kritik bir körlüğü var: **hiç
`ANALYZE` edilmemiş tabloda `avg_width = 0` olduğu için sonuç %0 bloat
çıkar.**

pgstat'ın avantajı sürekli izliyor olması. Aynı tablo tekrar tekrar
ölçüldüğü için:

```
satır başına bayt = table_size_bytes / reltuples
```

Bu değer, tablonun kendi geçmişindeki **en sıkışık üç günün medyanıyla**
karşılaştırılır. Yukarıdaki tablo ~20.032 bayt/satır ölçülmüş, sonra aynı
satır sayısında 338 bayt/satır — 59 kat. `avg_width`'e, `ANALYZE`
kalitesine veya fillfactor varsayımına hiç ihtiyaç duyulmadan.

**Bu bir tahmindir, iki ölçümün farkı değildir.** Pay (`table_size_bytes`)
gerçek bir ölçümdür, ama payda (`reltuples`) `pg_class`'ta duran bir
katalog **tahminidir** ve yalnızca `VACUUM`/`ANALYZE` çalıştığında
güncellenir. Bu yüzden ankraj anı ile boyut ölçümü arasındaki
eklenen/silinen satırlar delta'lardan düzeltilir; düzeltilemiyorsa kayıt
atlanır. Oranı olduğundan daha kesin sunmak, kullanıcıyı ölçmediğimiz bir
şeye güvendirmek olurdu.

Taban neden **medyan**, ham minimum değil: `bytes_per_row`'un paydası
tahmin olduğu için tek bir gözlemde `reltuples` yukarı saparsa
`bytes_per_row` aşağı sapar; ham minimum o gürültülü değeri taban yapar ve
sonraki her gözlem şişmiş görünür. Farklı günlerden gelen en düşük üç
değerin medyanı bunu önler (V110).

Sıkışık hâl kendiliğinden oluşur: `VACUUM FULL` sonrası, partition ilk
açıldığında, ya da tablo boşken.

**Sınırı:** taban geçerli olmadan alarm üretilmez — en az 21 farklı gece,
en az 28 günlük yayılım, aynı `relid`, aynı fillfactor rejimi, ve yalnızca
planlı gece ölçümlerinden. Uydurulmuş bir taban, sessizlikten daha
zararlıdır.

### Eşikler

`warning_threshold` / `critical_threshold` **şişme katıdır** (3 = olması
gerekenin 3 katı). `bloat_min_rows` bu kuralda **MB cinsinden mutlak alt
sınırdır** — küçük bir tabloda %300 şişme 3 MB'dır, müdahaleye değmez.
İki koşul birlikte aranır.

Ayrıca: 8 MB'ın altındaki tablolar ve iki gözlemden az geçmişi olanlar
dışlanır. Tek gözlemde minimum = mevcut değer olur, oran her zaman 1.0.

### Aksiyon tabloya göre ayrışır

- **Geçmiş tarihli partition** → `VACUUM FULL` güvenli, kimseyi
  engellemez
- **Aktif tablo** → `VACUUM FULL` yazmayı durdurur; bakım penceresi ya da
  kilit almayan `pg_repack`; tekrarlıyorsa asıl çözüm yazım desenini
  değiştirmek
