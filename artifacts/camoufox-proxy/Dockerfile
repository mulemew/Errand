FROM python:3.11-slim-bookworm

# Camoufox is a patched Firefox. It needs the usual GTK/X libs + Xvfb for its
# "virtual" headful mode (headful-on-virtual-display is harder to detect than headless).
# xdotool drives the REAL X pointer. Playwright's mouse only synthesises events inside the
# browser, and Cloudflare's interactive challenge does not act on those — the cursor arrives
# on the checkbox, the press is delivered to the widget's host, and the box never reacts.
# OS-level input is what the SeleniumBase sidecar has always used to clear the same widget
# (uc_gui_click_captcha), and it became possible here once every session got its own Xvfb.
# KasmVNC's Xvnc is the X server, VNC server and web server in one, replacing
# Xvfb + x11vnc + websockify. It also brings clipboard and file transfer, which
# noVNC-over-x11vnc cannot do. (Seamless clipboard needs a Chromium-based client browser.)
# Pinned: a silent major bump here would show up as a black live view.
ARG KASMVNC_VERSION=1.5.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xdotool ca-certificates curl \
    libgtk-3-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libasound2 libdbus-glib-1-2 libxt6 libpci3 fonts-liberation \
    libxfont2 libxkbfile1 libgnutls30 libjpeg62-turbo libwebp7 libpixman-1-0 \
    xauth xkb-data x11-xkb-utils libnss-wrapper \
  && arch="$(dpkg --print-architecture)" \
  && curl -fsSL -o /tmp/kasmvnc.deb \
       "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_${arch}.deb" \
  && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
  && rm -f /tmp/kasmvnc.deb \
  && rm -rf /var/lib/apt/lists/* \
  # Fail the build, not the first live view.
  && command -v Xvnc && command -v xdotool && command -v Xvfb

# Run as a NON-ROOT user (uid 1000, matching the cf-proxy sidecar so host-side ownership
# is consistent). A browser is the most exposed process in this stack — it renders hostile
# pages all day — and Firefox, unlike Chrome, runs as root without complaint, so nothing
# was stopping it. Everything below runs as this user: the browser, Xvfb and the API.
RUN useradd -m -u 1000 app && install -d -o app -g app /home/app/Downloads

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
  && chown -R app:app /app

USER app
# Set HOME explicitly rather than relying on Docker to derive it from /etc/passwd:
# camoufox resolves its browser directory from HOME, so if the fetch below and the runtime
# ever disagreed, the container would start with an empty cache and try to download the
# browser on first use.
ENV HOME=/home/app

# Download the Camoufox browser at build time so the first launch is instant and the
# container has no network dependency at runtime. Fetched AS the runtime user (it lands in
# ~/.cache/camoufox), and kept BEFORE the source copy so editing server.py does not
# invalidate this layer and re-download the browser on every build.
RUN python -m camoufox fetch

COPY --chown=app:app server.py launcher.py ./

ENV PYTHONUNBUFFERED=1
ENV DISPLAY=:99
ENV PORT=7318
EXPOSE 7318
# One view port per display: this container-wide one, plus one per session from
# CAMOUFOX_VIEW_PORT_BASE. Downloads live in the browser's own home so "Save as…" lands
# somewhere the viewer can reach.
ENV VNC_PORT=7900
ENV KASM_DOWNLOAD_DIR=/home/app/Downloads
EXPOSE 7900

# Xvfb for Camoufox's "virtual" headful mode, then the launcher API. Both run as `app`;
# /tmp is world-writable, so the X socket and its lock file need no privileges.
COPY --chown=app:app entrypoint.sh /app/entrypoint.sh
ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
