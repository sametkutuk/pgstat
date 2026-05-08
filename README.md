# pgstat

Çoklu PostgreSQL instance'larından merkezi metrik toplayan, alert üreten ve raporlayan operasyonel izleme sistemi.

## Mimari

3 servisli monorepo, hepsi tek Docker network'ünde:

- **Collector** (Java 21, Spring Boot 3.x) — kaynak PG'lerden metrik toplar, central PG17'ye delta + snapshot yazar
- **API** (Node.js + Express + TypeScript) — UI için REST endpoint'leri, JWT auth
- **UI** (Vite + React 18 + TypeScript + TanStack Query + Tailwind) — port 1234 (nginx tek giriş)
- **Grafana** — alt-path mount (`/grafana/`), auto-login (auth proxy)

## Hızlı Başlangıç

```bash
git clone https://github.com/sametkutuk/pgstat.git
cd pgstat
cp .env.example .env  # düzenle
docker compose up -d
```

UI: `http://<host>:1234` (default admin / admin)

## Özellikler

### Metrik Toplama
- Cluster + per-database + per-table + per-index istatistikleri (delta + snapshot)
- pg_stat_statements (granular, queryid bazlı)
- WAL / archiver / replication / SLRU snapshots
- pg_stat_io (PG16+), session_time/active_time (PG14+)
- PG12-PG18 desteği (SQL family resolver)

### Alert Sistemi
- 14 fazlı standart alert: HIGH_CPU, HIGH_TEMP_FILES, IDLE_IN_TX, SLOT_INACTIVE, LONG_RUNNING_QUERY, HIGH_CONNECTION_USAGE, STALE_DATA, HIGH_BLOAT_RATIO + cluster/job/instance bazlı
- Granular evaluation (statement / table / index per-record)
- Adaptive baselining (saatlik) + maintenance window + snooze
- Notification kanalları: Email, Teams, Telegram, Webhook (body_template editörü)
- Spam koruma: sadece yeni alert veya severity yükseldiğinde notify
- 15dk rolling dispatch (rule_eval'da gönderilmemiş alert'leri tekrar dener)

### Dashboard'lar
- 14 Grafana dashboard ($instance/$database/$service_group cascading variables, $bucket WAL)
- pgstat UI Dashboard: özet kartlar + WAL üretim + archiver + SLRU + alert özeti
- Dashboard widget visibility (Settings > Dashboard Görünümü)
- Pinned instances — Dashboard üstünde özet kartları (TPS, conn, alert)

### Raporlar
- On-demand Health Report (instance bazlı) — checklist + 4 trend grafiği (TPS, connection, WAL, CPU proxy) + bloat + PG settings + settings_diff
- Otomatik daily (UTC 06:00) + weekly (Pazartesi UTC 06:00) raporlar
- Notification kanallarından gönderim
- Print-to-PDF butonu (browser native)

### UX
- Loading skeleton + EmptyState + ErrorBoundary
- Mobile responsive sidebar (hamburger menu)
- Audit Log (Settings > Audit Log) — tüm PUT/POST/DELETE/PATCH istekleri
- Onboarding precheck — yeni instance eklerken pg_stat_statements/pg_monitor/track_io_timing kontrolü + copy-paste fix SQL

## Önemli Endpoint'ler

| Endpoint | Açıklama |
|---|---|
| `GET /api/instances` | Instance listesi |
| `GET /api/instances/:id/health-report?days=N` | Sağlık raporu |
| `GET /api/instances/:id/settings/diff?days=N` | pg_settings değişiklik geçmişi |
| `GET /api/statements/top?hours=N` | Top sorgular |
| `GET /api/statements/search?q=text` | Full-text sorgu arama |
| `GET /api/alerts?status=open` | Açık alertler |
| `GET /api/audit-log?hours=N&method=PUT` | Audit log |
| `POST /api/onboarding/precheck` | Yeni instance prerequisite check |
| `GET/PATCH /api/preferences` | Kullanıcı tercihleri |
| `GET /api/dashboard/instance-health` | Dashboard özet |

## Geliştirme

```bash
# DB migrasyon
./db/apply.sh

# Local dev
cd api && npm run dev
cd ui && npm run dev
cd collector && mvn spring-boot:run
```

### Migration eklemek
`db/migrations/V0XX__name.sql` — idempotent yaz (CREATE IF NOT EXISTS, ON CONFLICT DO NOTHING).

### Production upgrade
```bash
./pgstat upgrade  # git pull + migrate + rebuild
```

## Teknolojiler

- PostgreSQL 17 (central), PG12-PG18 (kaynak)
- Java 21, Spring Boot 3.x, JDBC
- Node.js 20, Express, raw SQL (no ORM)
- React 18, Vite, TanStack Query, Tailwind, recharts
- Docker Compose, nginx reverse proxy
- Flyway-style versiyonlu migrations

## Lisans

MIT
