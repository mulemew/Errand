#!/bin/sh
# Xvfb, a live view of it, then the launcher API. Everything runs as `app`.
set -e

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1920x1080x24 -ac &
sleep 2

# ── Live view ────────────────────────────────────────────────────────────────
# On by default. The browser here is genuinely headful on :99, so this is the real run —
# the actual widget, the actual click, the actual spinner — and having to remember an
# environment variable before you can look at your own automation is friction for nothing.
#
# It is not an exposure: this port is never published. The app proxies it on its own origin,
# behind the same login as everything else, so it sits inside the docker network exactly
# like this sidecar's API on 7318 — which has never been authenticated either. A VNC
# password on top of that is a second lock on an interior door.
#
# VNC_DISABLE=1 for anyone who wants the door bricked up anyway.
if [ "$VNC_DISABLE" = "1" ]; then
  echo "[vnc] disabled by VNC_DISABLE=1"
else
  # Check before claiming. This used to announce "live view ready" whether or not anything
  # was listening — websockify is backgrounded with its output discarded — so a missing
  # binary looked exactly like a working viewer, right up until the app got a connection
  # refused and returned a 502 with nothing to point at.
  missing=""
  command -v x11vnc >/dev/null 2>&1 || missing="$missing x11vnc"
  command -v websockify >/dev/null 2>&1 || missing="$missing websockify"
  [ -d /usr/share/novnc ] || missing="$missing /usr/share/novnc"
  if [ -n "$missing" ]; then
    echo "[vnc] NOT starting the live view — missing:$missing (this image predates the viewer; pull a current one)" >&2
  else
    # -forever: survive a viewer disconnecting.  -shared: more than one watcher.
    x11vnc -display :99 -nopw -rfbport 5900 -forever -shared -quiet -bg >/dev/null 2>&1 || \
      echo "[vnc] x11vnc failed to start — the live view will be unavailable" >&2
    # noVNC serves the HTML client and proxies WebSocket → 5900, so a browser tab is enough.
    websockify --web /usr/share/novnc "${VNC_PORT:-7900}" localhost:5900 >/dev/null 2>&1 &
    echo "[vnc] live view ready on :${VNC_PORT:-7900} (proxied by the app — not published)"
  fi
fi

exec python server.py
