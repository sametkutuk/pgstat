# Merkezi PostgreSQL Stat Toplama Tasarimi

## Amac

Bu dokuman, farkli PostgreSQL instance'larindan toplanan `pg_stat_statements` ve diger istatistiklerin merkezi bir PostgreSQL ortaminda guvenli, dusuk maliyetli ve surdurulebilir sekilde tutulmasi icin karar verilen kurallari, veri modelini, kontrol duzlemini ve operasyonel mimariyi tanimlar.

Bu tasarimin temel hedefleri:

- Kaynak PostgreSQL instance'larda lock ve anlamli performans yuku olusturmamak
- Ham veriyi kaynaklardan cekip islemeyi collector makinesinde yapmak
- Yeni makine eklemeyi kolay, guvenli ve otomatik hale getirmek
- PostgreSQL `11` ile `18` arasi surum farklarini desteklemek
- PostgreSQL upgrade sonrasi veri surekliligini korumak
- SQL text verisini tekrar tekrar yazmadan saklama maliyetini dusurmek

## Proje Niyeti ve Tasarim Siniri

Bu projenin niyeti, genel amacli bir observability platformu yazmak degil; PostgreSQL istatistik toplama problemini merkezden yoneten, surum farklarini handle eden ve kaynak sistemleri koruyan ozel bir toplama platformu kurmaktir.

Bu niyetin pratik anlami sudur:

- `50+` farkli PostgreSQL host ve cluster'ini tek merkezden yonetebilmek
- PostgreSQL `11` ile `18` arasi farkli major version'lari ayni collector mantigiyla toplayabilmek
- Her sunucuyu ayri, her database'i ayri ve gerekirse `service_group` bazinda birlikte raporlayabilmek
- Ayni SQL text'i gereksiz tekrar yazmadan saklamak
- `queryid` degiskenliginden etkilenmeden upgrade sonrasi tarihsel sureklilik saglamak
- Yeni host ekleme, retention tier degistirme ve toplama frekansi yonetimini uygulama ve inventory uzerinden yapmak
- Desteklenmeyen veya yeni surum goruldugunde tum akisi durdurmak yerine desteklenen metrikleri toplamaya devam edip operatoru uyarmak

Bu proje bilinclli olarak su isleri ilk amac olarak secmez:

- Kaynak PostgreSQL uzerinde derin analiz yapan agir bir tuning araci olmak
- Uygulama tablolarina join yapan raporlama urunu olmak
- Kaynak sistemde agent, function, trigger veya kalici obje yaratan bir yapi olmak
- Gecmise donuk tam backfill yapan bir migrasyon sistemi olmak

## Basari Kriterleri

Bu mimari basarili sayilmak icin asagidaki kosullari saglamalidir:

- Kaynak PostgreSQL tarafinda yazma yapmamalidir.
- Kaynak PostgreSQL tarafinda lock beklememeli ve anlamli yuk olusturmamalidir.
- Yeni bir host, inventory kaydi acilip gerekli baglanti ve schedule bilgileri girildikten sonra otomatik olarak toplama akisina girebilmelidir.
- Her instance icin retention tier sonradan degistirilebilmeli, bu degisiklik kod veya scheduler degisikligi gerektirmemelidir.
- Her instance ve her database ayri raporlanabilmeli, ayni zamanda `service_group` bazli birlestirilmis rapor da uretilebilmelidir.
- SQL text merkezi tarafta fiziksel cluster baglaminda tekillestirilmeli, fact tablolarda tekrar yazilmamalidir.
- PostgreSQL major upgrade sonrasi tarihsel veri kopmamali; desteklenmeyen kisimlar warning veya degraded olarak raporlanirken desteklenen kisimlar toplanmaya devam etmelidir.
- Veri toplama, retention ve alerting kontrolu merkezi DB ve collector mantiginda kalmali; tek tek host bazli cron veya script daginikligi olmamalidir.

## Temel Prensipler

### 1. Kaynak sistemlere zarar vermeme

- Collector kaynak PostgreSQL'lere **kesinlikle read-only** baglanir.
- Kaynak sistemlerde hicbir `DDL`, `DML`, `EXPLAIN`, `EXPLAIN ANALYZE`, temp tablo olusturma, kalici obje yaratma veya yazma islemi yapilmaz. Bu kural istisnasizdir.
- Collector yalnizca `SELECT` ve resmi PostgreSQL stat view/fonksiyonlarini kullanir. Calistirilan tum sorgular salt okumadır; `pg_stat_statements()`, `pg_stat_activity`, `pg_stat_replication` gibi sistem view'lari okunur, kaynak veritabanina hicbir veri yazilmaz.
- Kullanici tablolarina join, agir katalog taramalari veya uygulama sorgulariyla cakisabilecek ekstra islemler ilk fazda yapilmaz.
- Her kaynak instance icin ayni anda en fazla bir adet aktif toplama oturumu calisir.
- Her toplama oturumu kisa omurlu olur; baglanir, veriyi ceker, baglantiyi kapatir.

### 2. Isleme merkezi tarafta yapma

- Kaynak PostgreSQL'lerden mumkun oldugunca ham veri cekilir.
- Surum farki uyarlama, SQL text tekillestirme, delta hesaplama ve veri zenginlestirme collector makinesinde yapilir.
- Merkezi PostgreSQL'e full snapshot yerine gerekliyse delta ve dimension kayitlari yazilir.
- Veri yazma islemleri batch mantigiyla yapilir; satir satir yazim hedeflenmez.

### 3. Otomasyon ve kolay onboarding

- Isletim sistemi seviyesinde tek scheduler kullanilir.
- Tercih edilen scheduler `systemd oneshot service + systemd timer` modelidir.
- Hangi host'un ne zaman toplanacagi merkezi inventory tablosunda tutulur.
- Yeni makine eklemek icin scheduler unit'i degistirilmez; inventory kaydi eklenir.
- Kaynak PostgreSQL'de gerekli extension ve izinler hazirsa sistem otomatik toplamaya baslar.

### 4. Teknik dogruluk

- `queryid`, global ve kalici bir kimlik olarak kabul edilmez.
- SQL text ile istatistik serisi birbirinden ayrilir.
- Upgrade veya reset sonrasi yeni seri acilir; mevcut tarihsel raporlama bozulmaz.
- Surume gore degisen view ve kolonlar collector tarafinda handle edilir.

### 5. Kademeli ilk kurulum ve bootstrap

- Yeni eklenen host tam yukte toplamaya hemen alinmaz.
- Ilk baglantida once kesif yapilir; surum, extension, izin ve desteklenen view bilgileri toplanir.
- Ilk asamada cluster-level metrikler ve `pg_stat_statements` sayisal verisi onceliklendirilir.
- Database-local obje istatistikleri ilk faz kapsamina dahildir; ancak ayri job ve dusuk frekansla toplanir.
- SQL text zenginlestirme ayri bir kuyruk olarak ve sinirli batch'lerle calistirilir.
- Bir host icin tek bir run icinde alinan yeni SQL text sayisi sinirlanir; kalanlar sonraki run'lara birakilir.
- Varsayilan SQL text enrichment batch limiti host basina run basina `100` kayittir.
- Ilk kurulumda gecmise donuk backfill denenmez; baz cizgisi ilk gorulen andan itibaren baslar.
- Host bazli sure veya satir butcesi asilinca kalan toplama isi sonraki cycle'a devredilir.

## Kapsam

Ilk fazda toplanacak baslica veri kaynaklari:

- `pg_stat_statements`
- `pg_stat_database`
- `pg_stat_wal`
- `pg_stat_bgwriter`
- `pg_stat_checkpointer` uygun surumlerde
- `pg_stat_io` uygun surumlerde
- `pg_stat_user_tables`
- `pg_statio_user_tables`
- `pg_stat_user_indexes`
- `pg_statio_user_indexes`
- `pg_stat_activity` (session snapshot)
- `pg_stat_replication` (yalnizca primary node'larda)
- `pg_locks` (bekleyen lock'lar — `granted = false`)
- `pg_stat_progress_vacuum` (PG9.6+)
- `pg_stat_progress_analyze` (PG13+)
- `pg_stat_progress_create_index` (PG12+)
- `pg_stat_progress_cluster` (PG12+)
- `pg_stat_progress_basebackup` (PG13+)
- `pg_stat_progress_copy` (PG14+)

Ilk faz kapsamina alinmayacaklar:

- Uygulama tablolariyla join yapilan raporlar
- Source instance uzerinde uzun sureli veya agir analizler
- Tum objeler icin her cycle `pg_total_relation_size`, `pg_relation_size` benzeri pahali boyut taramalari

## Bilesenler

Bu yapi dort temel bilesenden olusur:

1. Kaynak PostgreSQL instance'lar
2. Collector uygulamasinin calistigi Linux makinesi
3. Merkezi PostgreSQL veritabani
4. `systemd timer` tabanli scheduler

### Kaynak PostgreSQL instance'lar

- Her instance icin ayri bir collector kullanicisi tanimlanir.
- Kullanici, yalnizca gerekli istatistik view'larini okuyabilecek en az yetki prensibiyle olusturulur.
- `pg_stat_statements` gerekli olan instance'larda `shared_preload_libraries` ile aktif edilmis olmali.
- Uygun surumlerde `compute_query_id` acik olmali.

### Collector uygulamasi

Collector merkezi is mantigini tasir. Gorevleri:

- Inventory'den aktif host listesini okumak
- Her host icin surumu ve desteklenen ozellikleri tespit etmek
- Uygun SQL profilini secmek
- Ham veriyi cekmek
- Delta, dedup ve seri yonetimi yapmak
- Merkezi PostgreSQL'e batch yazmak
- Hata, timeout ve retry kurallarini uygulamak

Collector bir daemon olmak zorunda degildir. Baslangic icin stateless bir CLI uygulamasi yeterlidir.

Ornek calistirma modeli:

```text
collector run --job cluster
collector run --job statements
collector run --job db_objects
collector run --job rollup
```

### `systemd timer`

`systemd timer`, yalnizca collector service'ini periyodik olarak tetikler. Is mantigi scheduler taniminda degil collector uygulamasinda tutulur.

Ornek gorev ayrimi:

- `cluster` job: sik, hafif ve cluster genelindeki metrikler
- `statements` job: daha agir olan `pg_stat_statements` toplama isi
- `db_objects` job: database-local tablo ve index istatistiklerini dusuk frekansla toplar
- `rollup` job: asagidaki iki asamayi sirali olarak calistirir:
  1. **Saatlik rollup** (`hourly_rollup_interval_seconds`'da bir): son tamamlanan saat icin `fact.pgss_delta`'dan `agg.pgss_hourly`'ye ozet uretir.
  2. **Gunluk rollup** (UTC `daily_rollup_hour_utc`'de bir kez): bir onceki gunun tamamlanmis `agg.pgss_hourly` saatlerini toplayarak `agg.pgss_daily`'ye yazar; ayni zamanda gelecek `14` gunluk eksik `fact` partisyonlarini ve gelecek `2` aylik `agg` partisyonlarini olusturur.

### Merkezi PostgreSQL

Merkezi veritabani su tip verileri tutar:

- Inventory ve scheduler konfigurasyonu
- SQL text dimension tablolari
- Statement series ve object reference dimension tablolari
- Cluster, database, statement, table ve index seviyesinde fact tablolari
- Rollup tablolari
- Hata ve toplama log kayitlari

## Uygulama Modulleri ve Yasam Dongusu

Bu mimari uygulama icinde asagidaki modullere ayrilir:

1. Inventory ve topology modulu
   Cluster ekleme, guncelleme, pasife alma ve service grouping burada yonetilir.
2. Scheduler ve execution modulu
   `systemd timer` ile tetiklenen collector run'larini yonetir.
3. Capability ve compatibility modulu
   Surum, extension ve desteklenen view kesfini yapar.
4. Ingestion ve normalization modulu
   Kaynak veriyi ceker, delta hesaplar, dedup yapar ve merkezi DB'ye yazar.
5. Retention ve partition management modulu
   Aylik retention kurallarina gore eski veriyi temizler; birincil olarak partisyon drop kullanir, tier farki varsa merkezi DB'de instance bazli batched delete uygular.
6. Alerting ve operations modulu
   Uygulama ekrani, warning/error/critical alertleri ve job loglarini yonetir.

### Cluster ekleme akisi

1. Uygulama uzerinden `instance_id`, baglanti bilgileri, `service_group`, schedule profili ve retention tier'i girilir.
2. Inventory kaydi olusur.
3. Collector kesif yapar.
4. Host destekleniyorsa aktif toplamaya alinir.
5. Desteklenmeyen kisimlar varsa `degraded` durumda calismaya devam eder.

### Cluster cikarma akisi

1. Cluster inventory kaydinda `is_active = false` yapilir.
2. Scheduler yeni toplama yapmayi birakir.
3. Tarihsel veri hemen silinmez.
4. Tarihsel veri retention politikasina gore zamanla temizlenir.

### Database ekleme akisi

1. Yeni database uygulama tarafindan manuel eklenmez.
2. Collector ilk goruste `dim.database_ref` kaydini otomatik acar.
3. `control.database_state` kaydi otomatik olusur ve tablo/index toplama queue'suna girer.
4. Sonraki fact kayitlari ilgili `dbid` altinda yazilir.

### Database cikarma akisi

1. Bir database kaynaktan silinirse collector artik yeni veri gormez.
2. `dim.database_ref.last_seen_at` tarihi son gorulen zamana kadar kalir.
3. Tarihsel veri retention dolana kadar raporlanabilir.
4. Hemen hard delete yapilmaz.

## Kaynak Taraf Icin Degismez Kurallar

Asagidaki kurallar ihlal edilmez:

- Kaynak host'ta yazma islemi yapilmaz.
- Kaynak host'ta uzun transaction birakilmaz.
- Kaynak host'ta lock beklenmez.
- Bir host ayni anda birden fazla collector oturumu tarafindan taranmaz.
- Ayni instance icin ayni anda en fazla bir adet database-local tablo/index toplama oturumu calisir.
- Collector, time-out alan veya yavaslayan host'u o tur atlar.
- Basarisiz bir host yuzunden genel job zinciri bloke edilmez.
- `pg_stat_statements` her toplamada SQL text ile okunmaz.
- Obje bazli istatistik toplama size fonksiyonlariyla zenginlestirilmez; yalnizca resmi stat view'lar okunur.

Baglanti seviyesinde minimum korumalar:

- `application_name` sabit bir collector adi ile set edilir.
- `connect_timeout` kullanilir.
- `statement_timeout` kullanilir.
- `lock_timeout` kullanilir.
- `idle_in_transaction_session_timeout` kullanilir.
- Mumkunse TLS kullanilir.

**Baglanti havuzu stratejisi:** Collector, her kaynak PostgreSQL instance'ina dogrudan (PgBouncer olmadan) kisa omurlu baglanti acar; toplama tamamlaninca hemen kapatir. Merkezi PostgreSQL'e de her job run icin dogrudan baglanti kullanilir; advisory lock bu baglanti uzerinde tutulur. `max_host_concurrency` degeri, ayni anda kac kaynak instance'ina paralel baglanti acilacagini sinirlar.

## Ilk Kurulum ve Bootstrap Kurali

Ilk kurulumda amac, kaynaktaki mevcut istatistikleri tek seferde "kazimak" degil, sistemi guvenli sekilde toplamaya almaktir.

Bu nedenle bootstrap sirasi sabitlenir:

1. `discover`: host'a baglan, surum ve capability tespiti yap.
2. `baseline_cluster`: hafif cluster-level metrikleri toplamaya basla.
3. `baseline_statements`: `pg_stat_statements(false)` ile sayisal baz cizgisini olustur.
4. `discover_databases`: database envanterini cikar ve `control.database_state` kayitlarini olustur.
5. `baseline_db_objects`: per-run database butcesi ile tablo ve index istatistiklerini parcali toplamaya basla.
6. `enrich_text`: yeni statement series icin SQL text'i sinirli batch'lerle cek.
7. `steady_state`: host normal periyodik toplama akisina gecsin.

**Bootstrap state gecisleri ve collector aksiyonu:**

| `bootstrap_state` | Anlam | Collector aksiyonu |
|---|---|---|
| `pending` | Inventory kaydedildi, ilk kesif bekleniyor | Baglanti kur, surum ve capability tespit et → `discovering` |
| `discovering` | Kesif sureci devam ediyor | Capability kaydet, database envanteri cikart → `baselining` |
| `baselining` | Sayisal baz olusturuluyor | `pg_stat_statements(false)` ile ilk sample al, cluster metrikleri topla → `enriching` |
| `enriching` | SQL text ve db_objects zenginlestiriliyor | Batch SQL text cek, ilk db_objects turu → `ready` |
| `ready` | Normal toplama modunda | Periyodik olarak tum job'lari calistir |
| `degraded` | Kismi calisiyor; eksik extension/view | Desteklenen metrikleri topla, eksikleri alert et; otomatik olarak `ready`'e donmez |
| `paused` | Manuel olarak duraklatildi | Hicbir toplama yapma; `ready`'e gecis UI'dan manuel yapilir |

**Bootstrap state geçişlerini kim yazar:** Collector, her adim tamamlandiginda `control.instance_inventory.bootstrap_state` kolonunu gunceller. Ornek:
```sql
update control.instance_inventory
set bootstrap_state = 'discovering'   -- veya 'baselining', 'enriching', 'ready', 'degraded'
where instance_pk = $1;
```

**`control.instance_state` baslatma:** `instance_inventory`'ye yeni kayit eklendiginde `instance_state` satiri otomatik olusturulmaz. Collector bootstrap'in `discovering` adiminda, kabiliyetleri tespit ettikten hemen sonra `instance_state` satirini INSERT eder:
```sql
insert into control.instance_state (instance_pk)
values ($1)
on conflict (instance_pk) do nothing;
```
Bu sayede `next_cluster_collect_at = NULL` ve `next_statements_collect_at = NULL` olur; scheduler bu satirlari `coalesce(..., '-infinity'::timestamptz) <= now()` kosulundan dolayi hemen secmez — collector, bootstrap tamamlaninca bu alanlari `now()` ile set eder. `bootstrap_state in ('pending', 'discovering', 'baselining', 'enriching')` olan instance'lar scheduler SQL'i tarafindan degil, ayri bir "bootstrap queue" sorgusuyla secilir (asagida).

Bootstrap fail olursa host `degraded` duruma gecer; toplama durdurulmaz, uygun adimdan yeniden denenir.

Bootstrap sirasinda ek kurallar:

- SQL text cekimi sayisal metrik toplamadan ayridir.
- Yeni host eklendiginde ayni run icinde tum SQL text'leri cekmeye calisilmaz.
- Yeni host eklendiginde ayni run icinde tum database'lerde tablo/index istatistigi taranmaz.
- `db_objects` collector her run'da host basina sinirli sayida database tarar; kalan database'ler sonraki cycle'lara kalir.
- SQL text enrichment isi host basina kucuk parcalara bolunur.
- Cok buyuk `pg_stat_statements` havuzlarinda once en yuksek `total_exec_time` veya `calls` degerine sahip statement'lar zenginlestirilebilir.
- Bootstrap fail olursa host tumden kapatilmaz; uygun asamadan tekrar denenir.

Bu yaklasim sayesinde ilk kurulumda kaynak host'ta ani CPU, I/O veya query text dosyasi okuma yuku olusturulmaz.

## Kaynak PostgreSQL Onkosullari ve Gerekli Ayarlar

Toplanacak her kaynak PostgreSQL instance'inda asagidaki onkosullar saglanmis olmalidir.

Zorunlu ayarlar:

- `shared_preload_libraries` icinde `pg_stat_statements` bulunmali
- Bu degisiklik icin PostgreSQL restart edilmis olmali
- Collector'in baglandigi admin database'de `CREATE EXTENSION pg_stat_statements` yapilmis olmali
- PostgreSQL `14+` icin varsayilan standart `compute_query_id = auto` olmali; `pg_stat_statements` aktifse bu yeterlidir
- `compute_query_id = on` ancak ortamda acik ve zorunlu bir config standardi isteniyorsa tercih edilmelidir
- Harici bir query-id modulu kullaniliyorsa in-core query id hesaplama kapali tutulmalidir
- `track_counts` acik olmali; bu genelde varsayilan olarak aciktir
- `pg_stat_activity` ve benzeri metrikler okunacaksa `track_activities` acik olmali; bu da genelde varsayilan olarak aciktir

Onerilen ayarlar:

- `pg_stat_statements.save = on`
- `pg_stat_statements.track = top`
- `pg_stat_statements.track_planning = off` ile baslanmali; planning istatistikleri ancak ihtiyac varsa acilmali
- `track_io_timing` ilk kurulumda zorunlu olmamali; acilacaksa overhead olculerek acilmali
- `pg_stat_statements.max` kaynak is yuku ve beklenen statement cesitliligine gore boyutlanmali

Notlar:

- `pg_stat_statements` istatistikleri cluster geneline aittir; bu nedenle collector icin tek bir admin database yeterlidir.
- `compute_query_id = auto`, `pg_stat_statements` yuklu ve aktif oldugunda query identifier hesaplamasini otomatik acar; bu nedenle normal durumda `on` zorunlu degildir.
- `track_io_timing` acik degilse ilgili I/O sure kolonlari sifir gelir; bu eksik veri kabul edilir, toplama akisi bozulmaz.
- `pg_stat_statements.max` buyudukce ek shared memory kullanimi ve ilk tarama maliyeti artar.

## Collector Kullanici Yetki Modeli

Collector kullanicisi ayri, adanmis ve non-superuser bir rol olmalidir.

Temel kurallar:

- Superuser gerekli degildir ve kullanilmaz.
- Ayrica `CREATEDB`, `CREATEROLE`, `REPLICATION` gibi gereksiz yetkiler verilmez.
- Collector kullanicisi cluster-level toplama icin admin database'e ve tablo/index toplama yapilacak her database'e `CONNECT` yetkisi alir.
- Diger kullanicilarin `pg_stat_statements` SQL text ve `queryid` alanlarini gorebilmek icin en az `pg_read_all_stats` verilmelidir.
- Collector kaynak ayarlari da dogruluyorsa `pg_read_all_settings` da verilmelidir.
- Daha genis ama daha kolay yonetilen bir secenek olarak `pg_monitor` verilebilir; ancak minimum yetki prensibi acisindan ilk tercih degildir.
- `pg_stat_statements_reset` gibi reset yetkileri verilmez.
- Server file veya program calistirma yetkileri verilmez.

Onerilen minimum rol modeli:

```sql
CREATE ROLE pgstats_collector
  LOGIN
  PASSWORD '***'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;

GRANT CONNECT ON DATABASE postgres TO pgstats_collector;
-- object stats toplanacak her database icin ayrica:
-- GRANT CONNECT ON DATABASE mydb TO pgstats_collector;
GRANT pg_read_all_stats TO pgstats_collector;
GRANT pg_read_all_settings TO pgstats_collector;
```

Operasyonel notlar:

- Eger extension `public` disinda bir schema'da kurulduysa veya schema izinleri kisitliysa ek `USAGE` ve gerekirse `SELECT` grant'leri verilmelidir.
- Database-local tablo/index collector, her database icinde yalnizca stat view'lari okur; kullanici tablolari uzerinde normal `SELECT` yetkisine ihtiyac duymaz.

## SQL Text ve `queryid` Stratejisi

Bu sistemde `queryid` tek basina global anahtar degildir.

Neden:

- PostgreSQL major version degisince `queryid` degisebilir.
- Ayni SQL farkli semantik kosullarda farkli `queryid` uretebilir.
- Reset, eviction veya extension davranislari sonucunda seri kopabilir.

Bu nedenle iki ayri katman tanimlanir:

### 1. SQL text dimension

- SQL text merkezi DB'de **tum clusterlar icin global olarak bir kez** saklanir.
- Tekillestirme anahtari yalnizca `query_hash`'dir; `system_identifier`'dan bagimsizdir.
- SQL text icin bir hash uretilir: `sha256(query_text)`.
- Full text yalnizca dimension tabloda tutulur.

Not:

- `system_identifier` failover veya restore sonrasi degisebilir; ancak SQL text ayni kaldigi surece `query_hash` degismez ve ayni text tekrar yazilmaz. `system_identifier` tekilleştirme anahtarindan cikarildi.

### 2. Statement series

- Teknik seri anahtari host ve surum baglamini icerir.
- Ornek seri mantigi:

```text
instance_pk + pg_major + pgss_epoch_key + dbid + userid + toplevel + queryid
```

Bu sayede:

- Ayni SQL text birden fazla sample'da tekrar yazilmaz.
- Upgrade sonrasi yeni `queryid` gelse bile ayni text tekrar kullanilabilir.
- Teknik olarak farkli seriler tarihsel raporda ayni SQL text altinda birlestirilebilir.

## SQL Text Toplama Kurali

Varsayilan toplama mantigi:

1. Ana toplama `pg_stat_statements(false)` ile yapilir.
2. SQL text her satirla birlikte cekilmez.
3. Yeni gorulen statement series icin SQL text ayrica alinabilir.
4. SQL text hash hesaplanir ve merkezi dimension tabloda tekillestirilir.
5. Fact tablolarina full text degil, `query_text_id` yazilir.

Bu tasarim disk kullanimini ciddi sekilde azaltir.

## Delta ve Reset Kurali

Toplanan istatistiklerin buyuk kismi kumulatif sayactir. Bu nedenle:

- Merkezi tarafta delta hesaplanir.
- Reset veya sayac geriye sarma durumu yeni bir epoch olarak ele alinir.
- Negatif delta olusursa once reset veya restart olasiligi kontrol edilir.
- `stats_reset` bilgisi mevcutsa kullanilir.
- `stats_reset` olmayan veya tutarsiz olan eski surumlerde sayac dususu tespit edilerek yeni seri baslatilir.

### Cluster Metrik Reset Takibi

`pg_stat_bgwriter`, `pg_stat_wal`, `pg_stat_checkpointer` gibi cluster seviyesindeki view'lar da kumulatif sayac iceriri ve `pg_stat_bgwriter_reset()` gibi fonksiyonlarla sifirlanalibilir.

`pgss_epoch_key` yalnizca `pg_stat_statements` reset takibi icin tanimlanmistir. Cluster metrikleri icin ek reset takip mekanizmasi gerekir:

- `pg_stat_bgwriter.stats_reset` (PostgreSQL 14 oncesinde mevcut, 17'de kaldirildi)
- `pg_stat_wal.stats_reset` (PostgreSQL 14+)
- `pg_stat_checkpointer.stats_reset` (PostgreSQL 17+)

Collector her cluster toplama cikisinda ilgili view'in `stats_reset` degerini onceki run ile karsilastirir. Degisim veya negatif delta tespit edildiginde:

1. `control.instance_state`'e cluster reset zamani yazilir.
2. O toplama donemi icin delta hesaplanmaz; yalnizca yeni baz cizgisi kaydedilir.
3. `ops.alert`'e `info` severity ile cluster stats reset uyarisi yazilir.

PostgreSQL 17 oncesinde `pg_stat_bgwriter.stats_reset` tek kaynak oldugundan, bu surumlerde reset sadece negatif delta tespiti ile anlasılır. Bu sinirlilik kabul edilebilir; ilk sample atlanarak veri surekliligi bozulmaz.

### Yeni epoch sonrasi ilk sample kurali

Reset, upgrade veya restart sonrasi yeni bir epoch acildiginda, o epoch'un ilk sample'i ozel olarak ele alinmalidir:

- Yeni epoch'ta ilk kez gorulen bir `statement_series` icin onceki epoch'un kumulatif degeri bilinmez.
- Bu nedenle ilk sample icin delta hesaplanamaz; ilk sample yalnizca "baz cizgisi" olarak kaydedilir, `fact` tablosuna delta yazilmaz.
- Baz cizgisi `control.instance_state.current_pgss_epoch_key` ve son bilinen snapshot olarak collector tarafinda hafizada (veya merkezi DB'de ara tabloda) tutulur.
- Bir sonraki sample geldiginde delta = yeni_deger - baz_deger olarak hesaplanir ve fact'e yazilir.
- Bu kural negatif delta ve sahte buyuk delta yazmalarini onler.

## PostgreSQL Upgrade Kurali

Bir kaynak PostgreSQL upgrade edildiginde:

- `instance_id` degismez.
- Yeni major version bilgisi kayda gecer.
- Yeni bir statement series baslatilir.
- SQL text ayniysa ve fiziksel cluster da ayniysa mevcut `query_text_id` tekrar kullanilabilir.
- Tarihsel raporlar teknik seriler uzerinden degil, ihtiyaca gore `query_text_id` veya instance bazli mantikla birlestirilir.

Bu kuralla upgrade sonrasi veri surekliligi korunur ve eski veri bozulmaz.

## Scheduler Kurali

Temel scheduler kararlari:

- OS seviyesinde tek `systemd timer` tanimi bulunur.
- `systemd timer`, inventory icindeki kayitlara gore collector service'ini tetikler.
- Her host icin ayrica scheduler tanimi yazilmaz.
- Her host icin toplama frekansi inventory'de tanimlanir.
- Ayni job'in cakisan iki kopyasi merkezi advisory lock ile engellenir.

### Advisory Lock Mekanizmasi

Collector her job run basinda merkezi PostgreSQL'e bir advisory lock alir. Bu lock, ayni job type'in birden fazla kopyasinin ayni anda calismasini onler.

Lock detaylari:

- Fonksiyon: `pg_try_advisory_lock(lock_key bigint)` — bloklayan degil, hemen `false` dondurenfonksiyon kullanilir; ikinci kopya lock alamazsa sessizce cikis yapar.
- Lock key: job type'a gore sabit bir `bigint` secilir. Ornek:
  - `cluster` job: `hashtext('pgstats_job_cluster')`
  - `statements` job: `hashtext('pgstats_job_statements')`
  - `db_objects` job: `hashtext('pgstats_job_db_objects')`
  - `rollup` job: `hashtext('pgstats_job_rollup')`
- Lock, merkezi PostgreSQL'deki collector'in kendi baglanti session'i uzerinde alinir.
- Session kapandiginda (normal cikis veya crash) PostgreSQL lock'u otomatik serbest birakir; lock takili kalmaz.
- Lock alinamazsa `ops.alert`'e `info` severity ile log yazilir; hata olarak raporlanmaz.

Ornek mantiksal frekanslar:

- Cluster-level metrikler: varsayilan `60` saniye
- `pg_stat_statements`: varsayilan `300` saniye
- Obje bazli tablo/index istatistikleri: varsayilan `1800` saniye
- Saatlik rollup (`agg.pgss_hourly`): varsayilan `3600` saniyede bir
- Gunluk rollup (`agg.pgss_daily`): varsayilan UTC `01:00`'de (bir onceki gunun verisi tamamlaninca); `rollup` job basinda `extract(hour from now() at time zone 'UTC') = daily_rollup_hour_utc` kosulu kontrol edilir, eslesme yoksa gunluk adim atlanir ve sadece saatlik rollup yapilir. Rollup global oldugundan `instance_state`'te instance bazinda `next_rollup_at` tutulmaz; tek bir job run her iki adimi (saatlik ve gunluk) kapsayabilir.

Bu degerler baslangic icin default kabul edilir; ihtiyaca gore degistirilebilir.

## Inventory ve Onboarding Kurali

Yeni host eklemek icin tek bir onboarding kaydi yeterli olmalidir.

Inventory kaydinda en az su bilgiler tutulur:

- `instance_id`
- host
- port
- admin database adi
- secret referansi veya baglanti credential kaynagi
- TLS ayarlari
- aktif veya pasif durumu
- toplama profili
- schedule profili
- retention tier veya retention policy

Onboarding akisi:

1. Inventory kaydi eklenir.
2. Collector ilk baglantida host surumunu tespit eder.
3. Gerekli extension ve view kontrolleri yapilir.
4. Host uygun ise otomatik olarak aktif toplamaya alinir.
5. Eksik extension varsa host `degraded` olarak isaretlenir.
6. Desteklenen metrikler toplanmaya devam eder, eksik kisimlar loglanir.

Bu modelle yeni makine eklemek icin `systemd` timer veya uygulama kodu degistirmek gerekmez.

## Inventory Modeli

Merkezi sistemde inventory bilgisi uygulama config dosyalarinda degil, veritabaninda tutulur.

### `control.schedule_profile`

Bu tablo ortak toplama profillerini tanimlar.

Onerilen kolonlar:

- `schedule_profile_id bigint generated always as identity primary key`
- `profile_code text not null unique`
- `cluster_interval_seconds integer not null default 60`
- `statements_interval_seconds integer not null default 300`
- `db_objects_interval_seconds integer not null default 1800`
- `hourly_rollup_interval_seconds integer not null default 3600`
- `daily_rollup_hour_utc integer not null default 1`
- `bootstrap_sql_text_batch integer not null default 100`
- `max_databases_per_run integer not null default 5`
- `statement_timeout_ms integer not null default 5000`
- `lock_timeout_ms integer not null default 250`
- `connect_timeout_seconds integer not null default 5`
- `max_host_concurrency integer not null default 1`
- `is_active boolean not null default true`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Ilk varsayilan profil:

- `profile_code = default`
- `cluster_interval_seconds = 60`
- `statements_interval_seconds = 300`
- `db_objects_interval_seconds = 1800`
- `hourly_rollup_interval_seconds = 3600`
- `daily_rollup_hour_utc = 1`
- `bootstrap_sql_text_batch = 100`
- `max_databases_per_run = 5`

Kurallar:

- `max_databases_per_run`, tek bir `db_objects` run icinde bir instance icin en fazla kac database taranacagini tanimlar.
- Batch limiti collector uygulamasi tarafinda enforce edilir; scheduler sadece due kayitlari aday olarak sunar.

### `control.retention_policy`

Bu tablo uygulama uzerinden yonetilen retention tier kurallarini tanimlar.

Onerilen kolonlar:

- `retention_policy_id bigint generated always as identity primary key`
- `policy_code text not null unique`
- `raw_retention_months integer not null`
- `hourly_retention_months integer not null`
- `daily_retention_months integer not null`
- `is_active boolean not null default true`
- `purge_enabled boolean not null default true`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Kurallar:

- Retention ay bazinda tanimlanir.
- Uygulama ekraninda ornek olarak `3`, `6`, `12` gibi ay degerleri secilir.
- `policy_code`, uygulamadaki retention tier kodudur.
- V2'de retention tier bazli cluster atamasi desteklenir.
- Her cluster veya node tam olarak bir retention tier'a baglanir.
- Birden fazla retention tier ayni anda `is_active = true` olabilir.
- Tier atamasi `control.instance_inventory.retention_policy_id` uzerinden yapilir.
- Fact tablolara ayri bir retention tier kolonu yazilmaz; purge karari `instance_pk -> retention_policy_id` iliskisi uzerinden hesaplanir.
- `raw_retention_months`, tum raw fact tablolari icin gecerli kabul edilir:
  - `fact.pgss_delta`
  - `fact.pg_database_delta`
  - `fact.pg_table_stat_delta`
  - `fact.pg_index_stat_delta`
  - `fact.pg_cluster_delta`
  - `fact.pg_io_stat_delta`
  - `fact.pg_activity_snapshot`
  - `fact.pg_replication_snapshot`
  - `fact.pg_lock_snapshot`
  - `fact.pg_progress_snapshot`
- `hourly_retention_months`, `agg.pgss_hourly` icin gecerlidir.
- `daily_retention_months`, `agg.pgss_daily` icin gecerlidir; genellikle `hourly_retention_months`'tan buyuk set edilir (ornek: `hourly = 3`, `daily = 24`).
- V1'de tablo/index istatistikleri icin ayri bir retention tier tanimlanmaz; bu raw fact'ler genel `raw_retention_months` kuralini izler.
- `raw_retention_months = 6` ise mevcut ay dahil son `6` takvim ayi tutulur.
- Ornek: tarih `2026-04-16` ise `6` aylik retention icin `2025-11-01` oncesi raw veri ya ilgili instance satirlari temizlenir ya da tumden eligible ise partisyon drop edilir.
- Silme icin birincil yol partisyon drop'tur.
- Tier bazli farkli retention degerleri nedeniyle gerekli oldugunda merkezi DB'de `instance_pk` bazli batched delete uygulanir.
- Tier degisikligi uygulama ekranindan istedigin zaman yapilabilir.
- Purge evaluator her gun calisir; retention ay bazli oldugu icin asil delete/drop adaylari genellikle ay donumunden sonra eligible hale gelir.
- Ayin ilk gunu calismak zorunlu degildir; gunluk calisma kacan purge'leri de telafi eder.
- Tier artisi `3 -> 6` gibi durumlarda yeni retention hemen gecerli olur; elde mevcut ve henuz silinmemis veri korunur.
- Tier azalisinda `12 -> 3` gibi durumlarda yeni retention bir sonraki gunluk purge calismasinda enforce edilir.
- Daha once silinmis veri retention artisi ile geri gelmez.

### `control.instance_inventory`

Bu tablo toplanacak PostgreSQL instance'larin ana kaydidir.

Onerilen kolonlar:

- `instance_pk bigint generated always as identity primary key`
- `instance_id text not null unique`
- `display_name text not null`
- `environment text null`
- `service_group text null`
- `host text not null`
- `port integer not null default 5432`
- `admin_dbname text not null default 'postgres'`
- `secret_ref text not null`
- `ssl_mode text not null default 'prefer'`
- `ssl_root_cert_path text null`
- `schedule_profile_id bigint not null references control.schedule_profile(schedule_profile_id)`
- `retention_policy_id bigint not null references control.retention_policy(retention_policy_id)`
- `is_active boolean not null default true`
- `bootstrap_state text not null default 'pending'`
- `collector_group text null`
- `notes text null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Kurallar:

- `instance_id` izlenen node veya endpoint'in kalici kimligidir.
- Her ayri raporlanacak sunucu icin ayri `instance_id` olmalidir.
- Ayni node upgrade olsa da `instance_id` degismez.
- Hostname veya IP degisebilir; `instance_id` degismeyebilir.
- `service_group`, ayni uygulama veya mantiksal servis altindaki node'lari gruplayabilmek icin kullanilir.
- Her instance'in aktif bir `retention_policy_id` atamasi olmak zorundadir.
- Retention tier degisimi `instance_inventory.retention_policy_id` update edilerek yapilir.
- Secret veya sifre bu tabloda tutulmaz; sadece `secret_ref` tutulur.

### `control.instance_capability`

Bu tablo collector tarafindan kesif sonrasinda doldurulur.

Onerilen kolonlar:

- `instance_pk bigint primary key references control.instance_inventory(instance_pk)`
- `server_version_num integer null`
- `pg_major integer null`
- `system_identifier bigint null`
- `is_reachable boolean null`
- `is_primary boolean null` — `pg_is_in_recovery() = false` ise `true`; replica'larda `false`; kesif yapilmamissa `null`
- `has_pg_stat_statements boolean not null default false`
- `has_pg_stat_statements_info boolean not null default false`
- `has_pg_stat_io boolean not null default false`
- `has_pg_stat_checkpointer boolean not null default false`
- `compute_query_id_mode text null`
- `collector_sql_family text null`
- `last_postmaster_start_at timestamptz null`
- `last_pgss_stats_reset_at timestamptz null`
- `last_discovered_at timestamptz null`
- `last_error_at timestamptz null`
- `last_error_text text null`

### `control.instance_state`

Bu tablo runtime toplama durumunu tutar.

Onerilen kolonlar:

- `instance_pk bigint primary key references control.instance_inventory(instance_pk)`
- `last_cluster_collect_at timestamptz null`
- `last_statements_collect_at timestamptz null`
- `last_rollup_at timestamptz null`
- `next_cluster_collect_at timestamptz null`
- `next_statements_collect_at timestamptz null`
- `bootstrap_completed_at timestamptz null`
- `current_pgss_epoch_key text null`
- `last_cluster_stats_reset_at timestamptz null`
- `consecutive_failures integer not null default 0`
- `backoff_until timestamptz null`
- `last_success_at timestamptz null`

### `control.database_state`

Bu tablo database-local tablo/index toplama runtime durumunu tutar.

Onerilen kolonlar:

- `instance_pk bigint not null`
- `dbid oid not null`
- `last_db_objects_collect_at timestamptz null`
- `next_db_objects_collect_at timestamptz null`
- `consecutive_failures integer not null default 0`
- `backoff_until timestamptz null`
- `last_error_at timestamptz null`
- `last_error_text text null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `primary key (instance_pk, dbid)`

Kurallar:

- Bu tablo `dim.database_ref` ile ayni anda degil, runtime planlama ihtiyaci icin ayrica tutulur.
- `db_objects` job'i due database secimini bu tablo uzerinden yapar.
- Per-run database butcesi ve bir sonraki collect zamani `schedule_profile` ile birlikte yorumlanir.

## Fiziksel Cluster Kimligi ve Epoch Modeli

Bu sistemde uc farkli kimlik katmani vardir:

1. `instance_id`
   Izlenen node veya endpoint kimligidir. Kullanici tarafinda anlamli isimdir.
2. `instance_pk`
   Merkezi warehouse icindeki surrogate bigint anahtardir.
3. `system_identifier`
   PostgreSQL'in fiziksel cluster kimligidir. `pg_control_system()` ile okunur.

Kurallar:

- `instance_id` ayni izlenen node veya endpoint icin sabit kalir.
- Failover, restore veya yeniden kurulum sonrasi `system_identifier` degisebilir.
- Ayni `instance_id` altinda farkli zamanlarda farkli `system_identifier` gorulebilir.
- Delta ve statement surekliligi fiziksel olarak `system_identifier` ve epoch ile izlenir.

`pgss_epoch_key` tanimi:

- `14+` surumlerde once `pg_stat_statements_info.stats_reset` kullanilir.
- Bu bilgi yoksa collector reseti sayac dususunden veya `pg_postmaster_start_time()` degisiminden tespit eder.
- Epoch anahtari mantiksal olarak su bilgileri temsil eder:

```text
system_identifier + pg_major + pgss_stats_reset_or_synthetic_reset_marker
```

**`pgss_epoch_key` somut format:** Collector asagidaki kuralla olusturur:

```
<system_identifier>_<pg_major>_<stats_reset_iso8601_utc>
ornek: 7291234567890123456_14_2026-04-17T03:00:00Z
```

`stats_reset` bilgisi yoksa (PG 13 ve altinda `pg_stat_statements_info` gelmez) veya ilk baglantida henuz reset zamani alinamadiysa, `pg_postmaster_start_time()` UTC ISO 8601 degeri kullanilir. Reset zamani yine alinamazsa, collector'in ilk sample aldigi UTC timestamp'i kullanilir (synthetic marker). Ayni reset olayini farkli collector process'lerinin tekrar tespit etmesi durumunda da deterministik sonuc uretilir, cunku kaynak `pg_stat_statements_info.stats_reset` sabit bir timestamp'dir.

**Reset tespit algoritmasi:**

```
1. Mevcut pg_stat_statements_info.stats_reset (PG14+) degerini oku
2. Onceki sample'da saklanan last_pgss_stats_reset_at ile karsilastir
   a. Farkli ise → reset oldu → yeni epoch ac
   b. Ayni ise → devam et
3. PG14- veya stats_reset mevcut degilse:
   a. Herhangi bir kumulatif sayacta delta < 0 tespit edilirse → reset oldu → yeni epoch ac
   b. pg_postmaster_start_time() degistiyse → restart oldu → yeni epoch ac
4. Yeni epoch acildiginda:
   a. Yeni pgss_epoch_key olustur (yukardaki formata gore)
   b. control.instance_state.current_pgss_epoch_key guncelle
   c. Bu sample'i baseline olarak kaydet, fact'e delta yazma
```

Sonuc:

- Upgrade, reset, rebuild veya restore sonrasi eski delta cizgisi devam ettirilmez.
- Yeni epoch acilir ve toplama kesilmeden devam eder.

## Merkezi DB Semasi

Merkezi PostgreSQL veritabani bes mantiksal schema altinda kurulur:

- `control`: inventory, schedule, capability ve runtime state
- `dim`: tekrar etmeyen tanimlayici veriler
- `fact`: zaman serisi metrik verileri
- `agg`: rollup tablolari — `agg.pgss_hourly` (saatlik) ve `agg.pgss_daily` (gunluk)
- `ops`: job run, hata ve audit kayitlari

### `dim.query_text`

SQL text'i tum clusterlar icinde global olarak tekillestirir.

Onerilen kolonlar:

- `query_text_id bigint generated always as identity primary key`
- `query_hash bytea not null`
- `query_text text not null`
- `query_text_len integer not null`
- `first_seen_at timestamptz not null default now()`
- `last_seen_at timestamptz not null default now()`
- `first_seen_instance_pk bigint null references control.instance_inventory(instance_pk) on delete set null`
- `source_pg_major integer null`

Not:

- `query_hash`, `sha256(query_text)` sonucudur.
- Ayni SQL text, hangi cluster'dan geldigi bagimsiz olarak merkezi DB'de bir kez saklanir.
- `first_seen_instance_pk`, SQL text'i ilk gonderen instance'in izini tutar. Instance silinirse `NULL` yapilir (`on delete set null`); SQL text silinmez.
- `source_pg_major`, SQL text'in hangi major version'dan alindigi bilgisini tutar; `pg_stat_statements(true)` ile SQL text cekildigi anda `instance_capability.pg_major` degerinden set edilir.
- Collector, `statements` job icinde yeni `dim.statement_series` satirlari ile `query_text_id = NULL` olan mevcut seri satirlarini tespit eder. Bu seriler icin `pg_stat_statements(true)` cagrisilarak SQL text alinir; `dim.query_text` upsert yapilir ve `dim.statement_series.query_text_id` guncellenir. `first_seen_instance_pk = current instance_pk`, `source_pg_major = current pg_major` olarak set edilir.

### `dim.database_ref`

Kaynak database kimligini insan okunur isimle esler.

Onerilen kolonlar:

- `database_ref_id bigint generated always as identity primary key`
- `instance_pk bigint not null references control.instance_inventory(instance_pk) on delete restrict`
- `dbid oid not null`
- `datname text not null`
- `is_template boolean null`
- `first_seen_at timestamptz not null default now()`
- `last_seen_at timestamptz not null default now()`
- `unique (instance_pk, dbid)`

OID degisimi kurali:

- `dbid`, PostgreSQL'in database OID'idir. `DROP DATABASE` + ayni isimle `CREATE DATABASE` yapildiginda `dbid` degisir.
- Yeni `dbid` icin collector yeni bir `dim.database_ref` satiri acar; eski satir silinmez.
- Eski `dbid`'e bagli `fact.pg_database_delta` satirlari `last_seen_at` tarihi dondukca tarihsel olarak korunur; ancak artik aktif database ile eslesmez.
- `last_seen_at < now() - interval '7 days'` ve artik kaynak tarafta gorunmeyen `dbid`'ler eski database olarak degerlendirilir.

### `dim.relation_ref`

Database icindeki tablo ve index kimliklerini insan okunur isimlerle esler.

Onerilen kolonlar:

- `relation_ref_id bigint generated always as identity primary key`
- `instance_pk bigint not null references control.instance_inventory(instance_pk) on delete restrict`
- `dbid oid not null`
- `relid oid not null`
- `schemaname text not null`
- `relname text not null`
- `relkind text not null`
- `parent_relid oid null`
- `first_seen_at timestamptz not null default now()`
- `last_seen_at timestamptz not null default now()`
- `unique (instance_pk, dbid, relid)`

OID degisimi kurali:

- PostgreSQL'de OID'ler tablo drop/recreate veya `pg_dump` + restore sonrasi degisebilir.
- Yeni `relid` icin collector yeni bir `dim.relation_ref` satiri acar; eski satir silinmez.
- Eski `relid`'e bagli `fact.pg_table_stat_delta` ve `fact.pg_index_stat_delta` satirlari orphan kalmaz; sadece `last_seen_at` tarihi donmaya baslar.
- Raporlama katmani `last_seen_at` tarihini kullanarak aktif ve eski relation'lari ayirt edebilir; `last_seen_at < now() - interval '7 days'` olan satirlar muhtemelen silinmis veya yeniden yaratilmis objelere aittir.
- Orphan `dim.relation_ref` satirlari periyodik cleanup ile temizlenebilir; ancak bu ilk fazda zorunlu degildir. Cleanup kriterleri: `last_seen_at` cok eski VE bagli fact satiri retention sinirinin disinda.

### `dim.role_ref`

Kaynak rol kimligini insan okunur isimle esler.

Onerilen kolonlar:

- `role_ref_id bigint generated always as identity primary key`
- `instance_pk bigint not null references control.instance_inventory(instance_pk) on delete restrict`
- `userid oid not null`
- `rolname text not null`
- `first_seen_at timestamptz not null default now()`
- `last_seen_at timestamptz not null default now()`
- `unique (instance_pk, userid)`

### `dim.statement_series`

Teknik istatistik serisini tanimlar.

Onerilen kolonlar:

- `statement_series_id bigint generated always as identity primary key`
- `instance_pk bigint not null`
- `pg_major integer not null`
- `collector_sql_family text not null`
- `system_identifier bigint not null`
- `pgss_epoch_key text not null`
- `dbid oid not null`
- `userid oid not null`
- `toplevel boolean null`
- `queryid bigint not null`
- `query_text_id bigint null references dim.query_text(query_text_id)`
- `first_seen_at timestamptz not null default now()`
- `last_seen_at timestamptz not null default now()`
- `unique (instance_pk, system_identifier, pg_major, pgss_epoch_key, dbid, userid, toplevel, queryid)`

Kurallar:

- Upgrade, restart veya reset sonrasi yeni epoch acilabilir.
- `query_text_id` ilk anda bos olabilir; enrichment sonrasi baglanir.
- Unique constraint'e `system_identifier` dahildir; cunku ayni `instance_pk` altinda failover veya rebuild sonrasi farkli fiziksel cluster'lar gorulebilir. `system_identifier` olmadan ayni `pgss_epoch_key + queryid` kombinasyonu farkli cluster'larda capraz cakisir.

## Varsayilan Raporlama Grain'i

Varsayilan raporlama grain'i asagidaki gibi olmalidir:

```text
instance_pk + dbid + query_text_id
```

Bu secim su anlama gelir:

- Her sunucu ayri raporlanir
- Her database ayri raporlanir
- Ayni fiziksel cluster icindeki ayni SQL text ayni `query_text_id` altinda birlesebilir
- Farkli fiziksel cluster'larda ayni SQL text farkli `query_text_id` alir

Global cross-cluster SQL toplamlari varsayilan davranis degildir; sadece ozel analiz olarak uretilir.

Obje bazli raporlama grain'i ise ayri tanimlanir:

```text
instance_pk + dbid + relid
```

Index bazli raporlarda anahtar:

```text
instance_pk + dbid + index_relid
```

### `fact.pgss_delta`

`pg_stat_statements` delta verisini tutar.

Onerilen kolonlar:

- `sample_ts timestamptz not null`
- `instance_pk bigint not null`
- `statement_series_id bigint not null references dim.statement_series(statement_series_id)`
- `calls_delta bigint not null`
- `plans_delta bigint null`
- `total_plan_time_ms_delta double precision null`
- `total_exec_time_ms_delta double precision not null`
- `rows_delta bigint null`
- `shared_blks_hit_delta bigint null`
- `shared_blks_read_delta bigint null`
- `shared_blks_dirtied_delta bigint null`
- `shared_blks_written_delta bigint null`
- `local_blks_hit_delta bigint null`
- `local_blks_read_delta bigint null`
- `local_blks_dirtied_delta bigint null`
- `local_blks_written_delta bigint null`
- `temp_blks_read_delta bigint null`
- `temp_blks_written_delta bigint null`
- `blk_read_time_ms_delta double precision null`
- `blk_write_time_ms_delta double precision null`
- `wal_records_delta bigint null`
- `wal_fpi_delta bigint null`
- `wal_bytes_delta numeric null`
- `jit_generation_time_ms_delta double precision null`
- `jit_inlining_time_ms_delta double precision null`
- `jit_optimization_time_ms_delta double precision null`
- `jit_emission_time_ms_delta double precision null`

Tablo gunluk partition edilmelidir:

- `partition by range (sample_ts)`

### `fact.pg_database_delta`

`pg_stat_database` delta verisini tutar.

`datname` kolonunun bu tabloda bulunma gerekceleri:

- `pg_stat_database` zaten `datname` dondurur; collector'in join yapmasina gerek kalmaz.
- Raporlama sorgularinda `dim.database_ref` ile join yapilmadan okunabilir.
- Kabul edilen sinirlilik: database rename edilirse bu fact satirlarindaki `datname` eskide kalir. Bu durum kabul edilebilir; asil kimlik `dbid` uzerinden `dim.database_ref` ile kurulur. Tarihsel fact satirlari rename oncesi isimle gorulur.

Onerilen kolonlar:

- `sample_ts timestamptz not null`
- `instance_pk bigint not null`
- `dbid oid not null`
- `datname text not null`
- `numbackends integer null`
- `xact_commit_delta bigint not null`
- `xact_rollback_delta bigint not null`
- `blks_read_delta bigint not null`
- `blks_hit_delta bigint not null`
- `tup_returned_delta bigint not null`
- `tup_fetched_delta bigint not null`
- `tup_inserted_delta bigint not null`
- `tup_updated_delta bigint not null`
- `tup_deleted_delta bigint not null`
- `conflicts_delta bigint null`
- `temp_files_delta bigint null`
- `temp_bytes_delta bigint null`
- `deadlocks_delta bigint null`
- `checksum_failures_delta bigint null`
- `blk_read_time_ms_delta double precision null`
- `blk_write_time_ms_delta double precision null`
- `session_time_ms_delta double precision null`
- `active_time_ms_delta double precision null`
- `idle_in_transaction_time_ms_delta double precision null`

### `fact.pg_table_stat_delta`

`pg_stat_user_tables` ve `pg_statio_user_tables` kaynakli tablo istatistiklerini tutar.

`schemaname` ve `relname` kolonlarinin bu tabloda bulunma gerekceleri:

- Kaynak view'lar bu alanlari zaten dondurmektedir; ek join maliyeti yoktur.
- Raporlama sorgularinda `dim.relation_ref` join'i olmadan okunabilir.
- Kabul edilen sinirlilik: tablo rename veya schema degisikligi durumunda eski fact satirlari eski isimle gorulur. Asil kimlik `relid` uzerinden `dim.relation_ref` ile kurulur.

Onerilen kolonlar:

- `sample_ts timestamptz not null`
- `instance_pk bigint not null`
- `dbid oid not null`
- `relid oid not null`
- `schemaname text not null`
- `relname text not null`
- `seq_scan_delta bigint null`
- `seq_tup_read_delta bigint null`
- `idx_scan_delta bigint null`
- `idx_tup_fetch_delta bigint null`
- `n_tup_ins_delta bigint null`
- `n_tup_upd_delta bigint null`
- `n_tup_del_delta bigint null`
- `n_tup_hot_upd_delta bigint null`
- `vacuum_count_delta bigint null`
- `autovacuum_count_delta bigint null`
- `analyze_count_delta bigint null`
- `autoanalyze_count_delta bigint null`
- `heap_blks_read_delta bigint null`
- `heap_blks_hit_delta bigint null`
- `idx_blks_read_delta bigint null`
- `idx_blks_hit_delta bigint null`
- `toast_blks_read_delta bigint null`
- `toast_blks_hit_delta bigint null`
- `tidx_blks_read_delta bigint null`
- `tidx_blks_hit_delta bigint null`
- `n_live_tup_estimate bigint null`
- `n_dead_tup_estimate bigint null`
- `n_mod_since_analyze bigint null`

### `fact.pg_index_stat_delta`

`pg_stat_user_indexes` ve `pg_statio_user_indexes` kaynakli index istatistiklerini tutar.

`schemaname`, `table_relname` ve `index_relname` kolonlarinin bu tabloda bulunma gerekceleri:

- Kaynak view'lar bu alanlari zaten dondurmektedir; ek join maliyeti yoktur.
- Raporlama sorgularinda `dim.relation_ref` join'i olmadan okunabilir.
- Kabul edilen sinirlilik: tablo veya index rename ya da schema degisikligi durumunda eski fact satirlari eski isimle gorulur. Asil kimlik `index_relid` uzerinden `dim.relation_ref` ile kurulur.

Onerilen kolonlar:

- `sample_ts timestamptz not null`
- `instance_pk bigint not null`
- `dbid oid not null`
- `table_relid oid not null`
- `index_relid oid not null`
- `schemaname text not null`
- `table_relname text not null`
- `index_relname text not null`
- `idx_scan_delta bigint null`
- `idx_tup_read_delta bigint null`
- `idx_tup_fetch_delta bigint null`
- `idx_blks_read_delta bigint null`
- `idx_blks_hit_delta bigint null`

### `fact.pg_cluster_delta`

Cluster genelindeki boyutsuz ortak metrikleri (`pg_stat_bgwriter`, `pg_stat_wal`, `pg_stat_checkpointer`) tek tabloda tutar. Generic key-value modeli; her metrik kolonu ayri bir satir olarak yazilir.

Onerilen kolonlar:

- `sample_ts timestamptz not null`
- `instance_pk bigint not null`
- `metric_family text not null`
- `metric_name text not null`
- `metric_value_num numeric not null`
- `primary key (sample_ts, instance_pk, metric_family, metric_name)`

Bu tablo su aileleri tutar:

- `pg_stat_wal`
- `pg_stat_bgwriter`
- `pg_stat_checkpointer`

`pg_stat_io` bu tabloda TUTULMAZ; cok boyutlu yapisi nedeniyle ayri bir dedicated tablo (`fact.pg_io_stat_delta`) kullanilir.

### `fact.pg_io_stat_delta`

`pg_stat_io` (PG16+) view'indan toplanan I/O istatistiklerini dedicated kolonlarla tutar. Her satir `(backend_type, object, context)` uclusuyle bir boyut grubunu temsil eder.

Onerilen kolonlar:

- `sample_ts timestamptz not null`
- `instance_pk bigint not null`
- `backend_type text not null` — `client backend`, `autovacuum worker`, `checkpointer`, vb.
- `object text not null` — `relation`, `temp relation`
- `context text not null` — `normal`, `vacuum`, `bulkread`, `bulkwrite`
- `reads_delta bigint null`
- `read_time_ms_delta double precision null`
- `writes_delta bigint null`
- `write_time_ms_delta double precision null`
- `extends_delta bigint null`
- `extend_time_ms_delta double precision null` — PG17+
- `hits_delta bigint null`
- `evictions_delta bigint null`
- `reuses_delta bigint null`
- `fsyncs_delta bigint null`
- `fsync_time_ms_delta double precision null`
- `primary key (sample_ts, instance_pk, backend_type, object, context)`

Toplama kurallari:

- Yalnizca `has_pg_stat_io = true` (PG16+) olan instance'lardan toplanir.
- Delta hesabi: collector onceki sample'daki `(backend_type, object, context)` satiri ile karsilastirir; negatif delta veya yeni satir goruldugunde cluster reset kurali uygulanir.
- PG16'da `extend_time_ms` mevcut degildir; `NULL` olarak yazilir. PG17+ icin dolu gelir.
- Gunluk partition ile saklanir; retention `raw_retention_months` kapsamindadir.

Sorgu ornegi:

```sql
-- client backend relation normal read throughput (son 1 saat)
select sample_ts, reads_delta, read_time_ms_delta
from fact.pg_io_stat_delta
where instance_pk = $1
  and backend_type = 'client backend'
  and object = 'relation'
  and context = 'normal'
  and sample_ts >= now() - interval '1 hour'
order by sample_ts;
```

### `fact.pg_activity_snapshot`

Cluster uzerindeki aktif session'larin anlık goruntusunu tutar. Delta hesabi yapilmaz; her `cluster` job cikisinda tam snapshot yazilir.

Onerilen kolonlar:

- `snapshot_ts timestamptz not null`
- `instance_pk bigint not null`
- `pid integer not null`
- `datname text null`
- `usename text null`
- `application_name text null`
- `client_addr inet null`
- `backend_start timestamptz null`
- `xact_start timestamptz null`
- `query_start timestamptz null`
- `state_change timestamptz null`
- `state text null`
- `wait_event_type text null`
- `wait_event text null`
- `query text null` — 1000 karaktere kisaltilir; tam text `dim.query_text`'ten elde edilir
- `backend_type text null`
- Primary key: `(snapshot_ts, instance_pk, pid)`

Toplama kurallari:

- Collector'in kendi session'i `pid <> pg_backend_pid()` ile dislanir.
- Tum session'lar (`idle` dahil) kaydedilir; raporlama katmani `state` filtrelemesi yapar.
- Gunluk partition ile saklanir; retention `raw_retention_months` kapsamindadir.

### `fact.pg_replication_snapshot`

Primary node'un replica'larina ait replikasyon durumunu tutar. Delta hesabi yapilmaz; her `cluster` job cikisinda snapshot yazilir.

Onerilen kolonlar:

- `snapshot_ts timestamptz not null`
- `instance_pk bigint not null`
- `pid integer not null`
- `usename text null`
- `application_name text null`
- `client_addr inet null`
- `state text null` — startup, catchup, streaming, backup, stopping
- `sent_lsn pg_lsn null`
- `write_lsn pg_lsn null`
- `flush_lsn pg_lsn null`
- `replay_lsn pg_lsn null`
- `write_lag interval null`
- `flush_lag interval null`
- `replay_lag interval null`
- `sync_state text null` — async, sync, potential, quorum
- `replay_lag_bytes bigint null` — hesaplanan: `sent_lsn - replay_lsn`
- Primary key: `(snapshot_ts, instance_pk, pid)`

Toplama kurallari:

- Yalnizca `pg_is_in_recovery() = false` (primary) olan node'lardan toplanir.
- Replica node'larda `pg_stat_replication` bos doner; sorgu calistirilmaz.
- `replay_lag > interval '5 minutes'` durumunda `replication_lag` alert'i upsert edilir.
- Gunluk partition ile saklanir; retention `raw_retention_months` kapsamindadir.

### `fact.pg_lock_snapshot`

Cluster uzerindeki aktif lock'larin anlik goruntusunu tutar. Lock contention analizi icin kullanilir; hangi session'in hangi kaynagi bekledigini gosterir.

Onerilen kolonlar:

- `snapshot_ts timestamptz not null`
- `instance_pk bigint not null`
- `pid integer not null` — lock'i tutan veya bekleyen process
- `locktype text not null` — `relation`, `transactionid`, `tuple`, `advisory`, vb.
- `database_oid oid null` — hangi database'de
- `relation_oid oid null` — hangi tablo/index (relation lock icin)
- `mode text not null` — `AccessShareLock`, `RowExclusiveLock`, `ExclusiveLock`, vb.
- `granted boolean not null` — `true` = lock alinmis, `false` = bekliyor
- `waitstart timestamptz null` — PG14+; `granted = false` ise bekleme baslangici
- `blocked_by_pids integer[] null` — bu PID'i bloklayan PID'ler (`pg_blocking_pids()`)
- Primary key: Yok (composite); `(snapshot_ts, instance_pk)` partition key, satirlar tekil degildir

Unique key bulunmaz cunku ayni PID ayni anda birden fazla lock tutabilir veya bekleyebilir. Primary key yerine `(snapshot_ts, instance_pk)` uzerinden partition by range ve ayri bir btree index kullanilir.

Toplama kurallari:

- Her `cluster` job cikisinda `pg_locks` + `pg_stat_activity` join ile snapshot alinir.
- Yalnizca `granted = false` VEYA `locktype in ('relation', 'transactionid', 'tuple')` olan satirlar kaydedilir; `advisory` ve `virtualxid` gibi dahili lock'lar varsayilan olarak atlanir.
- `pg_blocking_pids(pid)` fonksiyonu ile bloklayan PID listesi elde edilir (PG9.6+).
- Lock bekleme suresi > 30 saniye olan satirlar icin `lock_contention` alert'i olusturulabilir.
- Gunluk partition ile saklanir; retention `raw_retention_months` kapsamindadir.

### `fact.pg_progress_snapshot`

Uzun suren bakim operasyonlarinin (`VACUUM`, `ANALYZE`, `CREATE INDEX`, `CLUSTER`, `REINDEX`) ilerleme durumunu tutar. `pg_stat_progress_*` view'larindan toplanir.

Onerilen kolonlar:

- `snapshot_ts timestamptz not null`
- `instance_pk bigint not null`
- `pid integer not null`
- `command text not null` — `VACUUM`, `ANALYZE`, `CREATE INDEX`, `CLUSTER`, `REINDEX`, `BASEBACKUP`, `COPY`
- `datname text null`
- `relname text null` — hedef tablo/index adi (elde edilebilirse)
- `phase text null` — ornek: `scanning heap`, `vacuuming indexes`, `building index: scanning table`
- `blocks_total bigint null` — toplam islenecek blok
- `blocks_done bigint null` — islenmis blok
- `tuples_total bigint null` — toplam islenecek tuple
- `tuples_done bigint null` — islenmis tuple
- `progress_pct double precision null` — hesaplanan: `blocks_done::float / nullif(blocks_total, 0) * 100`
- Primary key: `(snapshot_ts, instance_pk, pid)`

Toplama kurallari:

- Her `cluster` job cikisinda su view'lar okunur:
  - `pg_stat_progress_vacuum` (PG9.6+)
  - `pg_stat_progress_analyze` (PG13+)
  - `pg_stat_progress_create_index` (PG12+)
  - `pg_stat_progress_cluster` (PG12+)
  - `pg_stat_progress_basebackup` (PG13+)
  - `pg_stat_progress_copy` (PG14+)
- Her view'in kolon isimleri farklidir; collector bunlari ortak `(blocks_total, blocks_done, tuples_total, tuples_done)` formatina normalize eder.
- Aktif operasyon yoksa satir yazilmaz (tablo bos).
- Gunluk partition ile saklanir; retention `raw_retention_months` kapsamindadir.

### `agg.pgss_hourly`

Statement bazli saatlik ozetleri tutar.

Onerilen kolonlar:

- `bucket_start timestamptz not null`
- `instance_pk bigint not null`
- `statement_series_id bigint not null`
- `calls_sum bigint not null`
- `exec_time_ms_sum double precision not null`
- `rows_sum bigint null`
- `shared_blks_read_sum bigint null`
- `shared_blks_hit_sum bigint null`
- `temp_blks_written_sum bigint null`
- `primary key (bucket_start, instance_pk, statement_series_id)`

**Rollup hangi bucket'i isler:** Her `rollup` job calismasinda `date_trunc('hour', now()) - interval '1 hour'` ile bir onceki tamamlanmis UTC saat bucket'i hedef alinir. `on conflict ... do update` idempotent oldugu icin ayni bucket'i tekrar islemek veri hasarina neden olmaz. Rollup job'i atlanirsa (orn. sistem yeniden baslatma), bir sonraki calisma en son tamamlanmis saat icin islem yapar; gecmis atlanmis saatler ayrica telafi edilmez (bu basit bir tasarim tercihi; catch-up mantigi ilk fazda kapsam disindadir). Ayri bir "last processed bucket" marker tutulmaz; idempotent yeniden yazma yeterlidir.

**Kismen basarisiz rollup recovery:** Rollup job bir saatin ortasinda cokerse (orn. baglanti kopuklugu), `agg.pgss_hourly`'deki ilgili bucket kismen yazilmis olabilir. Bir sonraki `rollup` calismasinda ayni bucket icin `on conflict ... do update` calisir; tum `fact.pgss_delta` satirlari yeniden toplanarak bucket tamamen ustune yazilir. Bu sayede kism yazim durumu otomatik onarilir; ekstra mudahale gerekmez.

**FK notu:** `agg.pgss_hourly` ve `agg.pgss_daily`, partitioned tablo olduklari ve saatlik yuksek INSERT hacmini hedefledikleri icin `statement_series_id` kolonuna FK constraint eklenmez; referans butunlugu INSERT kodunda garanti edilir (her rollup INSERT yalnizca `fact.pgss_delta`'da zaten mevcut `statement_series_id` degerlerini toplayarak yazar).

### `agg.pgss_daily`

Statement bazli gunluk ozetleri tutar. Uzun donem (aylik, yillik) raporlama icin `agg.pgss_hourly` yerine bu tablo kullanilir.

Onerilen kolonlar:

- `bucket_start date not null`
- `instance_pk bigint not null`
- `statement_series_id bigint not null`
- `calls_sum bigint not null`
- `exec_time_ms_sum double precision not null`
- `rows_sum bigint null`
- `shared_blks_read_sum bigint null`
- `shared_blks_hit_sum bigint null`
- `temp_blks_written_sum bigint null`
- `primary key (bucket_start, instance_pk, statement_series_id)`

Kurallar:

- `rollup` job her gun `agg.pgss_hourly`'den gunluk ozet uretir.
- `bucket_start` saat bilgisi tasimayan `date` tipindedir; timezone karmasikligindan kacinmak icin UTC gun siniri kullanilir.
- `hourly_retention_months` kurali `agg.pgss_hourly` icin gecerliyken `agg.pgss_daily` ayri bir `daily_retention_months` alanina baglanir.
- Idempotent yapidir: `on conflict ... do update` kullanilir, ayni gun icin ikinci calistirma veriyi gunceller, duplike etmez.

**Gunluk rollup INSERT mantigi (ornek):**

```sql
-- Bir onceki gunun UTC tarih sinirini hesapla
-- Collector bu sorguyu rollup job basinda calistirarak hangi gunu isledigini belirler
insert into agg.pgss_daily (
  bucket_start,
  instance_pk,
  statement_series_id,
  calls_sum,
  exec_time_ms_sum,
  rows_sum,
  shared_blks_read_sum,
  shared_blks_hit_sum,
  temp_blks_written_sum
)
select
  (now() at time zone 'UTC')::date - 1 as bucket_start,
  instance_pk,
  statement_series_id,
  sum(calls_sum)            as calls_sum,
  sum(exec_time_ms_sum)     as exec_time_ms_sum,
  sum(rows_sum)             as rows_sum,
  sum(shared_blks_read_sum) as shared_blks_read_sum,
  sum(shared_blks_hit_sum)  as shared_blks_hit_sum,
  sum(temp_blks_written_sum) as temp_blks_written_sum
from agg.pgss_hourly
where bucket_start >= ((now() at time zone 'UTC')::date - 1)::timestamptz
  and bucket_start <  ((now() at time zone 'UTC')::date)::timestamptz
group by instance_pk, statement_series_id
on conflict (bucket_start, instance_pk, statement_series_id) do update
  set calls_sum            = excluded.calls_sum,
      exec_time_ms_sum     = excluded.exec_time_ms_sum,
      rows_sum             = excluded.rows_sum,
      shared_blks_read_sum = excluded.shared_blks_read_sum,
      shared_blks_hit_sum  = excluded.shared_blks_hit_sum,
      temp_blks_written_sum = excluded.temp_blks_written_sum;
```

Eksik saatler (collector duraksamasi nedeniyle) sifirlama yerine oldugu haliyle toplanir; eksik araligi kapatmak icin gerekirse tarih parametresiyle yeniden calistirilabilir.

### `ops.job_run`

Collector job calisma kayitlarini tutar.

Onerilen kolonlar:

- `job_run_id bigint generated always as identity primary key`
- `job_type text not null`
- `started_at timestamptz not null`
- `finished_at timestamptz null`
- `status text not null`
- `worker_hostname text null`
- `rows_written bigint not null default 0`
- `instances_succeeded integer not null default 0`
- `instances_failed integer not null default 0`
- `error_text text null`

### `ops.job_run_instance`

Job'in host bazli sonucunu tutar.

Onerilen kolonlar:

- `job_run_instance_id bigint generated always as identity primary key`
- `job_run_id bigint not null references ops.job_run(job_run_id)`
- `instance_pk bigint not null`
- `job_type text not null`
- `started_at timestamptz not null`
- `finished_at timestamptz null`
- `status text not null`
- `rows_written bigint not null default 0`
- `new_series_count integer not null default 0`
- `new_query_text_count integer not null default 0`
- `error_text text null`

### `ops.alert`

Uygulama ekranindaki aktif ve gecmis uyarilari besleyen tablodur.

Onerilen kolonlar:

- `alert_id bigint generated always as identity primary key`
- `alert_key text not null unique`
- `alert_code text not null`
- `severity text not null`
- `status text not null`
- `source_component text not null`
- `instance_pk bigint null`
- `service_group text null`
- `system_identifier bigint null`
- `first_seen_at timestamptz not null`
- `last_seen_at timestamptz not null`
- `resolved_at timestamptz null`
- `acknowledged_at timestamptz null`
- `title text not null`
- `message text not null`
- `details_json jsonb null`
- `occurrence_count integer not null default 1`

Kurallar:

- `ops.alert` uygulama ekranindaki alert listesi icin ana kaynaktir.
- `systemd journal` ham execution log'u olarak kalir; UI dogrudan journal okumaz.
- Ayni alert, `alert_key` ile dedupe edilir ve `occurrence_count` arttirilir.
- Aktif alert ekrani `status in ('open','acknowledged')` ve `resolved_at is null` filtresiyle beslenir.

`alert_key` format kurali:

`alert_key`, bir alertin kaynagini benzersiz sekilde tanimlayan deterministik bir string'dir. Format:

```
{alert_code}:{scope}:{identifier}
```

Ornekler:

- `missing_extension:instance:42` — instance_pk=42'de pg_stat_statements eksik
- `stale_data:instance:42` — instance_pk=42'den 24 saattir veri gelmiyor
- `connection_error:instance:42` — instance_pk=42'ye baglanilemiyor
- `job_partial_failure:job:statements` — statements job partial failure
- `advisory_lock_skip:job:cluster` — cluster job lock alinamadigi icin atlandi
- `unsupported_version:instance:42` — desteklenmeyen PG versiyonu

**Tum `alert_code` degerleri:**

| `alert_code` | Severity | Scope | Aciklama |
|---|---|---|---|
| `connection_error` | error | instance | Kaynak PG'ye baglanilemiyor |
| `authentication_error` | error | instance | Kimlik dogrulama hatasi |
| `missing_extension` | warning | instance | `pg_stat_statements` extension eksik |
| `unsupported_version` | warning | instance | Collector SQL family karsilamiyor |
| `capability_degraded` | warning | instance | Bazi view/kolon eksik, kismi toplama |
| `stale_data` | warning | instance | Beklenen sureden uzun suredir veri aliniyor |
| `stats_reset_detected` | info | instance | `pg_stat_statements` veya cluster metrik resetlendi |
| `bootstrap_failed` | error | instance | Bootstrap sureci tamamlanamadi |
| `secret_ref_error` | critical | instance | `secret_ref` cozumlenemedi |
| `job_partial_failure` | warning | job | Job bazi instance'larda basarisiz oldu |
| `job_failed` | error | job | Job tamamen basarisiz oldu |
| `advisory_lock_skip` | info | job | Ayni job zaten calistigindan atland |
| `partition_missing` | critical | system | Gunluk partition olusturulamiyor |
| `rollup_lag` | warning | system | Rollup beklenen saatten gecikti |
| `replication_lag` | warning | instance | Replica replay lag esigi asti |
| `lock_contention` | warning | instance | Uzun sureli lock bekleme tespit edildi |

Kurallar:

- `alert_code` sabit bir enum-benzeri string; collector uygulamasinda sabit tanimlidir.
- `scope` su degerlerden biri olur: `instance`, `job`, `system`.
- `identifier` scope'a gore `instance_pk`, job adi veya sabit bir sistem kodu olur.
- Ayni kaynak icin yeni alert geldiginde `alert_key` uzerinden `upsert` yapilir; yeni satir acilmaz.

## Control Tablolari Fiziksel Tasarim

Bu bolum `control` schema altindaki tablolarin DDL seviyesinde sabit tasarim kurallarini tanimlar.

### `control.schedule_profile`

Fiziksel kurallar:

- Primary key: `schedule_profile_id`
- Unique constraint: `profile_code`
- Check constraint:
  - `cluster_interval_seconds > 0`
  - `statements_interval_seconds > 0`
  - `db_objects_interval_seconds > 0`
  - `hourly_rollup_interval_seconds > 0`
  - `daily_rollup_hour_utc between 0 and 23`
  - `bootstrap_sql_text_batch > 0`
  - `max_databases_per_run > 0`
  - `statement_timeout_ms > 0`
  - `lock_timeout_ms >= 0`
  - `connect_timeout_seconds > 0`
  - `max_host_concurrency > 0`
- `updated_at` uygulama veya trigger ile guncellenir

Index kurallari:

- Unique btree index: `(profile_code)`
- Ayrica ek secondary index gerekmez

### `control.retention_policy`

Fiziksel kurallar:

- Primary key: `retention_policy_id`
- Unique constraint: `policy_code`
- Check constraint:
  - `raw_retention_months > 0`
  - `hourly_retention_months > 0`
  - `daily_retention_months > 0`

Index kurallari:

- Unique btree index: `(policy_code)`
- Btree index: `(is_active, policy_code)`

### `control.instance_inventory`

Fiziksel kurallar:

- Primary key: `instance_pk`
- Unique constraint: `instance_id`
- Unique constraint: `(host, port, admin_dbname)`
- Foreign key: `schedule_profile_id -> control.schedule_profile(schedule_profile_id)`
- Foreign key: `retention_policy_id -> control.retention_policy(retention_policy_id)`
- Check constraint:
  - `port between 1 and 65535`
  - `ssl_mode in ('disable','allow','prefer','require','verify-ca','verify-full')`
  - `bootstrap_state in ('pending','discovering','baselining','enriching','ready','degraded','paused')`

Index kurallari:

- Unique btree index: `(instance_id)`
- Unique btree index: `(host, port, admin_dbname)`
- Btree index: `(schedule_profile_id)`
- Btree index: `(retention_policy_id)`
- Btree index: `(service_group, instance_id)`
- Partial btree index: `(collector_group, instance_id) where is_active`
- Partial btree index: `(bootstrap_state, instance_id) where is_active`

### `control.instance_capability`

Fiziksel kurallar:

- Primary key ve foreign key ayni kolon: `instance_pk -> control.instance_inventory(instance_pk)`
- Check constraint:
  - `server_version_num is null or server_version_num > 0`
  - `pg_major is null or pg_major > 0`
  - `system_identifier is null or system_identifier > 0`
  - `compute_query_id_mode is null or compute_query_id_mode in ('off','on','auto','regress','external')`

Index kurallari:

- Primary key index yeterlidir
- Opsiyonel partial index: `(last_discovered_at) where is_reachable = false or is_reachable is null`

Not:

- `is_reachable = NULL`: discovery henuz hic yapilmadi (yeni eklenen host)
- `is_reachable = false`: discovery denendi ama ulasilamadi
- `is_reachable = true`: son discovery basarili

### `control.instance_state`

Fiziksel kurallar:

- Primary key ve foreign key ayni kolon: `instance_pk -> control.instance_inventory(instance_pk)`
- Check constraint:
  - `consecutive_failures >= 0`

Index kurallari:

- Partial btree index: `(next_cluster_collect_at) where next_cluster_collect_at is not null`
- Partial btree index: `(next_statements_collect_at) where next_statements_collect_at is not null`
- Partial btree index: `(backoff_until) where backoff_until is not null`
- Btree index: `(last_success_at)`

### `control.database_state`

Fiziksel kurallar:

- Composite primary key: `(instance_pk, dbid)`
- Foreign key: `instance_pk -> control.instance_inventory(instance_pk)`
- Check constraint:
  - `consecutive_failures >= 0`

Index kurallari:

- Partial btree index: `(next_db_objects_collect_at) where next_db_objects_collect_at is not null`
- Partial btree index: `(backoff_until) where backoff_until is not null`

Scheduler sorgusu bu tabloyu `control.instance_inventory.is_active = true` filtresi ile join ederek kullanir.

## Dim Tablolari Fiziksel Tasarim

Bu bolum `dim` schema altindaki tablolarin DDL seviyesinde sabit tasarim kurallarini tanimlar.

### `dim.query_text`

Fiziksel kurallar:

- Primary key: `query_text_id`
- Unique constraint: `query_hash`
- `query_hash` `sha256` sonucu oldugu icin `octet_length(query_hash) = 32` check'i bulunur
- `query_text_len` stored generated column olarak tanimlanir:
  - `generated always as (length(query_text)) stored`

Index kurallari:

- Unique btree index: `(query_hash)`
- Btree index: `(last_seen_at desc)`

Not:

- `query_text` buyuk olabilecegi icin TOAST'a birakilir; full text uzerinde varsayilan olarak index acilmaz

### `dim.database_ref`

Fiziksel kurallar:

- Primary key: `database_ref_id`
- Unique constraint: `(instance_pk, dbid)`
- Foreign key: `instance_pk -> control.instance_inventory(instance_pk) on delete restrict`

Index kurallari:

- Unique btree index: `(instance_pk, dbid)`
- Btree index: `(instance_pk, datname)`
- Btree index: `(last_seen_at desc)`

### `dim.relation_ref`

Fiziksel kurallar:

- Primary key: `relation_ref_id`
- Unique constraint: `(instance_pk, dbid, relid)`
- Foreign key: `instance_pk -> control.instance_inventory(instance_pk) on delete restrict`

Index kurallari:

- Unique btree index: `(instance_pk, dbid, relid)`
- Btree index: `(instance_pk, dbid, schemaname, relname)`
- Btree index: `(last_seen_at desc)`

### `dim.role_ref`

Fiziksel kurallar:

- Primary key: `role_ref_id`
- Unique constraint: `(instance_pk, userid)`
- Foreign key: `instance_pk -> control.instance_inventory(instance_pk) on delete restrict`

Index kurallari:

- Unique btree index: `(instance_pk, userid)`
- Btree index: `(instance_pk, rolname)`
- Btree index: `(last_seen_at desc)`

### `dim.statement_series`

Fiziksel kurallar:

- Primary key: `statement_series_id`
- Foreign key: `query_text_id -> dim.query_text(query_text_id)`
- Teknik seri uniqueness'i normal unique constraint ile degil, expression unique index ile saglanir
- Sebep: `toplevel` eski surumlerde `NULL` olabilir ve PostgreSQL `UNIQUE` icinde `NULL` degerlerini ayri kabul eder

Unique index kurali:

- Unique btree index:
  - `(instance_pk, system_identifier, pg_major, pgss_epoch_key, dbid, userid, coalesce(toplevel::text, 'unknown'), queryid)`

Ek index kurallari:

- Btree index: `(instance_pk, query_text_id)`
- Btree index: `(instance_pk, dbid, userid)`
- Btree index: `(last_seen_at desc)`

Not:

- `query_text_id` ilk insert aninda `NULL` olabilir; daha sonra enrichment adiminda update edilir

## Ops ve Alert Tasarimi

Bu bolum `ops` schema altindaki calisma kayitlari ve uygulama alert modeli icin sabit tasarim kurallarini tanimlar.

### `ops.job_run`

Fiziksel kurallar:

- Primary key: `job_run_id`
- Check constraint:
  - `status in ('running','success','failed','partial')`
  - `rows_written >= 0`
  - `instances_succeeded >= 0`
  - `instances_failed >= 0`

Index kurallari:

- Btree index: `(job_type, started_at desc)`
- Btree index: `(status, started_at desc)`

### `ops.job_run_instance`

Fiziksel kurallar:

- Primary key: `job_run_instance_id`
- Foreign key: `job_run_id -> ops.job_run(job_run_id)`
- Check constraint:
  - `status in ('running','success','failed','partial','skipped')`
  - `rows_written >= 0`
  - `new_series_count >= 0`
  - `new_query_text_count >= 0`

Index kurallari:

- Btree index: `(instance_pk, started_at desc)`
- Btree index: `(job_type, status, started_at desc)`

### `ops.alert`

Fiziksel kurallar:

- Primary key: `alert_id`
- Unique constraint: `alert_key`
- Check constraint:
  - `severity in ('info','warning','error','critical')`
  - `status in ('open','acknowledged','resolved')`
  - `occurrence_count > 0`

Index kurallari:

- Unique btree index: `(alert_key)`
- Btree index: `(status, severity, last_seen_at desc)`
- Btree index: `(instance_pk, status, last_seen_at desc)`
- Btree index: `(service_group, status, last_seen_at desc)` where service_group is not null

Alert kaynaklari:

- extension eksikligi
- unsupported veya degraded version profili
- tekrarlayan baglanti hatasi
- collector job partial failure
- scheduler advisory lock cakisimi

Severity kurallari:

- Beklenen metrik ailesi hic toplanamiyorsa `error`
- Veri kismen toplanabiliyor ama eksik kolon, view veya family varsa `warning`
- Bir instance'tan `24` saattir basarili veri alinmiyorsa `critical`

Resolve kurallari:

- Bir sonraki basarili ve tam toplamada ilgili `error` veya `warning` alert'i otomatik resolve edilir
- `critical` stale-data alert'i yeni veri geldiginde otomatik resolve edilir
- Uygulama ekraninda manuel `acknowledge` desteklenebilir, ancak cozum yine otomatik resolve ile kapanir

UI kurali:

- Uygulamadaki alert ekrani `ops.alert` tablosundan beslenir.
- `systemd journal` detayli execution log'u ve troubleshooting icin ikinci kaynak olarak kalir.

## Fact Partition Tasarimi

Bu bolum `fact` ve `agg` schema altindaki buyuk zaman serisi tablolarinin fiziksel bolunmesini tanimlar.

### Genel kurallar

- Tum hot fact tablolar `range partition by sample_ts` ile bolunur
- Partisyonlar gunluk acilir
- En az gelecek `7` gunluk partisyon onceden olusturulur
- Retention temizliginde birincil yol `drop partition` kullanmaktir
- Cluster'lar farkli retention tier'larina bagli oldugu icin gerekli durumlarda merkezi DB tarafinda ilgili gunluk partisyonlarda `instance_pk` bazli batched delete uygulanir
- Purge evaluator once instance bazli delete adaylarini isler, daha sonra global hard cutoff'un gerisinde kalan partisyonlari `drop partition` ile kaldirir

**Purge evaluator ornek mantigi:**

```sql
-- 1. Adim: Instance bazli retention cutoff'lari hesapla
-- Her instance'in raw_retention_months'una gore en erken saklanacak ay
select
  i.instance_pk,
  date_trunc('month', now()) - make_interval(months => p.raw_retention_months) as raw_keep_from
from control.instance_inventory i
join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
where i.is_active and p.is_active and p.purge_enabled;

-- 2. Adim: En uzun retention'a sahip instance'in cutoff'unu bul (global hard drop siniri)
-- Bu cutoff'un gerisindeki partisyonlar tamamen drop edilebilir
select date_trunc('month', now()) - make_interval(months => max(p.raw_retention_months)) as hard_drop_before
from control.retention_policy p
where p.is_active and p.purge_enabled;

-- 3. Adim: Hard drop sinirinin gerisindeki fact partisyonlarini drop et
-- Ornek: 2024-01 partisyonu hard_drop_before'dan once ise
-- ALTER TABLE fact.pgss_delta DETACH PARTITION fact.pgss_delta_20240101;
-- DROP TABLE fact.pgss_delta_20240101;

-- 4. Adim: Hard drop siniri ile instance bazli cutoff arasindaki partisyonlarda
-- sadece ilgili instance_pk satirlarini sil (tier farki olan instance'lar icin)
delete from fact.pgss_delta
where sample_ts >= $hard_drop_before
  and sample_ts <  $instance_raw_keep_from
  and instance_pk = $instance_pk;
-- Not: Bu delete partisyon budging olarak calisir; buyuk partisyonlarda
-- batch'lere bolunmeli (orn. 10_000 satir limitiyle loop)

-- 5. Adim: Ayni mantik agg tablolari icin (hourly_retention_months / daily_retention_months)
-- agg.pgss_hourly icin monthly partition drop; agg.pgss_daily icin yearly partition drop
```

### Partition olusturma otomasyonu

Gelecek gun partisyonlarinin onceden olusturulmasi zorunludur; aksi halde collector yazma sirasinda "no partition of relation ... found for row" hatasiyla karsilasir.

Bu sorumluluk collector uygulamasinin `rollup` job'ina aittir:

- `rollup` job her calismasinda (varsayilan saatlik) gelecek `14` gunluk eksik partisyonlari kontrol eder ve olustururur.
- Kontrol sorgusu `pg_catalog.pg_inherits` ile mevcut partisyonlari tarar; eksik araliklari `CREATE TABLE ... PARTITION OF` ile doldurur. Ornek mantik:
  ```sql
  -- Mevcut fact.pgss_delta partisyonlarini bul
  select nmsp.nspname || '.' || child.relname as partition_name,
         pg_get_expr(child.relpartbound, child.oid) as bounds
  from pg_inherits
  join pg_class parent on parent.oid = pg_inherits.inhparent
  join pg_class child  on child.oid  = pg_inherits.inhrelid
  join pg_namespace nmsp on nmsp.oid = child.relnamespace
  where parent.relname = 'pgss_delta'
    and parent.relnamespace = (select oid from pg_namespace where nspname = 'fact');
  -- Eksik gunler icin olustur:
  -- CREATE TABLE fact.pgss_delta_20260420
  --   PARTITION OF fact.pgss_delta
  --   FOR VALUES FROM ('2026-04-20') TO ('2026-04-21');
  ```
- `agg.pgss_hourly` icin aylik partisyonlar yine `rollup` job'i tarafindan, en az mevcut ay ile gelecek `2` ay olusturularak yonetilir.
- `agg.pgss_daily` icin yillik partisyonlar `rollup` job'i tarafindan, en az mevcut yil ile gelecek `1` yil olusturularak yonetilir.
- `agg.pgss_hourly` purge'u `hourly_retention_months` kuralina gore, `agg.pgss_daily` purge'u `daily_retention_months` kuralina gore purge evaluator tarafindan aylik olarak yapilir; `drop partition` birincil yoldur.
- Ilk kurulumda migration script'i bugun dahil gecmis `7` gunun ve gelecek `14` gunun partisyonlarini olusturur.
- V1'de subpartition kullanilmaz
- `fact.pgss_delta` hacmi ileride cok buyurse ikinci fazda `hash(instance_pk)` alt parcasi dusunulebilir

### `fact.pgss_delta`

Partition kurali:

- Parent tablo: `partition by range (sample_ts)`
- Partisyon araligi: gunluk
- Primary key:
  - `(sample_ts, instance_pk, statement_series_id)`
- Foreign key:
  - `statement_series_id -> dim.statement_series(statement_series_id)`

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(statement_series_id, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, statement_series_id, sample_ts desc)`

Check kurallari:

- Tum `*_delta` kolonlari `is null or >= 0` mantiginda check alir

### `fact.pg_database_delta`

Partition kurali:

- Parent tablo: `partition by range (sample_ts)`
- Partisyon araligi: gunluk
- Primary key:
  - `(sample_ts, instance_pk, dbid)`

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, dbid, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, datname, sample_ts desc)`

Check kurallari:

- Tum `*_delta` kolonlari `is null or >= 0` mantiginda check alir
- `numbackends is null or numbackends >= 0`

### `fact.pg_table_stat_delta`

Partition kurali:

- Parent tablo: `partition by range (sample_ts)`
- Partisyon araligi: gunluk
- Primary key:
  - `(sample_ts, instance_pk, dbid, relid)`

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, dbid, relid, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, dbid, schemaname, relname, sample_ts desc)`

Check kurallari:

- Tum `*_delta` kolonlari `is null or >= 0` mantiginda check alir
- `n_live_tup_estimate is null or n_live_tup_estimate >= 0`
- `n_dead_tup_estimate is null or n_dead_tup_estimate >= 0`
- `n_mod_since_analyze is null or n_mod_since_analyze >= 0`

### `fact.pg_index_stat_delta`

Partition kurali:

- Parent tablo: `partition by range (sample_ts)`
- Partisyon araligi: gunluk
- Primary key:
  - `(sample_ts, instance_pk, dbid, index_relid)`

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, dbid, index_relid, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, dbid, table_relid, sample_ts desc)`

Check kurallari:

- Tum `*_delta` kolonlari `is null or >= 0` mantiginda check alir

### `fact.pg_cluster_delta`

Partition kurali:

- Parent tablo: `partition by range (sample_ts)`
- Partisyon araligi: gunluk
- Primary key:
  - `(sample_ts, instance_pk, metric_family, metric_name)`

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, metric_family, metric_name, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(metric_family, metric_name, sample_ts desc)`

### `fact.pg_io_stat_delta`

Partition kurali:

- Parent tablo: `partition by range (sample_ts)`
- Partisyon araligi: gunluk
- Primary key:
  - `(sample_ts, instance_pk, backend_type, object, context)`

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, sample_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, backend_type, object, context, sample_ts desc)`

### `fact.pg_lock_snapshot`

Partition kurali:

- Parent tablo: `partition by range (snapshot_ts)`
- Partisyon araligi: gunluk
- Primary key yok (ayni anda birden fazla lock bekleyen ayni PID olabilir; `snapshot_ts + instance_pk + pid` tek basina unique degil)

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, snapshot_ts desc)`
- Parent uzerinden tanimli partial btree index: `(instance_pk, snapshot_ts desc) where granted = false`

Tasarim notu: Yalnizca `granted = false` satirlar yazildigi icin partial index fiilen tum satiri kapsar; ancak gelecekte `granted = true` satirlar da yazilirsa partial index hala dogru calisir.

### `fact.pg_progress_snapshot`

Partition kurali:

- Parent tablo: `partition by range (snapshot_ts)`
- Partisyon araligi: gunluk
- Primary key:
  - `(snapshot_ts, instance_pk, pid)`

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, snapshot_ts desc)`
- Parent uzerinden tanimli btree index: `(instance_pk, command, snapshot_ts desc)`

### `agg.pgss_hourly`

Partition kurali:

- Parent tablo: `partition by range (bucket_start)`
- Partisyon araligi: aylik
- Primary key:
  - `(bucket_start, instance_pk, statement_series_id)`

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, statement_series_id, bucket_start desc)`
- Parent uzerinden tanimli btree index: `(bucket_start desc)`

### `agg.pgss_daily`

Partition kurali:

- Parent tablo: `partition by range (bucket_start)`
- Partisyon araligi: yillik
- Primary key:
  - `(bucket_start, instance_pk, statement_series_id)`

Index kurallari:

- Parent uzerinden tanimli btree index: `(instance_pk, statement_series_id, bucket_start desc)`
- Parent uzerinden tanimli btree index: `(bucket_start desc)`

## Indeks ve Unique Constraint Kurallari

Bu bolum tasarimin tamaminda uygulanacak sabit fiziksel kurallari toplar.

### Primary key ve foreign key yaklasimi

- `control` ve `dim` tablolarinda tam foreign key kullanilir
- En sicak fact tablolarda yalnizca gerekli olan foreign key tutulur
- V1'de `fact.pgss_delta` icin `statement_series_id` foreign key zorunludur
- `fact.pg_database_delta` ve `fact.pg_cluster_delta` icin write maliyetini sinirlamak amaciyla ek foreign key zorunlu degildir

### Unique constraint yaklasimi

- Is mantigi geregi tekillik gereken her yerde once unique index dusunulur
- `NULL` semantigi nedeniyle `dim.statement_series` tekilligi expression unique index ile saglanir
- `dim.query_text` tekilligi `query_hash` ile saglanir (global dedup)
- `control.instance_inventory.instance_id` ve `(host, port, admin_dbname)` tekil olur

### Yazma yolu indeks kurali

- Hicbir fact tabloya gereksiz index eklenmez
- Her ek index ingest maliyetini arttirdigi icin sadece sorgu desenleriyle dogrudan iliskili indexler tanimlanir
- V1 hedefi: hot tabloda `3` ana secondary index'i gecmemek

### Sorgu deseni odaklari

Indeksler asagidaki baskin sorgulari hizlandirmak icin secilir:

- Bir host icin son `N` dakika metriklerini cekmek
- Bir statement series'in zaman icindeki trendini okumak
- Bir database'in zaman icindeki trendini okumak
- Rollup job'larinda belirli zaman araligini sirali taramak
- Scheduler tarafinda siradaki host'lari secmek

### Check constraint yaklasimi

- Tum sayisal delta kolonlari negatif olamaz
- Enum benzeri text kolonlari `CHECK` ile sinirlandirilir
- Network ve credential alanlarinda business rule disi uzun validation mantigi DB'ye degil uygulamaya birakilir

## Merkezi DB DDL Kurallari

Ilk uygulamada su DDL kurallari sabittir:

- Tum fact tablolari zaman bazli partition edilir.
- `instance_id`, `sample_ts` ve ana boyut anahtarlarinda indeks bulunur.
- `dim.query_text.query_hash` unique olur.
- `dim.statement_series` teknik seri anahtarina gore unique olur.
- Secret verisi merkezi DB'de plaintext tutulmaz.
- `ops` tablolari en az `90` gun saklanir.

### `ops` Tablo Retention Kurallari

`ops.job_run` ve `ops.job_run_instance` tablolari yuksek frekansta yazilir; purge edilmezse sismeye devam eder.

Kurallar:

- `ops` tablolari icin sabit `90` gunluk retention uygulanir; bu deger konfigurasyona bagli degildir.
- Purge evaluator her gun calistiginda `ops.job_run` ve `ops.job_run_instance` icin `started_at < now() - interval '90 days'` kosulunu saglayan satirlari siler.
- Silme `ops.job_run` uzerinden cascade ile `ops.job_run_instance`'a yansir (`on delete cascade` constraint).
- `ops.alert` tablosunda `resolved_at` olan ve `resolved_at < now() - interval '90 days'` kosulunu saglayan satirlar ayni gun temizlenir.
- `ops.alert` tablosunda `status = 'open'` veya `status = 'acknowledged'` olan satirlar suresi ne olursa olsun silinmez.

## Ornek DDL ve SQL

Bu bolum, yukaridaki tasarimi dogrudan uygulamaya baslamak icin kullanilabilecek ornek SQL ve DDL bloklarini verir.

Varsayimlar:

- Merkezi PostgreSQL `14+`
- `query_hash` collector uygulamasi tarafinda hesaplanir
- `updated_at` kolonlari trigger ile guncellenir

### 1. Schema ve Yardimci Trigger

```sql
create schema if not exists control;
create schema if not exists dim;
create schema if not exists fact;
create schema if not exists agg;
create schema if not exists ops;

create or replace function control.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
```

### 2. Control Tablolari DDL

```sql
create table if not exists control.schedule_profile (
  schedule_profile_id bigint generated always as identity primary key,
  profile_code text not null,
  cluster_interval_seconds integer not null default 60,
  statements_interval_seconds integer not null default 300,
  db_objects_interval_seconds integer not null default 1800,
  hourly_rollup_interval_seconds integer not null default 3600,
  daily_rollup_hour_utc integer not null default 1,
  bootstrap_sql_text_batch integer not null default 100,
  max_databases_per_run integer not null default 5,
  statement_timeout_ms integer not null default 5000,
  lock_timeout_ms integer not null default 250,
  connect_timeout_seconds integer not null default 5,
  max_host_concurrency integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_schedule_profile_code unique (profile_code),
  constraint ck_schedule_profile_cluster_interval check (cluster_interval_seconds > 0),
  constraint ck_schedule_profile_statements_interval check (statements_interval_seconds > 0),
  constraint ck_schedule_profile_db_objects_interval check (db_objects_interval_seconds > 0),
  constraint ck_schedule_profile_rollup_interval check (hourly_rollup_interval_seconds > 0),
  constraint ck_schedule_profile_daily_rollup_hour check (daily_rollup_hour_utc between 0 and 23),
  constraint ck_schedule_profile_bootstrap_batch check (bootstrap_sql_text_batch > 0),
  constraint ck_schedule_profile_max_databases_per_run check (max_databases_per_run > 0),
  constraint ck_schedule_profile_statement_timeout check (statement_timeout_ms > 0),
  constraint ck_schedule_profile_lock_timeout check (lock_timeout_ms >= 0),
  constraint ck_schedule_profile_connect_timeout check (connect_timeout_seconds > 0),
  constraint ck_schedule_profile_host_concurrency check (max_host_concurrency > 0)
);

create table if not exists control.retention_policy (
  retention_policy_id bigint generated always as identity primary key,
  policy_code text not null,
  raw_retention_months integer not null,
  hourly_retention_months integer not null,
  daily_retention_months integer not null,
  is_active boolean not null default true,
  purge_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_retention_policy_code unique (policy_code),
  constraint ck_retention_policy_raw_months check (raw_retention_months > 0),
  constraint ck_retention_policy_hourly_months check (hourly_retention_months > 0),
  constraint ck_retention_policy_daily_months check (daily_retention_months > 0)
);

create table if not exists control.instance_inventory (
  instance_pk bigint generated always as identity primary key,
  instance_id text not null,
  display_name text not null,
  environment text null,
  service_group text null,
  host text not null,
  port integer not null default 5432,
  admin_dbname text not null default 'postgres',
  secret_ref text not null,
  ssl_mode text not null default 'prefer',
  ssl_root_cert_path text null,
  schedule_profile_id bigint not null references control.schedule_profile(schedule_profile_id),
  retention_policy_id bigint not null references control.retention_policy(retention_policy_id),
  is_active boolean not null default true,
  bootstrap_state text not null default 'pending',
  collector_group text null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_instance_inventory_instance_id unique (instance_id),
  constraint uq_instance_inventory_host_port_db unique (host, port, admin_dbname),
  constraint ck_instance_inventory_port check (port between 1 and 65535),
  constraint ck_instance_inventory_ssl_mode check (
    ssl_mode in ('disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full')
  ),
  constraint ck_instance_inventory_bootstrap_state check (
    bootstrap_state in ('pending', 'discovering', 'baselining', 'enriching', 'ready', 'degraded', 'paused')
  )
);

create table if not exists control.instance_capability (
  instance_pk bigint primary key references control.instance_inventory(instance_pk) on delete cascade,
  server_version_num integer null,
  pg_major integer null,
  system_identifier bigint null,
  is_reachable boolean null,
  is_primary boolean null,
  has_pg_stat_statements boolean not null default false,
  has_pg_stat_statements_info boolean not null default false,
  has_pg_stat_io boolean not null default false,
  has_pg_stat_checkpointer boolean not null default false,
  compute_query_id_mode text null,
  collector_sql_family text null,
  last_postmaster_start_at timestamptz null,
  last_pgss_stats_reset_at timestamptz null,
  last_discovered_at timestamptz null,
  last_error_at timestamptz null,
  last_error_text text null,
  constraint ck_instance_capability_version check (server_version_num is null or server_version_num > 0),
  constraint ck_instance_capability_pg_major check (pg_major is null or pg_major > 0),
  constraint ck_instance_capability_system_identifier check (system_identifier is null or system_identifier > 0),
  constraint ck_instance_capability_query_id_mode check (
    compute_query_id_mode is null or compute_query_id_mode in ('off', 'on', 'auto', 'regress', 'external')
  )
);

create table if not exists control.instance_state (
  instance_pk bigint primary key references control.instance_inventory(instance_pk) on delete cascade,
  last_cluster_collect_at timestamptz null,
  last_statements_collect_at timestamptz null,
  last_rollup_at timestamptz null,
  next_cluster_collect_at timestamptz null,
  next_statements_collect_at timestamptz null,
  bootstrap_completed_at timestamptz null,
  current_pgss_epoch_key text null,
  last_cluster_stats_reset_at timestamptz null,
  consecutive_failures integer not null default 0,
  backoff_until timestamptz null,
  last_success_at timestamptz null,
  constraint ck_instance_state_consecutive_failures check (consecutive_failures >= 0)
);

create table if not exists control.database_state (
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete cascade,
  dbid oid not null,
  last_db_objects_collect_at timestamptz null,
  next_db_objects_collect_at timestamptz null,
  consecutive_failures integer not null default 0,
  backoff_until timestamptz null,
  last_error_at timestamptz null,
  last_error_text text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (instance_pk, dbid),
  constraint ck_database_state_consecutive_failures check (consecutive_failures >= 0)
);

create trigger trg_schedule_profile_updated_at
before update on control.schedule_profile
for each row execute function control.set_updated_at();

create trigger trg_retention_policy_updated_at
before update on control.retention_policy
for each row execute function control.set_updated_at();

create trigger trg_instance_inventory_updated_at
before update on control.instance_inventory
for each row execute function control.set_updated_at();

create trigger trg_database_state_updated_at
before update on control.database_state
for each row execute function control.set_updated_at();

create index if not exists ix_instance_inventory_schedule_profile
  on control.instance_inventory (schedule_profile_id);

create index if not exists ix_instance_inventory_retention_policy
  on control.instance_inventory (retention_policy_id);

create index if not exists ix_instance_inventory_service_group
  on control.instance_inventory (service_group, instance_id);

create index if not exists ix_retention_policy_active
  on control.retention_policy (is_active, policy_code)
  where is_active;

create index if not exists ix_instance_inventory_active_group
  on control.instance_inventory (collector_group, instance_id)
  where is_active;

create index if not exists ix_instance_inventory_active_bootstrap
  on control.instance_inventory (bootstrap_state, instance_id)
  where is_active;

create index if not exists ix_instance_capability_unreachable
  on control.instance_capability (last_discovered_at)
  where is_reachable = false or is_reachable is null;

create index if not exists ix_instance_state_next_cluster
  on control.instance_state (next_cluster_collect_at)
  where next_cluster_collect_at is not null;

create index if not exists ix_instance_state_next_statements
  on control.instance_state (next_statements_collect_at)
  where next_statements_collect_at is not null;

create index if not exists ix_instance_state_backoff
  on control.instance_state (backoff_until)
  where backoff_until is not null;

create index if not exists ix_instance_state_last_success
  on control.instance_state (last_success_at);

create index if not exists ix_database_state_next_db_objects
  on control.database_state (next_db_objects_collect_at)
  where next_db_objects_collect_at is not null;

create index if not exists ix_database_state_backoff
  on control.database_state (backoff_until)
  where backoff_until is not null;
```

### 3. Dim Tablolari DDL

```sql
create table if not exists dim.query_text (
  query_text_id bigint generated always as identity primary key,
  query_hash bytea not null,
  query_text text not null,
  query_text_len integer generated always as (length(query_text)) stored,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  first_seen_instance_pk bigint null references control.instance_inventory(instance_pk) on delete set null,
  source_pg_major integer null,
  constraint uq_query_text_hash unique (query_hash),
  constraint ck_query_text_hash_len check (octet_length(query_hash) = 32)
);

create table if not exists dim.database_ref (
  database_ref_id bigint generated always as identity primary key,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete restrict,
  dbid oid not null,
  datname text not null,
  is_template boolean null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint uq_database_ref unique (instance_pk, dbid)
);

create table if not exists dim.relation_ref (
  relation_ref_id bigint generated always as identity primary key,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete restrict,
  dbid oid not null,
  relid oid not null,
  schemaname text not null,
  relname text not null,
  relkind text not null,
  parent_relid oid null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint uq_relation_ref unique (instance_pk, dbid, relid)
);

create table if not exists dim.role_ref (
  role_ref_id bigint generated always as identity primary key,
  instance_pk bigint not null references control.instance_inventory(instance_pk) on delete restrict,
  userid oid not null,
  rolname text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint uq_role_ref unique (instance_pk, userid)
);

create table if not exists dim.statement_series (
  statement_series_id bigint generated always as identity primary key,
  instance_pk bigint not null,
  pg_major integer not null,
  collector_sql_family text not null,
  system_identifier bigint not null,
  pgss_epoch_key text not null,
  dbid oid not null,
  userid oid not null,
  toplevel boolean null,
  queryid bigint not null,
  query_text_id bigint null references dim.query_text(query_text_id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create unique index if not exists uq_statement_series_natural
  on dim.statement_series (
    instance_pk,
    system_identifier,
    pg_major,
    pgss_epoch_key,
    dbid,
    userid,
    coalesce(toplevel::text, 'unknown'),
    queryid
  );

create index if not exists ix_query_text_last_seen
  on dim.query_text (last_seen_at desc);

create index if not exists ix_database_ref_instance_datname
  on dim.database_ref (instance_pk, datname);

create index if not exists ix_database_ref_last_seen
  on dim.database_ref (last_seen_at desc);

create index if not exists ix_relation_ref_instance_name
  on dim.relation_ref (instance_pk, dbid, schemaname, relname);

create index if not exists ix_relation_ref_last_seen
  on dim.relation_ref (last_seen_at desc);

create index if not exists ix_role_ref_instance_rolname
  on dim.role_ref (instance_pk, rolname);

create index if not exists ix_role_ref_last_seen
  on dim.role_ref (last_seen_at desc);

create index if not exists ix_statement_series_instance_query_text
  on dim.statement_series (instance_pk, query_text_id);

create index if not exists ix_statement_series_instance_ids
  on dim.statement_series (instance_pk, dbid, userid);

create index if not exists ix_statement_series_last_seen
  on dim.statement_series (last_seen_at desc);
```

### 4. Fact ve Agg Parent Tablolari DDL

```sql
create table if not exists fact.pgss_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  statement_series_id bigint not null references dim.statement_series(statement_series_id),
  calls_delta bigint not null,
  plans_delta bigint null,
  total_plan_time_ms_delta double precision null,
  total_exec_time_ms_delta double precision not null,
  rows_delta bigint null,
  shared_blks_hit_delta bigint null,
  shared_blks_read_delta bigint null,
  shared_blks_dirtied_delta bigint null,
  shared_blks_written_delta bigint null,
  local_blks_hit_delta bigint null,
  local_blks_read_delta bigint null,
  local_blks_dirtied_delta bigint null,
  local_blks_written_delta bigint null,
  temp_blks_read_delta bigint null,
  temp_blks_written_delta bigint null,
  blk_read_time_ms_delta double precision null,
  blk_write_time_ms_delta double precision null,
  wal_records_delta bigint null,
  wal_fpi_delta bigint null,
  wal_bytes_delta numeric null,
  jit_generation_time_ms_delta double precision null,
  jit_inlining_time_ms_delta double precision null,
  jit_optimization_time_ms_delta double precision null,
  jit_emission_time_ms_delta double precision null,
  primary key (sample_ts, instance_pk, statement_series_id),
  constraint ck_pgss_delta_calls check (calls_delta >= 0),
  constraint ck_pgss_delta_plans check (plans_delta is null or plans_delta >= 0),
  constraint ck_pgss_delta_exec_time check (total_exec_time_ms_delta >= 0),
  constraint ck_pgss_delta_plan_time check (total_plan_time_ms_delta is null or total_plan_time_ms_delta >= 0),
  constraint ck_pgss_delta_rows check (rows_delta is null or rows_delta >= 0),
  constraint ck_pgss_delta_wal_bytes check (wal_bytes_delta is null or wal_bytes_delta >= 0)
) partition by range (sample_ts);

create table if not exists fact.pg_database_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  dbid oid not null,
  datname text not null,
  numbackends integer null,
  xact_commit_delta bigint not null,
  xact_rollback_delta bigint not null,
  blks_read_delta bigint not null,
  blks_hit_delta bigint not null,
  tup_returned_delta bigint not null,
  tup_fetched_delta bigint not null,
  tup_inserted_delta bigint not null,
  tup_updated_delta bigint not null,
  tup_deleted_delta bigint not null,
  conflicts_delta bigint null,
  temp_files_delta bigint null,
  temp_bytes_delta bigint null,
  deadlocks_delta bigint null,
  checksum_failures_delta bigint null,
  blk_read_time_ms_delta double precision null,
  blk_write_time_ms_delta double precision null,
  session_time_ms_delta double precision null,
  active_time_ms_delta double precision null,
  idle_in_transaction_time_ms_delta double precision null,
  primary key (sample_ts, instance_pk, dbid),
  constraint ck_pg_database_numbackends check (numbackends is null or numbackends >= 0),
  constraint ck_pg_database_commit check (xact_commit_delta >= 0),
  constraint ck_pg_database_rollback check (xact_rollback_delta >= 0),
  constraint ck_pg_database_blks_read check (blks_read_delta >= 0),
  constraint ck_pg_database_blks_hit check (blks_hit_delta >= 0)
) partition by range (sample_ts);

create table if not exists fact.pg_table_stat_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  dbid oid not null,
  relid oid not null,
  schemaname text not null,
  relname text not null,
  seq_scan_delta bigint null,
  seq_tup_read_delta bigint null,
  idx_scan_delta bigint null,
  idx_tup_fetch_delta bigint null,
  n_tup_ins_delta bigint null,
  n_tup_upd_delta bigint null,
  n_tup_del_delta bigint null,
  n_tup_hot_upd_delta bigint null,
  vacuum_count_delta bigint null,
  autovacuum_count_delta bigint null,
  analyze_count_delta bigint null,
  autoanalyze_count_delta bigint null,
  heap_blks_read_delta bigint null,
  heap_blks_hit_delta bigint null,
  idx_blks_read_delta bigint null,
  idx_blks_hit_delta bigint null,
  toast_blks_read_delta bigint null,
  toast_blks_hit_delta bigint null,
  tidx_blks_read_delta bigint null,
  tidx_blks_hit_delta bigint null,
  n_live_tup_estimate bigint null,
  n_dead_tup_estimate bigint null,
  n_mod_since_analyze bigint null,
  primary key (sample_ts, instance_pk, dbid, relid),
  constraint ck_pg_table_stat_seq_scan check (seq_scan_delta is null or seq_scan_delta >= 0),
  constraint ck_pg_table_stat_seq_tup_read check (seq_tup_read_delta is null or seq_tup_read_delta >= 0),
  constraint ck_pg_table_stat_idx_scan check (idx_scan_delta is null or idx_scan_delta >= 0),
  constraint ck_pg_table_stat_idx_tup_fetch check (idx_tup_fetch_delta is null or idx_tup_fetch_delta >= 0),
  constraint ck_pg_table_stat_live_tup check (n_live_tup_estimate is null or n_live_tup_estimate >= 0),
  constraint ck_pg_table_stat_dead_tup check (n_dead_tup_estimate is null or n_dead_tup_estimate >= 0),
  constraint ck_pg_table_stat_mod_since_analyze check (n_mod_since_analyze is null or n_mod_since_analyze >= 0)
) partition by range (sample_ts);

create table if not exists fact.pg_index_stat_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  dbid oid not null,
  table_relid oid not null,
  index_relid oid not null,
  schemaname text not null,
  table_relname text not null,
  index_relname text not null,
  idx_scan_delta bigint null,
  idx_tup_read_delta bigint null,
  idx_tup_fetch_delta bigint null,
  idx_blks_read_delta bigint null,
  idx_blks_hit_delta bigint null,
  primary key (sample_ts, instance_pk, dbid, index_relid),
  constraint ck_pg_index_stat_scan check (idx_scan_delta is null or idx_scan_delta >= 0),
  constraint ck_pg_index_stat_tup_read check (idx_tup_read_delta is null or idx_tup_read_delta >= 0),
  constraint ck_pg_index_stat_tup_fetch check (idx_tup_fetch_delta is null or idx_tup_fetch_delta >= 0),
  constraint ck_pg_index_stat_blks_read check (idx_blks_read_delta is null or idx_blks_read_delta >= 0),
  constraint ck_pg_index_stat_blks_hit check (idx_blks_hit_delta is null or idx_blks_hit_delta >= 0)
) partition by range (sample_ts);

create table if not exists fact.pg_cluster_delta (
  sample_ts timestamptz not null,
  instance_pk bigint not null,
  metric_family text not null,
  metric_name text not null,
  metric_value_num numeric not null,
  primary key (sample_ts, instance_pk, metric_family, metric_name),
  constraint ck_pg_cluster_metric_family check (metric_family <> ''),
  constraint ck_pg_cluster_metric_name check (metric_name <> '')
) partition by range (sample_ts);

create table if not exists fact.pg_io_stat_delta (
  sample_ts              timestamptz not null,
  instance_pk            bigint not null,
  backend_type           text not null,
  object                 text not null,
  context                text not null,
  reads_delta            bigint null,
  read_time_ms_delta     double precision null,
  writes_delta           bigint null,
  write_time_ms_delta    double precision null,
  extends_delta          bigint null,
  extend_time_ms_delta   double precision null,
  hits_delta             bigint null,
  evictions_delta        bigint null,
  reuses_delta           bigint null,
  fsyncs_delta           bigint null,
  fsync_time_ms_delta    double precision null,
  primary key (sample_ts, instance_pk, backend_type, object, context)
) partition by range (sample_ts);

create table if not exists fact.pg_activity_snapshot (
  snapshot_ts       timestamptz not null,
  instance_pk       bigint not null,
  pid               integer not null,
  datname           text null,
  usename           text null,
  application_name  text null,
  client_addr       inet null,
  backend_start     timestamptz null,
  xact_start        timestamptz null,
  query_start       timestamptz null,
  state_change      timestamptz null,
  state             text null,
  wait_event_type   text null,
  wait_event        text null,
  query             text null,
  backend_type      text null,
  primary key (snapshot_ts, instance_pk, pid)
) partition by range (snapshot_ts);

create table if not exists fact.pg_lock_snapshot (
  snapshot_ts       timestamptz not null,
  instance_pk       bigint not null,
  pid               integer not null,
  locktype          text not null,
  database_oid      oid null,
  relation_oid      oid null,
  mode              text not null,
  granted           boolean not null,
  waitstart         timestamptz null,
  blocked_by_pids   integer[] null
) partition by range (snapshot_ts);

create table if not exists fact.pg_progress_snapshot (
  snapshot_ts       timestamptz not null,
  instance_pk       bigint not null,
  pid               integer not null,
  command           text not null,
  datname           text null,
  relname           text null,
  phase             text null,
  blocks_total      bigint null,
  blocks_done       bigint null,
  tuples_total      bigint null,
  tuples_done       bigint null,
  progress_pct      double precision null,
  primary key (snapshot_ts, instance_pk, pid)
) partition by range (snapshot_ts);

create table if not exists fact.pg_replication_snapshot (
  snapshot_ts         timestamptz not null,
  instance_pk         bigint not null,
  pid                 integer not null,
  usename             text null,
  application_name    text null,
  client_addr         inet null,
  state               text null,
  sent_lsn            pg_lsn null,
  write_lsn           pg_lsn null,
  flush_lsn           pg_lsn null,
  replay_lsn          pg_lsn null,
  write_lag           interval null,
  flush_lag           interval null,
  replay_lag          interval null,
  sync_state          text null,
  replay_lag_bytes    bigint null,
  primary key (snapshot_ts, instance_pk, pid)
) partition by range (snapshot_ts);

create table if not exists agg.pgss_hourly (
  bucket_start timestamptz not null,
  instance_pk bigint not null,
  statement_series_id bigint not null,
  calls_sum bigint not null,
  exec_time_ms_sum double precision not null,
  rows_sum bigint null,
  shared_blks_read_sum bigint null,
  shared_blks_hit_sum bigint null,
  temp_blks_written_sum bigint null,
  primary key (bucket_start, instance_pk, statement_series_id)
) partition by range (bucket_start);

create table if not exists agg.pgss_daily (
  bucket_start date not null,
  instance_pk bigint not null,
  statement_series_id bigint not null,
  calls_sum bigint not null,
  exec_time_ms_sum double precision not null,
  rows_sum bigint null,
  shared_blks_read_sum bigint null,
  shared_blks_hit_sum bigint null,
  temp_blks_written_sum bigint null,
  primary key (bucket_start, instance_pk, statement_series_id)
) partition by range (bucket_start);

create index if not exists ix_pgss_delta_instance_sample
  on fact.pgss_delta (instance_pk, sample_ts desc);

create index if not exists ix_pgss_delta_series_sample
  on fact.pgss_delta (statement_series_id, sample_ts desc);

create index if not exists ix_pgss_delta_instance_series_sample
  on fact.pgss_delta (instance_pk, statement_series_id, sample_ts desc);

create index if not exists ix_pg_database_delta_instance_sample
  on fact.pg_database_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_database_delta_instance_dbid_sample
  on fact.pg_database_delta (instance_pk, dbid, sample_ts desc);

create index if not exists ix_pg_database_delta_instance_datname_sample
  on fact.pg_database_delta (instance_pk, datname, sample_ts desc);

create index if not exists ix_pg_table_stat_instance_sample
  on fact.pg_table_stat_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_table_stat_instance_rel_sample
  on fact.pg_table_stat_delta (instance_pk, dbid, relid, sample_ts desc);

create index if not exists ix_pg_table_stat_instance_name_sample
  on fact.pg_table_stat_delta (instance_pk, dbid, schemaname, relname, sample_ts desc);

create index if not exists ix_pg_index_stat_instance_sample
  on fact.pg_index_stat_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_index_stat_instance_index_sample
  on fact.pg_index_stat_delta (instance_pk, dbid, index_relid, sample_ts desc);

create index if not exists ix_pg_index_stat_instance_table_sample
  on fact.pg_index_stat_delta (instance_pk, dbid, table_relid, sample_ts desc);

create index if not exists ix_pg_cluster_delta_instance_sample
  on fact.pg_cluster_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_cluster_delta_instance_family_name_sample
  on fact.pg_cluster_delta (instance_pk, metric_family, metric_name, sample_ts desc);

create index if not exists ix_pg_io_stat_delta_instance_sample
  on fact.pg_io_stat_delta (instance_pk, sample_ts desc);

create index if not exists ix_pg_io_stat_delta_instance_dims_sample
  on fact.pg_io_stat_delta (instance_pk, backend_type, object, context, sample_ts desc);

create index if not exists ix_pg_lock_snapshot_instance_snapshot
  on fact.pg_lock_snapshot (instance_pk, snapshot_ts desc);

create index if not exists ix_pg_lock_snapshot_instance_waiting
  on fact.pg_lock_snapshot (instance_pk, snapshot_ts desc)
  where granted = false;

create index if not exists ix_pg_progress_snapshot_instance_snapshot
  on fact.pg_progress_snapshot (instance_pk, snapshot_ts desc);

create index if not exists ix_pg_activity_snapshot_instance_snapshot
  on fact.pg_activity_snapshot (instance_pk, snapshot_ts desc);

create index if not exists ix_pg_activity_snapshot_instance_state
  on fact.pg_activity_snapshot (instance_pk, state, snapshot_ts desc);

create index if not exists ix_pg_replication_snapshot_instance_snapshot
  on fact.pg_replication_snapshot (instance_pk, snapshot_ts desc);

create index if not exists ix_pgss_hourly_instance_series_bucket
  on agg.pgss_hourly (instance_pk, statement_series_id, bucket_start desc);

create index if not exists ix_pgss_hourly_bucket
  on agg.pgss_hourly (bucket_start desc);

create index if not exists ix_pgss_daily_instance_series_bucket
  on agg.pgss_daily (instance_pk, statement_series_id, bucket_start desc);

create index if not exists ix_pgss_daily_bucket
  on agg.pgss_daily (bucket_start desc);
```

### 5. Ops Tablolari DDL

```sql
create table if not exists ops.job_run (
  job_run_id bigint generated always as identity primary key,
  job_type text not null,
  started_at timestamptz not null,
  finished_at timestamptz null,
  status text not null,
  worker_hostname text null,
  rows_written bigint not null default 0,
  instances_succeeded integer not null default 0,
  instances_failed integer not null default 0,
  error_text text null,
  constraint ck_job_run_status check (status in ('running', 'success', 'failed', 'partial')),
  constraint ck_job_run_rows_written check (rows_written >= 0),
  constraint ck_job_run_instances_succeeded check (instances_succeeded >= 0),
  constraint ck_job_run_instances_failed check (instances_failed >= 0)
);

create table if not exists ops.job_run_instance (
  job_run_instance_id bigint generated always as identity primary key,
  job_run_id bigint not null references ops.job_run(job_run_id) on delete cascade,
  instance_pk bigint not null,
  job_type text not null,
  started_at timestamptz not null,
  finished_at timestamptz null,
  status text not null,
  rows_written bigint not null default 0,
  new_series_count integer not null default 0,
  new_query_text_count integer not null default 0,
  error_text text null,
  constraint ck_job_run_instance_status check (status in ('running', 'success', 'failed', 'partial', 'skipped')),
  constraint ck_job_run_instance_rows_written check (rows_written >= 0),
  constraint ck_job_run_instance_new_series check (new_series_count >= 0),
  constraint ck_job_run_instance_new_query_text check (new_query_text_count >= 0)
);

create table if not exists ops.alert (
  alert_id bigint generated always as identity primary key,
  alert_key text not null,
  alert_code text not null,
  severity text not null,
  status text not null,
  source_component text not null,
  instance_pk bigint null,
  service_group text null,
  system_identifier bigint null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  resolved_at timestamptz null,
  acknowledged_at timestamptz null,
  title text not null,
  message text not null,
  details_json jsonb null,
  occurrence_count integer not null default 1,
  constraint uq_alert_key unique (alert_key),
  constraint ck_alert_severity check (severity in ('info', 'warning', 'error', 'critical')),
  constraint ck_alert_status check (status in ('open', 'acknowledged', 'resolved')),
  constraint ck_alert_occurrence_count check (occurrence_count > 0)
);

create index if not exists ix_job_run_type_started
  on ops.job_run (job_type, started_at desc);

create index if not exists ix_job_run_status_started
  on ops.job_run (status, started_at desc);

create index if not exists ix_job_run_instance_pk_started
  on ops.job_run_instance (instance_pk, started_at desc);

create index if not exists ix_job_run_instance_job_status_started
  on ops.job_run_instance (job_type, status, started_at desc);

create index if not exists ix_alert_status_severity_last_seen
  on ops.alert (status, severity, last_seen_at desc);

create index if not exists ix_alert_instance_status_last_seen
  on ops.alert (instance_pk, status, last_seen_at desc);

create index if not exists ix_alert_service_group_status_last_seen
  on ops.alert (service_group, status, last_seen_at desc)
  where service_group is not null;
```

### 6. Ornek Partition DDL

```sql
create table if not exists fact.pgss_delta_2026_04_16
  partition of fact.pgss_delta
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists fact.pg_database_delta_2026_04_16
  partition of fact.pg_database_delta
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists fact.pg_table_stat_delta_2026_04_16
  partition of fact.pg_table_stat_delta
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists fact.pg_index_stat_delta_2026_04_16
  partition of fact.pg_index_stat_delta
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists fact.pg_cluster_delta_2026_04_16
  partition of fact.pg_cluster_delta
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists fact.pg_io_stat_delta_2026_04_16
  partition of fact.pg_io_stat_delta
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists fact.pg_lock_snapshot_2026_04_16
  partition of fact.pg_lock_snapshot
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists fact.pg_progress_snapshot_2026_04_16
  partition of fact.pg_progress_snapshot
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists fact.pg_activity_snapshot_2026_04_16
  partition of fact.pg_activity_snapshot
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists fact.pg_replication_snapshot_2026_04_16
  partition of fact.pg_replication_snapshot
  for values from ('2026-04-16 00:00:00+00') to ('2026-04-17 00:00:00+00');

create table if not exists agg.pgss_hourly_2026_04
  partition of agg.pgss_hourly
  for values from ('2026-04-01 00:00:00+00') to ('2026-05-01 00:00:00+00');

create table if not exists agg.pgss_daily_2026
  partition of agg.pgss_daily
  for values from ('2026-01-01') to ('2027-01-01');
```

### 7. Collector Tarafindan Kullanilacak Ornek SQL

#### Yeni host inventory ekleme

```sql
with schedule_profile as (
  select schedule_profile_id
  from control.schedule_profile
  where profile_code = 'default'
),
retention_policy as (
  select retention_policy_id
  from control.retention_policy
  where policy_code = coalesce($10, 'r6')
    and is_active
)
insert into control.instance_inventory (
  instance_id,
  display_name,
  environment,
  service_group,
  host,
  port,
  admin_dbname,
  secret_ref,
  ssl_mode,
  schedule_profile_id,
  retention_policy_id,
  collector_group
)
select
  $1,
  $2,
  $3,
  $4,
  $5,
  $6,
  coalesce($7, 'postgres'),
  $8,
  coalesce($9, 'prefer'),
  schedule_profile.schedule_profile_id,
  retention_policy.retention_policy_id,
  $11
from schedule_profile
cross join retention_policy
on conflict (instance_id) do update
set display_name = excluded.display_name,
    environment = excluded.environment,
    service_group = excluded.service_group,
    host = excluded.host,
    port = excluded.port,
    admin_dbname = excluded.admin_dbname,
    secret_ref = excluded.secret_ref,
    ssl_mode = excluded.ssl_mode,
    schedule_profile_id = excluded.schedule_profile_id,
    retention_policy_id = excluded.retention_policy_id,
    collector_group = excluded.collector_group,
    updated_at = now()
returning instance_pk;
```

#### Bootstrap bekleyen host secme (bootstrap queue)

`pending`, `discovering`, `baselining`, `enriching` durumundaki instance'lar normal scheduler sorgusuyla degil, ayri bir bootstrap queue sorgusuyla secilir. Bu instance'larin `instance_state` satiri henuz olmayabilir.

```sql
select
  i.instance_pk,
  i.instance_id,
  i.host,
  i.port,
  i.admin_dbname,
  i.secret_ref,
  i.ssl_mode,
  i.bootstrap_state,
  p.connect_timeout_seconds,
  p.statement_timeout_ms,
  p.lock_timeout_ms,
  p.bootstrap_sql_text_batch
from control.instance_inventory i
join control.schedule_profile p on p.schedule_profile_id = i.schedule_profile_id
where i.is_active
  and i.bootstrap_state in ('pending', 'discovering', 'baselining', 'enriching')
order by i.instance_pk
for update of i skip locked
limit $1;
```

#### Scheduler icin due host secme (steady state)

`ready` ve `degraded` durumundaki instance'lar bu sorguyla secilir. `degraded` instance'lar da dahil edilir; desteklenen metrikler toplanmaya devam eder.

```sql
select
  i.instance_pk,
  i.instance_id,
  i.host,
  i.port,
  i.admin_dbname,
  i.secret_ref,
  i.ssl_mode,
  i.bootstrap_state,
  s.next_cluster_collect_at,
  s.next_statements_collect_at,
  p.cluster_interval_seconds,
  p.statements_interval_seconds,
  p.bootstrap_sql_text_batch,
  p.statement_timeout_ms,
  p.lock_timeout_ms,
  p.connect_timeout_seconds
from control.instance_inventory i
join control.instance_state s on s.instance_pk = i.instance_pk
join control.schedule_profile p on p.schedule_profile_id = i.schedule_profile_id
where i.is_active
  and i.bootstrap_state in ('ready', 'degraded')
  and (s.backoff_until is null or s.backoff_until <= now())
  and (
    coalesce(s.next_cluster_collect_at, '-infinity'::timestamptz) <= now()
    or coalesce(s.next_statements_collect_at, '-infinity'::timestamptz) <= now()
  )
order by least(
  coalesce(s.next_cluster_collect_at, '-infinity'::timestamptz),
  coalesce(s.next_statements_collect_at, '-infinity'::timestamptz)
)
for update of s skip locked
limit $1;
```

#### `db_objects` job'i icin due database secme

```sql
select
  i.instance_pk,
  i.instance_id,
  i.host,
  i.port,
  ds.dbid,
  r.datname,
  i.secret_ref,
  i.ssl_mode,
  ds.next_db_objects_collect_at,
  p.db_objects_interval_seconds,
  p.max_databases_per_run,
  p.statement_timeout_ms,
  p.lock_timeout_ms,
  p.connect_timeout_seconds
from control.database_state ds
join control.instance_inventory i on i.instance_pk = ds.instance_pk
join control.schedule_profile p on p.schedule_profile_id = i.schedule_profile_id
join dim.database_ref r on r.instance_pk = ds.instance_pk and r.dbid = ds.dbid
where i.is_active
  and (ds.backoff_until is null or ds.backoff_until <= now())
  and coalesce(ds.next_db_objects_collect_at, '-infinity'::timestamptz) <= now()
order by
  coalesce(ds.next_db_objects_collect_at, '-infinity'::timestamptz),
  i.instance_pk,
  r.datname
for update of ds skip locked
limit $1;
```

#### `control.instance_capability` upsert (discovery sonrasi)

```sql
insert into control.instance_capability (
  instance_pk,
  server_version_num,
  pg_major,
  collector_sql_family,
  is_reachable,
  is_primary,
  has_pg_stat_statements,
  has_pg_stat_statements_info,
  has_pg_stat_io,
  has_pg_stat_checkpointer,
  compute_query_id_mode,
  last_discovered_at
)
values ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, now())
on conflict (instance_pk) do update
set server_version_num        = excluded.server_version_num,
    pg_major                  = excluded.pg_major,
    collector_sql_family      = excluded.collector_sql_family,
    is_reachable              = true,
    is_primary                = excluded.is_primary,
    has_pg_stat_statements    = excluded.has_pg_stat_statements,
    has_pg_stat_statements_info = excluded.has_pg_stat_statements_info,
    has_pg_stat_io            = excluded.has_pg_stat_io,
    has_pg_stat_checkpointer  = excluded.has_pg_stat_checkpointer,
    compute_query_id_mode     = excluded.compute_query_id_mode,
    last_discovered_at        = now();
-- Baglanti hatasi durumunda yalnizca is_reachable guncellenir:
-- UPDATE control.instance_capability SET is_reachable = false WHERE instance_pk = $1;
```

#### `control.database_state` upsert (discover_databases adimi)

```sql
insert into control.database_state (instance_pk, dbid)
values ($1, $2)
on conflict (instance_pk, dbid) do nothing;
-- Yeni database goruldugunde satir olusur; sonraki db_objects cycle'i
-- next_db_objects_collect_at = NULL oldugu icin bu satiri hemen seccektir.
```

#### `dim.database_ref` upsert

```sql
insert into dim.database_ref (instance_pk, dbid, datname, is_template)
values ($1, $2, $3, $4)
on conflict (instance_pk, dbid) do update
set datname     = excluded.datname,
    last_seen_at = now();
```

#### `dim.relation_ref` upsert

```sql
insert into dim.relation_ref (instance_pk, dbid, relid, schemaname, relname, relkind)
values ($1, $2, $3, $4, $5, $6)
on conflict (instance_pk, dbid, relid) do update
set schemaname  = excluded.schemaname,
    relname     = excluded.relname,
    last_seen_at = now();
```

#### `dim.role_ref` upsert

```sql
insert into dim.role_ref (instance_pk, userid, rolname)
values ($1, $2, $3)
on conflict (instance_pk, userid) do update
set rolname     = excluded.rolname,
    last_seen_at = now();
```

#### `dim.query_text` upsert

```sql
insert into dim.query_text (
  query_hash,
  query_text,
  first_seen_instance_pk,
  source_pg_major
)
values ($1, $2, $3, $4)
on conflict (query_hash) do update
set last_seen_at = now()
returning query_text_id;
```

#### `ops.alert` upsert

```sql
insert into ops.alert (
  alert_key,
  alert_code,
  severity,
  status,
  source_component,
  instance_pk,
  service_group,
  system_identifier,
  first_seen_at,
  last_seen_at,
  occurrence_count,
  title,
  message,
  details_json
)
values (
  $1, $2, $3, 'open', $4, $5, $6, $7, now(), now(), 1, $8, $9, $10
)
on conflict (alert_key) do update
set severity = excluded.severity,
    status = case
      when ops.alert.status = 'resolved' then 'open'
      else ops.alert.status
    end,
    instance_pk = coalesce(excluded.instance_pk, ops.alert.instance_pk),
    service_group = coalesce(excluded.service_group, ops.alert.service_group),
    system_identifier = coalesce(excluded.system_identifier, ops.alert.system_identifier),
    last_seen_at = now(),
    title = excluded.title,
    message = excluded.message,
    details_json = excluded.details_json,
    occurrence_count = ops.alert.occurrence_count + 1,
    resolved_at = null
returning alert_id;
```

#### `ops.alert` resolve

```sql
update ops.alert
set status = 'resolved',
    resolved_at = now(),
    last_seen_at = now()
where alert_key = $1
  and status <> 'resolved';
```

#### `ops.job_run` baslangic ve bitis

```sql
-- Job run baslarken INSERT (status = 'running')
insert into ops.job_run (job_type, started_at, status, worker_hostname)
values ($1, now(), 'running', $2)
returning job_run_id;

-- Job run bitince UPDATE
update ops.job_run
set finished_at        = now(),
    status             = $2,   -- 'success' | 'failed' | 'partial'
    rows_written       = $3,
    instances_succeeded = $4,
    instances_failed   = $5,
    error_text         = $6
where job_run_id = $1;
```

#### `ops.job_run_instance` baslangic ve bitis

```sql
-- Instance bazli run baslarken INSERT
insert into ops.job_run_instance (
  job_run_id, instance_pk, job_type, started_at, status
)
values ($1, $2, $3, now(), 'running')
returning job_run_instance_id;

-- Instance tamamlaninca UPDATE
update ops.job_run_instance
set finished_at         = now(),
    status              = $2,   -- 'success' | 'failed' | 'partial' | 'skipped'
    rows_written        = $3,
    new_series_count    = $4,
    new_query_text_count = $5,
    error_text          = $6
where job_run_instance_id = $1;
```

#### Instance bazli retention tier bilgisini okuma

```sql
select
  i.instance_pk,
  i.instance_id,
  p.retention_policy_id,
  p.policy_code,
  p.raw_retention_months,
  p.hourly_retention_months,
  p.daily_retention_months,
  p.purge_enabled
from control.instance_inventory i
join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
where i.is_active
  and p.is_active;
```

#### Instance bazli raw retention cutoff ay basini hesaplama

```sql
select
  i.instance_pk,
  i.instance_id,
  p.policy_code,
  date_trunc('month', now()) - make_interval(months => p.raw_retention_months - 1) as keep_from_month
from control.instance_inventory i
join control.retention_policy p on p.retention_policy_id = i.retention_policy_id
where i.is_active
  and p.is_active
  and p.purge_enabled;
```

#### Global hard drop cutoff ay basini hesaplama

```sql
select
  date_trunc('month', now()) - make_interval(months => max(p.raw_retention_months) - 1) as hard_drop_before_month
from control.retention_policy p
where p.is_active
  and p.purge_enabled;
```

#### `dim.statement_series` upsert

```sql
insert into dim.statement_series (
  instance_pk,
  pg_major,
  collector_sql_family,
  system_identifier,
  pgss_epoch_key,
  dbid,
  userid,
  toplevel,
  queryid,
  query_text_id
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
on conflict (
  instance_pk,
  system_identifier,
  pg_major,
  pgss_epoch_key,
  dbid,
  userid,
  (coalesce(toplevel::text, 'unknown')),
  queryid
)
do update
set query_text_id = coalesce(dim.statement_series.query_text_id, excluded.query_text_id),
    last_seen_at = now()
returning statement_series_id;
```

#### `cluster` job adim sirasi

```
1.  pg_is_in_recovery() sorgula → is_primary belirle; control.instance_capability.is_primary guncelle
2.  pg_stat_bgwriter / pg_stat_wal / pg_stat_checkpointer oku → delta hesapla → fact.pg_cluster_delta INSERT
3.  pg_stat_io oku (PG16+, has_pg_stat_io = true) → satir bazinda delta hesapla → fact.pg_io_stat_delta INSERT
4.  pg_stat_activity oku → query 1000 karaktere kisalt → fact.pg_activity_snapshot INSERT (tum session'lar)
5.  is_primary = true ise: pg_stat_replication oku → replay_lag_bytes hesapla → fact.pg_replication_snapshot INSERT
    is_primary = false ise: pg_replication_snapshot adimi atlanir
6.  Replay lag esigi asildiysa (varsayilan: replay_lag > interval '5 minutes'): ops.alert upsert (replication_lag)
7.  pg_locks + pg_stat_activity join → granted = false olan bekleyen lock'lari tespit et → fact.pg_lock_snapshot INSERT
    Uzun sureli lock bekleme tespit edilirse (varsayilan: waitstart < now() - interval '5 minutes'): ops.alert upsert (lock_contention)
8.  pg_stat_progress_* view'lari oku (aktif operasyon varsa) → fact.pg_progress_snapshot INSERT
    Surum uyumlulugu: vacuum PG9.6+, analyze PG13+, create_index PG12+, cluster PG12+, basebackup PG13+, copy PG14+
9.  control.instance_state.last_cluster_collect_at guncelle
10. ops.job_run_instance UPDATE
```

#### `fact.pg_activity_snapshot` insert

```sql
insert into fact.pg_activity_snapshot (
  snapshot_ts,
  instance_pk,
  pid,
  datname,
  usename,
  application_name,
  client_addr,
  backend_start,
  xact_start,
  query_start,
  state_change,
  state,
  wait_event_type,
  wait_event,
  query,
  backend_type
)
select
  now(),
  $1,
  pid,
  datname,
  usename,
  application_name,
  client_addr,
  backend_start,
  xact_start,
  query_start,
  state_change,
  state,
  wait_event_type,
  wait_event,
  left(query, 1000),
  backend_type
from pg_stat_activity
where pid <> pg_backend_pid();
```

Not: `pid <> pg_backend_pid()` ile collector'in kendi session'i dislanir. `query` kolonu 1000 karaktere kisaltilir; tam metin gerekirse `pg_stat_statements`'tan alinir.

#### `fact.pg_replication_snapshot` insert

```sql
insert into fact.pg_replication_snapshot (
  snapshot_ts,
  instance_pk,
  pid,
  usename,
  application_name,
  client_addr,
  state,
  sent_lsn,
  write_lsn,
  flush_lsn,
  replay_lsn,
  write_lag,
  flush_lag,
  replay_lag,
  sync_state,
  replay_lag_bytes
)
select
  now(),
  $1,
  pid,
  usename,
  application_name,
  client_addr,
  state,
  sent_lsn,
  write_lsn,
  flush_lsn,
  replay_lsn,
  write_lag,
  flush_lag,
  replay_lag,
  sync_state,
  sent_lsn - replay_lsn
from pg_stat_replication;
```

Not: Bu INSERT yalnizca `pg_is_in_recovery() = false` (primary node) oldugunda calistirilir. Replica node'larda `pg_stat_replication` bos donecektir; sorgu calistirilmaz.

#### `fact.pg_lock_snapshot` insert

```sql
insert into fact.pg_lock_snapshot (
  snapshot_ts,
  instance_pk,
  pid,
  locktype,
  database_oid,
  relation_oid,
  mode,
  granted,
  waitstart,
  blocked_by_pids
)
select
  now(),
  $1,
  l.pid,
  l.locktype,
  l.database,
  l.relation,
  l.mode,
  l.granted,
  l.waitstart,                    -- PG14+; eski surumlerde NULL
  array(
    select distinct bl.pid
    from pg_locks bl
    where bl.granted
      and bl.locktype = l.locktype
      and bl.database is not distinct from l.database
      and bl.relation is not distinct from l.relation
      and bl.mode != l.mode       -- conflicting mode
      and bl.pid != l.pid
  )
from pg_locks l
join pg_stat_activity a on a.pid = l.pid
where l.granted = false;
```

Not: Yalnizca `granted = false` (bekleyen) lock'lar yazilir. `blocked_by_pids` alt sorgu ile ayni kaynak uzerinde conflicting mode'da lock tutan PID'ler hesaplanir. `waitstart` kolonu PG14+ icin gecerlidir; PG11-13'te `NULL` yazilir.

#### `fact.pg_progress_snapshot` insert

```sql
insert into fact.pg_progress_snapshot (
  snapshot_ts,
  instance_pk,
  pid,
  command,
  datname,
  relname,
  phase,
  blocks_total,
  blocks_done,
  tuples_total,
  tuples_done,
  progress_pct
)
-- VACUUM progress (PG9.6+)
select
  now(), $1, p.pid, 'VACUUM',
  d.datname,
  c.relname,
  p.param1_label,                 -- phase (collector tarafinda map edilir)
  p.param4,                       -- heap_blks_total
  p.param5,                       -- heap_blks_scanned
  null,                           -- tuples_total (VACUUM icin yok)
  p.param6,                       -- heap_blks_vacuumed
  case when p.param4 > 0 then round(100.0 * p.param5 / p.param4, 2) else null end
from pg_stat_progress_vacuum p
left join pg_database d on d.oid = p.datid
left join pg_class c on c.oid = p.relid
union all
-- ANALYZE progress (PG13+)
select
  now(), $1, p.pid, 'ANALYZE',
  d.datname,
  c.relname,
  p.phase,
  p.sample_blks_total,
  p.sample_blks_scanned,
  p.ext_stats_total,
  p.ext_stats_computed,
  case when p.sample_blks_total > 0 then round(100.0 * p.sample_blks_scanned / p.sample_blks_total, 2) else null end
from pg_stat_progress_analyze p
left join pg_database d on d.oid = p.datid
left join pg_class c on c.oid = p.relid
union all
-- CREATE INDEX progress (PG12+)
select
  now(), $1, p.pid, 'CREATE INDEX',
  d.datname,
  c.relname,
  p.phase,
  p.blocks_total,
  p.blocks_done,
  p.tuples_total,
  p.tuples_done,
  case when p.blocks_total > 0 then round(100.0 * p.blocks_done / p.blocks_total, 2) else null end
from pg_stat_progress_create_index p
left join pg_database d on d.oid = p.datid
left join pg_class c on c.oid = p.relid;
```

Not: Collector, kaynak instance'in PG major versiyonuna gore uygun `pg_stat_progress_*` view'larini secici olarak sorgular. PG11 icin yalnizca `pg_stat_progress_vacuum` vardir. `phase` kolonu her komut icin farkli degerler alir (ornek: VACUUM icin `scanning heap`, `vacuuming indexes` vb.); collector ham string olarak yazar. `CLUSTER`, `REINDEX`, `BASEBACKUP`, `COPY` progress view'lari da ayni pattern ile sorgulanir; yukaridaki ornekte en yaygin uc komut gosterilmistir.

---

#### `statements` job adim sirasi

```
1. pg_stat_statements(false) ile sadece sayisal verileri oku (text yok, daha hafif)
2. Her satir icin dim.statement_series upsert → statement_series_id al
3. Delta hesapla (onceki snapshot ile karsilastir); epoch degistiyse baseline kaydet, delta yazma
4. fact.pgss_delta INSERT (delta > 0 olan satirlar)
5. query_text_id = NULL olan yeni seriler icin:
   a. pg_stat_statements(true) ile SQL text'i batch'ler halinde cek (bootstrap_sql_text_batch adedi)
   b. dim.query_text upsert → query_text_id al
   c. dim.statement_series.query_text_id guncelle
6. ops.job_run_instance UPDATE (rows_written, new_series_count, new_query_text_count)
```

`pg_stat_statements(false)`: text alani bos gelir, sadece sayisal kolonlar dolu — her toplama cikisinda kullanilir.
`pg_stat_statements(true)`: text alani dolu — yalnizca enrichment adiminda, sinirli batch boyutuyla kullanilir.

#### `fact.pgss_delta` insert

```sql
insert into fact.pgss_delta (
  sample_ts,
  instance_pk,
  statement_series_id,
  calls_delta,
  plans_delta,
  total_plan_time_ms_delta,
  total_exec_time_ms_delta,
  rows_delta,
  shared_blks_hit_delta,
  shared_blks_read_delta,
  shared_blks_dirtied_delta,
  shared_blks_written_delta,
  local_blks_hit_delta,
  local_blks_read_delta,
  local_blks_dirtied_delta,
  local_blks_written_delta,
  temp_blks_read_delta,
  temp_blks_written_delta,
  blk_read_time_ms_delta,
  blk_write_time_ms_delta,
  wal_records_delta,
  wal_fpi_delta,
  wal_bytes_delta,
  jit_generation_time_ms_delta,
  jit_inlining_time_ms_delta,
  jit_optimization_time_ms_delta,
  jit_emission_time_ms_delta
)
values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
  $11, $12, $13, $14, $15, $16, $17, $18,
  $19, $20, $21, $22, $23, $24, $25, $26, $27
)
on conflict do nothing;
```

#### `agg.pgss_hourly` insert (saatlik rollup)

```sql
-- Tamamlanan son saat bucket'ini hesapla
-- Collector bunu rollup job basinda belirler
insert into agg.pgss_hourly (
  bucket_start,
  instance_pk,
  statement_series_id,
  calls_sum,
  exec_time_ms_sum,
  rows_sum,
  shared_blks_read_sum,
  shared_blks_hit_sum,
  temp_blks_written_sum
)
select
  date_trunc('hour', sample_ts) as bucket_start,
  instance_pk,
  statement_series_id,
  sum(calls_delta)                as calls_sum,
  sum(total_exec_time_ms_delta)   as exec_time_ms_sum,
  sum(rows_delta)                 as rows_sum,
  sum(shared_blks_read_delta)     as shared_blks_read_sum,
  sum(shared_blks_hit_delta)      as shared_blks_hit_sum,
  sum(temp_blks_written_delta)    as temp_blks_written_sum
from fact.pgss_delta
where sample_ts >= date_trunc('hour', now() - interval '1 hour')
  and sample_ts <  date_trunc('hour', now())
group by date_trunc('hour', sample_ts), instance_pk, statement_series_id
on conflict (bucket_start, instance_pk, statement_series_id) do update
  set calls_sum             = excluded.calls_sum,
      exec_time_ms_sum      = excluded.exec_time_ms_sum,
      rows_sum              = excluded.rows_sum,
      shared_blks_read_sum  = excluded.shared_blks_read_sum,
      shared_blks_hit_sum   = excluded.shared_blks_hit_sum,
      temp_blks_written_sum = excluded.temp_blks_written_sum;
```

#### `fact.pg_cluster_delta` insert (cluster metrik ornegi)

```sql
-- Ornek: pg_stat_bgwriter ve pg_stat_wal icin delta yazma
-- Collector her metrik kolonu icin ayri satir uretir
insert into fact.pg_cluster_delta (
  sample_ts,
  instance_pk,
  metric_family,
  metric_name,
  metric_value_num
)
values
  ($1, $2, 'pg_stat_bgwriter', 'buffers_clean',     $3),
  ($1, $2, 'pg_stat_bgwriter', 'buffers_alloc',     $4),
  ($1, $2, 'pg_stat_bgwriter', 'maxwritten_clean',  $5),
  ($1, $2, 'pg_stat_wal',      'wal_records',       $6),
  ($1, $2, 'pg_stat_wal',      'wal_bytes',         $7)
on conflict do nothing;
```

#### `fact.pg_io_stat_delta` insert (kaynak: `pg_stat_io`, PG16+)

```sql
-- Collector pg_stat_io'dan tum satirlari okur, onceki sample ile karsilastirir,
-- her (backend_type, object, context) uclüsu icin delta hesaplar
insert into fact.pg_io_stat_delta (
  sample_ts,
  instance_pk,
  backend_type,
  object,
  context,
  reads_delta,
  read_time_ms_delta,
  writes_delta,
  write_time_ms_delta,
  extends_delta,
  extend_time_ms_delta,
  hits_delta,
  evictions_delta,
  reuses_delta,
  fsyncs_delta,
  fsync_time_ms_delta
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
on conflict do nothing;
```

#### `fact.pg_database_delta` insert (kaynak: `pg_stat_database`)

```sql
-- Collector kaynak PG'de her database icin pg_stat_database'i okur,
-- onceki sample ile farkini hesaplar ve merkezi DB'ye yazar
insert into fact.pg_database_delta (
  sample_ts,
  instance_pk,
  dbid,
  datname,
  numbackends,
  xact_commit_delta,
  xact_rollback_delta,
  blks_read_delta,
  blks_hit_delta,
  tup_returned_delta,
  tup_fetched_delta,
  tup_inserted_delta,
  tup_updated_delta,
  tup_deleted_delta,
  conflicts_delta,
  temp_files_delta,
  temp_bytes_delta,
  deadlocks_delta,
  checksum_failures_delta,
  blk_read_time_ms_delta,
  blk_write_time_ms_delta,
  session_time_ms_delta,
  active_time_ms_delta,
  idle_in_transaction_time_ms_delta
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24)
on conflict do nothing;
```

#### `fact.pg_table_stat_delta` insert (kaynak: `pg_stat_user_tables`)

```sql
insert into fact.pg_table_stat_delta (
  sample_ts,
  instance_pk,
  dbid,
  relid,
  schemaname,
  relname,
  seq_scan_delta,
  seq_tup_read_delta,
  idx_scan_delta,
  idx_tup_fetch_delta,
  n_tup_ins_delta,
  n_tup_upd_delta,
  n_tup_del_delta,
  n_tup_hot_upd_delta,
  vacuum_count_delta,
  autovacuum_count_delta,
  analyze_count_delta,
  autoanalyze_count_delta,
  heap_blks_read_delta,
  heap_blks_hit_delta,
  idx_blks_read_delta,
  idx_blks_hit_delta,
  toast_blks_read_delta,
  toast_blks_hit_delta,
  tidx_blks_read_delta,
  tidx_blks_hit_delta,
  n_live_tup_estimate,
  n_dead_tup_estimate,
  n_mod_since_analyze
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29)
on conflict do nothing;
```

#### `fact.pg_index_stat_delta` insert (kaynak: `pg_stat_user_indexes`)

```sql
insert into fact.pg_index_stat_delta (
  sample_ts,
  instance_pk,
  dbid,
  table_relid,
  index_relid,
  schemaname,
  table_relname,
  index_relname,
  idx_scan_delta,
  idx_tup_read_delta,
  idx_tup_fetch_delta,
  idx_blks_read_delta,
  idx_blks_hit_delta
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
on conflict do nothing;
```

#### Basarili run sonrasi state guncelleme

```sql
update control.instance_state s
set last_cluster_collect_at = case when $2 then $1 else s.last_cluster_collect_at end,
    last_statements_collect_at = case when $3 then $1 else s.last_statements_collect_at end,
    next_cluster_collect_at = case when $2 then $1 + make_interval(secs => $4) else s.next_cluster_collect_at end,
    next_statements_collect_at = case when $3 then $1 + make_interval(secs => $5) else s.next_statements_collect_at end,
    bootstrap_completed_at = case
      when $6 and s.bootstrap_completed_at is null then $1
      else s.bootstrap_completed_at
    end,
    current_pgss_epoch_key = coalesce($7, s.current_pgss_epoch_key),
    consecutive_failures = 0,
    backoff_until = null,
    last_success_at = $1
where s.instance_pk = $8;
```

#### Hata sonrasi backoff guncelleme

```sql
update control.instance_state s
set consecutive_failures = s.consecutive_failures + 1,
    backoff_until = now() + make_interval(secs => least(900, greatest(30, (2 ^ least(s.consecutive_failures, 9))::integer))),
    next_cluster_collect_at = greatest(coalesce(s.next_cluster_collect_at, now()), now()),
    next_statements_collect_at = greatest(coalesce(s.next_statements_collect_at, now()), now())
where s.instance_pk = $1;
```

#### Rollup job tamamlaninca `last_rollup_at` guncelleme

`last_rollup_at` instance bazinda degil global bir deger olarak izlenir; rollup job sistemi tum instance'lari kapsamaktadir. Her instance'in `instance_state` satirinda tutulur; rollup job her basarili run sonunda tum aktif instance'lar icin toplu gunceller:

```sql
update control.instance_state
set last_rollup_at = now()
where instance_pk in (
  select instance_pk from control.instance_inventory
  where is_active
);
```

Rollup job kismen basarisiz olursa (orn. partition olusturulamazsa) `last_rollup_at` guncellenmez; bir sonraki basarili run'a kadar eski deger kalir. UI'da "Son rollup" gostergesi bu alana bakar.

## Guvenlik Kurallari

- Her kaynak PostgreSQL icin ayri collector kullanicisi olusturulur.
- Kullaniciya en az yetki verilir.
- Sifreler service unit icine veya kod icine plain text olarak yazilmaz.
- Secret'lar dosya izinleri kisitli bir config, secret manager veya environment tabanli guvenli kaynakta tutulur.

### Merkezi Veritabani Collector Izinleri

Collector, merkezi PostgreSQL'de ayri bir rol (`pgstats_collector`) ile calisir. Bu role verilmesi gereken minimum yetkiler:

```sql
-- Rol olustur
create role pgstats_collector login;

-- Schema erisimi
grant usage on schema control, dim, fact, agg, ops to pgstats_collector;

-- control: okuma + yazma (inventory okuma, state guncelleme)
grant select, update on all tables in schema control to pgstats_collector;
grant usage, select on all sequences in schema control to pgstats_collector;

-- dim: okuma + yazma (dimension upsert)
grant select, insert, update on all tables in schema dim to pgstats_collector;
grant usage, select on all sequences in schema dim to pgstats_collector;

-- fact: yazma (delta insert)
grant insert on all tables in schema fact to pgstats_collector;

-- agg: okuma + yazma (rollup upsert)
grant select, insert, update on all tables in schema agg to pgstats_collector;

-- ops: okuma + yazma (job run ve alert yonetimi)
grant select, insert, update on all tables in schema ops to pgstats_collector;
grant usage, select on all sequences in schema ops to pgstats_collector;

-- Gelecekte olusacak tablolar icin default privileges
alter default privileges in schema fact    grant insert            on tables to pgstats_collector;
alter default privileges in schema agg     grant select, insert, update on tables to pgstats_collector;
alter default privileges in schema dim     grant select, insert, update on tables to pgstats_collector;
alter default privileges in schema ops     grant select, insert, update on tables to pgstats_collector;
alter default privileges in schema control grant select, update          on tables to pgstats_collector;
```

`pg_try_advisory_lock` icin ek yetki gerekmez; bu fonksiyon tum kullanicilara varsayilan olarak aciktir.

### `secret_ref` Format ve Cozum Mekanizmasi

`control.instance_inventory.secret_ref` kolonu bir credential referansidir; gercek sifreyi degil, sifreye ulasma anahtarini icerir.

Desteklenen format ornekleri:

- `file:/etc/pgstats/secrets/prod-db1.pwd` — collector bu dosyayi okur; dosya izni `600`, sahibi collector service user olmalidir.
- `env:PGSTATS_PROD_DB1_PASSWORD` — collector bu environment variable'i okur; systemd service unit'inde `EnvironmentFile` ile set edilir.
- `vault:secret/pgstats/prod-db1` — HashiCorp Vault path; collector, Vault agent veya AppRole auth ile token alir ve bu path'ten okur.

Kurallar:

- `secret_ref` prefix `:` formatini izler; collector prefix'e gore dogru backend'i cagirir.
- Desteklenmeyen prefix goruldugunde collector o instance'i `degraded` olarak isaretler ve ops.alert'e error yazar.
- Secret rotation durumunda yalnizca `secret_ref`'in gosterdigi kaynak guncellenir; `instance_inventory` satiri degismez.
- V1'de `file:` ve `env:` format zorunlu desteklenir; `vault:` opsiyonel olarak eklenir.
- Kaynak PostgreSQL erisimi collector makinesinin IP'leriyle sinirlandirilir.
- Mumkunse TLS zorunlu hale getirilir.
- Tum baglantilarda `application_name` ile izlenebilirlik saglanir.

## Performans ve Yuk Sinirlari

Baslangic icin onerilen sinirlar:

- Her kaynak instance icin ayni anda maksimum `1` collector oturumu
- Global worker sayisi: `5` ile `10` arasi
- `statement_timeout`: `3s` ile `5s`
- `lock_timeout`: `100ms` ile `250ms`
- `connect_timeout`: ortama uygun konservatif bir deger

Ek kurallar:

- Kaynak instance gec cevap verirse o cycle atlanir.
- Bir host'ta ardisik hata aliniyorsa exponential backoff benzeri bir kontrol eklenir.
- Fail eden host'lar tum sistemin calismasini durdurmaz.

## Surum Profilleri

Collector SQL'leri PostgreSQL major version'a gore secilir.

Baslangic profilleri ve hangi major version'lari karsiladiklarini gosteren tablo:

| `collector_sql_family` | Karsilanan PG Versiyonlari |
|---|---|
| `pg11_12` | 11, 12 |
| `pg13` | 13 |
| `pg14_16` | 14, 15, 16 |
| `pg17_18` | 17, 18 |

Bu deger, `control.instance_capability.collector_sql_family` ve `dim.statement_series.collector_sql_family` kolonlarina yazilir. Collector, `server_version_num` bilgisinden major version'u hesaplayarak yukardaki tabloya gore `collector_sql_family` degerini atar.

**Atama zamani:** `collector_sql_family`, bootstrap'in `discovering` adiminda `server_version_num` sorgulandiktan hemen sonra belirlenir ve `control.instance_capability`'ye yazilir. Ayni deger, o instance icin yapilan her `dim.statement_series` upsert'inde de tekrarlanir; boylece serinin hangi SQL family ile toplandigi tarihsel olarak izlenebilir.

Bu profillerin sebebi:

- `pg_stat_statements` kolonlari surume gore degisir.
- `compute_query_id` ve `toplevel` gibi alanlar tum surumlerde ayni degildir.
- `pg_stat_io` sadece yeni surumlerde vardir.
- `pg_stat_checkpointer` yeni surumlerde ayri view olarak gelir.

Merkezi schema ise sabit ve superset mantiginda kalir; kaynakta olmayan alanlar `NULL` olarak yazilir.

Unknown version davranisi:

- Collector yeni bir major version gordugunde `server_version_num` bilgisini capability tablosuna yazar.
- Eger birebir SQL family eslesmesi yoksa sistem tum toplama isini durdurmaz.
- Desteklenen generic metrikler toplanmaya devam eder.
- Desteklenmeyen view veya kolonlar `degraded` durumunda skip edilir.
- Ops tarafina acik bir uyari ve incompatibility log'u yazilir.
- Yeni SQL family eklenene kadar sistem "toplayabildigini toplar, toplayamadigini raporlar" prensibiyle calisir.

## Saklama ve Retention Yaklasimi

Disk ve yazma maliyetini dusurmek icin:

- Ham SQL text tekrar tekrar saklanmaz.
- Mumkun oldugunca delta saklanir.
- Ham delta veriler sinirli sure tutulur.
- Saatlik ve gunluk rollup tablolari olusturulur.
- Buyuk fact tablolari zaman bazli partition edilir.
- Her cluster bir retention tier'a baglanir.
- Retention tier degisikligi metadata seviyesinde hemen gecerli olur.
- Purge evaluator her gun calisir.
- Gunluk purge, gerekli ise merkezi DB'de instance bazli batched delete yapar; tamamen eskimis partisyonlari ise `drop partition` ile kaldirir.
- `fact.pg_table_stat_delta` ve `fact.pg_index_stat_delta` raw tier kapsamindadir; ayri object retention tanimi ilk fazda yoktur.
- `agg.pgss_hourly` icin `hourly_retention_months`, `agg.pgss_daily` icin `daily_retention_months` kuralı gecerlidir; purge evaluator bu tablolari da gunluk olarak kontrol eder.
- `dim` tablolari retention tier ile aylik purge edilmez; orphan veya uzun sure guncellenmeyen dimension satirlari icin cleanup ihtiyaci ayrica operasyonel karar olarak ele alinabilir.

Retention degerleri operasyonel ihtiyaca gore tanimlanacak olsa da genel hedef:

- Kisa sureli detayli veri
- Orta ve uzun sureli ozet veri

## HA ve Replica Topolojisi

Bu bolum yuksek erisebilirlik (HA) ve primary/replica kurulumlarinda collector davranisini tanimlar.

### Hangi node izlenir?

- Varsayilan: collector yalnizca **primary** node'a baglanir.
- `pg_stat_statements` ve diger istatistik view'lari primary'de eksiksiz gelir; replica'da apply lag ve read-only sinirlamalar olabilir.
- Replica istatistigi gereken durumlar icin ayri `instance_id` ile replica'lar ayrica inventory'e eklenebilir; bu ihtiyarc ilk fazda kapsam disindadir.

### Floating IP / VIP senaryosu

- HA konfigurasyonlarinda genellikle primary'i gosteren tek bir floating IP veya VIP kullanilir.
- Bu durumda `control.instance_inventory.host` VIP olarak girilir; failover sonrasi yeni primary'e VIP tasinir ve collector otomatik olarak yeni primary'e baglanir.
- Failover sirasinda `system_identifier` degismez (ayni fiziksel cluster); dolayisiyla mevcut epoch ve seriler gecerli kalmaya devam eder.

### Failover sonrasi `system_identifier` degisimi (promote + new cluster)

- Bazi HA senaryolarinda (ornegin yeni sunucuya promote veya pg_basebackup ile yeniden kurulum) `system_identifier` degisebilir.
- Collector bu durumu `control.instance_capability.system_identifier` guncellemesi ile tespit eder.
- Yeni `system_identifier` goruldugunde yeni epoch acilir; eski seriler tarihsel olarak korunur.

### `(host, port, admin_dbname)` unique constraint sinirliligI

- Bu unique constraint ayni host:port uzerinde birden fazla PostgreSQL cluster calistirma senaryosunu (ornegin farkli versiyon veya container port'lari) engeller.
- Farkli `admin_dbname` kullanilarak bu constraint asililamaz; port farki ile ayirt edilmeli veya farkli hostname/IP kullanilmalidir.
- Bilerek kabul edilen sinirlilik: bu tasarim tek bir (host, port) ciftinin tek bir PostgreSQL cluster'a isaret ettigini varsayar.

## Operasyonel Hedefler

Sistemin saglamasi beklenen operasyonel ozellikler:

- Bir host'un hatasi diger host'lari etkilemez.
- Upgrade sonrasi veri surekliligi korunur.
- Yeni host ekleme tek kayitla yapilir.
- Scheduler mantigi merkezi olarak yonetilir.
- Kaynak host'larda gozle gorulur ek yuk olusturulmaz.
- Merkezi raporlama icin tutarli ve normalize veri saglanir.

## Ilk Uygulama Kararlari

Bu dokumana gore ilk implementasyon asamasinda su kararlar sabittir:

- Scheduler olarak `systemd timer + oneshot service` kullanilacak.
- Is mantigi bash script daginikligi yerine tek bir collector uygulamasinda olacak.
- Collector stateless CLI mantiginda gelistirilecek.
- SQL text ayri dimension tabloda tekillestirilecek.
- Database-local tablo ve index istatistikleri ilk fazda ayri `db_objects` job'i ile toplanacak.
- `queryid` global identity olarak kullanilmayacak.
- Upgrade continuity `instance_id` ve statement series mantigiyla korunacak.
- Version farklari collector tarafinda SQL profil mantigiyla handle edilecek.

## Uygulama Asamasi Operasyonel Kararlar

Asagidaki basliklar mimari eksikligi degil, implementasyon asamasinda secilecek operasyonel detaylardir:

- Batch yazma stratejisinin kesin formu
- Local spool veya retry queue ihtiyaci
- Rollup tablolarinin detay yapisi
- Hata loglama ve gozlemlenebilirlik modelinin UI ve log entegrasyon detaylari
- Secret yonetim yonteminin hangi urun veya altyapiyla saglanacagi

## UI Tasarimi

Bu bolum, collector uygulamasinin web arayuzunun hangi ekranlardan olustugunu, her ekranin ne gosterdigi ve hangi tablolardan beslendigi tanimlar. Teknoloji secimi (React, Vue, vb.) bu belgede kapsam disindadir; ekran ve veri modeli sabittir.

### Genel Prensipler

- UI yalnizca **okuma ve konfigurasyon** amaclidir; collector is mantigina mudahale etmez.
- Tum veri merkezi PostgreSQL'deki `control`, `ops` ve `dim` tablolarindan okunur.
- Yazan islemler (host ekleme, retention guncelleme) yalnizca `control` schema'sindaki tablolara yapilir.
- UI, `systemd journal` veya collector process'ini dogrudan yonetmez.
- Her ekran icin veri kaynagi tablolari asagida belirtilmistir.

---

### Ekran 1 — Dashboard (Ana Sayfa)

**Amac:** Sistemin genel saglik durumunu tek bakista gostermek.

**Gosterilen bilgiler:**

- Toplam aktif instance sayisi / pasif instance sayisi
- Bootstrap durumuna gore dagilim: `ready`, `degraded`, `pending`, `discovering`
- Acik alert sayisi severity bazinda: `critical`, `error`, `warning`, `info`
- Son `24` saatte basarili / basarisiz job run sayisi
- Son `5` job run'in ozeti (job_type, status, started_at, sure)
- Son `1` saatte veri gelen ve gelmeyen instance sayisi

**Veri kaynaklari:**

- `control.instance_inventory` — aktif/pasif sayilari, bootstrap_state dagilimi
- `control.instance_state` — last_success_at, backoff_until
- `ops.alert` — `status in ('open','acknowledged')` filtresiyle severity dagilimi
- `ops.job_run` — son job run ozeti

---

### Ekran 2 — Instance Listesi

**Amac:** Tum izlenen PostgreSQL instance'larini listelemek, yeni host eklemek, mevcut host'u duzenlmek veya pasife almak.

**Tablo kolonlari:**

| Kolon | Kaynak |
|---|---|
| Display Name | `instance_inventory.display_name` |
| Host:Port | `instance_inventory.host`, `port` |
| Environment | `instance_inventory.environment` |
| Service Group | `instance_inventory.service_group` |
| PG Version | `instance_capability.pg_major` |
| Bootstrap Durumu | `instance_inventory.bootstrap_state` |
| Son Basarili Toplama | `instance_state.last_success_at` |
| Aktif Alert | `ops.alert` sayisi |
| Durum (Aktif/Pasif) | `instance_inventory.is_active` |

**Filtreler:** environment, service_group, bootstrap_state, is_active, collector_group

**Aksiyonlar:**

- `+ Host Ekle` — Ekran 3'e gider
- Satira tikla — Ekran 4'e gider (instance detay)
- `Pasife Al` / `Aktive Et` — `instance_inventory.is_active` guncellenir
- `Duzenle` — Ekran 3'u duzenleme moduyla acar

**Veri kaynaklari:** `control.instance_inventory`, `control.instance_capability`, `control.instance_state`, `ops.alert`

---

### Ekran 3 — Host Ekleme / Duzenleme Formu

**Amac:** Yeni bir PostgreSQL instance'i inventory'e eklemek veya mevcut instance'i guncellemek.

**Form alanlari:**

| Alan | Zorunlu | Aciklama |
|---|---|---|
| Instance ID | Evet | Degismez tekil kimlik; duzenleme modunda readonly |
| Display Name | Evet | Insan okunur isim |
| Host | Evet | IP veya hostname |
| Port | Evet | Varsayilan 5432 |
| Admin Database | Evet | Varsayilan `postgres` |
| Secret Ref | Evet | `file:`, `env:` veya `vault:` prefix ile |
| SSL Mode | Evet | Dropdown: disable / allow / prefer / require / verify-ca / verify-full |
| SSL Root Cert Path | Hayir | `ssl_root_cert_path`; verify-ca / verify-full secildiginde zorunlu hale gelir |
| Environment | Hayir | Serbest metin (prod, staging, dev) |
| Service Group | Hayir | Ayni uygulamanin node'larini gruplamak icin |
| Schedule Profili | Evet | `control.schedule_profile` listesinden secim |
| Retention Politikasi | Evet | `control.retention_policy` listesinden secim |
| Collector Group | Hayir | Birden fazla collector makinesinde is bolumu icin |
| Notlar | Hayir | Serbest metin |

**Kaydet sonrasi:** `control.instance_inventory`'ye INSERT veya UPDATE yapilir; `bootstrap_state = 'pending'` ile baslar. Collector bir sonraki calismasinda discovery yapar.

**Validasyon (UI tarafinda):**

- `display_name`, `host`, `admin_dbname` bos birakilamaz
- `secret_ref` bos birakilamaz; `file:`, `env:` veya `vault:` prefix'lerinden biriyle baslamali
- `port` 1–65535 arasi olmali
- `ssl_mode` listede tanimli alti degerden biri olmali; `verify-ca` veya `verify-full` secilirse `ssl_root_cert_path` zorunlu
- Duzenleme modunda `instance_id` degistirilemez
- `instance_id` ve `(host, port, admin_dbname)` ciftleri benzersiz olmali; unique constraint ihlali kullaniciya acik hata mesajiyla bildirilir

---

### Ekran 4 — Instance Detay

**Amac:** Tek bir instance'in tum toplama durumunu, capability bilgilerini, database listesini ve hatalarini gostermek.

**Ust panel — Genel Bilgiler:**

- display_name, instance_id, host:port, environment, service_group
- PG version (`server_version_num`), `pg_major`
- `system_identifier`
- `bootstrap_state` badge
- `is_reachable` durumu
- `collector_sql_family`
- Son discovery zamani (`last_discovered_at`)

**Capability Paneli:**

| Ozellik | Deger |
|---|---|
| pg_stat_statements | Var / Yok |
| pg_stat_statements_info | Var / Yok |
| pg_stat_io | Var / Yok |
| pg_stat_checkpointer | Var / Yok |
| compute_query_id modu | off / on / auto / external |

**Toplama Durumu Paneli:**

- Son cluster toplama: `last_cluster_collect_at` / Sonraki: `next_cluster_collect_at`
- Son statements toplama: `last_statements_collect_at` / Sonraki: `next_statements_collect_at`
- Son rollup: `last_rollup_at`
- Ardisik hata sayisi: `consecutive_failures`
- Backoff bitis: `backoff_until`

**Database Listesi:**

Her database icin:
- `datname`, `dbid`
- Son db_objects toplama: `last_db_objects_collect_at`
- Sonraki: `next_db_objects_collect_at`
- Ardisik hata: `consecutive_failures`

**Aktif Alertler:** Bu instance'a ait `status in ('open','acknowledged')` alertler.

**Son Job Run'lar:** Bu instance'a ait son `20` `ops.job_run_instance` satiri.

**Veri kaynaklari:** `control.instance_inventory`, `control.instance_capability`, `control.instance_state`, `dim.database_ref`, `control.database_state`, `ops.alert`, `ops.job_run_instance`

---

### Ekran 5 — Alert Listesi

**Amac:** Tum sistemdeki aktif ve gecmis alertleri gostermek, acknowledge etmek.

**Sekmeler:**

- **Aktif** — `status in ('open', 'acknowledged') and resolved_at is null`
- **Cozulmus** — `status = 'resolved'`, son `90` gun

**Tablo kolonlari:**

| Kolon | Kaynak |
|---|---|
| Severity | `ops.alert.severity` (badge: critical=kirmizi, error=turuncu, warning=sari, info=mavi) |
| Alert Kodu | `alert_code` |
| Instance | `instance_inventory.display_name` (instance_pk ile join) |
| Mesaj | `ops.alert.message` |
| Ilk Gorulme | `first_seen_at` |
| Son Gorulme | `last_seen_at` |
| Tekrar Sayisi | `occurrence_count` |
| Durum | `status` |

**Aksiyonlar:**

- `Acknowledge` — `status = 'acknowledged'`, `acknowledged_at = now()` yazar
- Satira tikla — detayda `details_json` gosterilir

**Filtreler:** severity, instance, service_group, alert_code, status

**Son Guncelleme Gostergesi:** Ekranin sag ust kosesinde "Son guncelleme: X dk once" zaman damgasi gosterilir. Bu deger, API/veritabani sorgusunun tamamlandigi `Date.now()` anindan hesaplanir; sayfanin ne zaman son yenilendigini kullaniciya bildirir. Kullanici baska bir ekrana gidip geri dondugunde (`goto()` cagrildiginda) sayac sifirlanir ve badge yeniden "az once" olarak gosterilir.

**Veri kaynaklari:** `ops.alert`, `control.instance_inventory`

---

### Ekran 6 — Job Run Gecmisi

**Amac:** Collector job run'larinin gecmisini gostermek; hata ayiklamak icin kullanilir.

**Ust tablo — Job Run Ozeti:**

| Kolon | Kaynak |
|---|---|
| Job Tipi | `ops.job_run.job_type` |
| Baslangic | `started_at` |
| Sure | `finished_at - started_at` |
| Durum | `status` (success / failed / partial) |
| Yazilan Satir | `rows_written` |
| Basarili Instance | `instances_succeeded` |
| Basarisiz Instance | `instances_failed` |

**Detay paneli (satira tikladiginda):**

`ops.job_run_instance` satirlari: her instance icin ayri satir, status, rows_written, new_series_count, new_query_text_count, error_text.

**Filtreler:** job_type, status, tarih araligi

**Son Guncelleme Gostergesi:** Ekranin sag ust kosesinde "Son guncelleme: X dk once" zaman damgasi gosterilir. Bu deger, sorgu tamamlanma anindan hesaplanir; kullanicinin stale veri gorup gormedigi hakkinda bilgi verir. Kullanici baska bir ekrana gidip geri dondugunde (`goto()` cagrildiginda) sayac sifirlanir ve badge yeniden "az once" olarak gosterilir.

**Veri kaynaklari:** `ops.job_run`, `ops.job_run_instance`, `control.instance_inventory`

---

### Ekran 7 — Retention Politikalari

**Amac:** Retention tier'larini yonetmek; hangi instance'in hangi tier'a bagli oldugunu gormek.

**Politika Listesi:**

| Kolon | Kaynak |
|---|---|
| Politika Kodu | `retention_policy.policy_code` |
| Ham Veri Suresi | `raw_retention_months` ay |
| Saatlik Rollup Suresi | `hourly_retention_months` ay |
| Gunluk Rollup Suresi | `daily_retention_months` ay |
| Purge Aktif | `purge_enabled` |
| Bagli Instance Sayisi | `instance_inventory` COUNT |

**Aksiyonlar:**

- `+ Yeni Politika` — Yeni politika olusturma formunu acar (INSERT modu)
- `Duzenle` — Mevcut politikayı guncelleme formunu acar (UPDATE modu)
- `Sil` — Yalnizca `bagli_instance_sayisi = 0` olan satirlarda aktif; tiklandiginda onay dialog'u acar. Onaylanirsa `DELETE FROM control.retention_policy WHERE retention_policy_id = $1` calistirilir. Bagli instance varsa buton disabled olarak gosterilir ve uzerine gelindiginde "X instance bagli, once instance atamalarini degistirin" tooltipli gorulur.

**Olusturma / Duzenleme Formu:**

| Alan | Kural | INSERT | UPDATE |
|---|---|---|---|
| `policy_code` | Zorunlu; benzersiz olmali; sadece harf/rakam/tire | Duzenlenebilir | Readonly |
| `raw_retention_months` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `hourly_retention_months` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `daily_retention_months` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `purge_enabled` | Toggle | Duzenlenebilir | Duzenlenebilir |
| `is_active` | Toggle; pasife alininca purge durur | Duzenlenebilir | Duzenlenebilir |

**Kaydet sonrasi:**
- INSERT: `control.retention_policy`'ye yeni satir eklenir; `policy_code` unique constraint ihlali kullaniciya acik hata mesajiyla bildirilir.
- UPDATE: Mevcut satir guncellenir; `policy_code` degistirilemez.
- Her iki durumda da islem basarili oldugunda ekranin sag alt kosesinde **basari toast bildirimi** ("Politika kaydedildi.") 3 saniye gosterilir. Hata durumunda kirmizi toast ("Politika kaydedilemedi: {hata mesaji}") gosterilir ve modal kapanmaz.

**Instance Atama Gorunu:** Secili politikaya bagli instance'larin listesi; buradan `instance_inventory.retention_policy_id` guncellenebilir.

**Veri kaynaklari:** `control.retention_policy`, `control.instance_inventory`

---

### Ekran 8 — Schedule Profilleri

**Amac:** Toplama frekanslarini ve timeout degerlerini profil bazinda yonetmek.

**Profil Listesi:**

| Kolon | Kaynak |
|---|---|
| Profil Kodu | `schedule_profile.profile_code` |
| Aktif | `is_active` badge |
| Cluster Interval | `cluster_interval_seconds` sn |
| Statements Interval | `statements_interval_seconds` sn |
| DB Objects Interval | `db_objects_interval_seconds` sn |
| Saatlik Rollup | `hourly_rollup_interval_seconds` sn |
| Gunluk Rollup Saati | `daily_rollup_hour_utc` UTC |
| Bagli Instance | COUNT |

**Aksiyonlar:**

- `+ Yeni Profil` — Yeni profil olusturma formunu acar (INSERT modu)
- `Duzenle` — Mevcut profili guncelleme formunu acar (UPDATE modu)
- `Sil` — Yalnizca `bagli_instance_sayisi = 0` olan profillerde aktif; tiklandiginda onay dialog'u acar. Onaylanirsa `DELETE FROM control.schedule_profile WHERE schedule_profile_id = $1` calistirilir. Bagli instance varsa buton disabled olarak gosterilir.

**Olusturma / Duzenleme Formu:**

| Alan | Kural | INSERT | UPDATE |
|---|---|---|---|
| `profile_code` | Zorunlu; benzersiz olmali | Duzenlenebilir | Readonly |
| `cluster_interval_seconds` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `statements_interval_seconds` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `db_objects_interval_seconds` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `hourly_rollup_interval_seconds` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `daily_rollup_hour_utc` | 0–23 arasi tam sayi | Duzenlenebilir | Duzenlenebilir |
| `bootstrap_sql_text_batch` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `max_databases_per_run` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `statement_timeout_ms` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `lock_timeout_ms` | >= 0 | Duzenlenebilir | Duzenlenebilir |
| `connect_timeout_seconds` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `max_host_concurrency` | > 0 | Duzenlenebilir | Duzenlenebilir |
| `is_active` | Toggle; pasife alinan profil scheduler tarafindan secilmez | Duzenlenebilir | Duzenlenebilir |

**Kaydet sonrasi:**
- INSERT: `control.schedule_profile`'a yeni satir eklenir; `profile_code` unique constraint ihlali kullaniciya acik hata mesajiyla bildirilir.
- UPDATE: Mevcut satir guncellenir; `profile_code` degistirilemez.
- Her iki durumda da islem basarili oldugunda **basari toast bildirimi** ("Profil kaydedildi.") 3 saniye gosterilir. Hata durumunda kirmizi toast gosterilir ve modal kapanmaz.

**Veri kaynaklari:** `control.schedule_profile`, `control.instance_inventory`

---

### Ekran 9 — Cluster / Database Toplama Detayi

**Amac:** Hangi cluster'dan hangi database'ler toplandigi, hangi statement series'lerin aktif oldugu, son toplama metriklerini gostermek. Bu ekran gozlemsel amaclidir; duzenleme yapilmaz.

**Ust seviye: Cluster secimi**

Dropdown veya liste: aktif instance'lar. Secilen instance icin:

**Database Sekmesi:**

- `dim.database_ref`'ten bu instance'a ait database'ler
- Her database icin: datname, dbid, first_seen_at, last_seen_at
- Son `db_objects` toplama zamani ve durumu

**Statement Serisi Sekmesi:**

- Bu instance'a ait aktif statement series'ler: toplam seri sayisi, query_text_id bagli / bagsiz sayisi
- En yuksek `calls_sum` veya `exec_time_ms_sum` olan ilk `20` seri (`agg.pgss_hourly`'den son `24` saat)
- Her seri icin: kisaltilmis SQL text (`dim.query_text`'ten), toplam cagri, toplam sure, ortalama sure

**Tablo/Index Sekmesi:**

- Secilen database icin `fact.pg_table_stat_delta`'dan son toplama donemi verileri
- En yuksek `seq_scan_delta` veya `n_tup_upd_delta` olan tablolar
- Index bazinda `idx_scan_delta`

**Aktif Sessionlar Sekmesi:**

`fact.pg_activity_snapshot`'tan son toplama anindaki session listesi.

| Kolon | Kaynak |
|---|---|
| PID | `pid` |
| Database | `datname` |
| Kullanici | `usename` |
| Uygulama | `application_name` |
| Durum | `state` (renk: active=yesil, idle in transaction=sari, diğer=gri) |
| Bekleme | `wait_event_type / wait_event` |
| Sorgu Suresi | `now() - query_start` |
| Sorgu (kisaltilmis) | `query` (ilk 120 karakter) |

Filtre: sadece aktif / idle in transaction / bekleyenler. Uzun surenin esigi asildiysa (>30s) satir sari vurgulanir.

**Replikasyon Sekmesi:**

`fact.pg_replication_snapshot`'tan son toplama anindaki replica listesi. Yalnizca `is_primary = true` olan instance'larda gosterilir; replica node'larda "Bu node primary degil" mesaji gosterilir.

| Kolon | Kaynak |
|---|---|
| Replica | `application_name` / `client_addr` |
| Durum | `state` |
| Sync | `sync_state` |
| Replay Lag (sure) | `replay_lag` |
| Replay Lag (byte) | `replay_lag_bytes` formatlanmis (KB/MB/GB) |
| Flush Lag | `flush_lag` |

Replay lag > 5 dakika ise satir turuncu; > 30 dakika ise kirmizi vurgulanir.

**Veri kaynaklari:** `control.instance_inventory`, `dim.database_ref`, `control.database_state`, `dim.statement_series`, `dim.query_text`, `agg.pgss_hourly`, `fact.pg_table_stat_delta`, `fact.pg_index_stat_delta`, `fact.pg_activity_snapshot`, `fact.pg_replication_snapshot`

---

### UI Ekran Haritasi Ozeti

```
Dashboard
├── Instance Listesi
│   ├── Host Ekle / Duzenle (Form)
│   └── Instance Detay
│       ├── Capability
│       ├── Toplama Durumu
│       ├── Database Listesi
│       ├── Aktif Alertler
│       └── Son Job Run'lar
├── Alert Listesi
├── Job Run Gecmisi
├── Cluster / Database Toplama Detayi
└── Ayarlar
    ├── Retention Politikalari
    └── Schedule Profilleri
```

### UI Veri Yazma Kurallari

- UI yalnizca `control` schema'ya yazar; `fact`, `dim`, `agg`, `ops` tablolarina UI'dan yazma yapilmaz.
- Alert `acknowledge` islemi `ops.alert.status` ve `acknowledged_at` gunceller; bu tek `ops` yazma istisnasi.
- Collector is mantigini tetiklemek (discovery yeniden calistirma, manual collect) ilk fazda kapsam disindadir; `bootstrap_state = 'pending'` set ederek dolayh olarak tetiklenebilir.
- **Instance silme yoktur;** instance pasife alinir (`is_active = false`), retention politikasi zamanla temizler.
- **Retention politikasi ve schedule profili silinebilir;** ancak yalnizca hic instance atanmamissa (`bagli_instance_sayisi = 0`). UI, atamali kayitlarda Sil butonunu disabled gosterir.
- Silme oncesi onay dialog'u zorunludur; kullanici kodu gorecek sekilde onaylama yapilir.

## Implementasyon Notlari

Bu bolum, kodlamaya gecmeden once gelistiricinin bilmesi gereken uygulama-seviyesi detaylari icermektedir. Belgenin geri kalani mimari tasarimi kapsar; buradaki notlar dogrudan kod yazarken karsılasilacak pratik konulari ele alir.

### 1. SQL Profil Secim Mantigi

`collector_sql_family` degerine gore (`pg11_12`, `pg13`, `pg14_16`, `pg17_18`) collector farkli kolon listesiyle `pg_stat_statements` okumalidir. Temel farklar:

| Kolon | pg11_12 | pg13 | pg14_16 | pg17_18 |
|---|---|---|---|---|
| `toplevel` | Yok | Var | Var | Var |
| `plans`, `plan_time` | Yok | Yok | Var | Var |
| `wal_records`, `wal_bytes` | Yok | Var | Var | Var |
| `jit_*` | Yok | Var | Var | Var |
| `pg_stat_io` | Yok | Yok | Yok | Var (PG16+) |
| `pg_stat_checkpointer` | Yok | Yok | Yok | Var (PG17+) |
| `pg_stat_statements_info` | Yok | Yok | Var | Var |

Uygulama yaklasimlari:
- Her family icin ayri SQL sabiti tanimla; runtime'da `collector_sql_family`'e gore sec.
- Merkezi DB superset kolona sahip; kaynakta olmayan alanlar `NULL` olarak yazilir.
- Bilinmeyen family goruldugunde `degraded` olustur, desteklenen ortak kolonlarla devam et.

### 2. Ilk Deployment: Partition Migration Scripti

Collector `rollup` job'i calistiginda gelecek partisyonlari olusturur. Ancak ilk kurulumda `rollup` job calisana kadar gecen surede `fact` tablolarina yazma yapilirsa "no partition of relation found for row" hatasiyla karsilasılir.

Bu nedenle deployment sirasinda asagidaki migration scripti **elle** calistirilmalidir:

```sql
-- fact tablolari: bugun dahil gecmis 7 gun + gelecek 14 gun
-- Ornek: fact.pgss_delta icin
do $$
declare
  d date;
begin
  for d in
    select generate_series(
      current_date - 7,
      current_date + 14,
      '1 day'::interval
    )::date
  loop
    execute format(
      'create table if not exists fact.pgss_delta_%s
         partition of fact.pgss_delta
         for values from (%L) to (%L)',
      to_char(d, 'YYYYMMDD'),
      d::timestamptz,
      (d + 1)::timestamptz
    );
  end loop;
end $$;

-- Ayni dongu fact.pg_database_delta, fact.pg_table_stat_delta,
-- fact.pg_index_stat_delta, fact.pg_cluster_delta icin tekrarlanir.

-- agg.pgss_hourly: mevcut ay + gelecek 2 ay (aylik partisyon)
-- agg.pgss_daily: mevcut yil + gelecek 1 yil (yillik partisyon)
```

Rollup job basarıyla calistiktan sonra partition yonetimi otomatik hale gelir.

### 3. `vault:` Secret Ref Implementasyonu

`file:` ve `env:` prefix'leri V1'de zorunlu desteklenir. `vault:` prefix'i opsiyoneldir; eklenecekse su akis onerilir:

```
vault:<path>  ornek: vault:secret/pgstats/prod-db1

Akis:
1. Uygulama baslarken VAULT_ADDR ve VAULT_TOKEN (veya VAULT_ROLE_ID +
   VAULT_SECRET_ID) environment variable'larindan Vault baglantisi kur.
2. AppRole auth: POST /v1/auth/approle/login → token al.
3. Token'i bellekte tut; TTL dolmadan yenile (token renewal).
4. Secret okuma: GET /v1/<path> → data.password alanini al.
5. Token veya network hatasi durumunda instance'i 'degraded' olarak
   isaretler; ops.alert'e secret_ref_error yaz.
6. Secret rotation: rotation sonrasi bir sonraki connection attempt'te
   Vault'tan yeniden okur; instance_inventory satiri degismez.
```

V1 kapsaminda `vault:` desteklenmeyecekse, kod `vault:` prefix'ini gorduğunde `secret_ref_error` alert'i yazarak instance'i `degraded`'a almali; sessizce hata vermemelidir.

## Ozet

Bu tasarimin ozu sudur:

- `systemd timer` sadece scheduler olacak
- Asil toplama mantigi collector uygulamasinda olacak
- Kaynak PostgreSQL'lere minimum yukle, read-only baglanilacak
- Veri isleme merkezi collector makinesinde yapilacak
- SQL text bir kez saklanacak
- Upgrade ve surum farklari teknik olarak dogru sekilde handle edilecek
- Yeni host eklemek inventory tabanli ve otomatik olacak
