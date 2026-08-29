FROM python:3.11-slim-bookworm

# Camoufox is a patched Firefox. It needs the usual GTK/X libs + Xvfb for its
# "virtual" headful mode (headful-on-virtual-display is harder to detect than headless).
# xdotool drives the REAL X pointer. Playwright's mouse only synthesises events inside the
# browser, and Cloudflare's interactive challenge does not act on those — the cursor arrives
# on the checkbox, the press is delivered to the widget's host, and the box never reacts.
# OS-level input is what the SeleniumBase sidecar has always used to clear the same widget
# (uc_gui_click_captcha), and it became possible here once every session got its own Xvfb.
# KasmVNC replaces the Xvfb + x11vnc + websockify trio with ONE process (Xvnc), which is
# an X server, a VNC server and a web server at once. Three reasons, in order of how much
# they cost us:
#
#  1. x11vnc leaked 62 SysV shared-memory segments per instance because it was SIGKILLed on
#     teardown, and `kernel.shmmni` is 4096 — about 66 sessions before shmget started
#     failing for EVERY new x11vnc. It then died on startup while Xvfb and websockify came
#     up fine, leaving a view that connects, completes the WebSocket upgrade, and shows a
#     blank screen forever with no error anywhere. Removing x11vnc removes that failure
#     mode rather than managing it.
#  2. Clipboard, and file upload/download into the session, which noVNC-over-x11vnc cannot
#     do. (Seamless clipboard needs a Chromium-based CLIENT browser — Chrome, Edge. Firefox
#     users get the manual clipboard panel.)
#  3. One process per display instead of three, so teardown has one thing to get right.
#
# Pinned rather than "latest": this is the one piece of the image whose behaviour the live
# view depends on completely, and a silent major bump would be found by a black screen.
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
  # Fail the BUILD, not the first live view. An image that starts fine and only reveals at
  # runtime that it cannot serve a screen is the failure this check exists to prevent.
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
# Live view, served by KasmVNC itself (see entrypoint.sh). One port per display: the
# container-wide one here, and one per session allocated from CAMOUFOX_VIEW_PORT_BASE.
ENV VNC_PORT=7900
# Where KasmVNC puts files a user uploads into the session, and picks up downloads from.
# Inside the browser's own home so a page's "Save as…" lands somewhere the viewer can see.
ENV KASM_DOWNLOAD_DIR=/home/app/Downloads
EXPOSE 7900

# Xvfb for Camoufox's "virtual" headful mode, then the launcher API. Both run as `app`;
# /tmp is world-writable, so the X socket and its lock file need no privileges.
COPY --chown=app:app entrypoint.sh /app/entrypoint.sh
ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
