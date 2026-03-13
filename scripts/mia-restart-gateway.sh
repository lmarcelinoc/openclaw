#!/usr/bin/env bash
# MIA OpenClaw — restart the gateway
# Usage: bash ~/mia-openclaw/scripts/mia-restart-gateway.sh

set -o pipefail

REPO_DIR="${REPO_DIR:-$HOME/mia-openclaw}"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
ENV_FILE="$OPENCLAW_STATE_DIR/.env"

# Load nvm to resolve node path
export NVM_DIR="$HOME/.nvm"
set +u
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
set +u

NODE_BIN=$(dirname "$(command -v node)" 2>/dev/null || echo "/usr/local/bin")

echo "Stopping existing gateway..."
pkill -9 -f openclaw-gateway 2>/dev/null || true
sleep 1

echo "Starting gateway..."
nohup bash -c "
  export PATH=\"${NODE_BIN}:\$PATH\"
  export OPENCLAW_STATE_DIR=\"${OPENCLAW_STATE_DIR}\"
  export OPENCLAW_CONFIG_PATH=\"${OPENCLAW_CONFIG_PATH}\"
  set -a
  [ -f '${ENV_FILE}' ] && source '${ENV_FILE}'
  set +a
  cd '${REPO_DIR}'
  exec node dist/index.js gateway run --bind loopback --port 18789 --force
" > /tmp/openclaw-gateway.log 2>&1 &

sleep 4
if ps aux | grep -q "[o]penclaw-gateway"; then
  echo "✓ Gateway running — log: /tmp/openclaw-gateway.log"
else
  echo "✗ Gateway failed to start. Check /tmp/openclaw-gateway.log"
  tail -20 /tmp/openclaw-gateway.log
  exit 1
fi
