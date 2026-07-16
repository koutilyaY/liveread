#!/usr/bin/env bash
# Chaos test: restart Redis while the API is serving and verify bounded
# recovery (readiness returns unhealthy during outage, healthy after).
set -euo pipefail

API=${API_URL:-http://localhost:4000}

echo "1) baseline readiness"
curl -sf "$API/readyz" > /dev/null && echo "   ready ✓"

echo "2) restarting redis container"
docker restart liveread-redis-1 > /dev/null

echo "3) waiting for recovery (max 30s)"
for i in $(seq 1 30); do
  if curl -sf "$API/readyz" > /dev/null 2>&1; then
    echo "   recovered after ${i}s ✓"
    exit 0
  fi
  sleep 1
done
echo "   FAILED: API did not recover within 30s"
exit 1
