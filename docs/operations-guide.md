# pgstat Operasyon Rehberi

## Kurulum

### Gereksinimler

- Linux sunucu (RHEL/Oracle Linux 8+, Ubuntu 20.04+)
- Docker + Docker Compose
- PostgreSQL 14+ (merkezi depo olarak — Docker dışında kendi kurulumunuz)
- Kaynak PG'lere network erişimi (collector container'dan)

### İlk Kurulum

```bash
git clone https://github.com/sametkutuk/pgstat.git /opt/pgstat
cd /opt/pgstat
sed -i 's/\r$//' pgstat
chmod +x pgstat
./pgstat setup
```

Setup interaktif olarak sorar:
- Merkezi PostgreSQL bağlantı bilgileri (host, port, user, şifre)
- UI ve API portları
- Admin şifresi (UI giriş için)

### Merkezi DB Kullanıcı Yetkileri

pgstat'ın veri saklayacağı merkezi DB için:

```sql
-- Seçenek 1: Kullanıcı DB'yi oluştursun
CREATE ROLE pgstat_admin LOGIN PASSWORD 'güçlü_şifre' CREATEDB;

-- Seçenek 2: DB'yi siz oluşturun
CREATE ROLE pgstat_admin LOGIN PASSWORD 'güçlü_şifre';
CREATE DATABASE pgstat OWNER pgstat_admin;
\c pgstat
GRANT ALL ON SCHEMA public TO pgstat_admin;
GRANT CREATE ON SCHEMA public TO pgstat_admin;
```

Neden bu yetkiler gerekli:
- CREATE SCHEMA: migration'lar control, dim, fact, agg, ops schema'ları oluşturur
- CREATE TABLE: 28 tablo + 220+ partition oluşturulur
- INSERT/UPDATE/DELETE: collector veri yazar, API okur/yazar

### Kaynak PG Gereksinimleri

İzlemek istediğiniz her kaynak PostgreSQL'de:

```sql
-- 1. Collector kullanıcısı oluşturun
CREATE ROLE pgstats_collector
  LOGIN PASSWORD 'şifre'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT pg_read_all_stats TO pgstats_collector;
GRANT pg_read_all_settings TO pgstats_collector;
GRANT CONNECT ON DATABASE postgres TO pgstats_collector;

-- Tablo/index istatistikleri toplanacak her DB için:
GRANT CONNECT ON DATABASE mydb TO pgstats_collector;
```

```ini
# postgresql.conf — restart gerektirir
shared_preload_libraries = 'pg_stat_statements'
```

```sql
-- Admin DB'de (genellikle postgres)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

---

## Günlük Yönetim

| Komut | Açıklama |
|---|---|
| `./pgstat up` | Başlat |
| `./pgstat down` | Durdur |
| `./pgstat restart` | Yeniden başlat |
| `./pgstat status` | Container durumları |
| `./pgstat logs` | Tüm loglar |
| `./pgstat logs collector` | Sadece collector logları |
| `./pgstat logs api` | Sadece API logları |
| `./pgstat passwd` | Admin şifresini değiştir |
| `./pgstat backup` | DB backup al |
| `./pgstat upgrade` | Güncelle (git pull + migration + rebuild) |

### Systemd Servisi (Boot'ta Otomatik Başlatma)

```bash
./pgstat install     # kur — makine açılınca otomatik başlar
./pgstat uninstall   # kaldır

systemctl status pgstat
journalctl -u pgstat -f
```

---

## Bağlantı ve Performans Limitleri

### Kaynak PG'ye Bağlantı

| Parametre | Varsayılan | Açıklama |
|---|---|---|
| Bağlantı modeli | Ephemeral | Her toplama döngüsünde aç-kapat, havuzlanmaz |
| Instance başına eşzamanlı bağlantı | 1 | Aynı kaynak PG'ye aynı anda tek bağlantı |
| `connect_timeout_seconds` | 5 | Bağlantı kurma zaman aşımı |
| `statement_timeout_ms` | 5000 | Sorgu zaman aşımı (kaynak PG'de SET edilir) |
| `lock_timeout_ms` | 250 | Kilit bekleme zaman aşımı |
| `application_name` | pgstat_collector | Kaynak PG'de `pg_stat_activity`'de görünür |

### Paralel İşleme

| Parametre | Varsayılan | Nerede Ayarlanır |
|---|---|---|
| `max_host_concurrency` | 1 | Schedule profile (UI > Ayarlar) |
| `maxConcurrentHosts` | 5 | `application.yml` (pgstat.worker.max-concurrent-hosts) |
| Efektif paralel host | min(max_host_concurrency, maxConcurrentHosts) | — |

`max_host_concurrency`: Schedule profile'da tanımlı, instance'a atanır. Aynı anda kaç farklı kaynak PG'ye paralel bağlantı açılacağını belirler.

`maxConcurrentHosts`: Collector JVM seviyesinde thread pool boyutu. Tüm profiller için üst sınır.

### Toplama Frekansları

| Job | Varsayılan Interval | Açıklama |
|---|---|---|
| `cluster` | 60 saniye | pg_stat_bgwriter, wal, activity, replication, locks |
| `statements` | 300 saniye | pg_stat_statements delta |
| `db_objects` | 1800 saniye | Per-database tablo/index istatistikleri |
| `rollup` | 3600 saniye | Saatlik/günlük rollup + partition oluşturma |

Tüm frekanslar schedule profile üzerinden UI'dan değiştirilebilir.

### Batch Limitleri

| Parametre | Varsayılan | Açıklama |
|---|---|---|
| `bootstrap_sql_text_batch` | 100 | Host başına run başına max SQL text enrichment |
| `max_databases_per_run` | 5 | Instance başına tek db_objects run'ında max DB |
| `schedulerBatchSize` | 20 | Tek poll'da due instance queue boyutu |
| `bootstrapBatchSize` | 10 | Tek poll'da bootstrap queue boyutu |

### Merkezi DB (HikariCP)

| Parametre | Değer | Açıklama |
|---|---|---|
| `maximum-pool-size` | 15 | Collector'ın merkezi DB'ye max bağlantı |
| `minimum-idle` | 5 | Boşta tutulan minimum bağlantı |
| `connection-timeout` | 10000ms | Havuzdan bağlantı alma zaman aşımı |
| `idle-timeout` | 300000ms | Boş bağlantı kapatma süresi |
| `max-lifetime` | 600000ms | Bağlantı maksimum ömrü |

### Advisory Lock

Her job type için merkezi DB'de session-level advisory lock alınır:
- `pg_try_advisory_lock(hashtext('pgstats_job_cluster'))`
- `pg_try_advisory_lock(hashtext('pgstats_job_statements'))`
- `pg_try_advisory_lock(hashtext('pgstats_job_db_objects'))`
- `pg_try_advisory_lock(hashtext('pgstats_job_rollup'))`

Lock alınamazsa (başka collector kopyası çalışıyorsa) job sessizce atlanır.

---

## Hata Yönetimi

### Backoff Mekanizması

Bir instance'a bağlantı başarısız olursa:
- `consecutive_failures` sayacı artar
- Exponential backoff uygulanır: `min(900s, max(30s, 2^failures))`
- Başarılı toplamada sayaç sıfırlanır

### Bootstrap State'leri

| State | Anlam |
|---|---|
| `pending` | Yeni eklendi, keşif bekleniyor |
| `discovering` | Versiyon ve capability tespiti yapılıyor |
| `baselining` | İlk sample alınıyor (delta yok) |
| `enriching` | SQL text enrichment yapılıyor |
| `ready` | Normal toplama modunda |
| `degraded` | Kısmi çalışıyor (eksik extension/view) |
| `paused` | Manuel durduruldu |

### Alert Kodları

| Kod | Seviye | Açıklama |
|---|---|---|
| `connection_failure` | critical | Kaynak PG'ye bağlanılamıyor |
| `authentication_failure` | critical | Şifre/kullanıcı hatası |
| `permission_denied` | error | Yetki eksik |
| `extension_missing` | warning | pg_stat_statements yok |
| `replication_lag` | warning | Replay lag > 100MB |
| `lock_contention` | warning | 5dk+ lock bekleme |
| `stats_reset_detected` | info | pg_stat_statements reset algılandı |
| `advisory_lock_skip` | info | Başka collector kopyası çalışıyor |

---

## Retention ve Purge

### Retention Politikaları

UI > Ayarlar > Retention Politikaları'ndan yönetilir.

| Tier | raw_retention | hourly_retention | daily_retention |
|---|---|---|---|
| standard | 6 ay | 3 ay | 24 ay |
| extended | 12 ay | 6 ay | 36 ay |
| minimal | 3 ay | 1 ay | 12 ay |

### Purge Mekanizması

Rollup job her çalıştığında:
1. Global hard drop sınırı hesaplanır (en uzun retention'a sahip instance)
2. Bu sınırın gerisindeki partition'lar `DETACH + DROP` edilir
3. Tier farkı olan instance'lar için aradaki partition'larda batched delete (10.000 satır/batch)
4. `ops.job_run` ve `ops.alert` için sabit 90 gün retention

### Partition Yönetimi

Rollup job otomatik olarak:
- Fact tabloları: gelecek 14 günlük daily partition
- `agg.pgss_hourly`: gelecek 2 aylık monthly partition
- `agg.pgss_daily`: gelecek 1 yıllık yearly partition

---

## Güvenlik

### API Koruması

- JWT authentication (access token 1 saat, refresh token 7 gün)
- Brute force koruması: IP başına 5 deneme, 15dk kilit
- Rate limiting: login 20 req/15dk, genel API 500 req/15dk
- Helmet güvenlik header'ları
- CORS kısıtlaması

### Secret Yönetimi

- Instance şifreleri AES-256-GCM ile encrypt edilir
- Encryption key: `PGSTAT_SECRET_KEY` (.env'de, `openssl rand -hex 32` ile üretilir)
- `.pass` dosyaları API ve collector arasında shared volume ile paylaşılır
- `.env` dosyası `chmod 600` — sadece owner okuyabilir

### Kaynak PG Güvenliği

- Collector kaynak PG'lere kesinlikle read-only bağlanır
- Hiçbir DDL, DML, EXPLAIN çalıştırılmaz
- Minimum yetki prensibi: `pg_read_all_stats` + `pg_read_all_settings`
- Her bağlantıda `statement_timeout` ve `lock_timeout` set edilir

---

## Sorun Giderme

### Collector bağlanamıyor

```bash
# Logları kontrol et
./pgstat logs collector

# Kaynak PG'ye container'dan erişim testi
docker exec pgstat-collector ping -c 1 10.90.137.10
```

### API 502 Bad Gateway

```bash
# API container çalışıyor mu?
./pgstat status

# API logları
./pgstat logs api

# Nginx DNS cache sorunu — UI restart
docker restart pgstat-ui
```

### Migration hatası

```bash
# Manuel migration çalıştır
./pgstat migrate

# Belirli migration'ı kontrol et
docker exec pgstat-api node -e "const {pool}=require('./dist/config/database');pool.query('SELECT 1').then(()=>console.log('OK')).catch(console.error)"
```

### Şifre sıfırlama

```bash
./pgstat passwd
```
