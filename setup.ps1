# =============================================================================
# OpenClaw Voltek — Full Setup Script (Windows PowerShell)
# =============================================================================
# Checks for and installs every dependency, then walks you through auth
# and the onboarding wizard.
#
# Usage (in PowerShell):
#   .\setup.ps1                  # interactive
#   .\setup.ps1 -NoOnboard       # skip the onboarding wizard at the end
#
# If you get an execution policy error, run first:
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
#
# Support: openclaw@voltekit.com
# =============================================================================

[CmdletBinding()]
param(
    [switch]$NoOnboard
)

$ErrorActionPreference = "Stop"

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Step  { param($msg) Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Info  { param($msg) Write-Host "[INFO]  $msg" -ForegroundColor White }
function Write-Warn  { param($msg) Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red }

function Invoke-CheckCommand {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Confirm-Prompt {
    param([string]$Message, [string]$Default = "Y")
    $prompt = if ($Default -eq "Y") { "$Message [Y/n]" } else { "$Message [y/N]" }
    $reply = Read-Host $prompt
    if ([string]::IsNullOrWhiteSpace($reply)) { $reply = $Default }
    return $reply -match "^[Yy]"
}

# ── Banner ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║      OpenClaw Voltek — Setup Script          ║" -ForegroundColor Cyan
Write-Host "║      Support: openclaw@voltekit.com          ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Info "Platform: Windows (PowerShell)"

# ─────────────────────────────────────────────────────────────────────────────
# 1. winget availability
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Checking package manager"
$HAS_WINGET = Invoke-CheckCommand "winget"
$HAS_CHOCO  = Invoke-CheckCommand "choco"
$HAS_SCOOP  = Invoke-CheckCommand "scoop"

if ($HAS_WINGET) {
    Write-Ok "winget available"
} elseif ($HAS_CHOCO) {
    Write-Ok "Chocolatey available (winget not found)"
} elseif ($HAS_SCOOP) {
    Write-Ok "Scoop available (winget/choco not found)"
} else {
    Write-Warn "No package manager found (winget/choco/scoop)."
    Write-Warn "Install Node 22 manually from https://nodejs.org then rerun this script."
    Write-Warn "Or install winget: https://aka.ms/winget-install"
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Node.js 22+
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Checking Node.js"
$NodeOk = $false

if (Invoke-CheckCommand "node") {
    $nodeVer = (node -e "process.stdout.write(process.versions.node)" 2>$null)
    $nodeMajor = [int]($nodeVer -split "\.")[0]
    if ($nodeMajor -ge 22) {
        Write-Ok "Node.js $nodeVer — OK"
        $NodeOk = $true
    } else {
        Write-Warn "Node.js $nodeVer found but version 22+ required. Upgrading..."
    }
} else {
    Write-Info "Node.js not found. Installing..."
}

if (-not $NodeOk) {
    if ($HAS_WINGET) {
        Write-Info "Installing via winget..."
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    } elseif ($HAS_CHOCO) {
        Write-Info "Installing via Chocolatey..."
        choco install nodejs-lts -y
    } elseif ($HAS_SCOOP) {
        Write-Info "Installing via Scoop..."
        scoop install nodejs-lts
    } else {
        Write-Err "Cannot install Node.js automatically."
        Write-Err "Download and install Node 22 from https://nodejs.org then rerun this script."
        exit 1
    }

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")

    if (Invoke-CheckCommand "node") {
        $nodeVer = (node -e "process.stdout.write(process.versions.node)" 2>$null)
        Write-Ok "Node.js $nodeVer installed"
    } else {
        Write-Warn "Node was installed but 'node' is not yet on PATH in this session."
        Write-Warn "Close and reopen PowerShell, then rerun this script."
        exit 1
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. Git
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Checking Git"
if (Invoke-CheckCommand "git") {
    Write-Ok "$(git --version)"
} else {
    Write-Info "Git not found. Installing..."
    if ($HAS_WINGET) {
        winget install --id Git.Git --accept-source-agreements --accept-package-agreements
    } elseif ($HAS_CHOCO) {
        choco install git -y
    } elseif ($HAS_SCOOP) {
        scoop install git
    } else {
        Write-Err "Cannot install Git automatically."
        Write-Err "Download from https://git-scm.com/download/win and rerun."
        exit 1
    }
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Ok "Git installed"
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. npm PATH — make sure global bin is reachable
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Checking npm global PATH"
$npmPrefix = (npm config get prefix 2>$null).Trim()
Write-Info "npm global prefix: $npmPrefix"

$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$npmPrefix*") {
    Write-Warn "npm global prefix not in user PATH. Adding..."
    [System.Environment]::SetEnvironmentVariable(
        "Path",
        "$userPath;$npmPrefix",
        "User"
    )
    $env:Path = "$env:Path;$npmPrefix"
    Write-Ok "Added $npmPrefix to user PATH"
} else {
    Write-Ok "npm global prefix already on PATH"
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. Claude Code CLI
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Checking Claude Code CLI"
if (Invoke-CheckCommand "claude") {
    $claudeVer = (claude --version 2>$null | Select-Object -First 1)
    Write-Ok "claude already installed ($claudeVer)"
} else {
    Write-Info "Installing @anthropic-ai/claude-code..."
    npm install -g "@anthropic-ai/claude-code"
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User") + ";$npmPrefix"
    Write-Ok "Claude Code CLI installed"
}

# ─────────────────────────────────────────────────────────────────────────────
# 6. OpenClaw
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Checking OpenClaw"
if (Invoke-CheckCommand "openclaw") {
    $ocVer = (openclaw --version 2>$null | Select-Object -First 1)
    Write-Ok "openclaw already installed ($ocVer)"
    Write-Info "Updating to latest..."
    npm install -g openclaw@latest
    Write-Ok "OpenClaw updated"
} else {
    Write-Info "Installing openclaw@latest..."
    npm install -g openclaw@latest
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User") + ";$npmPrefix"
    Write-Ok "OpenClaw installed"
}

if (-not (Invoke-CheckCommand "openclaw")) {
    Write-Warn "openclaw not found in PATH after install."
    Write-Warn "Close and reopen PowerShell so the new PATH takes effect, then rerun."
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 7. Claude OAuth — setup-token
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "Claude authentication (OAuth)"
Write-Host ""
Write-Host "OpenClaw uses Claude Code OAuth — no raw API key needed." -ForegroundColor Cyan
Write-Host ""
Write-Host "This will:"
Write-Host "  1. Run  claude setup-token  (opens a browser login)"
Write-Host "  2. Ask you to paste the token into OpenClaw"
Write-Host ""

if (Confirm-Prompt "Run 'claude setup-token' now?") {
    Write-Host ""
    Write-Info "Running: claude setup-token"
    Write-Host "──────────────────────────────────────────────"
    try {
        claude setup-token
    } catch {
        Write-Warn "claude setup-token exited with an error."
        Write-Warn "You can retry later: claude setup-token && openclaw models auth setup-token"
    }
    Write-Host "──────────────────────────────────────────────"
    Write-Host ""
    Write-Info "Registering token with OpenClaw..."
    try {
        openclaw models auth setup-token
        Write-Ok "Authentication configured"
    } catch {
        Write-Warn "Token registration failed. Retry: openclaw models auth setup-token"
    }
} else {
    Write-Warn "Skipped. Run these manually when ready:"
    Write-Warn "  claude setup-token"
    Write-Warn "  openclaw models auth setup-token"
}

# ─────────────────────────────────────────────────────────────────────────────
# 8. Onboarding wizard
# ─────────────────────────────────────────────────────────────────────────────
if (-not $NoOnboard) {
    Write-Step "OpenClaw onboarding"
    Write-Host ""
    Write-Host "The wizard will configure your gateway, channels, and workspace."
    Write-Host ""
    if (Confirm-Prompt "Run 'openclaw onboard' now?") {
        openclaw onboard
    } else {
        Write-Warn "Skipped. Run 'openclaw onboard' whenever you're ready."
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  Setup complete — OpenClaw Voltek is ready!  ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Start gateway:    openclaw gateway run"
Write-Host "  Re-authenticate:  claude setup-token; openclaw models auth setup-token"
Write-Host "  Re-run onboard:   openclaw onboard"
Write-Host "  Health check:     openclaw doctor"
Write-Host ""
Write-Host "  Support: openclaw@voltekit.com" -ForegroundColor Cyan
Write-Host ""
