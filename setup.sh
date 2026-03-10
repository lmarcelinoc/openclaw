#!/usr/bin/env bash
# =============================================================================
# OpenClaw Voltek — Full Setup Script (Linux / macOS)
# =============================================================================
# Checks for and installs every dependency, then walks you through auth
# and the onboarding wizard.
#
# Usage:
#   bash setup.sh            # interactive
#   bash setup.sh --no-onboard  # skip the onboarding wizard at the end
#
# Support: openclaw@voltekit.com
# =============================================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
step()    { echo -e "\n${BOLD}▶ $*${RESET}"; }
die()     { error "$*"; exit 1; }

# ── Parse flags ──────────────────────────────────────────────────────────────
NO_ONBOARD=0
for arg in "$@"; do
  case "$arg" in
    --no-onboard) NO_ONBOARD=1 ;;
  esac
done

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║      OpenClaw Voltek — Setup Script          ║${RESET}"
echo -e "${BOLD}║      Support: openclaw@voltekit.com          ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"
echo ""

# ── OS detection ─────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      die "Unsupported OS: $OS. Use setup.ps1 on Windows." ;;
esac
info "Platform: $PLATFORM"

# ─────────────────────────────────────────────────────────────────────────────
# 1. Homebrew (macOS only)
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$PLATFORM" == "macos" ]]; then
  step "Checking Homebrew"
  if command -v brew &>/dev/null; then
    ok "Homebrew already installed ($(brew --version | head -1))"
  else
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add Homebrew to PATH for Apple Silicon
    if [[ -f "/opt/homebrew/bin/brew" ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    ok "Homebrew installed"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Node.js 22+
# ─────────────────────────────────────────────────────────────────────────────
step "Checking Node.js"
NODE_OK=0
if command -v node &>/dev/null; then
  NODE_VER="$(node -e 'process.stdout.write(process.versions.node)')"
  NODE_MAJOR="${NODE_VER%%.*}"
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    ok "Node.js $NODE_VER — OK"
    NODE_OK=1
  else
    warn "Node.js $NODE_VER found but version 22+ required. Upgrading..."
  fi
else
  info "Node.js not found. Installing..."
fi

if [[ "$NODE_OK" -eq 0 ]]; then
  if [[ "$PLATFORM" == "macos" ]]; then
    brew install node
  else
    # Detect package manager
    if command -v apt-get &>/dev/null; then
      info "Detected apt — installing Node 22 via NodeSource..."
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
      info "Detected dnf — installing Node..."
      sudo dnf install -y nodejs npm
    elif command -v yum &>/dev/null; then
      info "Detected yum — installing Node..."
      sudo yum install -y nodejs npm
    elif command -v pacman &>/dev/null; then
      info "Detected pacman — installing Node..."
      sudo pacman -Sy --noconfirm nodejs npm
    else
      die "Cannot detect package manager. Install Node 22+ manually from https://nodejs.org then rerun this script."
    fi
  fi

  # Verify
  NODE_VER="$(node -e 'process.stdout.write(process.versions.node)' 2>/dev/null)" || die "Node install failed. Check errors above."
  ok "Node.js $NODE_VER installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. npm global prefix — fix EACCES on Linux
# ─────────────────────────────────────────────────────────────────────────────
step "Checking npm global prefix"
NPM_PREFIX="$(npm prefix -g 2>/dev/null || echo "")"
if [[ "$PLATFORM" == "linux" ]] && [[ "$NPM_PREFIX" == "/usr" || "$NPM_PREFIX" == "/usr/local" ]]; then
  warn "npm global prefix is $NPM_PREFIX (root-owned). Switching to ~/.npm-global to avoid permission errors."
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  NPM_GLOBAL_BIN="$HOME/.npm-global/bin"
  export PATH="$NPM_GLOBAL_BIN:$PATH"
  # Persist to shell rc
  for RC in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [[ -f "$RC" ]] && ! grep -q 'npm-global' "$RC"; then
      echo "" >> "$RC"
      echo '# npm global (added by OpenClaw Voltek setup)' >> "$RC"
      echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$RC"
      info "Added ~/.npm-global/bin to PATH in $RC"
    fi
  done
  ok "npm prefix → ~/.npm-global"
else
  ok "npm prefix: $NPM_PREFIX"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Git
# ─────────────────────────────────────────────────────────────────────────────
step "Checking Git"
if command -v git &>/dev/null; then
  ok "Git $(git --version)"
else
  info "Git not found. Installing..."
  if [[ "$PLATFORM" == "macos" ]]; then
    brew install git
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y git
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y git
  elif command -v yum &>/dev/null; then
    sudo yum install -y git
  elif command -v pacman &>/dev/null; then
    sudo pacman -Sy --noconfirm git
  else
    die "Cannot install git automatically. Install it manually then rerun."
  fi
  ok "Git installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. Claude Code CLI
# ─────────────────────────────────────────────────────────────────────────────
step "Checking Claude Code CLI"
if command -v claude &>/dev/null; then
  CLAUDE_VER="$(claude --version 2>/dev/null | head -1 || echo 'unknown')"
  ok "claude already installed ($CLAUDE_VER)"
else
  info "Installing @anthropic-ai/claude-code..."
  npm install -g @anthropic-ai/claude-code
  ok "Claude Code CLI installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. OpenClaw
# ─────────────────────────────────────────────────────────────────────────────
step "Checking OpenClaw"
if command -v openclaw &>/dev/null; then
  OC_VER="$(openclaw --version 2>/dev/null | head -1 || echo 'unknown')"
  ok "openclaw already installed ($OC_VER)"
  info "Updating to latest..."
  npm install -g openclaw@latest
  ok "OpenClaw updated"
else
  info "Installing openclaw@latest..."
  npm install -g openclaw@latest
  ok "OpenClaw installed"
fi

# Verify openclaw is on PATH
if ! command -v openclaw &>/dev/null; then
  warn "openclaw not found in PATH after install."
  warn "Try opening a new terminal, or add the npm global bin to your PATH:"
  warn "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  die "Cannot continue — openclaw not found. Fix PATH and rerun."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7. Claude OAuth — setup-token
# ─────────────────────────────────────────────────────────────────────────────
step "Claude authentication (OAuth)"
echo ""
echo -e "${CYAN}OpenClaw uses Claude Code OAuth — no raw API key needed.${RESET}"
echo ""
echo "This will:"
echo "  1. Run  claude setup-token  (opens a browser login)"
echo "  2. Ask you to paste the token into OpenClaw"
echo ""

read -r -p "Run 'claude setup-token' now? [Y/n] " REPLY
REPLY="${REPLY:-Y}"
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  echo ""
  info "Running: claude setup-token"
  echo "──────────────────────────────────────────────"
  claude setup-token || warn "claude setup-token exited with an error — you can rerun 'openclaw models auth setup-token' manually later."
  echo "──────────────────────────────────────────────"
  echo ""
  info "Registering token with OpenClaw..."
  openclaw models auth setup-token || warn "Token registration failed — you can retry: openclaw models auth setup-token"
  ok "Authentication configured"
else
  warn "Skipped. Run these manually when ready:"
  warn "  claude setup-token"
  warn "  openclaw models auth setup-token"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 8. Onboarding wizard
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$NO_ONBOARD" -eq 0 ]]; then
  step "OpenClaw onboarding"
  echo ""
  echo "The wizard will configure your gateway, channels, and workspace."
  echo ""
  read -r -p "Run 'openclaw onboard' now? [Y/n] " REPLY2
  REPLY2="${REPLY2:-Y}"
  if [[ "$REPLY2" =~ ^[Yy]$ ]]; then
    openclaw onboard --install-daemon
  else
    warn "Skipped. Run 'openclaw onboard' whenever you're ready."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║  Setup complete — OpenClaw Voltek is ready!  ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════╝${RESET}"
echo ""
echo "  Start gateway:    openclaw gateway run"
echo "  Re-authenticate:  claude setup-token && openclaw models auth setup-token"
echo "  Re-run onboard:   openclaw onboard"
echo "  Health check:     openclaw doctor"
echo ""
echo -e "  Support: ${CYAN}openclaw@voltekit.com${RESET}"
echo ""
