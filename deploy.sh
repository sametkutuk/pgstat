#!/bin/bash
# =============================================================================
# pgstat Deploy Script
# Tek komutla: migration uygula + image build + container up + health check
#
# Kullanım:
#   ./deploy.sh          # full deploy
#   ./deploy.sh --skip-migrate   # migration atla (sadece app deploy)
#   ./deploy.sh --skip-build     # rebuild atla (mevcut image ile up)
# =============================================================================

set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Renkli çıktı
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# --- Argüman parse ---
SKIP_MIGRATE=false
SKIP_BUILD=false
for arg in "$@"; do
  case $arg in
    --skip-migrate) SKIP_MIGRATE=true ;;
    --skip-build)   SKIP_BUILD=true ;;
  esac
done

# --- .env kontrolü ---
if [ ! -f "$ENV_FILE" ]; then
  error ".env dosyası bulunamadı!"
  echo "  cp .env.example .env  # düzenleyip tekrar çalıştırın"
  exit 1
fi

# .env yükle
set -a; source "$ENV_FILE"; set +a

info "pgstat deploy başlıyor..."
echo "  DB: ${PGSTAT_DB_HOST}:${PGSTAT_DB_PORT}/${PGSTAT_DB_NAME}"
echo "  API Port: ${API_PORT:-3001}"
echo "  UI Port: ${UI_PORT:-3000}"
echo ""

# --- 1. DB bağlantı testi ---
info "Veritabanı bağlantısı kontrol ediliyor..."
if ! PGPASSWORD="$PGSTAT_DB_PASSWORD" psql -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" -U "$PGSTAT_DB_USER" -d "$PGSTAT_DB_NAME" -c "SELECT 1" > /dev/null 2>&1; then
  # DB var mı kontrol et, yoksa oluştur
  warn "pgstat veritabanına bağlanılamadı, oluşturuluyor..."
  PGPASSWORD="$PGSTAT_DB_PASSWORD" psql -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" -U "$PGSTAT_DB_USER" -d postgres -c "CREATE DATABASE $PGSTAT_DB_NAME" 2>/dev/null || true
fi

if PGPASSWORD="$PGSTAT_DB_PASSWORD" psql -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" -U "$PGSTAT_DB_USER" -d "$PGSTAT_DB_NAME" -c "SELECT 1" > /dev/null 2>&1; then
  info "Veritabanı bağlantısı OK ✓"
else
  error "Veritabanına bağlanılamadı! .env ayarlarını kontrol edin."
  exit 1
fi

# --- 2. Migration ---
if [ "$SKIP_MIGRATE" = false ]; then
  info "Migration'lar uygulanıyor..."

  # Migration tracking tablosu oluştur (ilk çalışmada)
  table_existed=$(PGPASSWORD="$PGSTAT_DB_PASSWORD" psql \
    -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" \
    -d "$PGSTAT_DB_NAME" -U "$PGSTAT_DB_USER" \
    -tAc "select count(*) from information_schema.tables where table_schema='public' and table_name='schema_migrations'" 2>/dev/null || echo "0")

  PGPASSWORD="$PGSTAT_DB_PASSWORD" psql \
    -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" \
    -d "$PGSTAT_DB_NAME" -U "$PGSTAT_DB_USER" \
    -c "create table if not exists public.schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )" > /dev/null 2>&1

  # Tablo yeni oluşturulduysa: control şeması var mı kontrol et.
  # Varsa daha önce migration'lar elle uygulanmış demektir — mevcut dosyaları applied say.
  # Bu sayede ilk upgrade'de eski migration'lar tekrar çalışmaz.
  if [ "$table_existed" = "0" ]; then
    schema_exists=$(PGPASSWORD="$PGSTAT_DB_PASSWORD" psql \
      -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" \
      -d "$PGSTAT_DB_NAME" -U "$PGSTAT_DB_USER" \
      -tAc "select count(*) from information_schema.schemata where schema_name='control'" 2>/dev/null || echo "0")

    if [ "$schema_exists" = "1" ]; then
      warn "Mevcut DB tespit edildi, migration geçmişi tohumlanıyor..."
      # Her migration dosyası için: tablo/kolon/constraint varlığına gore applied mi değil mi?
      # Basit yaklaşım: dosyayı çalıştır (idempotent yazılmış), başarılıysa kaydet.
      # Bu sefer ON_ERROR_STOP=1 yerine hatayı tolere edip kaydetmiyoruz.
      for f in "$SCRIPT_DIR/db/migrations"/V*.sql; do
        fname_seed=$(basename "$f")
        version="${fname_seed%.sql}"
        if PGPASSWORD="$PGSTAT_DB_PASSWORD" psql \
          -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" \
          -d "$PGSTAT_DB_NAME" -U "$PGSTAT_DB_USER" \
          -f "$f" -v ON_ERROR_STOP=1 > /dev/null 2>&1; then
          PGPASSWORD="$PGSTAT_DB_PASSWORD" psql \
            -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" \
            -d "$PGSTAT_DB_NAME" -U "$PGSTAT_DB_USER" \
            -c "insert into public.schema_migrations (version) values ('$version') on conflict do nothing" > /dev/null 2>&1
          info "  Seeded: $fname_seed"
        else
          warn "  Atlandı (hata): $fname_seed"
        fi
      done
      warn "Geçmiş tohumlandı. Bir sonraki upgrade'de sadece yeni migration'lar çalışacak."
    fi
  fi

  applied=0
  skipped=0
  for f in "$SCRIPT_DIR/db/migrations"/V*.sql; do
    fname=$(basename "$f")
    version="${fname%.sql}"

    # Zaten uygulandıysa atla
    already=$(PGPASSWORD="$PGSTAT_DB_PASSWORD" psql \
      -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" \
      -d "$PGSTAT_DB_NAME" -U "$PGSTAT_DB_USER" \
      -tAc "select count(*) from public.schema_migrations where version = '$version'" 2>/dev/null || echo "0")

    if [ "$already" = "1" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    info "  Applying $fname ..."
    if PGPASSWORD="$PGSTAT_DB_PASSWORD" psql \
      -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" \
      -d "$PGSTAT_DB_NAME" -U "$PGSTAT_DB_USER" \
      -f "$f" -v ON_ERROR_STOP=1 > /dev/null 2>&1; then
      # Başarılıysa kayıt et
      PGPASSWORD="$PGSTAT_DB_PASSWORD" psql \
        -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" \
        -d "$PGSTAT_DB_NAME" -U "$PGSTAT_DB_USER" \
        -c "insert into public.schema_migrations (version) values ('$version')" > /dev/null 2>&1
      applied=$((applied + 1))
    else
      error "  $fname uygulanırken hata oluştu!"
      exit 1
    fi
  done

  info "Migration tamamlandı ✓ ($applied yeni, $skipped atlandı)"
else
  warn "Migration atlandı (--skip-migrate)"
fi

# --- 3. Docker build + up ---
if [ "$SKIP_BUILD" = false ]; then
  info "Docker image'ları build ediliyor..."
  docker compose -f "$COMPOSE_FILE" build --quiet
  info "Build tamamlandı ✓"
else
  warn "Build atlandı (--skip-build)"
fi

info "Container'lar başlatılıyor..."
docker compose -f "$COMPOSE_FILE" up -d

# --- 4. Health check ---
info "Health check bekleniyor..."
API_URL="http://localhost:${API_PORT:-3001}/api/health"
RETRIES=30
for i in $(seq 1 $RETRIES); do
  if curl -sf "$API_URL" > /dev/null 2>&1; then
    info "API health check OK ✓"
    break
  fi
  if [ "$i" -eq "$RETRIES" ]; then
    error "API health check başarısız! Logları kontrol edin:"
    echo "  docker compose -f $COMPOSE_FILE logs api --tail 20"
    exit 1
  fi
  sleep 2
done

# UI check
UI_URL="http://localhost:${UI_PORT:-3000}"
if curl -sf "$UI_URL" > /dev/null 2>&1; then
  info "UI erişilebilir ✓"
fi

echo ""
info "═══════════════════════════════════════════"
info "  pgstat deploy tamamlandı!"
info "  UI:  http://localhost:${UI_PORT:-3000}"
info "  API: http://localhost:${API_PORT:-3001}/api/health"
info "═══════════════════════════════════════════"
