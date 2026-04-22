# =============================================================================
# pgstat Makefile — ./pgstat script wrapper'ı
# Tüm komutlar için: ./pgstat help
# =============================================================================

.PHONY: deploy upgrade stop start restart logs logs-collector logs-api \
        status health migrate build backup-db restore-db clean

# --- Full deploy: migrate + build + up + health check ---
deploy:
	@./pgstat upgrade

# --- Container yönetimi ---
stop:
	@./pgstat down

start:
	@./pgstat up

restart:
	@./pgstat restart

# --- Loglar ---
logs:
	@./pgstat logs

logs-collector:
	@./pgstat logs collector

logs-api:
	@./pgstat logs api

# --- Durum ---
status:
	@./pgstat status

health:
	@./pgstat status
	@set -a; . ./.env; set +a; \
	echo "API:"; curl -sf http://localhost:$${API_PORT:-3001}/api/health && echo ""; \
	echo "UI:"; curl -sf -o /dev/null -w "HTTP %{http_code}" http://localhost:$${UI_PORT:-3000} && echo ""

# --- Migration (sadece) ---
migrate:
	@./pgstat migrate

# --- Build (sadece) ---
build:
	@set -a; . ./.env; set +a; \
	docker compose -f docker-compose.prod.yml --env-file .env build

# --- DB Backup ---
backup-db:
	@./pgstat backup

# --- DB Restore ---
# Kullanım: make restore-db FILE=backups/pgstat_20260420_150000.sql.gz
restore-db:
	@if [ -z "$(FILE)" ]; then echo "Kullanım: make restore-db FILE=backups/xxx.sql.gz"; exit 1; fi
	@set -a; . ./.env; set +a; \
	echo "UYARI: Bu işlem mevcut veriyi silecek!"; \
	read -p "Devam? (yes/no): " confirm; \
	if [ "$$confirm" = "yes" ]; then \
		echo "Restore: $(FILE)"; \
		gunzip -c "$(FILE)" | PGPASSWORD="$${PGSTAT_DB_PASSWORD}" psql \
			-h "$${PGSTAT_DB_HOST}" -p "$${PGSTAT_DB_PORT}" \
			-U "$${PGSTAT_DB_USER}" -d "$${PGSTAT_DB_NAME}"; \
		echo "Restore tamamlandı."; \
	else \
		echo "İptal edildi."; \
	fi

# --- Temizlik (container + image sil, volume KORUNUR) ---
clean:
	docker compose -f docker-compose.prod.yml down --rmi local
