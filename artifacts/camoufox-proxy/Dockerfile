FROM python:3.11-slim-bookworm

# Camoufox is a patched Firefox. It needs the usual GTK/X libs + Xvfb for its
# "virtual" headful mode (headful-on-virtual-display is harder to detect than headless).
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libgtk-3-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libasound2 libdbus-glib-1-2 libxt6 libpci3 fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Run as a NON-ROOT user (uid 1000, matching the cf-proxy sidecar so host-side ownership
# is consistent). A browser is the most exposed process in this stack — it renders hostile
# pages all day — and Firefox, unlike Chrome, runs as root without complaint, so nothing
# was stopping it. Everything below runs as this user: the browser, Xvfb and the API.
RUN useradd -m -u 1000 app

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

# Xvfb for Camoufox's "virtual" headful mode, then the launcher API. Both run as `app`;
# /tmp is world-writable, so the X socket and its lock file need no privileges.
ENTRYPOINT ["/bin/sh", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99; Xvfb :99 -screen 0 1920x1080x24 -ac & sleep 2 && exec python server.py"]
