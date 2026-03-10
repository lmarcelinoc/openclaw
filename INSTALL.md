# OpenClaw Voltek — Installation Guide

> **OpenClaw Voltek** is a customised distribution of the open-source [OpenClaw](https://github.com/openclaw/openclaw) gateway, maintained by Voltek and actively receiving upstream updates.
>
> Support: **openclaw@voltekit.com**

---

## Quick start — automated setup (recommended)

The setup scripts check for every dependency, install anything missing, walk you through OAuth login, and launch the onboarding wizard. **Start here.**

**Linux / macOS:**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/lmarcelinoc/openclaw/main/setup.sh)
```

Or if you already have the repo:

```bash
bash setup.sh
```

**Windows (PowerShell):**

```powershell
# Allow scripts to run (one-time)
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser

# Run setup
.\setup.ps1
```

Both scripts are safe to rerun — they skip steps that are already done.

---

## Before you start — get your Claude credentials

OpenClaw Voltek authenticates via **Claude Code OAuth** (the Anthropic Agent SDK). This means you log in through the `claude` CLI — no raw API key needed.

**Step 1 — Install the Claude Code CLI**

```bash
npm install -g @anthropic-ai/claude-code
```

**Step 2 — Generate a setup token**

```bash
claude setup-token
```

This opens a browser login (or prints a URL). After you authorise, it prints a short-lived setup token. Copy it.

**Step 3 — Keep the token ready**

The OpenClaw setup wizard (`openclaw onboard`) will ask you to paste it. You can also set it as an environment variable:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=<token from step 2>
```

That's it — no `sk-ant-...` API key required.

---

## Prerequisites

| Requirement                | Version         | Notes                                                |
| -------------------------- | --------------- | ---------------------------------------------------- |
| Node.js                    | **22 or newer** | The installer handles this automatically             |
| Claude Code CLI (`claude`) | latest          | `npm install -g @anthropic-ai/claude-code` for OAuth |
| Git                        | any recent      | Required for some install paths                      |
| Internet access            | —               | To pull packages and reach Anthropic                 |

---

## Install on Linux

### One-line install (recommended)

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
```

This automatically installs Node 22 if needed (via apt, dnf, or Homebrew), installs OpenClaw globally, and launches the setup wizard.

### Manual install (npm)

```bash
# 1. Install Node 22 — Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 1. Install Node 22 — Fedora/RHEL
sudo dnf install nodejs

# 2. Install OpenClaw Voltek
npm install -g openclaw@latest

# 3. Run the setup wizard
openclaw onboard --install-daemon
```

### Fix: permission error on `npm install -g`

If you see `EACCES`, switch npm to a user-writable prefix first:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
```

Then re-run `npm install -g openclaw@latest`.

---

## Install on macOS

### One-line install (recommended)

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
```

Installs Homebrew if missing, installs Node 22 via Homebrew, installs OpenClaw, and launches the setup wizard.

### Manual install (Homebrew + npm)

```bash
# 1. Install Homebrew (skip if already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Install Node 22
brew install node

# 3. Install OpenClaw Voltek
npm install -g openclaw@latest

# 4. Run the setup wizard
openclaw onboard --install-daemon
```

### Fix: `openclaw: command not found` after install

```bash
# Find where npm puts global binaries
npm prefix -g
# → e.g. /opt/homebrew/lib

# That directory's /bin should already be on PATH via Homebrew.
# If not, add to ~/.zshrc:
echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

---

## Install on Windows (PowerShell)

> **Recommendation:** Use **WSL2** (Windows Subsystem for Linux) and follow the Linux instructions above — it gives the smoothest experience. Instructions below are for native Windows installs.

### One-line install (PowerShell)

Open **PowerShell** as your normal user (not Administrator) and run:

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

This installs Node 22 via winget (falls back to Chocolatey or Scoop), installs OpenClaw globally, and launches the setup wizard.

### Manual install (PowerShell)

```powershell
# 1. Install Node 22 via winget
winget install OpenJS.NodeJS.LTS

# Close and reopen PowerShell so node/npm are on PATH, then:

# 2. Install OpenClaw Voltek
npm install -g openclaw@latest

# 3. Run the setup wizard
openclaw onboard
```

### Fix: `openclaw is not recognized`

```powershell
# Find npm's global prefix
npm config get prefix
# → e.g. C:\Users\YourName\AppData\Roaming\npm

# Add that path to your user PATH:
# Settings → System → About → Advanced system settings → Environment Variables
# Under "User variables" → select Path → Edit → New → paste the path above
# Reopen PowerShell
```

### Fix: PowerShell execution policy error

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

## Setup wizard (`openclaw onboard`)

After install, the wizard walks you through:

1. **Gateway configuration** — port, network binding (loopback by default), auth token
2. **Auth** — choose the OAuth / setup-token option and paste the token from `claude setup-token`
3. **Model selection** — defaults to the latest Claude model
4. **Channel setup** — connect Telegram, WhatsApp, Slack, Discord, etc.
5. **Skills** — enable web search, memory, and other tools

```bash
openclaw onboard
# or, to also install as a background daemon:
openclaw onboard --install-daemon
```

---

## Configure credentials manually

If you skipped the wizard or need to re-authorise, run:

```bash
# Re-generate a token
claude setup-token

# Register it with OpenClaw
openclaw models auth setup-token
```

Or set the env var in `~/.openclaw/.env` before starting the gateway:

```bash
echo 'CLAUDE_CODE_OAUTH_TOKEN=<your token>' >> ~/.openclaw/.env
```

On Windows (PowerShell):

```powershell
Add-Content "$env:USERPROFILE\.openclaw\.env" "CLAUDE_CODE_OAUTH_TOKEN=<your token>"
```

Tokens expire. If the gateway stops responding with auth errors, re-run `claude setup-token` and `openclaw models auth setup-token`.

---

## First run — meet your assistant

After `openclaw onboard` completes, open the web chat or your connected messaging app and send any message. Your assistant will:

1. Introduce itself ("Hey. I just came online. Who am I? Who are you?")
2. Ask for its name, personality, and emoji
3. Ask for your name and preferences
4. Update its workspace files (`IDENTITY.md`, `USER.md`) with what it learns

This only happens once. After that it knows who it is.

---

## Start / stop the gateway

```bash
# Start
openclaw gateway run

# Start on a specific port
openclaw gateway run --port 18789

# Check status
openclaw channels status --probe

# Stop (macOS launchd daemon)
openclaw gateway stop

# Restart (Linux systemd)
systemctl --user restart openclaw-gateway
```

---

## Update

```bash
npm install -g openclaw@latest
```

```powershell
# Windows
npm install -g openclaw@latest
```

---

## Troubleshooting

| Problem                          | Fix                                                                |
| -------------------------------- | ------------------------------------------------------------------ |
| `openclaw: command not found`    | npm global bin isn't on PATH — see platform section above          |
| `EACCES` on npm install          | Switch to user-writable npm prefix — see Linux section             |
| Gateway won't start              | Run `openclaw doctor` to diagnose                                  |
| Auth errors / token expired      | Rerun `claude setup-token` then `openclaw models auth setup-token` |
| Execution policy error (Windows) | `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`              |
| Node version too old             | Install Node 22+ (see platform section)                            |

Run `openclaw doctor` for a full health check.

---

## More resources

- Configuration reference: `openclaw configure`
- Channel setup (Telegram, WhatsApp, etc.): `openclaw onboard --skip-gateway`
- Logs: `~/.openclaw/logs/`
- Config file: `~/.openclaw/openclaw.json`
- Workspace files: `~/.openclaw/workspace/`

**Support: openclaw@voltekit.com**

---

_OpenClaw Voltek is built on the open-source [OpenClaw](https://github.com/openclaw/openclaw) gateway (MIT licence). Upstream updates are regularly merged._
