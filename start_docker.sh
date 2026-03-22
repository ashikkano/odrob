#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi

echo "⏳ Waiting for Docker VM to be ready..."
for i in $(seq 1 20); do
  if curl -s --unix-socket ~/.docker/run/docker.sock http://localhost/version >/dev/null 2>&1; then
    echo "✅ Docker VM ready!"
    docker context use desktop-linux >/dev/null 2>&1
    cd "$SCRIPT_DIR"
    echo "🔨 Building and starting containers..."
    docker compose up -d --build
    echo ""
    echo "⏳ Waiting for health checks..."
    sleep 15
    docker compose ps
    echo ""
    curl -s http://localhost:3001/api/indexes | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Backend: {len(d)} indexes')" 2>/dev/null
    curl -s -o /dev/null -w "Frontend: HTTP %{http_code}\n" http://localhost:3000
    exit 0
  fi
  sleep 5
  echo "  attempt $i/20..."
done
echo "❌ Docker VM did not start in time"
exit 1
