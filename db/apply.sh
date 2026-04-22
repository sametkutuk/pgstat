#!/bin/bash
# =============================================================================
# Migration uygulama scripti
# Tüm V*.sql dosyalarını sırayla central DB'ye uygular
# =============================================================================

PGHOST="${PGSTAT_DB_HOST:-localhost}"
PGPORT="${PGSTAT_DB_PORT:-5417}"
PGDATABASE="${PGSTAT_DB_NAME:-pgstat}"
PGUSER="${PGSTAT_DB_USER:-samet}"

export PGPASSWORD="${PGSTAT_DB_PASSWORD:-samet}"

echo "=== pgstat migration ==="
echo "Host: $PGHOST:$PGPORT / $PGDATABASE (user: $PGUSER)"
echo ""

# pgstat veritabanını oluştur (yoksa)
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
  -c "SELECT 1 FROM pg_database WHERE datname = '$PGDATABASE'" | grep -q 1 || \
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "CREATE DATABASE $PGDATABASE"

# Migration dosyalarını sırayla uygula
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for f in "$SCRIPT_DIR/migrations"/V*.sql; do
  echo "Applying $(basename "$f") ..."
  psql -h "$PGHOST" -p "$PGPORT" -d "$PGDATABASE" -U "$PGUSER" \
    -f "$f" -v ON_ERROR_STOP=1
  if [ $? -ne 0 ]; then
    echo "HATA: $(basename "$f") uygulanırken hata oluştu!"
    exit 1
  fi
done

echo ""
echo "=== Tüm migration'lar başarıyla uygulandı ==="
