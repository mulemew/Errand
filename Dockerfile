# =============================================================
# Errand — single container (API + Web UI + bundled Chromium)
# Includes Patchright's patched Chromium for the "local" browser provider.
# Also works with remote CDP services (browserless, etc.) via the
# "playwright" or "puppeteer" provider settings.
# =============================================================

# ─── Stage 1: Workspace dependencies (shared) ────────────────
# --platform=$BUILDPLATFORM: compile JS on the build host (amd64) natively.
# The Vite/Rollup output is pure JS — platform-agnostic — so this is safe.
#
# The web and API builders used to run a full `pnpm install` EACH, installing the
# same workspace twice per image and twice again for the second architecture.
# Installing once here and branching off it removes that duplicate work, and the
# layer is cached across builds because only manifests land in it — editing
# source no longer re-resolves dependencies.
FROM --platform=$BUILDPLATFORM node:20-bookworm AS deps

WORKDIR /workspace
# Pinned to the same major the workflow's typecheck job installs. Unpinned, this took
# whatever npm called latest, and pnpm 12 stopped honouring the workspace's
# onlyBuiltDependencies — the image then failed to build on a commit that touched no
# dependency at all.
RUN npm install -g pnpm@10

# Manifests only (plus lib/, whose sources both builders need anyway) so that a
# code change does not invalidate the install layer.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ lib/
COPY artifacts/web-ui/package.json artifacts/web-ui/
COPY artifacts/api-server/package.json artifacts/api-server/
COPY scripts/package.json scripts/

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build web UI ───────────────────────────────────
FROM deps AS web-builder
COPY artifacts/web-ui/ artifacts/web-ui/
ENV BASE_PATH=/ NODE_ENV=production
RUN pnpm --filter @workspace/web-ui run build

# ─── Stage 3: Build API server ───────────────────────────────
FROM deps AS api-builder
COPY artifacts/api-server/ artifacts/api-server/
RUN pnpm --filter @workspace/api-server run build

# ─── Stage: sing-box binary source ───────────────────────────
# SagerNet publishes an official multi-arch image on ghcr.io (the same registry
# this workflow already authenticates to and caches against). Copying the binary
# from it is far more reliable in CI than downloading the release tarball from
# github.com, whose asset CDN intermittently times out and broke the build.
# buildx resolves this FROM per target platform, so each arch gets its own binary.
FROM ghcr.io/sagernet/sing-box:v1.14.0 AS singbox

# ─── Stage 3: Production runtime ─────────────────────────────
FROM node:20-bookworm-slim AS runner

# Minimal system deps. The app container no longer runs a local browser — all
# browsing goes to the cf-proxy sidecar (SeleniumBase) or a remote CDP service —
# so Chromium's runtime libs, Xvfb/xdotool/fluxbox and screenshot fonts are gone.
# This is what makes the image small and the build fast.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # wget — healthcheck
    wget \
    # curl — /tasks/:id/proxy-geo queries the exit IP's geolocation THROUGH the
    # configured proxy (handles socks5:// and http:// uniformly, unlike undici).
    curl \
    # ca-certificates — without it curl cannot make ANY https request from this
    # container: it fails before connecting, with
    #   curl: (77) error setting certificate file: /etc/ssl/certs/ca-certificates.crt
    # The slim base does not ship a CA bundle, and nothing noticed because the geo
    # check only ever fetched an http:// URL. The moment it preferred https targets —
    # which is how a browser uses a proxy, over CONNECT — every probe failed inside
    # the container while the identical curl worked from the host. The proxy was fine
    # throughout; this image simply could not speak TLS.
    ca-certificates \
    # tini — PID-1 init that reaps orphaned sing-box helpers
    tini \
  && rm -rf /var/lib/apt/lists/*

# ─── sing-box (advanced proxy protocols: VLESS/VMess/Trojan/Hysteria2/WARP) ───
# The proxy-manager starts sing-box on demand to expose a local SOCKS5 inbound
# that Chromium can consume. Passthrough http/socks5 proxies do NOT need this.
#
# The binary is copied from SagerNet's official multi-arch image (see the
# "singbox" stage above) rather than downloaded at build time — the release
# CDN on github.com intermittently times out and silently broke the image
# (it shipped WITHOUT sing-box, so every advanced-proxy task failed at runtime
# with "sing-box is not installed on this host"). We still verify the binary
# actually runs so a broken build never reaches production.
COPY --from=singbox /usr/local/bin/sing-box /usr/local/bin/sing-box
RUN set -eux; \
    chmod +x /usr/local/bin/sing-box; \
    /usr/local/bin/sing-box version

WORKDIR /app

# Install puppeteer + playwright-core ONLY for the remote-CDP providers
# (playwright/puppeteer connect to an external browser service — no local browser
# is downloaded). The "local" Patchright provider was removed, so patchright and
# its bundled Chromium are no longer installed — this is the bulk of the size/
# build-time savings.
COPY artifacts/api-server/package.json ./package-src.json
RUN node -e "\
  const p = JSON.parse(require('fs').readFileSync('./package-src.json', 'utf-8'));\
  const out = { name: 'errand', version: '1.0.0', type: 'module',\
    dependencies: {\
      puppeteer: p.dependencies.puppeteer,\
      'playwright-core': p.dependencies['playwright-core']\
    }\
  };\
  require('fs').writeFileSync('./package.json', JSON.stringify(out, null, 2));\
  " && rm package-src.json

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev

# API bundle (pino workers are included by esbuild-plugin-pino)
COPY --from=api-builder /workspace/artifacts/api-server/dist ./dist

# Web UI static assets — Express serves these from dist/public at runtime
COPY --from=web-builder /workspace/artifacts/web-ui/dist/public ./dist/public

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data

# The unprivileged user for the server. Both sidecars already run as one; this image did
# not, so the process that drives browsers and holds decrypted credentials ran as uid 0.
#
# `node` is the base image's own user and it is uid 1000 — the same uid the camoufox and
# cf-proxy sidecars deliberately pick, so a bind-mounted data directory has one owner
# across all three. Creating another is not possible anyway: `useradd -u 1000 app` fails
# with "UID 1000 is not unique", and a different uid would defeat the reason they match.
#
# The switch happens in the entrypoint rather than with USER, because DATA_DIR is a volume
# whose existing contents belong to root on every instance that already exists — see the
# script for what it does about that.

# Only the data directory. `chown -R /app` would copy node_modules and dist into a new
# layer for nothing: the server reads those, it never writes them.
RUN mkdir -p /app/data/screenshots && chown -R node:node /app/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/healthz || exit 1

# tini as PID 1 (-g forwards signals to the whole process group) reaps orphaned
# sing-box helpers that reparent to PID 1 if the Node child-registry misses them.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/docker-entrypoint.sh"]

# No local browser to launch anymore — just run the Node server (browsing goes to
# the cf-proxy sidecar or a remote CDP service, each with its own display).
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
