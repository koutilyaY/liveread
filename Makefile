# LiveRead — every target here is expected to work; see docs/BUILD_STATUS.md
SHELL := /bin/bash
COMPOSE := docker compose
INFRA_SERVICES := postgres redis minio mailpit

.PHONY: setup dev up down logs migrate seed test test-unit test-integration wait-api \
        test-e2e test-load test-network test-accessibility test-provider-failure \
        verify-real-stt readme-stats readme-assets \
        lint typecheck \
        format verify backup restore clean

setup: ## install dependencies, start infra, migrate, seed
	pnpm install
	cp -n .env.example .env || true
	$(COMPOSE) up -d $(INFRA_SERVICES)
	@sleep 3
	$(MAKE) migrate
	$(MAKE) seed

dev: ## run API + web on the host against dockerized infra
	$(COMPOSE) up -d $(INFRA_SERVICES)
	pnpm dev

up: ## full stack in Docker
	$(COMPOSE) up --build -d

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=100

migrate:
	cd apps/api && set -a && source ../.env 2>/dev/null || source ../../.env; set +a && npx prisma migrate deploy

seed:
	cd apps/api && set -a && source ../../.env && set +a && npx tsx prisma/seed.ts

test: test-unit test-integration

test-unit:
	pnpm --filter @liveread/shared test
	pnpm --filter @liveread/api test

test-integration:
	$(COMPOSE) up -d postgres redis minio
	pnpm --filter @liveread/api test:integration

wait-api: ## block until the API reports ready (replaces brittle sleeps)
	@for i in $$(seq 1 60); do \
	  if curl -sf http://localhost:4000/readyz >/dev/null 2>&1; then exit 0; fi; \
	  sleep 1; \
	done; \
	echo "API did not become ready within 60s"; exit 1

test-e2e: ## API in test mode (production signup limits would throttle the suite)
	NODE_ENV=test $(COMPOSE) up -d api
	@$(MAKE) --no-print-directory wait-api
	pnpm --filter @liveread/web exec playwright test; \
	  status=$$?; $(COMPOSE) up -d api >/dev/null; exit $$status

test-load: ## k6 via docker; TRUST_PROXY lets k6 simulate distinct viewer IPs
	TRUST_PROXY=true $(COMPOSE) up -d api
	@$(MAKE) --no-print-directory wait-api
	docker run --rm -i --network host -e API_URL=http://localhost:4000 grafana/k6 run - < infra/k6/viewer-load.js; \
	  status=$$?; $(COMPOSE) up -d api >/dev/null; exit $$status

test-network: ## chaos: restart redis mid-session and verify recovery
	bash infra/chaos/redis-restart-test.sh

readme-stats: ## regenerate the README test table from real runner output
	node scripts/readme-stats.mjs

readme-assets: ## re-capture README screenshots + GIF from the running app
	node apps/web/scripts/capture-readme-assets.mjs
	docker run --rm -v "$$(pwd)/docs/assets:/a" liveread-api:latest sh -c \
	  'ffmpeg -y -i /a/read-aloud.webm -vf "crop=1280:430:0:0,fps=10,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 /a/read-aloud.gif'

verify-real-stt: ## live check of the REAL speech provider (needs your own DEEPGRAM_API_KEY)
	@test -n "$$DEEPGRAM_API_KEY" || { echo "Set DEEPGRAM_API_KEY first — this deliberately does not fall back to the fake provider."; exit 1; }
	pnpm --filter @liveread/api verify:real-stt

test-provider-failure: ## acceptance 27/28 through the UI: force an STT outage
	NODE_ENV=test FAKE_STT_FAIL_MODE=start $(COMPOSE) up -d api
	@$(MAKE) --no-print-directory wait-api
	E2E_PROVIDER_FAILURE=1 pnpm --filter @liveread/web exec playwright test \
	  e2e/provider-failure.spec.ts --project=chromium; \
	  status=$$?; $(COMPOSE) up -d api >/dev/null; exit $$status

test-accessibility:
	NODE_ENV=test $(COMPOSE) up -d api
	@$(MAKE) --no-print-directory wait-api
	pnpm --filter @liveread/web exec playwright test e2e/accessibility.spec.ts --project=chromium; \
	  status=$$?; $(COMPOSE) up -d api >/dev/null; exit $$status

lint:
	pnpm --filter @liveread/shared lint
	pnpm --filter @liveread/api lint
	pnpm --filter @liveread/web lint

typecheck:
	pnpm typecheck

format:
	pnpm format

verify: lint typecheck test ## full local gate
	pnpm --filter @liveread/web build
	pnpm --filter @liveread/api build

backup: ## logical Postgres dump into ./backups
	mkdir -p backups
	docker exec liveread-postgres-1 pg_dump -U liveread -Fc liveread > backups/liveread-$$(date +%Y%m%d-%H%M%S).dump
	@ls -lh backups | tail -2

restore: ## restore the newest dump (DESTRUCTIVE to current data)
	@latest=$$(ls -t backups/*.dump | head -1); \
	echo "Restoring $$latest"; \
	docker exec -i liveread-postgres-1 pg_restore -U liveread -d liveread --clean --if-exists < $$latest

clean:
	$(COMPOSE) down -v
	rm -rf node_modules apps/*/node_modules packages/*/node_modules \
	       apps/web/.next apps/*/dist packages/*/dist .turbo
