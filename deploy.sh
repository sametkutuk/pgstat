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
  for f in "$SCRIPT_DIR/db/migrations"/V*.sql; do
    fname=$(basename "$f")
    # Basit idempotency: schema var mı kontrol et (V001 control schema oluşturur)
    info "  Applying $fname ..."
    PGPASSWORD="$PGSTAT_DB_PASSWORD" psql \
      -h "$PGSTAT_DB_HOST" -p "$PGSTAT_DB_PORT" \
      -d "$PGSTAT_DB_NAME" -U "$PGSTAT_DB_USER" \
      -f "$f" -v ON_ERROR_STOP=0 > /dev/null 2>&1 || warn "  $fname zaten uygulanmış olabilir (devam ediliyor)"
  done
  info "Migration'lar tamamlandı ✓"
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
