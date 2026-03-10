# OpenClaw Voltek — Installation Guide

> **OpenClaw Voltek** is a customised distribution of the open-source [OpenClaw](https://github.com/openclaw/openclaw) gateway, maintained by Voltek and actively receiving upstream updates.
>
> Support: **openclaw@voltekit.com**

---

## Before you start — get your API key

OpenClaw Voltek runs on Claude (Anthropic). You need an API key before anything works.

1. Go to [https://console.anthropic.com](https://console.anthropic.com) and sign in (or create a free account)
2. Navigate to **API Keys → Create Key**
3. Copy the value — it starts with `sk-ant-...`
4. Keep it handy; the setup wizard will ask for it

---

## Prerequisites

| Requirement     | Version         | Notes                                        |
| --------------- | --------------- | -------------------------------------------- |
| Node.js         | **22 or newer** | The installer handles this automatically     |
| Git             | any recent      | Required for some install paths              |
| Internet access | —               | To pull packages and reach the Anthropic API |

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
2. **Auth / API key** — paste your `ANTHROPIC_API_KEY` here
3. **Model selection** — defaults to the latest Claude model
4. **Channel setup** — connect Telegram, WhatsApp, Slack, Discord, etc.
5. **Skills** — enable web search, memory, and other tools

```bash
openclaw onboard
# or, to also install as a background daemon:
openclaw onboard --install-daemon
```

---

## Configure your API key manually

If you skipped the wizard, add your key to `~/.openclaw/.env`:

```bash
# Create or edit ~/.openclaw/.env
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.openclaw/.env
```

On Windows (PowerShell):

```powershell
Add-Content "$env:USERPROFILE\.openclaw\.env" "ANTHROPIC_API_KEY=sk-ant-..."
```

---

## Claude Code SDK credentials (optional)

If you use Claude Code agent features:

```bash
# Log in once — credentials are saved automatically to ~/.claude/credentials.json
claude

# No separate key needed after that.
# For headless/CI environments, ANTHROPIC_API_KEY is used automatically.
```

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

| Problem                          | Fix                                                                        |
| -------------------------------- | -------------------------------------------------------------------------- |
| `openclaw: command not found`    | npm global bin isn't on PATH — see platform section above                  |
| `EACCES` on npm install          | Switch to user-writable npm prefix — see Linux section                     |
| Gateway won't start              | Run `openclaw doctor` to diagnose                                          |
| API key not working              | Check `~/.openclaw/.env` has `ANTHROPIC_API_KEY=sk-ant-...` with no quotes |
| Execution policy error (Windows) | `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`                      |
| Node version too old             | Install Node 22+ (see platform section)                                    |

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
