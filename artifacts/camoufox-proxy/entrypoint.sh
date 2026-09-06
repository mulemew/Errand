#!/bin/sh
# Xvfb, a live view of it, then the launcher API. Everything runs as `app`.
set -e

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# ── The container-wide display, and a live view of it ────────────────────────
# One process now, not three. KasmVNC's Xvnc IS the X server, the VNC server and the web
# server, which is why there is no x11vnc here any more — that one leaked 62 shared-memory
# segments every time it was killed, and after about 66 sessions no new one could start at
# all: the view connected, upgraded, and showed a blank screen with no error anywhere.
#
# The port is never published. The app proxies it on its own origin behind the same login
# as everything else, so it sits inside the docker network exactly like this sidecar's API
# on 7318 — which has never been authenticated either. A VNC password on top of that is a
# second lock on an interior door.
#
# VNC_DISABLE=1 falls back to a plain Xvfb: the browser still renders, nobody can watch.
if [ "$VNC_DISABLE" = "1" ]; then
  echo "[vnc] disabled by VNC_DISABLE=1 — plain Xvfb, no live view"
  Xvfb :99 -screen 0 "${CAMOUFOX_SCREEN:-1920x1080x24}" -ac &
else
  # Check before claiming. This used to announce "live view ready" whether or not anything
  # was listening, so a missing binary looked exactly like a working viewer right up until
  # the app got a connection refused and returned a 502 with nothing to point at.
  if ! command -v Xvnc >/dev/null 2>&1; then
    echo "[vnc] Xvnc missing — this image predates KasmVNC; falling back to Xvfb with no live view" >&2
    Xvfb :99 -screen 0 "${CAMOUFOX_SCREEN:-1920x1080x24}" -ac &
  else
    geom="${CAMOUFOX_SCREEN:-1920x1080x24}"
    wh="${geom%x*}"; depth="${geom##*x}"
    mkdir -p "${KASM_DOWNLOAD_DIR:-$HOME/Downloads}"
    # -rfbport 0: no raw VNC listener, the websocket is the only door. -DisableBasicAuth
    # needs the explicit 1; the bare flag is accepted and ignored.
    Xvnc :99 -geometry "$wh" -depth "$depth"          -websocketPort "${VNC_PORT:-7900}" -rfbport 0          -httpd "${KASM_WWW_DIR:-/usr/share/kasmvnc/www}"          -SecurityTypes None -DisableBasicAuth 1 -AlwaysShared -interface 0.0.0.0 &
    echo "[vnc] live view ready on :${VNC_PORT:-7900} (KasmVNC — proxied by the app, not published)"
  fi
fi

# Wait for the DISPLAY to exist rather than sleeping a fixed amount: Xvnc has more to set
# up than Xvfb did, and a browser started against a half-ready display dies on connect.
i=0
while [ ! -e /tmp/.X11-unix/X99 ] && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.1; done
[ -e /tmp/.X11-unix/X99 ] || echo "[vnc] WARNING: :99 never appeared" >&2

exec python server.py
