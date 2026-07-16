# LiveRead — Deployment

## Environments

| Env          | Purpose                     | Notes                                                                  |
| ------------ | --------------------------- | ---------------------------------------------------------------------- |
| `local`      | `docker compose up --build` | fake STT, MinIO, Mailpit, auto email verify                            |
| `test`       | CI + integration/E2E        | fake STT only; **paid provider tests are skipped without credentials** |
| `staging`    | pre-production              | own secrets, own database, own buckets — **never production secrets**  |
| `production` | live                        | TLS-only, real STT (optional), real SMTP, real object storage          |

## Required production configuration

| Variable                            | Required              | Notes                                                                                                                                                                                                                |
| ----------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production`               | ✅                    | enables strict rate limits, `Secure` cookies, HSTS                                                                                                                                                                   |
| `DATABASE_URL`                      | ✅                    | Postgres 16+                                                                                                                                                                                                         |
| `REDIS_URL`                         | ✅                    |                                                                                                                                                                                                                      |
| `COOKIE_SECRET`                     | ✅                    | ≥32 random chars; rotating invalidates all sessions                                                                                                                                                                  |
| `WEB_ORIGINS`                       | ✅                    | exact browser origins (CORS + CSRF allowlist)                                                                                                                                                                        |
| `APP_BASE_URL`                      | ✅                    | used in emails and viewer URLs                                                                                                                                                                                       |
| `S3_*`                              | ✅                    | endpoint, region, bucket, credentials                                                                                                                                                                                |
| `SMTP_URL`, `MAIL_FROM`             | ✅                    | real delivery                                                                                                                                                                                                        |
| **`TRUST_PROXY`**                   | ✅ **if behind a LB** | set to the LB's IPs/CIDRs. Leaving it `false` behind a proxy collapses all clients into one rate-limit bucket. Setting it `true` while directly exposed lets clients forge `X-Forwarded-For` and bypass rate limits. |
| `STT_PROVIDER` / `DEEPGRAM_API_KEY` | optional              | omit → fake provider (no audio egress)                                                                                                                                                                               |
| `LIVEKIT_*`                         | optional              | required only for live creator audio                                                                                                                                                                                 |
| `MAX_*`                             | recommended           | cost controls                                                                                                                                                                                                        |

The API validates all of this at boot (Zod) and **refuses to start** on invalid
config rather than running half-configured.

## Checklist

- **DNS** — `app.` (web), `api.`, `livekit.`, `turn.`
- **TLS** — required. `Secure` cookies and HSTS depend on `NODE_ENV=production`. Terminate at the LB; WSS must be supported.
- **TURN** — coturn or managed; restrictive networks fail WebRTC without it.
- **Media region** — LiveKit near creators.
- **API region** — near viewers; stateless, so scale horizontally behind the LB. No sticky sessions needed: sequence allocation is atomic and replay is DB-backed.
- **Database** — managed Postgres, automated backups, PITR; read replicas as a future option.
- **Redis** — managed; liveness-critical, not durability-critical.
- **Object storage** — versioning + lifecycle rules aligned to `retention_days`.
- **CDN** — static assets and completed-session reads.
- **Autoscaling** — API on CPU + `liveread_ws_connections`; workers on queue depth.
- **Monitoring** — scrape `/metrics`; LB health checks on `/readyz` (not `/healthz` — the latter is up-ness only).
- **Secret management** — platform secret store; never baked into images.
- **Rollback** — images are immutable and stateless; roll back by redeploying the previous tag. **Migration safety: expand → backfill → contract.** Never drop a column in the same release that stops writing it, or a rollback lands on a schema that has already lost data.
- **Migrations** — `prisma migrate deploy` runs at container start; idempotent.

## Deploy

```bash
docker build -f apps/api/Dockerfile -t <registry>/liveread-api:<sha> .
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
  -t <registry>/liveread-web:<sha> .
```

`NEXT_PUBLIC_API_URL` is **baked at build time** — a build is environment-specific.

Both images run as non-root (uid 10001). The API image entrypoint applies
migrations then starts; the worker image is the same artifact with
`node dist/worker.js`.

## Not implemented

Terraform/OpenTofu modules, blue-green/canary automation, automated cross-region
failover. Nothing in the application obstructs them — no cloud-specific API is
used in application logic. See LIMITATIONS.md.
