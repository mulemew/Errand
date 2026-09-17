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

## 生产部署 / Production deployment

生产环境**不需要克隆代码、不需要构建**。三个镜像都是公开的预构建镜像（`linux/amd64` 与
`linux/arm64`），每次合并到 `main` 自动发布：

| 镜像 | 作用 |
|---|---|
| `ghcr.io/mulemew/errand:latest` | 主程序（API + 管理界面 + 内置 Chromium） |
| `ghcr.io/mulemew/provider-seleniumbase:latest` | 浏览器后端：SeleniumBase（undetected Chrome） |
| `ghcr.io/mulemew/provider-camoufox:latest` | 浏览器后端：Camoufox（反检测 Firefox，带实时画面） |

另外会用到两个官方公开镜像：`postgres:16-alpine`、`ghcr.io/browserless/chromium:latest`。

### 0. 准备

- 一台常驻运行的 Linux 服务器（VPS / 虚拟机 / 物理机，x86_64 或 ARM64）
- Docker Engine 与 Docker Compose v2（`docker compose version` 能输出版本即可）

  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

- 内存要留足：两个浏览器后端容器各自申请 2 GB 共享内存（`shm_size: 2g`），同时跑多个浏览器会继续占用

> **不要部署到会缩容到零的平台**（Serverless、按请求计费的容器平台）。Errand 自带调度器，
> 并且要常驻浏览器进程。

### 1. 创建目录并下载编排文件

```bash
mkdir -p /opt/errand && cd /opt/errand
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/mulemew/Errand/main/docker-compose.yml
```

这份文件里所有服务都用 `image:` 直接拉镜像，没有任何 `build:`。

### 2. 创建 `.env`

在同一目录新建 `.env`：

```env
# ── 必填 ──────────────────────────────────────────────
# 内置 PostgreSQL 的密码。首次启动后就写进数据库卷，之后不要再改。
POSTGRES_PASSWORD=换成一个足够长的随机字符串

# ── 按需填写 ──────────────────────────────────────────
# 管理界面登录密码。不填也行：第一次打开页面时会让你在浏览器里设置。
#DASHBOARD_PASSWORD=

# 对外端口，默认 80
#PORT=80

# 放在 HTTPS 反向代理（Caddy / Nginx / Traefik）后面时，下面两项都要打开：
#SECURE_COOKIES=true
#TRUST_PROXY_HOPS=1
```

生成随机密码：

```bash
openssl rand -hex 24
```

**只有 `POSTGRES_PASSWORD` 是必填的。** 加密密钥 `ENCRYPTION_KEY` 与会话密钥
`SESSION_SECRET` 会在首次启动时自动生成，保存在数据卷的 `data/secrets.json`
里（见下方「备份」）。

### 3. 启动

```bash
docker compose pull
docker compose up -d
```

查看状态，等所有服务都变成 `healthy`（首次启动数据库初始化需要一两分钟）：

```bash
docker compose ps
```

有问题看日志：

```bash
docker compose logs -f app
```

### 4. 登录并完成初始化

浏览器打开 `http://服务器IP`（改过 `PORT` 就带上端口）：

1. 没填 `DASHBOARD_PASSWORD` 的话，按页面提示设置登录密码
2. 打开 **Providers** 页，确认浏览器后端状态正常；需要默认用哪个就把它设为默认
3. 需要的话在 **Settings** 里配置验证码服务、日志级别等

到这里就能建任务了。

### 5. 配置 HTTPS（推荐）

用任意反向代理把域名转发到 `http://127.0.0.1:80`（或你设置的 `PORT`）。以 Caddy 为例：

```caddy
errand.example.com {
    reverse_proxy 127.0.0.1:80
}
```

然后在 `.env` 里打开 `SECURE_COOKIES=true` 与 `TRUST_PROXY_HOPS=1`，执行
`docker compose up -d` 让它生效。

- `SECURE_COOKIES=true`：登录 cookie 只通过 HTTPS 发送。**纯 HTTP 访问时千万别开**，否则登录后
  浏览器不会带 cookie，会一直回到登录页
- `TRUST_PROXY_HOPS=1`：前面有一层代理。登录限流按真实客户端 IP 计算；不设置时所有请求都会被
  当成来自代理本身
- 反代必须透传 WebSocket（`Upgrade` 头），否则任务详情里的实时画面连不上。Caddy 默认就支持

### 升级

```bash
cd /opt/errand
docker compose pull
docker compose up -d
```

`latest` 跟随 `main` 分支。升级前最好确认没有长时间运行的任务在跑，重启会中断正在执行的任务。

### 备份与迁移

需要备份两样东西：

| 内容 | 位置 |
|---|---|
| 数据库（任务、账号、会话，均已加密） | 卷 `pgdata` |
| 加密密钥与截图 | 卷 `autoops_data`，其中 **`secrets.json` 最关键** |

**`secrets.json` 丢了，数据库里所有已保存的密码和会话都无法解密。** 迁移到新服务器时，
把这两个卷一起带走；或者把 `secrets.json` 里的两个值分别填进新服务器 `.env` 的
`ENCRYPTION_KEY` 和 `SESSION_SECRET`。

导出 `secrets.json`：

```bash
docker compose cp app:/app/data/secrets.json ./secrets.json.bak
```

### 使用外部 PostgreSQL

在 `.env` 里设置 `DATABASE_URL`，并从 `docker-compose.yml` 中删掉 `db` 服务以及 `app` 的
`depends_on: db`：

```env
DATABASE_URL=postgresql://user:password@your-pg-host:5432/dbname
```

Neon、Supabase、RDS 等标准 PostgreSQL 均可。表结构在程序启动时自动创建与升级，不需要手动迁移。

### 环境变量一览

大部分配置在页面里改（Settings、Providers）。下面这些必须放在环境变量里，因为程序读数据库之前就要用到：

| 变量 | 是否必填 | 说明 |
|---|---|---|
| `POSTGRES_PASSWORD` | **必填**（使用内置数据库时） | 内置 PostgreSQL 密码 |
| `DATABASE_URL` | 仅外部数据库 | PostgreSQL 连接串，设置后优先于内置数据库 |
| `DASHBOARD_PASSWORD` | 否 | 初始登录密码；不填则首次访问时在页面设置，之后可在 Settings 修改 |
| `PORT` | 否 | 宿主机端口，默认 `80` |
| `SECURE_COOKIES` | HTTPS 反代后必填 | `true` 时 cookie 仅经 HTTPS 发送，默认 `false` |
| `TRUST_PROXY_HOPS` | HTTPS 反代后建议 | 前面代理的层数，一层就填 `1`，默认 `0` |
| `ENCRYPTION_KEY` | 否 | 自动生成。**生成后永远不要改**，只在迁移恢复时手动填 |
| `SESSION_SECRET` | 否 | 自动生成。迁移恢复时手动填 |
| `LOG_LEVEL` | 否 | 启动时的日志级别；Settings 里可随时修改且优先 |
| `CAMOUFOX_HEADLESS` | 否 | Camoufox 是否无头，默认 `false`（有头更不容易被识别） |
| `VNC_DISABLE` | 否 | 设为 `1` 关闭实时画面 |
| `WARP_CONFIG_PATH` | 仅用 WARP 代理时 | sing-box WireGuard 出站配置文件路径 |
| `BROWSERLESS_URL` / `CF_PROXY_URL` / `CAMOUFOX_URL` | 否 | 仅当浏览器后端不在同一个 compose 里时才需要改 |
| `SINGBOX_PROXY_PUBLIC_HOST` | 否 | 浏览器在独立容器时访问 sing-box 代理用的地址，默认自动探测 |
| `SINGBOX_PROXY_LISTEN_HOST` | 否 | sing-box 代理监听地址，默认 `0.0.0.0` |
| `WIT_AI_TOKEN` / `RECAPTCHA_STT_ORDER` | 否 | reCAPTCHA 音频识别兜底配置，通常在 Settings → 验证码 里设置 |

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

The provider containers are browser backends, selected per task on the Providers page.

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

## 开发 / Development

**这一节只用于改代码、本地调试和测试。生产环境请按上面的「生产部署」使用预构建镜像。**

### Dev container（推荐）

```bash
git clone https://github.com/mulemew/Errand.git
code Errand
# VS Code: "Reopen in Container"
```

PostgreSQL、表结构和完整的 Chromium 环境会自动就绪，API 和界面都支持热重载。

### 本地直接运行（不用 Docker）

需要 Node.js 20+、pnpm，以及一个 PostgreSQL。

```bash
pnpm install
```

表结构由服务端启动时自动创建，没有单独的迁移步骤，指向一个空数据库即可。

```bash
pnpm --filter @workspace/api-server run dev
```

```bash
pnpm --filter @workspace/web-ui run dev
```

这种方式不会安装浏览器，需要浏览器的步骤得另外准备。

### 用源码构建并整体跑起来（测试用）

`docker-compose.dev.yml` 会**从当前源码构建**全部镜像，用于验证改动能否完整跑通，不用于生产：

```bash
cp .env.example .env   # 至少填 POSTGRES_PASSWORD
docker compose -f docker-compose.dev.yml up -d --build
```

只构建主程序镜像：

```bash
docker build -t errand .
```

---

## License

[MIT](LICENSE) © 2026 mulemew
