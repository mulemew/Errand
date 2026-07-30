#!/bin/sh
# Xvfb, optionally a live view of it, then the launcher API. Everything runs as `app`.
set -e

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1920x1080x24 -ac &
sleep 2

# ── Live view (opt-in) ───────────────────────────────────────────────────────
# The browser here is genuinely headful on :99, so this shows the real run — the actual
# Turnstile widget, the actual click, the actual spinner. It is also a REMOTE CONTROL of
# that browser, which is the point for hand-driven work (registering an account inside the
# exact fingerprint + proxy a task will later reuse), and exactly why it is off by default
# and refuses to start without a password.
if [ "$VNC_ENABLE" = "1" ]; then
  if [ -z "$VNC_PASSWORD" ]; then
    echo "[vnc] VNC_ENABLE=1 but VNC_PASSWORD is empty — refusing to expose an unauthenticated remote control of this browser" >&2
  else
    mkdir -p "$HOME/.vnc"
    x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1
    # -forever: survive a viewer disconnecting.  -shared: more than one watcher.
    # -nopw is deliberately NOT used; -rfbauth is the password file written above.
    x11vnc -display :99 -rfbauth "$HOME/.vnc/passwd" -rfbport 5900 -forever -shared -quiet -bg >/dev/null 2>&1
    # noVNC serves the HTML client and proxies WebSocket → 5900, so a browser tab is enough.
    websockify --web /usr/share/novnc "${VNC_PORT:-7900}" localhost:5900 >/dev/null 2>&1 &
    echo "[vnc] live view on :${VNC_PORT:-7900} (noVNC)"
  fi
fi

exec python server.py
