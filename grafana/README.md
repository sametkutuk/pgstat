# Grafana Entegrasyonu

pgstat UI ile **aynı port üzerinden** Grafana sunulur. Reverse-proxy nginx (UI container içinde) `/grafana/` yolunu Grafana container'ına yönlendirir.

```
http://yourhost:${UI_PORT}/           → React UI
http://yourhost:${UI_PORT}/api/       → API
http://yourhost:${UI_PORT}/grafana/   → Grafana
```

## Kurulum

1. `.env` dosyasında Grafana ayarlarını set et:
   ```bash
   GRAFANA_ADMIN_USER=admin
   GRAFANA_ADMIN_PASSWORD=<güçlü-şifre>
   GRAFANA_ROOT_URL=http://yourhost:${UI_PORT}/grafana/   # gerçek hostname/port
   PGSTAT_GRAFANA_DB_USER=pgstat_grafana_ro
   PGSTAT_GRAFANA_DB_PASSWORD=<güçlü-şifre>
   ```

2. **Grafana read-only kullanıcısını oluştur (TEK SEFER, superuser ile)**:
   ```bash
   ./pgstat setup-grafana
   ```
   Bu komut superuser kullanıcı/şifresini sorar (varsayılan `postgres`) ve
   `db/setup/grafana-user.sql`'i `.env`'deki `PGSTAT_GRAFANA_DB_PASSWORD`
   ile çalıştırır. `pgstat_admin` kullanıcısının `CREATEROLE` yetkisi
   olmadığı için bu adım manueldir.

3. Migration + container build:
   ```bash
   ./pgstat upgrade
   ```
   V031 migration `pgstat_grafana_ro` kullanıcısına SELECT yetkilerini
   verir. Kullanıcı henüz yoksa V031 sessizce atlar (uyarı verir).

4. Grafana container'ını ayağa kaldır (ilk kez):
   ```bash
   docker compose -f docker-compose.prod.yml up -d grafana
   docker compose -f docker-compose.prod.yml restart ui   # nginx config yenile
   ```

5. Tarayıcıdan `http://yourhost:${UI_PORT}/grafana/` adresine git. Anonymous viewer aktif — login olmadan dashboard'u görürsün. Düzenleme için admin/şifre.

**Sonraki upgrade'lerde**: sadece `./pgstat upgrade` yeterli. Şifreyi değiştirmek istersen `.env`'i güncelleyip tekrar `./pgstat setup-grafana` çalıştır.

## Sağlanan Dashboard'lar

### `pgstat — Instance Detail`
Tek bir instance için 360° görünüm:

- **Sağlık özeti** (4 stat panel): aktif bağlantı, açık alert, cache hit, TPS, WAL üretimi (1h), disk read
- **Bağlantı sayısı** — bugün vs dün vs geçen hafta overlay (DoD/WoW)
- **WAL üretimi (bayt/sn)** — bugün vs dün vs geçen hafta overlay, otomatik birim (KB/MB/GB/TB)
- **TPS (commit + rollback)** — stacked
- **Cache hit ratio** — eşik çizgili
- **Aktivite dağılımı** — state bazlı stacked
- **Wait events** — wait_event_type bazlı time series
- **Top 20 sorgu** — toplam exec süresi + WAL + disk read tablosu
- **Top 20 tablo** — dead tuple oranı
- **Açık alert'ler** — instance bazlı tablo

### Variables
- **`$instance`**: dropdown'dan instance seç. Tüm paneller otomatik o instance'a daralır.

### Time range
- Üst sağdaki Grafana picker: 5m / 1h / 6h / 24h / 7d / 30d / custom
- Click+drag ile bir grafiğin alanını seç → tüm dashboard o aralığa zoom yapar
- Refresh: 30s default (özelleştirilebilir)

### Birim formatı
- `bytes` → otomatik B/KB/MB/GB/TB
- `Bps` → bayt/sn (KBps/MBps/GBps)
- `ms` → milisaniye
- `percent` → %

## Provisioning yapısı

```
grafana/
  provisioning/
    datasources/pgstat.yml      ← data source otomatik kurulur
    dashboards/pgstat.yml       ← dashboard provider config
  dashboards/
    instance-detail.json        ← dashboard JSON (versiyonlu)
```

`updateIntervalSeconds: 30` — dashboard JSON'unu değiştirip Git'ten çekersen 30 sn içinde Grafana yeniden yükler. `allowUiUpdates: true` — UI'dan da düzenleyebilirsin (kalıcı değil, restart'ta JSON kazanır).

## Yeni dashboard ekleme

`grafana/dashboards/` altına yeni JSON koy. UID benzersiz olsun. 30 sn içinde Grafana algılar.

UI'da düzenleyip "Save" → "JSON Model" panelinden export et → `grafana/dashboards/foo.json` olarak commit et. Bu yol UI deneyiminin Git tarafına aktarılması için temiz.

## Sorun giderme

| Sorun | Çözüm |
|---|---|
| `/grafana/` 502 | `docker compose ps grafana` — container ayakta mı? |
| Login ekranı geliyor | `GF_AUTH_ANONYMOUS_ENABLED=true` set mi? container restart |
| "No data" tüm panellerde | `pgstat_grafana_ro` user var mı? `./pgstat migrate` çalıştır |
| "FATAL: password authentication failed" | `PGSTAT_GRAFANA_DB_PASSWORD` env ile DB'deki uyumsuz — `./pgstat upgrade` ile sync |
| Dashboard yüklenmedi | `docker logs pgstat-grafana` — provisioning hata mı? JSON syntax hatası olabilir |
| Iframe embed çalışmıyor | `GF_SECURITY_ALLOW_EMBEDDING=true` set, `GF_SECURITY_COOKIE_SAMESITE=lax` |

## İleride

- **Fleet Overview dashboard** — service_group filtreli, multi-instance bird's eye
- **Top Queries dashboard** — pg_stat_statements derinleşme
- **iframe embed** — pgstat UI'da InstanceDetail sayfasına Grafana panelleri gömme
- **Materialized view'ler** — uzun zaman aralığı sorgu hızlandırması (V032+)

Detaylı plan: [../docs/grafana-integration-design.md](../docs/grafana-integration-design.md)
