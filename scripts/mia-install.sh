#!/usr/bin/env bash
# MIA OpenClaw Installer — do not run directly, invoked by bootstrap.sh
# Tested on Ubuntu 22.04/24.04 (2026-03-13)
#
# Key design decisions:
#   - NOT set -e  (recovery loop handles errors)
#   - NOT set -u  (nvm uses unbound variables internally)
#   - set -o pipefail  (catch pipe failures)
#   - Claude CLI auth via `claude auth login` (NOT setup-token)
#     The claude-cli backend spawns `claude -p` as a subprocess.
#     No OAuth token is stored in OpenClaw — the CLI manages its own session.
set -o pipefail

MIA_API="${MIA_API_URL:-https://mia.voltek.us}"
SESSION_ID="${MIA_SESSION_ID:-}"
API_KEY="${MIA_API_KEY:-}"
OS="${MIA_OS:-$(uname -s)}"
ARCH="${MIA_ARCH:-$(uname -m)}"
ATTEMPT=0
MAX_AI_ATTEMPTS=8

NVM_VERSION="v0.40.1"
REPO_URL="https://github.com/Voltek-US/mia-openclaw"
REPO_DIR="$HOME/mia-openclaw"

# OpenClaw state directory — canonical location for runtime secrets and config
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

mia_step() { echo -e "\n${BOLD}[MIA]${RESET} ${CYAN}▶️  $1${RESET}"; }
mia_ok()   { echo -e "${GREEN} ✓ $1${RESET}"; }
mia_warn() { echo -e "${YELLOW} ⚠️  $1${RESET}"; }
mia_err()  { echo -e "${RED} ✗ $1${RESET}" >&2; }
mia_ai()   { echo -e "${YELLOW} ⟳ MIA is diagnosing and fixing automatically...${RESET}"; }
mia_info() { echo -e " ${CYAN}→ $1${RESET}"; }

# ── Env validation helper ─────────────────────────────────────────────────────
require_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    mia_err "Required environment variable missing: $key"
    return 1
  fi
}

# ── nvm helper ────────────────────────────────────────────────────────────────
# IMPORTANT: nvm uses unbound variables internally. Never restore set -u after nvm.
nvm_init() {
  export NVM_DIR="$HOME/.nvm"
  set +u
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  set +u
}

nvm_run() {
  set +u
  nvm "$@"
  local rc=$?
  set +u
  return $rc
}

# ── Pre-flight checks ─────────────────────────────────────────────────────────
preflight_check() {
  mia_step "Pre-flight checks"

  # Internet connectivity
  if ! curl -sf --max-time 5 https://nodejs.org > /dev/null 2>&1; then
    mia_err "No internet connection. Please check your network and try again."
    exit 1
  fi
  mia_ok "Internet connection"

  # Disk space (need at least 3 GB free for node_modules)
  local free_kb
  free_kb=$(df -k "$HOME" | awk 'NR==2 {print $4}')
  local free_gb=$(( free_kb / 1024 / 1024 ))
  if [[ $free_kb -lt 3145728 ]]; then
    mia_warn "Low disk space: ~${free_gb}GB free (recommended: 3GB+). Continuing anyway..."
  else
    mia_ok "Disk space: ~${free_gb}GB free"
  fi

  # Required system tools
  local missing=()
  for dep in curl git; do
    if ! command -v "$dep" &>/dev/null; then
      missing+=("$dep")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    mia_warn "Missing system tools: ${missing[*]}. Attempting to install..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -q && sudo apt-get install -y "${missing[@]}" 2>&1 | tail -3
    elif command -v brew &>/dev/null; then
      brew install "${missing[@]}"
    else
      mia_err "Cannot auto-install: ${missing[*]}. Please install manually."
      exit 1
    fi
  fi
  mia_ok "System tools present"

  # jq (needed for AI recovery JSON parsing)
  if ! command -v jq &>/dev/null; then
    mia_warn "Installing jq..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y jq 2>&1 | tail -2
    elif command -v brew &>/dev/null; then
      brew install jq
    fi
  fi
  mia_ok "jq present"
}

# ── AI Recovery ───────────────────────────────────────────────────────────────
# Sends error output to the AI orchestrator and executes the returned action.
# Returns 0 if the step should be retried/resumed, 1 if unrecoverable.
ai_recover() {
  local step="$1"
  local output="$2"
  ATTEMPT=$((ATTEMPT + 1))

  if [[ -z "$SESSION_ID" ]]; then
    mia_err "No session — cannot contact AI. Error in step: $step"
    return 1
  fi

  mia_ai

  local payload
  payload=$(jq -n \
    --arg step "$step" \
    --arg out "${output:0:3000}" \
    --arg os "$OS" \
    --arg arch "$ARCH" \
    --argjson attempt "$ATTEMPT" \
    '{step:$step, output:$out, os:$os, arch:$arch, attemptCount:$attempt}')

  local resp
  if ! resp=$(curl -sf --max-time 30 -X POST "${MIA_API}/api/v1/sessions/${SESSION_ID}/output" \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${API_KEY}" \
    -d "$payload" 2>&1); then
    mia_err "Could not reach MIA server for diagnostics."
    return 1
  fi

  local action message command require_confirm question
  action=$(echo "$resp" | jq -r '.action')
  message=$(echo "$resp" | jq -r '.message')

  echo -e " ${CYAN}MIA: ${message}${RESET}"

  case "$action" in
    run_command)
      command=$(echo "$resp" | jq -r '.command // empty')
      require_confirm=$(echo "$resp" | jq -r '.requireConfirmation // false')

      if [[ "$require_confirm" == "true" ]]; then
        echo ""
        echo -e " ${YELLOW}MIA needs to run: ${BOLD}${command}${RESET}"
        read -r -p " Allow this? [y/N] " confirm < /dev/tty
        if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
          mia_warn "Skipped by user."
          curl -sf -X POST "${MIA_API}/api/v1/sessions/${SESSION_ID}/answer" \
            -H "Content-Type: application/json" \
            -H "x-api-key: ${API_KEY}" \
            -d '{"answer":"user declined to run the command"}' &>/dev/null || true
          return 1
        fi
      fi

      local cmd_out cmd_exit
      set +e
      cmd_out=$(eval "$command" 2>&1)
      cmd_exit=$?
      set +e

      if [[ $cmd_exit -eq 0 ]]; then
        ATTEMPT=0
        return 0
      else
        ai_recover "$command" "$cmd_out"
        return $?
      fi
      ;;

    ask_user)
      question=$(echo "$resp" | jq -r '.question // empty')
      echo ""
      read -r -p " ${question} " user_answer < /dev/tty
      curl -sf -X POST "${MIA_API}/api/v1/sessions/${SESSION_ID}/answer" \
        -H "Content-Type: application/json" \
        -H "x-api-key: ${API_KEY}" \
        -d "{\"answer\":\"${user_answer}\"}" &>/dev/null || true
      return 0
      ;;

    resume)
      ATTEMPT=0
      return 0
      ;;

    complete)
      return 0
      ;;

    failed)
      mia_err "$message"
      return 1
      ;;

    *)
      mia_err "Unknown AI response: $action"
      return 1
      ;;
  esac
}

# ── Step runner ───────────────────────────────────────────────────────────────
# Runs a command with live output to terminal.
# On failure, enters AI recovery loop and retries.
run_step() {
  local name="$1"; shift
  local cmd="$*"

  mia_step "$name"

  # Use temp file to capture output while streaming live to terminal
  local tmpout
  tmpout=$(mktemp /tmp/mia-step-XXXXXX)

  set +e
  eval "$cmd" 2>&1 | tee "$tmpout"
  local exit_code=${PIPESTATUS[0]}
  set +e

  local out
  out=$(cat "$tmpout")
  rm -f "$tmpout"

  if [[ $exit_code -eq 0 ]]; then
    mia_ok "Done"
    ATTEMPT=0
    return 0
  fi

  mia_warn "Step failed (exit $exit_code)"

  while ! ai_recover "$name" "$out"; do
    if [[ $ATTEMPT -ge $MAX_AI_ATTEMPTS ]]; then
      mia_err "Could not recover after $MAX_AI_ATTEMPTS attempts."
      mia_err "Please contact support@voltek.us and describe the issue."
      report_failed
      exit 1
    fi
  done

  # Retry the original step after AI recovery
  mia_info "Retrying: $name"
  local tmpout2
  tmpout2=$(mktemp /tmp/mia-step-XXXXXX)
  set +e
  eval "$cmd" 2>&1 | tee "$tmpout2"
  local retry_exit=${PIPESTATUS[0]}
  set +e
  local retry_out
  retry_out=$(cat "$tmpout2")
  rm -f "$tmpout2"

  if [[ $retry_exit -ne 0 ]]; then
    ai_recover "$name (retry)" "$retry_out" || {
      report_failed
      exit 1
    }
  fi

  mia_ok "Recovered and completed"
  ATTEMPT=0
}

report_failed() {
  [[ -z "$SESSION_ID" ]] && return 0
  curl -sf -X POST "${MIA_API}/api/v1/sessions/${SESSION_ID}/output" \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${API_KEY}" \
    -d '{"step":"installation_failed","output":"Installation aborted after unrecoverable error","attemptCount":99}' \
    &>/dev/null || true
}

report_complete() {
  [[ -z "$SESSION_ID" ]] && return 0
  curl -sf -X POST "${MIA_API}/api/v1/sessions/${SESSION_ID}/complete" \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${API_KEY}" \
    -d '{}' &>/dev/null || true
}

# ── INSTALLATION ──────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Starting OpenClaw installation...${RESET}"
echo ""

# ── Pre-flight ────────────────────────────────────────────────────────────────
preflight_check

# ── Step 1 — Install nvm ──────────────────────────────────────────────────────
mia_step "nvm ${NVM_VERSION}"
if [ -d "$HOME/.nvm" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  mia_ok "Already installed"
else
  run_step "Installing nvm ${NVM_VERSION}" \
    "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash"
fi

# Source nvm for this script session
nvm_init

# Absolute-path helpers — resolved after each install so subshells and
# nohup processes don't depend on nvm being re-sourced.
resolve_bins() {
  NODE_BIN=$(command -v node 2>/dev/null || true)
  NPM_BIN=$(command -v npm 2>/dev/null || true)
  PNPM_BIN=$(command -v pnpm 2>/dev/null || true)
  CLAUDE_BIN=$(command -v claude 2>/dev/null || true)
  NODE_DIR=$(dirname "${NODE_BIN:-/usr/local/bin/node}")
}
resolve_bins

# ── Step 2 — Install Node.js 24 ───────────────────────────────────────────────
mia_step "Node.js 24"
set +u
NODE_MAJOR=$(node -p "process.versions.node" 2>/dev/null | cut -d. -f1 || echo "0")
if command -v node &>/dev/null && [[ "$NODE_MAJOR" -ge 22 ]]; then
  mia_ok "Already installed ($(node -v))"
else
  set +u
  run_step "Installing Node.js 24" \
    'set +u; export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm install 24 && nvm use 24 && nvm alias default 24'
  nvm_init  # re-source so node is in PATH for this script
fi
set +u
resolve_bins

mia_info "Node $(node -v) | npm $(npm -v)"

# ── Step 3 — Install pnpm ─────────────────────────────────────────────────────
mia_step "pnpm"
if command -v pnpm &>/dev/null; then
  mia_ok "Already installed ($(pnpm --version))"
else
  run_step "Installing pnpm" "'${NPM_BIN:-npm}' install -g pnpm"
fi
resolve_bins  # capture absolute pnpm path immediately after install
mia_info "pnpm at: ${PNPM_BIN:-not found}"

# ── Step 4 — Install Claude Code CLI ─────────────────────────────────────────
# Install globally via nvm's npm so claude lands in the nvm-managed bin dir.
mia_step "Claude Code CLI"
if command -v claude &>/dev/null; then
  mia_ok "Already installed ($(claude --version 2>&1 | head -1))"
else
  run_step "Installing Claude Code CLI" "'${NPM_BIN:-npm}' install -g @anthropic-ai/claude-code"
fi
resolve_bins

# ── Step 5 — Clone / update mia-openclaw ─────────────────────────────────────
mia_step "mia-openclaw repository"
if [ -d "$REPO_DIR/.git" ]; then
  mia_ok "Already cloned — pulling latest"
  run_step "Updating mia-openclaw" "git -C \"$REPO_DIR\" pull"
else
  run_step "Cloning mia-openclaw" "git clone \"$REPO_URL\" \"$REPO_DIR\""
fi

# ── Step 6 — Install dependencies ────────────────────────────────────────────
mia_info "Installing dependencies. First run can take several minutes (~2GB)."
run_step "Installing dependencies" \
  "cd \"$REPO_DIR\" && '${PNPM_BIN:-pnpm}' install"

# ── Step 7 — Build project ────────────────────────────────────────────────────
mia_info "Building OpenClaw CLI/runtime."
run_step "Building OpenClaw" \
  "cd \"$REPO_DIR\" && '${NODE_BIN:-node}' scripts/tsdown-build.mjs"

# ── Step 8 — Authenticate Claude Code CLI ────────────────────────────────────
#
# WHY `claude auth login` and NOT `claude setup-token`:
#   - `claude auth login` authenticates the local CLI installation.
#     After this, `claude -p "..."` works as a subprocess (which is how
#     OpenClaw's claude-cli backend runs it — no API key required).
#   - `claude setup-token` only generates a bearer token for third-party
#     direct API access. Using that token directly against api.anthropic.com
#     violates Anthropic's usage policy. We don't need it.
#
mia_step "Claude Code CLI authentication"
echo ""
echo -e " ${BOLD}Authenticating the Claude CLI.${RESET}"
echo -e " ${CYAN}1.${RESET} A browser URL will appear — open it"
echo -e " ${CYAN}2.${RESET} Log in with your Claude account"
echo -e " ${CYAN}3.${RESET} Return here when done"
echo ""

if "${CLAUDE_BIN:-claude}" auth status &>/dev/null 2>&1; then
  mia_ok "Claude CLI already authenticated"
else
  echo ""
  echo -e " ${BOLD}Starting claude auth login...${RESET}"
  echo -e " ${CYAN}1.${RESET} A URL will appear below — open it in your browser"
  echo -e " ${CYAN}2.${RESET} Log in, then paste the code shown back here"
  echo ""

  # claude auth login is a readline TUI — it needs a real PTY to render
  # the code-paste prompt. Use `script` to allocate one; fall back to
  # plain /dev/tty redirect if `script` isn't available.
  if command -v script &>/dev/null; then
    script -q -c "${CLAUDE_BIN:-claude} auth login" /dev/null
    LOGIN_EXIT=$?
  else
    "${CLAUDE_BIN:-claude}" auth login </dev/tty >/dev/tty 2>/dev/tty
    LOGIN_EXIT=$?
  fi

  if [[ $LOGIN_EXIT -eq 0 ]]; then
    mia_ok "Claude CLI authenticated"
  else
    mia_warn "claude auth login exited with code $LOGIN_EXIT. Checking status..."
  fi
fi

# Verify the CLI session is usable
if "${CLAUDE_BIN:-claude}" auth status </dev/null >/dev/null 2>&1; then
  mia_ok "Verified: claude -p is ready"
else
  mia_warn "Claude CLI not confirmed authenticated."
  mia_warn "Run '${CLAUDE_BIN:-claude} auth login' manually if 'claude -p' fails later."
fi

# ── Step 9 — .env setup ───────────────────────────────────────────────────────
# Canonical env file lives in OPENCLAW_STATE_DIR so the gateway always
# finds it regardless of working directory or launch context.
mkdir -p "$OPENCLAW_STATE_DIR"
ENV_FILE="$OPENCLAW_STATE_DIR/.env"

mia_step "Setting up your environment"
echo ""

# Helper: write or update a key in .env
# Handles: uncommented key (update), commented key (uncomment+set), missing (append)
env_set() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  elif grep -q "^#[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^#[[:space:]]*${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

# Start from repo template if state dir .env doesn't exist yet
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_DIR/.env.example" "$ENV_FILE" 2>/dev/null || touch "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

# ── Gateway token (auto-generate — secures the local OpenClaw gateway) ────────
GATEWAY_TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-f0-9' | head -c 32)
env_set "OPENCLAW_GATEWAY_TOKEN" "$GATEWAY_TOKEN"
mia_ok "Gateway token generated"

# ── AI Providers (all optional — claude-cli is the default, no key needed) ────
echo ""
echo -e " ${BOLD}Optional: Additional AI Provider Keys${RESET} ${CYAN}(press Enter to skip any)${RESET}"
echo -e " ${CYAN}Note:${RESET} Claude via CLI is already configured — no key needed for that."
echo ""

read -r -p " OpenAI API key (sk-...): " _key < /dev/tty
[[ -n "$_key" ]] && env_set "OPENAI_API_KEY" "$_key" && mia_ok "OpenAI key saved"

read -r -p " Groq API key (gsk_...): " _key < /dev/tty
[[ -n "$_key" ]] && env_set "GROQ_API_KEY" "$_key" && mia_ok "Groq key saved"

read -r -p " Tavily API key (tvly-...): " _key < /dev/tty
[[ -n "$_key" ]] && env_set "TAVILY_API_KEY" "$_key" && mia_ok "Tavily key saved"

# ── Channels ──────────────────────────────────────────────────────────────────
echo ""
echo -e " ${BOLD}Telegram${RESET} ${CYAN}(press Enter to skip)${RESET}"
echo ""

read -r -p " Telegram bot token: " _key < /dev/tty
[[ -n "$_key" ]] && env_set "TELEGRAM_BOT_TOKEN" "$_key" && mia_ok "Telegram token saved"

echo ""
mia_ok ".env configured — ${ENV_FILE}"

# ── Re-source env and nvm for the steps below ────────────────────────────────
nvm_init
set +u; nvm use default --silent 2>/dev/null || true; set +u

set -a
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && source "$ENV_FILE"
set +a

# ── Step 10 — Onboard (first deploy only) ─────────────────────────────────────
mia_step "OpenClaw onboard"

require_env OPENCLAW_GATEWAY_TOKEN || { report_failed; exit 1; }

if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  mia_ok "Already configured — skipping onboard"
else
  mia_info "First-time setup — configuring OpenClaw non-interactively"

  # Determine provider flags based on what keys are available.
  # claude-cli is always the primary — it needs no API key.
  # We pass --skip-provider so onboard doesn't fail on missing keys.
  _PROVIDER_FLAGS="--skip-provider"
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    _PROVIDER_FLAGS="--auth-choice openai --openai-api-key \"${OPENAI_API_KEY}\""
  fi

  run_step "Running openclaw onboard" \
    "'${NODE_BIN:-node}' '${REPO_DIR}/dist/index.js' onboard \
      --non-interactive \
      --accept-risk \
      ${_PROVIDER_FLAGS} \
      --gateway-bind loopback \
      --gateway-port 18789 \
      --gateway-auth token \
      --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
      --skip-channels \
      --skip-skills \
      --skip-search \
      --skip-health \
      --skip-daemon"

  # Set claude-cli/sonnet as the primary model.
  # All traffic goes through the authenticated `claude -p` subprocess —
  # no API key stored, no direct API calls made by OpenClaw.
  mia_info "Setting claude-cli/sonnet as primary model"
  set +e
  "${NODE_BIN:-node}" "${REPO_DIR}/dist/index.js" config set agents.defaults.model claude-cli/sonnet 2>&1
  set +e
  mia_ok "Primary model: claude-cli/sonnet"
fi

# ── Step 11 — Launch OpenClaw gateway ────────────────────────────────────────
mia_step "Launching OpenClaw gateway"
pkill -9 -f openclaw-gateway 2>/dev/null || true
sleep 1

# Resolve the absolute Node binary path so the nohup subshell doesn't depend
# on nvm being sourced (nvm is a shell function, unavailable in bare bash).
NODE_BIN=$(dirname "$(command -v node)")

nohup bash -c "
  export PATH=\"${NODE_DIR}:\$PATH\"
  export OPENCLAW_STATE_DIR=\"${OPENCLAW_STATE_DIR}\"
  export OPENCLAW_CONFIG_PATH=\"${OPENCLAW_CONFIG_PATH}\"
  set -a
  [ -f '${ENV_FILE}' ] && source '${ENV_FILE}'
  set +a
  cd '${REPO_DIR}'
  exec '${NODE_BIN:-node}' dist/index.js gateway run --bind loopback --port 18789 --force
" > /tmp/openclaw-gateway.log 2>&1 &
GATEWAY_PID=$!

# Health check — give gateway a few seconds to confirm it started
sleep 6
if ps -p "$GATEWAY_PID" > /dev/null 2>&1; then
  mia_ok "Gateway started (PID $GATEWAY_PID) — log: /tmp/openclaw-gateway.log"
else
  mia_err "Gateway exited unexpectedly. Check /tmp/openclaw-gateway.log"
  tail -20 /tmp/openclaw-gateway.log >&2
  report_failed
  exit 1
fi

# ── Done ──────────────────────────────────────────────────────────────────────
report_complete

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${GREEN} ✓ OpenClaw installation complete!${RESET}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e " ${BOLD}Tools installed:${RESET}"
set +u; nvm_init
echo -e "   Node.js  $(node -v)"
echo -e "   npm      $(npm -v)"
echo -e "   pnpm     $(pnpm --version)"
echo -e "   claude   $(claude --version 2>&1 | head -1)"
set +u
echo ""
echo -e " ${BOLD}Gateway:${RESET}"
echo -e "   Running on loopback:18789"
echo -e "   Log: /tmp/openclaw-gateway.log"
echo -e "   Primary model: claude-cli/sonnet (via claude -p subprocess)"
echo ""
echo -e " ${BOLD}To restart the gateway:${RESET}"
echo -e "   ${CYAN}bash ~/mia-openclaw/scripts/mia-restart-gateway.sh${RESET}"
echo ""
echo -e " ${YELLOW}Open a new terminal or run ${CYAN}source ~/.bashrc${YELLOW} to refresh PATH.${RESET}"
echo ""
