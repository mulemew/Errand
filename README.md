# Errand

A self-hosted platform for **testing browser automation against your own production systems** —
scheduled end-to-end runs that exercise real login flows, sessions, proxies and anti-bot
defences, and report what actually happened.

It exists to answer questions you cannot answer from a staging environment: does the login
form still work from a datacentre IP, did the session survive the deploy, does the WAF rule
you shipped last night lock out your own monitoring, does the checkout page still render
behind the CDN in another region.

## Acceptable use / 使用限制

**Only run Errand against systems you own or have written authorization to test.**

Anti-bot handling (Cloudflare challenges, captcha solving, fingerprint and proxy control)
exists so that authorized end-to-end verification is not blocked by your own defences.
Pointing it at third-party services is out of scope and explicitly disallowed — including
scraping, credential testing, sign-up or reward farming, scheduled check-ins or renewals on
someone else's platform, circumventing rate limits or terms of service, and anything whose
value comes from a service not knowing an automated client is there.

Nothing in this repository targets, or is tuned for, any particular website.

You are responsible for the legality of what you automate. If you are unsure whether a
target is in scope, it is not.

> **仅限用于你自己拥有、或已获得书面授权的系统。**
>
> 项目中的反爬/验证码/指纹/代理相关能力，目的是让**授权范围内**的端到端验证不被你自己的
> 防护策略挡住，不是用来绕过别人的防护。**严禁滥用**：包括但不限于抓取第三方数据、撞库、
> 批量注册、薅羊毛、在他人平台上做定时签到或续期、绕过限流或违反服务条款，以及任何「靠对方
> 不知道这是自动化」才成立的用途。
>
> 本仓库不针对任何特定网站，也不包含任何特定网站的适配。
>
> 你需要自行承担所自动化行为的合法性责任。不确定目标是否在授权范围内时，就当作不在。

---

## What it does

- **Scheduled runs** — cron or manual, with retry policy and per-window run limits
- **Workflow steps** — navigate, click (text / CSS / XPath), fill, select, wait, key press,
  scroll, screenshot, dismiss popups, conditional branches
- **Login flows** — password forms, TOTP, email OTP, and OAuth (GitHub / Google), so an
  end-to-end test can start from a genuinely signed-out state
- **Session reuse** — the authenticated storage state is encrypted and kept per task; the
  next run restores it, checks whether it is still valid, and only logs in again when it is
  not. This is how you tell "the session broke" apart from "the login broke"
- **Session isolation** — every run gets a fresh browser context, so one run's state can
  never explain another's result
- **Per-task proxy** — HTTP, SOCKS5, and via bundled sing-box: VLESS, VMess, Trojan,
  Hysteria2, TUIC, Shadowsocks and Cloudflare WARP. Verify a page from the region and exit
  IP your users actually come from
- **Fingerprint profiles** — OS, timezone, locale, screen and WebGL identity, saved as
  profiles and attached per provider or per task
- **Anti-bot handling** — Cloudflare interstitials and Turnstile, plus captcha support via
  2Captcha / Capsolver / Anti-Captcha, and a local reCAPTCHA audio solver (faster-whisper,
  no API key). See the acceptable-use section above for what this is and is not for
- **Browser providers** — bundled Chromium, SeleniumBase (undetected-chromedriver),
  Camoufox (anti-detect Firefox), browserless, or any CDP-compatible remote — each with its
  own concurrency limit
- **Run history** — per-step logs, screenshots at the point of failure, exit-IP geolocation,
  and 30 days of pass/fail history per task
- **Encrypted at rest** — AES-256-GCM for every saved credential and persisted session

---

## Quick start (Docker Compose)

### 1. Clone

```bash
git clone https://github.com/mulemew/Errand.git
cd Errand
```

### 2. Configure

```bash
cp .env.example .env
```

Only two values are required:

| Variable | Description |
|---|---|
| `DASHBOARD_PASSWORD` | Initial login password (can also be set in the browser on first visit) |
| `POSTGRES_PASSWORD` | Password for the bundled PostgreSQL container |

Everything else is either auto-generated or configurable in the Settings and Providers pages
after startup.

### 3. Start

```bash
docker compose up -d
```

| File | Use |
|---|---|
| `docker-compose.yml` | Builds the images from this checkout |
| `docker-compose.image.yml` | Pulls the prebuilt images from GHCR |

Open **http://localhost** and sign in.

---

## Architecture

```
┌──────────────────────────────────┐
│  app                             │
│  Node.js (Express)               │
│  ├── /api/*  → API               │
│  └── /*      → Web UI (SPA)      │
│  Chromium (bundled)              │
└──────────────────────────────────┘
      │            │            │
      ▼            ▼            ▼
┌──────────┐ ┌──────────────┐ ┌──────────────────┐
│ postgres │ │ provider-    │ │ provider-        │
│          │ │ seleniumbase │ │ camoufox         │
└──────────┘ └──────────────┘ └──────────────────┘
```

The two provider containers are optional browser backends, selected per task on the
Providers page. Images are published to GHCR on every push to `main`:

```
ghcr.io/mulemew/errand
ghcr.io/mulemew/provider-seleniumbase
ghcr.io/mulemew/provider-camoufox
```

---

## Using an external PostgreSQL

Set `DATABASE_URL` and comment out the bundled `db` service (and the `app` service's
`depends_on: db`):

```env
DATABASE_URL=postgresql://user:password@your-pg-host:5432/dbname
```

Works with Neon, Supabase, Aiven, Railway, RDS and any standard PostgreSQL. Migrations run
on startup against whatever `DATABASE_URL` points at.

---

## Configuration reference

Most settings live in the app (Settings and Providers pages). These are the ones that must
be in the environment, because they are needed before the database is readable:

| Variable | Required | Description |
|---|---|---|
| `DASHBOARD_PASSWORD` | First run | Initial login password (stored in the DB afterwards) |
| `POSTGRES_PASSWORD` | Compose only | Password for the bundled Postgres container |
| `DATABASE_URL` | External DB only | PostgreSQL connection string |
| `SESSION_SECRET` | No | Auto-generated on first run — set only to restore a backup |
| `ENCRYPTION_KEY` | No | Auto-generated on first run — **never change it afterwards or saved credentials become unreadable** |
| `PORT` | No | Host port (default `80`) |
| `LOG_LEVEL` | No | Starting log level. Settings → Log level changes it live and takes precedence |
| `BROWSERLESS_URL` | Browserless only | WebSocket endpoint (`wss://...`) |
| `CF_PROXY_URL` / `CAMOUFOX_URL` | No | Only when a provider sidecar runs somewhere other than the bundled compose service |
| `WARP_CONFIG_PATH` | WARP proxy only | Path to a sing-box WireGuard outbound JSON (generate with `wgcf`/warp-reg), used when a task's proxy type is `warp` |
| `SINGBOX_PROXY_PUBLIC_HOST` | No | Host/IP the **browser** dials to reach the on-demand sing-box SOCKS5. Only relevant when the browser runs in a **separate container** (browserless / provider-seleniumbase / remote CDP). Auto-detected from the app container's non-loopback IP; set it explicitly if auto-detection picks the wrong interface |
| `SINGBOX_PROXY_LISTEN_HOST` | No | Interface the sing-box SOCKS5 inbound binds to. Defaults to `0.0.0.0` so sibling containers can reach it; `127.0.0.1` restricts it to the local container (safe only with the bundled browser) |

Captcha keys, the audio-solver engine order and the wit.ai token are configured under
**Settings → Captcha**; the browser backend, concurrency, stealth flags and session timeouts
under **Providers**. The corresponding environment variables still work as a fallback, and
the pages show when a value is coming from the environment.

> **Backing up secrets**: `SESSION_SECRET` and `ENCRYPTION_KEY` are written to
> `data/secrets.json` inside the `autoops_data` volume. Back this file up before migrating
> to a new host. (The volume keeps its original name so that upgrading an existing
> deployment does not point it at an empty volume.)

---

## Per-task browser, proxy and session options

Each task can override the global defaults:

- **Provider** — which browser backend runs it, or "default" to follow whichever provider is
  starred on the Providers page
- **Proxy** — a saved proxy profile, or an inline address:
  - `HTTP/HTTPS` / `SOCKS5` — a normal proxy URL (`http://user:pass@host:8080`,
    `socks5://host:1080`); the browser connects to it directly
  - `VLESS` / `VMess` / `Trojan` / `Hysteria2` / `TUIC` / `Shadowsocks` — a node share link.
    A per-run sing-box helper dials the node and exposes a SOCKS5 for the browser. When the
    browser runs in a separate container the helper binds to all interfaces and advertises a
    cross-container address instead of `127.0.0.1`
  - `Cloudflare WARP` — set `WARP_CONFIG_PATH` and leave the address blank
- **Fingerprint** — a saved fingerprint profile, or none for the browser's own identity
- **Headed mode** — run with a visible window on the container's Xvfb display, for
  troubleshooting. The SeleniumBase backend is always headed

### Session / cookie mode

On any login step:

- After a successful run the authenticated storage state (cookies + localStorage) is
  encrypted and saved for that task
- The next run restores it into a fresh context and checks whether it is still valid — if so
  the login step is skipped entirely; if not, it logs in again and re-saves
- State is isolated per task (optionally per `sessionKey`), so no run can inherit another's

Filling in a success criterion on the login step is what makes that check reliable; without
one the task falls back to reading the page and simply logs in again when it cannot tell.

---

## Deployment

### VM / VPS

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/mulemew/Errand.git
cd Errand && cp .env.example .env
docker compose up -d
```

Put Caddy or Traefik in front for TLS.

### Prebuilt image

```bash
docker pull ghcr.io/mulemew/errand:latest
```

```bash
docker run -d -p 80:8080 -v autoops_data:/app/data \
  -e DATABASE_URL=postgresql://... -e DASHBOARD_PASSWORD=... \
  ghcr.io/mulemew/errand:latest
```

### Kubernetes / Coolify / Portainer

The container listens on `8080`, needs a PostgreSQL database and a persistent volume at
`/app/data` (secrets and screenshots), ~512 MB RAM minimum, and does **not** need root or
privileged mode.

### Not serverless

Errand runs its own scheduler and keeps a browser alive. **Do not deploy it anywhere that
scales to zero.** Use a VM or an always-on container.

---

## Development

### Dev container (recommended)

```bash
git clone https://github.com/mulemew/Errand.git
code Errand
# VS Code: "Reopen in Container"
```

PostgreSQL, migrations and a full Chromium environment come up automatically; hot reload
works for both the API and the web UI.

### Local without Docker

Requires Node.js 20+, pnpm and a PostgreSQL instance.

```bash
pnpm install
```

The schema is applied by the server itself on startup, so there is no migration step:
point it at an empty database and it creates what it needs.

```bash
pnpm --filter @workspace/api-server run dev
```

```bash
pnpm --filter @workspace/web-ui run dev
```

Chromium is not installed by this path — browser steps need one available separately.

### Build the image

```bash
docker build -t errand .
```

---

## License

[MIT](LICENSE) © 2026 mulemew
