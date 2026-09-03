"""camoufox-proxy — a tiny launcher sidecar for the Camoufox anti-detect browser.

This is a SEPARATE provider. It does NOT touch the SeleniumBase cf-proxy at all.

Camoufox is a patched Firefox whose fingerprint (canvas/WebGL/screen/UA/…) is injected
at the C++/engine level — internally consistent, no headless GPU needed. It speaks the
Playwright protocol, so instead of re-implementing a whole session HTTP API we just
launch a Camoufox *Playwright server* per session with the requested fingerprint/proxy
and hand the api-server its ws:// endpoint. The api-server then drives it with native
playwright-core (firefox.connect) through its existing PageAdapter — no new endpoints.

Endpoints:
  GET  /health                      -> {ok}
  POST /launch  {os,screen,locale,timezone,humanize,proxy} -> {id, ws}
  POST /release {id}                -> {ok}
"""
import glob
import json
import os
import random
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from flask import Flask, jsonify, request

app = Flask(__name__)
PORT = int(os.getenv("PORT", "7318"))

# id -> {proc, ws}
_servers = {}
_lock = threading.Lock()

# launcher.py runs Camoufox's Playwright server and prints its ws endpoint on stdout.
# Config is passed as a JSON blob via env so we never have to shell-quote it, and the
# launcher (which can import camoufox) turns screen dict -> Screen object.
_LAUNCHER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launcher.py")

_WS_RE = re.compile(r"(ws://[^\s]+)")

# Seconds one dwell leg really costs on THIS box, learned from each gesture. Seeded at the
# figure measured in the production container (5.9s over ~14 legs); the first gesture
# corrects it either way.
_leg_cost = [0.42]


def _build_options(body: dict) -> dict:
    """Map the api-server's fingerprint/proxy config to Camoufox launch options."""
    # CAMOUFOX_HEADLESS controls headful vs headless. IMPORTANT: launch_server() forwards
    # `headless` straight to the browser process, which accepts a BOOL only — the string
    # "virtual" (valid on the Camoufox() context-manager, not here) makes the child exit
    # with "headless: expected boolean, got string". This container already runs its own
    # Xvfb :99 (DISPLAY=:99), so headless=False = a real, fully-rendered headful browser
    # on that display — no need for Camoufox's own virtual-display mode.
    #   "true"/"1"/"yes"/"on"      → True  (real headless, more detectable)
    #   anything else (default,     → False (headful on Xvfb :99 — the intended mode)
    #    incl. "false"/"virtual")
    _h = os.getenv("CAMOUFOX_HEADLESS", "false").strip().lower()
    _headless: bool = _h in ("true", "1", "yes", "on")

    def _envflag(name: str, default: bool) -> bool:
        v = os.getenv(name)
        if v is None:
            return default
        return v.strip().lower() in ("true", "1", "yes", "on")

    # humanize / block_webrtc are configured PER-PROVIDER (Providers page) and sent in the
    # body. When absent, fall back to env, then the sane default (camoufox's own default is
    # humanize OFF; we default WebRTC BLOCKED to avoid the STUN IPv4-vs-IPv6 leak that
    # lowers fingerprint scores — both are just defaults, the provider toggle wins).
    def _bodyflag(key: str, env: str, default: bool) -> bool:
        v = body.get(key)
        if v is not None:
            return bool(v)
        return _envflag(env, default)

    opts: dict = {
        "headless": _headless,
        # Camoufox rotates a realistic, internally-consistent fingerprint for the OS.
        "geoip": True,
        "humanize": _bodyflag("humanize", "CAMOUFOX_HUMANIZE", True),
        "block_webrtc": _bodyflag("blockWebrtc", "CAMOUFOX_BLOCK_WEBRTC", True),
    }
    # Extra camoufox knobs, opt-in via env (all off by default):
    if _envflag("CAMOUFOX_BLOCK_IMAGES", False):
        opts["block_images"] = True
    # COOP left ALONE by default, which is also camoufox's own default.
    #
    # disable_coop makes the browser ignore a site's Cross-Origin-Opener-Policy header, so
    # cross-origin windows keep references that the header exists to sever. Camoufox
    # documents it for clicking a Turnstile checkbox inside a cross-origin iframe, and I
    # turned it on for that reason.
    #
    # That reason is gone: the checkbox is clicked with the sidecar's real X pointer now, so
    # the press arrives as genuine input from the window system and never touches the DOM or
    # any cross-origin check. What remains is a browser that behaves unlike a stock Firefox
    # in a way a page can notice — window.crossOriginIsolated, or a popup whose opener is not
    # null when it should be — which is the opposite of what an anti-detect build is for, and
    # is why camoufox ships it off.
    #
    # Whether Cloudflare actually looks, I do not know and have no evidence either way. The
    # switch goes back to its default because its justification went away, not as a guess at
    # the cause.
    if _envflag("CAMOUFOX_DISABLE_COOP", False):
        opts["disable_coop"] = True
    _os = (body.get("os") or "").strip().lower()
    if _os in ("windows", "macos", "mac", "linux"):
        opts["os"] = "macos" if _os == "mac" else _os
    scr = body.get("screen")
    if isinstance(scr, str) and "x" in scr:
        try:
            w, h = scr.lower().split("x", 1)
            opts["screen"] = {"width": int(w), "height": int(h)}
        except Exception:
            pass
    if body.get("locale"):
        opts["locale"] = body["locale"]
    # Manual timezone from the fingerprint profile wins over geoip. geoip=True still
    # fills geolocation/timezone from the proxy IP when this is left empty. (locale is
    # forwarded above; timezone was previously dropped, so it silently fell back to the
    # proxy IP even when the profile set one explicitly.)
    if body.get("timezone"):
        opts["timezone"] = body["timezone"]
    proxy = body.get("proxy")
    if isinstance(proxy, dict) and proxy.get("server"):
        p = {"server": proxy["server"]}
        if proxy.get("username"):
            p["username"] = proxy["username"]
        if proxy.get("password"):
            p["password"] = proxy["password"]
        opts["proxy"] = p
    # FIXED fingerprint from a saved profile (from /generate): a pickled browserforge
    # Fingerprint (exact reproduction) OR a real preset dict. launcher.py turns these
    # into launch_server's fingerprint= / fingerprint_preset=. If neither is present,
    # Camoufox generates a fresh consistent one from `os`.
    fp = body.get("fingerprint") or {}
    if isinstance(fp, dict):
        if fp.get("fp"):
            opts["_fp_pickle"] = fp["fp"]
        elif fp.get("preset"):
            opts["_preset"] = fp["preset"]
        if not opts.get("os") and fp.get("os"):
            _fos = str(fp["os"]).strip().lower()
            if _fos in ("windows", "macos", "mac", "linux"):
                opts["os"] = "macos" if _fos == "mac" else _fos
    return opts


@app.get("/health")
def health():
    return jsonify({"ok": True, "sessions": len(_servers)})


def _g(obj, *names):
    for n in names:
        v = getattr(obj, n, None) if obj is not None else None
        if v is not None:
            return v
    return None


def _screen_wh(scr):
    """(width, height) from a Screen object, a plain dict, or a stringified dict.

    browserforge/camoufox have moved between these shapes across versions, and when the
    lookup failed the summary ended up carrying the raw value — which the profile editor
    then showed verbatim ("{'width': 1536, 'height': 864, ...}") instead of a resolution.
    """
    if scr is None:
        return None, None
    if isinstance(scr, dict):
        return scr.get("width"), scr.get("height")
    w, h = _g(scr, "width"), _g(scr, "height")
    if w and h:
        return w, h
    m_w = re.search(r"['\"]?width['\"]?\s*[:=]\s*(\d+)", str(scr))
    m_h = re.search(r"['\"]?height['\"]?\s*[:=]\s*(\d+)", str(scr))
    return (int(m_w.group(1)) if m_w else None, int(m_h.group(1)) if m_h else None)


def _summ_from_fp(fp, os_name: str) -> dict:
    nav = getattr(fp, "navigator", None)
    scr = getattr(fp, "screen", None)
    vc = getattr(fp, "videoCard", None) or getattr(fp, "video_card", None)
    w, h = _screen_wh(scr)
    return {
        "source": "browserforge",
        "os": "mac" if os_name == "macos" else os_name,
        "userAgent": _g(nav, "userAgent", "user_agent") or "",
        "platform": _g(nav, "platform") or "",
        "languages": _g(nav, "languages") or [],
        "screen": f"{w}x{h}" if w and h else "",
        "webglVendor": (_g(vc, "vendor") or "") if vc is not None else "",
        "webglRenderer": (_g(vc, "renderer") or "") if vc is not None else "",
        "hardwareConcurrency": _g(nav, "hardwareConcurrency", "hardware_concurrency"),
        "deviceMemory": _g(nav, "deviceMemory", "device_memory"),
    }


# How many times to re-draw a preset whose GPU camoufox cannot actually spoof. About 1 in 9
# Windows presets is unusable (measured: 47/400; macOS and Linux ~8%), so five draws leaves
# roughly a 1-in-60000 chance of not finding a good one.
_PRESET_REROLLS = int(os.getenv("CAMOUFOX_PRESET_REROLLS", "5"))

_WEBGL_DB = "/usr/local/lib/python3.11/site-packages/camoufox/webgl/webgl_data.db"
_webgl_pairs_cache = [None]


def _supported_webgl_pairs():
    """The vendor/renderer pairs camoufox has real WebGL parameter data for.

    Camoufox ships TWO datasets that do not agree with each other: 312 device presets, and
    33 rows of WebGL data. `launch_options` looks a preset's GPU up in the second one and
    raises `ValueError: No WebGL data found for vendor ... and renderer ...` when it is
    absent — which fails /launch with a 500, at task-run time, long after the profile was
    saved and named. Measured on the bundled v150 preset set: 11% of Windows presets, 8% of
    macOS and Linux. The most common offender is an Intel Arc A750.

    That combination is only reachable when a preset supplies a GPU *and* WebGL is enabled,
    which is presumably why the error string has no hits anywhere on GitHub. The synthetic
    (browserforge) path never hits it: camoufox drops browserforge's videoCard entirely and
    samples its own GPU, so it can only ever pick a supported one.
    """
    if _webgl_pairs_cache[0] is None:
        pairs = set()
        try:
            import sqlite3
            con = sqlite3.connect(f"file:{_WEBGL_DB}?mode=ro", uri=True)
            try:
                for vendor, renderer in con.execute("select vendor, renderer from webgl_fingerprints"):
                    pairs.add((vendor, renderer))
            finally:
                con.close()
        except Exception as e:
            # Unreadable database: return an EMPTY set and let the caller treat every preset
            # as acceptable. Guessing the other way would reject all of them and leave the
            # fingerprint page unable to generate anything at all.
            print(f"[fingerprint] could not read the webgl dataset ({e}) — skipping the check", flush=True)
        _webgl_pairs_cache[0] = pairs
    return _webgl_pairs_cache[0]


def _preset_webgl_is_supported(preset) -> bool:
    """Can camoufox actually launch with this preset's GPU?"""
    pairs = _supported_webgl_pairs()
    if not pairs:
        return True                      # dataset unreadable — do not block generation
    wg = preset.get("webgl") if isinstance(preset, dict) else None
    if not isinstance(wg, dict):
        return True                      # no GPU in the preset — camoufox samples its own
    vendor, renderer = wg.get("unmaskedVendor"), wg.get("unmaskedRenderer")
    if not vendor or not renderer:
        return True
    return (vendor, renderer) in pairs


def _summ_from_preset(preset: dict, os_name: str) -> dict:
    # A preset is a NESTED dict: navigator{userAgent,platform,hardwareConcurrency},
    # screen{width,height,...}, webgl{unmaskedVendor,unmaskedRenderer}.
    nav = preset.get("navigator") if isinstance(preset, dict) else None
    scr = preset.get("screen") if isinstance(preset, dict) else None
    wg = preset.get("webgl") if isinstance(preset, dict) else None
    nav = nav if isinstance(nav, dict) else {}
    wg = wg if isinstance(wg, dict) else {}
    w, h = _screen_wh(scr)
    return {
        "source": "preset",
        "os": "mac" if os_name == "macos" else os_name,
        "userAgent": nav.get("userAgent") or "",
        "platform": nav.get("platform") or "",
        "screen": f"{w}x{h}" if w and h else "",
        "webglVendor": wg.get("unmaskedVendor") or "",
        "webglRenderer": wg.get("unmaskedRenderer") or "",
        "hardwareConcurrency": nav.get("hardwareConcurrency"),
    }


def _preset_ff_version():
    """Which preset set to draw from — and it is not the default.

    camoufox ships two: a legacy file and a v150 file, chosen by ff_version at
    PRESETS_V150_MIN_FF (149). Passing None picked the LEGACY set: 75 Windows presets
    carrying rv:147/rv:148 user agents, against 180 in the current set. Two problems at
    once — less than half the variety, and a browser that IS Firefox 150 announcing itself
    as 147, which is a contradiction anyone can check.

    Resolved once, in order: CAMOUFOX_FF_VERSION if set, then whatever the installed
    package reports, and finally the newest set available. The last is a guess, but a
    better one than a version we know is stale.
    """
    global _PRESET_FF
    if _PRESET_FF is not _UNSET:
        return _PRESET_FF

    resolved = None
    env = (os.getenv("CAMOUFOX_FF_VERSION") or "").strip()
    if env.isdigit():
        resolved = int(env)
        why = "CAMOUFOX_FF_VERSION"
    else:
        try:
            from camoufox import pkgman
            for attr in ("installed_verstr", "get_installed_version", "installed_version", "current_verstr"):
                fn = getattr(pkgman, attr, None)
                if callable(fn):
                    m = re.search(r"(\d+)", str(fn()))
                    if m:
                        resolved = int(m.group(1))
                        why = f"pkgman.{attr}"
                        break
        except Exception:
            pass
    if resolved is None:
        # Ask for the newest set rather than accepting the legacy default.
        try:
            from camoufox.fingerprints import PRESETS_V150_MIN_FF
            resolved = int(PRESETS_V150_MIN_FF) + 1
        except Exception:
            resolved = 150
        why = "newest available set"

    _PRESET_FF = resolved
    print(f"[fingerprint] preset set for Firefox {resolved} ({why})", flush=True)
    return _PRESET_FF


_UNSET = object()
_PRESET_FF = _UNSET


@app.get("/generate")
def generate():
    """Generate ONE concrete, consistent fingerprint the user saves as a FIXED profile.
    source=browserforge (synthetic, from browserforge's real-world dataset) or
    source=preset (a REAL captured device preset). Returns { config, summary }: save
    `config` verbatim into the profile and POST it back as `fingerprint` on /launch;
    `summary` is human-readable for the UI. Never randomly hand-assign values — both
    sources are authentic + internally consistent (WAFs hash the WebGL fingerprint)."""
    os_name = (request.args.get("os") or "windows").strip().lower()
    if os_name == "mac":
        os_name = "macos"
    if os_name not in ("windows", "macos", "linux"):
        os_name = "windows"
    source = (request.args.get("source") or "browserforge").strip().lower()
    try:
        if source == "preset":
            from camoufox.fingerprints import get_random_preset
            preset = None
            for _ in range(_PRESET_REROLLS):
                candidate = get_random_preset(os=os_name, ff_version=_preset_ff_version())
                if not candidate:
                    break
                if _preset_webgl_is_supported(candidate):
                    preset = candidate
                    break
                preset = preset or candidate      # keep the first one as a fallback
            if not preset:
                return jsonify({"error": f"no bundled preset available for os={os_name}"}), 404
            if not _preset_webgl_is_supported(preset):
                # Every roll landed on an unusable GPU. Drop the webgl block rather than
                # hand back a profile that cannot launch: camoufox then samples a supported
                # vendor/renderer itself and the rest of the preset — UA, screen, navigator,
                # voices — is used exactly as captured.
                wg = preset.get("webgl") if isinstance(preset, dict) else None
                dropped = (wg or {}).get("unmaskedRenderer")
                preset.pop("webgl", None)
                print(f"[fingerprint] dropped an unsupported GPU from the preset: {dropped}", flush=True)
            summary = _summ_from_preset(preset, os_name)
            return jsonify({"config": {"source": "preset", "os": os_name, "preset": preset, "summary": summary}, "summary": summary})
        # default: browserforge synthetic — pickle the Fingerprint so /launch reproduces it EXACTLY
        from browserforge.fingerprints import FingerprintGenerator, Screen
        import base64
        import pickle
        # MUST be a Firefox fingerprint — Camoufox is patched Firefox and rejects Chrome/
        # other-browser fingerprints (NonFirefoxFingerprint). browser= flows through to the
        # header generator, forcing a Firefox UA the rest of the fingerprint is built around.
        #
        # CONSTRAINED to ordinary hardware. browserforge samples its whole dataset, which is
        # statistically honest and individually terrible: every value it picks exists
        # somewhere, but a 1600x2560 portrait panel with an obscure GPU is a machine almost
        # nobody has, and standing out is the one thing a fingerprint must not do. The
        # generated profiles were "rare-looking" for exactly this reason.
        #
        # So: keep the screen inside the band real desktops occupy, then prefer a generation
        # whose resolution is one people actually run. mainstream=0 restores raw sampling.
        mainstream = (request.args.get("mainstream") or "1").strip().lower() not in ("0", "false", "no")
        gen = FingerprintGenerator(
            screen=Screen(min_width=1280, max_width=1920, min_height=720, max_height=1200)
        ) if mainstream else FingerprintGenerator()

        fp = gen.generate(os=os_name, browser="firefox")
        if mainstream:
            # The desktop resolutions with real share. Sampling until one lands is cheap
            # (generation is local and fast) and leaves the rest of the fingerprint alone —
            # nothing is hand-edited, so it stays internally consistent.
            COMMON = {
                (1920, 1080), (1536, 864), (1366, 768), (1440, 900),
                (1600, 900), (1280, 720), (1680, 1050), (1920, 1200),
            }
            # A common SCREEN with an exotic GPU is still an odd machine — the renderer
            # string is one of the most-read fields there is. Accept the vendors that
            # actually ship in consumer desktops and laptops.
            GPU_OK = re.compile(r"nvidia|geforce|rtx|gtx|amd|radeon|intel|iris|uhd graphics|hd graphics|apple", re.I)

            def ordinary(f) -> bool:
                scr = getattr(f, "screen", None)
                if not scr or (getattr(scr, "width", 0), getattr(scr, "height", 0)) not in COMMON:
                    return False
                vc = getattr(f, "videoCard", None) or getattr(f, "video_card", None)
                renderer = (_g(vc, "renderer") or "") if vc is not None else ""
                # No card reported at all is normal for some Firefox configs; only reject a
                # renderer that IS present and is something nobody runs.
                return not renderer or bool(GPU_OK.search(renderer))

            for _ in range(40):
                if ordinary(fp):
                    break
                fp = gen.generate(os=os_name, browser="firefox")
            else:
                print("[fingerprint] no ordinary screen+GPU after 40 tries — keeping the last", flush=True)
        summary = _summ_from_fp(fp, os_name)
        fp_b64 = base64.b64encode(pickle.dumps(fp)).decode("ascii")
        return jsonify({"config": {"source": "browserforge", "os": os_name, "fp": fp_b64, "summary": summary}, "summary": summary})
    except Exception as e:
        import traceback
        return jsonify({"error": f"fingerprint generate failed ({source}): {e}\n{traceback.format_exc()}"}), 500


# ── Per-session displays ─────────────────────────────────────────────────────
#
# Every session used to render onto the container's single Xvfb :99, which made "watch this
# task" impossible: concurrent runs pile their windows onto one screen with no way to tell
# them apart. It also meant they shared one pointer and one focus, which is its own source
# of interference for anything that clicks.
#
# So each session gets its own Xvfb, its own x11vnc and its own websockify port, torn down
# with the session. Allocation failure is NOT fatal: the session falls back to :99 and the
# only thing lost is the ability to watch that one on its own.

_DISPLAY_BASE = int(os.getenv("CAMOUFOX_DISPLAY_BASE", "100"))
_DISPLAY_MAX = int(os.getenv("CAMOUFOX_DISPLAY_MAX", "132"))
_VIEW_PORT_BASE = int(os.getenv("CAMOUFOX_VIEW_PORT_BASE", "7901"))
_display_lock = threading.Lock()
_displays_in_use: set = set()
_VNC_DISABLED = os.getenv("VNC_DISABLE") == "1"
# Where the KasmVNC web client lives, and where files uploaded through it land.
_KASM_WWW = os.getenv("KASM_WWW_DIR", "/usr/share/kasmvnc/www")
_KASM_DOWNLOADS = os.getenv("KASM_DOWNLOAD_DIR", os.path.expanduser("~/Downloads"))


def _screen_geometry() -> str:
    return os.getenv("CAMOUFOX_SCREEN", "1920x1080x24")


def _alloc_display():
    """Reserve a display number, or None when they are all taken."""
    with _display_lock:
        for n in range(_DISPLAY_BASE, _DISPLAY_MAX):
            if n not in _displays_in_use:
                _displays_in_use.add(n)
                return n
    return None


def _free_display(n):
    if n is None:
        return
    with _display_lock:
        _displays_in_use.discard(n)


def _kasm_env():
    """Environment a KasmVNC server needs to start without a password prompt."""
    env = dict(os.environ)
    env.setdefault("HOME", os.path.expanduser("~"))
    return env


def _xvnc_argv(display: int, view_port: int) -> list:
    """One process: X server + VNC + web server. Every flag here was checked against a
    running Xvnc, because the ones that look obvious are the ones that were wrong.

      -rfbport 0        no raw VNC listener; the websocket is the only door. (`-1` is not
                        "off" — it makes the whole listener setup fail silently.)
      -httpd            without it the port answers but serves no client at all.
      -DisableBasicAuth needs an explicit 1; the bare flag is accepted and ignored.
      -SecurityTypes None  deliberate: this port is never published, the app proxies it
                        behind the same login as everything else, and a VNC password on an
                        interior door only guarantees that the door gets propped open.

    The websocket lives at BOTH /websockify and /api/websockify — verified by handshake,
    which is why the app's existing proxy path keeps working unchanged. A 401 from either
    is almost never authentication: Xvnc rejects a handshake with no Origin header and
    reports it as 401, which cost an hour to learn the first time.
    """
    geom = _screen_geometry()                      # "WxHxD"
    wh, _, depth = geom.rpartition("x")
    return [
        "Xvnc", f":{display}",
        "-geometry", wh,
        "-depth", depth,
        "-websocketPort", str(view_port),
        "-rfbport", "0",
        "-httpd", _KASM_WWW,
        "-SecurityTypes", "None",
        "-DisableBasicAuth", "1",
        "-AlwaysShared",                           # more than one watcher, like x11vnc -shared
        "-interface", "0.0.0.0",
    ]


def _wait_port(port: int, timeout: float = 10.0) -> bool:
    """True once something accepts a TCP connection on 127.0.0.1:port."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def _start_session_display():
    """A KasmVNC server for one session: its own X display, its own view port.

    Returns (display_num, view_port, [procs]) — or (None, None, []) if anything failed, in
    which case the caller uses the shared :99 and simply cannot be watched individually.

    This used to start three processes (Xvfb, x11vnc, websockify) and the middle one was
    the whole problem: SIGKILLed on teardown, it leaked 62 shared-memory segments each
    time, and after ~66 sessions no new x11vnc could start at all — the view connected,
    upgraded, and stayed black. Xvnc is all three at once, so there is one process to
    start, one to stop, and nothing that can half-fail into a silent blank screen.
    """
    n = _alloc_display()
    if n is None:
        print("[display] none free — session will share :99", flush=True)
        return None, None, []
    procs = []
    try:
        # A crashed X server leaves its lock behind and the next one on that number refuses
        # to start ("Server is already active"). Without this the number would fail forever
        # after one crash.
        for stale in (f"/tmp/.X{n}-lock", f"/tmp/.X11-unix/X{n}"):
            try:
                os.unlink(stale)
            except OSError:
                pass

        view_port = None
        if _VNC_DISABLED:
            # No viewer wanted: a plain Xvfb is enough to render into, and it costs less.
            xserver = subprocess.Popen(
                ["Xvfb", f":{n}", "-screen", "0", _screen_geometry(), "-ac"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            )
        else:
            view_port = _VIEW_PORT_BASE + (n - _DISPLAY_BASE)
            xserver = subprocess.Popen(
                _xvnc_argv(n, view_port),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                env=_kasm_env(),
            )
        procs.append(xserver)

        # Wait for the DISPLAY to exist rather than sleeping a fixed amount. Xvnc has more
        # to set up than Xvfb did, and a fixed 1s was already marginal for the old pair:
        # the browser would start against a display that was not ready and die on connect.
        ready = False
        for _ in range(60):                      # up to ~6s
            if xserver.poll() is not None:
                raise RuntimeError(f"X server for :{n} exited immediately")
            if os.path.exists(f"/tmp/.X11-unix/X{n}"):
                ready = True
                break
            time.sleep(0.1)
        if not ready:
            raise RuntimeError(f"X server for :{n} never created its socket")

        # …and then for the VIEW PORT, which is a separate thing Xvnc sets up after the X
        # socket. Reporting the port before it listens is what made the live view open on a
        # bare blue screen and stay there: the app proxied to a port nothing answered on,
        # while a second attempt moments later worked. Waiting here costs a few hundred ms
        # and removes the race rather than papering over it with a retry in the viewer.
        if view_port and not _wait_port(view_port):
            raise RuntimeError(f"Xvnc for :{n} never listened on {view_port}")

        print(f"[display] :{n} up (view port {view_port})", flush=True)
        return n, view_port, procs
    except Exception as e:
        print(f"[display] :{n} failed ({e}) — session will share :99", flush=True)
        for pr in procs:
            try:
                pr.kill()
            except Exception:
                pass
        _free_display(n)
        return None, None, []


def _stop_session_display(entry):
    """Shut this session's Xvfb + x11vnc + websockify down, gracefully first.

    THIS USED TO BE `pr.kill()` — SIGKILL, immediately, to all three — and that single line
    took the whole live-view feature down after about a day of uptime.

    x11vnc holds SIXTY-TWO SysV shared-memory segments per instance — measured, not
    estimated: a scanline, the full framebuffer, and a tile for each region it polls. It
    releases them when it exits normally; SIGKILL gives it no chance, so every session leaks
    all 62. The kernel allows 4096 (`kernel.shmmni`), which is **about 66 sessions** — two
    days of ordinary use — after which `shmget` fails for EVERY new x11vnc. It then dies on
    startup while Xvfb and websockify come up fine, leaving a view port that accepts the
    WebSocket, completes the upgrade, and shows nothing at all, forever, with no error
    anywhere. Measured on production before the fix: 4096/4096 segments, 4034 unattached.

    Reverse order on purpose: websockify and x11vnc are CLIENTS of the Xvfb they were
    started with. Signalling all three at once can take the X server down first, which is
    the same thing as SIGKILL from x11vnc's point of view — it dies against a dead display
    and leaks anyway.
    """
    procs = list(entry.get("view_procs") or [])
    for pr in reversed(procs):
        try:
            pr.terminate()
        except Exception:
            pass
    deadline = time.time() + _VIEW_GRACE_S
    for pr in reversed(procs):
        try:
            pr.wait(timeout=max(0.1, deadline - time.time()))
        except Exception:
            pass
    for pr in procs:
        try:
            if pr.poll() is None:
                pr.kill()
        except Exception:
            pass
    _free_display(entry.get("display"))


# How long x11vnc/websockify/Xvfb get to exit on their own before SIGKILL. Short, because
# it is spent on every session teardown — but it must be long enough for x11vnc to detach
# and remove its shared-memory segments, which is all it needs to do.
_VIEW_GRACE_S = float(os.getenv("CAMOUFOX_VIEW_GRACE", "3"))


def _sweep_shm():
    """Reclaim SysV shared-memory segments nobody can ever use again.

    The net under the graceful teardown above, for the cases where nothing graceful can
    happen: an OOM-killed x11vnc, a container-level SIGKILL, or a crash. Without it the
    count only ever goes up, and the failure it produces is silent and total — every new
    x11vnc fails to start and the live view shows a blank page that never errors.

    Two conditions, BOTH required, and both verified against production before this was
    written: nothing is attached to the segment (nattch == 0) AND the process that created
    it is gone. A segment in use by a running viewer therefore cannot be touched, and
    neither can one whose creator is still starting up.
    """
    def _ipcs(args):
        try:
            return subprocess.run(["ipcs"] + args, capture_output=True, text=True,
                                  timeout=15).stdout.splitlines()
        except Exception:
            return []

    # `ipcs -m`    : key shmid owner perms bytes nattch status
    nattch = {}
    for line in _ipcs(["-m"]):
        f = line.split()
        if len(f) >= 6 and f[0].startswith("0x") and f[1].isdigit() and f[5].isdigit():
            nattch[f[1]] = int(f[5])
    # `ipcs -m -p` : shmid owner cpid lpid — NO key column, so it cannot be parsed the same
    # way as the table above. Getting that wrong makes this function silently sweep nothing.
    creator = {}
    for line in _ipcs(["-m", "-p"]):
        f = line.split()
        if len(f) >= 4 and f[0].isdigit() and f[2].isdigit():
            creator[f[0]] = f[2]

    freed = 0
    for shmid, n in nattch.items():
        if n != 0:
            continue
        cpid = creator.get(shmid)
        if not cpid or os.path.isdir(f"/proc/{cpid}"):
            continue
        try:
            if subprocess.run(["ipcrm", "-m", shmid], capture_output=True, timeout=10).returncode == 0:
                freed += 1
        except Exception:
            pass
    if freed:
        print(f"[camoufox] reclaimed {freed} orphaned shared-memory segment(s)", flush=True)


@app.post("/launch")
def launch():
    body = request.get_json(silent=True) or {}

    opts = _build_options(body)
    env = dict(os.environ)
    env["CAMOUFOX_CFG"] = json.dumps(opts)
    # This session's own screen. The launcher inherits DISPLAY, so the browser it starts
    # renders there instead of on the shared :99.
    _display, _view_port, _view_procs = _start_session_display()
    if _display is not None:
        env["DISPLAY"] = f":{_display}"
    # start_new_session puts the launcher in its OWN process group, so we can later kill
    # the WHOLE tree. This is the leak: SIGTERM to the launcher does not necessarily take
    # down the Firefox it spawned (Playwright's browser process is a grandchild), so the
    # browser was reparented to init and kept running — several hundred MB each, piling up
    # across runs until the box ran out of RAM.
    proc = subprocess.Popen(
        [sys.executable, _LAUNCHER_PATH],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    # Read stdout until the ws endpoint appears (or the child dies / times out).
    ws = None
    deadline = time.time() + int(os.getenv("CAMOUFOX_LAUNCH_TIMEOUT", "120"))
    tail = []
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                break
            continue
        tail.append(line.rstrip())
        tail[:] = tail[-40:]
        m = _WS_RE.search(line)
        if m:
            ws = m.group(1)
            break
    if not ws:
        # Failed startup can still have spawned a browser — kill the group, not just python.
        _kill(proc)
        _stop_session_display({"view_procs": _view_procs, "display": _display})
        return jsonify({"error": "Camoufox server did not report a ws endpoint\n" + "\n".join(tail)}), 500
    sid = str(uuid.uuid4())
    try:
        _pgid = os.getpgid(proc.pid)
    except Exception:
        _pgid = None
    with _lock:
        _servers[sid] = {
            "proc": proc, "ws": ws, "started": time.time(), "pgid": _pgid,
            "display": _display, "view_port": _view_port, "view_procs": _view_procs,
            # A browser someone is driving by hand is SUPPOSED to sit there for hours. The
            # age reaper below is the orphan net for task sessions that never called
            # /release, and it was killing these at 90 minutes with the app none the wiser.
            # Read from the REQUEST BODY, not from opts: _build_options maps the body to
            # camoufox's own launch options and keepAlive is not one of them, so reading it
            # there was always None and every hand-driven browser was still reaped at 90
            # minutes — verified in production before this line was changed.
            "keep_alive": bool(body.get("keepAlive")),
        }
    # Drain the child's remaining stdout in the background so it never blocks on a full pipe.
    threading.Thread(target=_drain, args=(proc,), daemon=True).start()
    # locale/timezone are printed because "empty" is a DECISION here: geoip is on, so a
    # blank locale means the exit IP picks the language, and the only way to tell that from
    # "the profile said en-US" was to read the database.
    print(
        f"[camoufox] launched {sid} ws={ws} os={opts.get('os')} display=:{_display}"
        f" keep_alive={bool(body.get('keepAlive'))}"
        f" locale={opts.get('locale') or 'AUTO(geoip)'}"
        f" tz={opts.get('timezone') or 'AUTO(geoip)'}",
        flush=True,
    )
    # viewPort lets the app proxy THIS session's screen rather than the whole container's.
    return jsonify({"id": sid, "ws": ws, "viewPort": _view_port})


def _drain(proc):
    try:
        for _ in proc.stdout:
            pass
    except Exception:
        pass


# How long the launcher gets to unwind on its own, and how long the process group gets
# after that before SIGKILL. Both only matter on teardown, so generous is cheap.
_GRACE_S = int(os.getenv("CAMOUFOX_KILL_GRACE", "8"))
_FORCE_S = int(os.getenv("CAMOUFOX_KILL_FORCE_AFTER", "5"))


def _group_alive(pgid):
    """Does the process group still have members? Signal 0 tests without delivering."""
    if not pgid:
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True          # exists, just not ours to signal
    except Exception:
        return False


def _kill(proc):
    """Kill the launcher AND everything it started — graceful first, group force second.

    THE ORDER IS THE WHOLE POINT, and getting it wrong is what leaked 4.2 GB of /tmp in two
    days of uptime (65 abandoned playwright_firefoxdev_profile-* at ~85 MB each, plus 57
    playwright-artifacts-*).

    Playwright creates those directories inside its Node driver and deletes them when the
    browser is closed properly. launcher.py already turns SIGTERM into SystemExit precisely
    so that launch_server's context managers unwind and that close happens. But this
    function used to open with killpg(SIGTERM) — and the driver sits in the SAME process
    group. Node's default SIGTERM disposition is immediate death, so the driver was gone
    before the launcher had finished unwinding, and the cleanup it was supposed to perform
    never ran. Every teardown path (release, TTL reap, failed launch) went through that
    call, so the leak was 100%: the directories only ever disappeared when the container
    was rebuilt and its writable layer went with it.

    So: signal the LAUNCHER ALONE and let it shut the browser down. Only if it is still
    there after the grace period do we fall back to the group, and only if the group
    survives THAT do we SIGKILL. The escalation is still guaranteed — an unkillable Firefox
    must not outlive its session, which is what the group signal was added for — it just is
    no longer the opening move.
    """
    try:
        pgid = os.getpgid(proc.pid)
    except Exception:
        pgid = None

    # ── Phase 1: the launcher, by itself, gets to close the browser ────────────────
    try:
        proc.send_signal(signal.SIGTERM)
    except (ProcessLookupError, OSError):
        pass
    except Exception:
        pass
    try:
        proc.wait(timeout=_GRACE_S)
    except Exception:
        pass

    # Reap first: a camoufox-bin that has already exited lingers as a zombie (this process
    # is PID 1, so orphans reparent here) and a zombie still answers signal 0. Without this
    # the aliveness check below would read "group still populated" on a perfectly clean
    # shutdown and escalate for no reason.
    _reap_orphans()

    # ── Phase 2: the group, only for what the graceful path left behind ────────────
    if _group_alive(pgid):
        try:
            os.killpg(pgid, signal.SIGTERM)
        except Exception:
            pass
        _wait_group_gone(pgid, _FORCE_S)
        if _group_alive(pgid):
            try:
                os.killpg(pgid, signal.SIGKILL)
            except Exception:
                pass

    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=3)
    except Exception:
        pass


def _wait_group_gone(pgid, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _group_alive(pgid):
            return True
        time.sleep(0.2)
    return not _group_alive(pgid)


def _kill_group_of(entry):
    """Best-effort sweep of a session's process group, recorded at launch time so it works
    even after the launcher itself has exited (os.getpgid would fail then).

    No graceful phase here on purpose: this runs when the launcher is ALREADY gone, so
    there is nobody left to unwind launch_server and ask Playwright to clean up. All that
    remains is to take down whatever it orphaned — which _sweep_tmp then tidies after.
    SIGKILL is still held back until SIGTERM has had _FORCE_S to work (it used to get
    exactly 0.5 s, which is not enough for Firefox to finish exiting).
    """
    pgid = entry.get("pgid")
    if not _group_alive(pgid):
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except Exception:
        return
    _wait_group_gone(pgid, _FORCE_S)
    if _group_alive(pgid):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except Exception:
            pass


# Background reaper: without it a session whose task hung (never called /release) would
# leave its launcher+firefox subprocess running forever, and a crashed launcher would sit
# as a zombie (nobody wait()s it). Every 20s we (a) reap dead procs — Popen.poll() collects
# the zombie and sets returncode — and (b) SIGTERM/kill sessions older than the TTL.
# Must stay comfortably ABOVE the app's task timeout (default 30 min): the reaper cannot
# tell "hung" from "still working", so a TTL equal to the task timeout would kill the
# browser out from under a task that is merely slow. This is the orphan net, not a limit —
# and sessions launched with keepAlive are exempt entirely, because a browser opened from
# the fingerprint-browsers page is meant to stay open until someone closes it.
_SESSION_TTL = int(os.getenv("CAMOUFOX_SESSION_TTL", "5400"))


def _reap_orphans():
    """Collect any dead child, not just the ones we track.

    This container's PID 1 IS this process (the entrypoint execs it), so every browser we
    orphan gets reparented HERE — and a killed process stays in the table as a zombie until
    someone wait()s for it. Popen.poll() only reaps the specific launcher it owns, so the
    camoufox-bin grandchildren killed by killpg lingered as 0-byte entries: harmless for
    memory, but they hold PID slots and make "is anything leaking?" impossible to answer
    from ps. waitpid(-1) with WNOHANG drains whatever is finished.
    """
    reaped = 0
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break  # nothing left to reap
        except Exception:
            break
        if pid == 0:
            break  # children exist but none have exited
        reaped += 1
    if reaped:
        print(f"[camoufox] reaped {reaped} orphaned child process(es)", flush=True)


# Temp directories Playwright creates per browser and is supposed to remove on close.
# _kill's graceful path is what makes that happen; this sweep is the net under it, for the
# cases where no graceful path exists at all — a launcher killed by the OOM killer, a
# container-level SIGKILL, or simply a Playwright version that misses one on its way out.
_TMP_GLOBS = (
    "playwright_firefoxdev_profile-*",
    "playwright_firefox_profile-*",
    "playwright-artifacts-*",
)
# A directory younger than this is never touched, however dead it looks: it may belong to a
# session that is still starting up and has not put its path into anyone's argv yet.
_SWEEP_MIN_AGE = int(os.getenv("CAMOUFOX_TMP_SWEEP_AGE", "300"))


def _referenced_paths():
    """Every path any live process names — argv, cwd, or an open fd.

    Firefox is started with `-profile /tmp/playwright_firefoxdev_profile-XXXX`, so argv
    alone catches profiles; fds and cwd cover the artifacts directories, which nothing
    names on a command line. Returned as one blob for substring testing: a false "still in
    use" only costs us a sweep cycle, a false "dead" would delete a running browser's
    profile out from under it.
    """
    blob = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                blob.append(fh.read().decode("utf-8", "replace"))
        except Exception:
            pass
        try:
            blob.append(os.readlink(f"/proc/{pid}/cwd"))
        except Exception:
            pass
        try:
            fd_dir = f"/proc/{pid}/fd"
            for fd in os.listdir(fd_dir):
                try:
                    blob.append(os.readlink(os.path.join(fd_dir, fd)))
                except Exception:
                    pass
        except Exception:
            pass
    return "\0".join(blob)


def _sweep_tmp():
    """Delete Playwright temp dirs that no live process refers to."""
    now = time.time()
    # Never sweep anything newer than the oldest session still running. Its artifacts dir
    # can legitimately sit idle — no open fd, named nowhere — between a download and the
    # next one, and removing it would break that session rather than tidy after a dead one.
    with _lock:
        starts = [e.get("started", now) for e in _servers.values()]
    cutoff = now - _SWEEP_MIN_AGE
    if starts:
        cutoff = min(cutoff, min(starts))

    try:
        live = _referenced_paths()
    except Exception:
        return  # cannot prove anything is dead — sweep nothing

    tmp = tempfile.gettempdir()
    swept = 0
    for pattern in _TMP_GLOBS:
        for path in glob.glob(os.path.join(tmp, pattern)):
            try:
                if os.path.getmtime(path) >= cutoff:
                    continue
                if os.path.basename(path) in live:
                    continue
                shutil.rmtree(path, ignore_errors=True)
                swept += 1
            except FileNotFoundError:
                continue
            except Exception:
                continue
    if swept:
        print(f"[camoufox] swept {swept} orphaned temp dir(s)", flush=True)


def _reaper():
    while True:
        time.sleep(20)
        try:
            now = time.time()
            with _lock:
                items = list(_servers.items())
            for sid, e in items:
                proc = e["proc"]
                if proc.poll() is not None:  # already exited — poll() reaps the zombie
                    # The LAUNCHER is gone, but its browser may not be: a launcher that
                    # crashed (or was killed by the OOM killer) leaves camoufox-bin running
                    # with nobody to reap it. Sweep the whole group before forgetting it.
                    _kill_group_of(e)
                    _stop_session_display(e)
                    with _lock:
                        _servers.pop(sid, None)
                    print(f"[camoufox] reaped dead session {sid} (exit={proc.returncode})", flush=True)
                    continue
                if e.get("keep_alive"):
                    continue                                     # held open on purpose
                if now - e.get("started", now) > _SESSION_TTL:  # hung / orphaned
                    _kill(proc)
                    _stop_session_display(e)
                    with _lock:
                        _servers.pop(sid, None)
                    print(f"[camoufox] killed over-age session {sid} (>{_SESSION_TTL}s)", flush=True)
        except Exception as ex:  # never let the reaper die
            print(f"[camoufox] reaper error: {ex}", flush=True)
        # AFTER the tracked sweep, so Popen still owns the bookkeeping for its own
        # launchers and only genuine orphans are collected generically.
        _reap_orphans()
        # And AFTER that, so a browser that just died is no longer holding fds when the
        # sweep asks whether its directory is still in use.
        try:
            _sweep_tmp()
        except Exception as ex:
            print(f"[camoufox] tmp sweep error: {ex}", flush=True)
        try:
            _sweep_shm()
        except Exception as ex:
            print(f"[camoufox] shm sweep error: {ex}", flush=True)


threading.Thread(target=_reaper, daemon=True).start()


@app.get("/sessions/<sid>/view")
def session_view(sid):
    """Where to watch this session — the websockify port of its own display.

    null means it is sharing the container display (allocation failed, or the viewer is
    disabled), in which case the caller falls back to the container-wide view.
    """
    with _lock:
        entry = _servers.get(sid)
    if not entry:
        return jsonify({"error": "no such session"}), 404
    return jsonify({"viewPort": entry.get("view_port"), "display": entry.get("display")})


@app.post("/sessions/<sid>/os-click")
def session_os_click(sid):
    """Click with the REAL X pointer, on this session's own display.

    Playwright's mouse synthesises events inside the browser. Cloudflare's interactive
    challenge does not act on them: the cursor arrives, the press is delivered to the
    widget's host element, and the checkbox never reacts — observed directly, repeatedly,
    on a challenge whose widget lives in a closed shadow root. The SeleniumBase sidecar has
    always cleared the same widget with OS-level input (uc_gui_click_captcha), and once every
    session got its own Xvfb there was no reason this one could not do the same.

    Coordinates are SCREEN coordinates on that display. The caller converts from viewport
    space using Firefox's window.mozInnerScreenX/Y, which is exact — no guessing at the
    height of the browser chrome.
    """
    body = request.get_json(silent=True) or {}
    try:
        x = int(round(float(body.get("x"))))
        y = int(round(float(body.get("y"))))
    except (TypeError, ValueError):
        return jsonify({"error": "x and y are required"}), 400

    with _lock:
        entry = _servers.get(sid)
    if not entry:
        return jsonify({"error": "no such session"}), 404
    disp = entry.get("display")
    if disp is None:
        # Sharing the container display: a click there would land in whatever else is on it.
        return jsonify({"error": "session has no display of its own"}), 409

    env = dict(os.environ)
    env["DISPLAY"] = f":{disp}"
    try:
        # ONE xdotool invocation for the whole gesture, starting from where the pointer
        # already is.
        #
        # Three things separated our input from a hand moving the same mouse through VNC,
        # now that nothing else touches the page and a human passes this challenge where we
        # do not:
        #
        #   · we teleported to the start. The path was interpolated, but the jump TO its
        #     first point was a single mousemove — so the first thing observed was a
        #     discontinuity no mouse can produce. It starts from getmouselocation now.
        #   · the event rate was ~25Hz. A real mouse reports at 100-125Hz, and the gap is
        #     visible in the deltas: ours moved several pixels per event, a hand moves one.
        #   · every step was its own subprocess. Process startup in a container is tens of
        #     milliseconds and varies wildly, so the intended 8ms cadence was neither 8ms nor
        #     regular. xdotool chains commands in one invocation, which is one process and
        #     one X connection for the entire gesture.
        loc = subprocess.run(["xdotool", "getmouselocation", "--shell"],
                             env=env, timeout=5, check=True, capture_output=True, text=True)
        cur = {}
        for line in loc.stdout.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                cur[k.strip()] = v.strip()
        try:
            sx, sy = int(cur.get("X", x)), int(cur.get("Y", y))
        except ValueError:
            sx, sy = x, y
        # If the pointer is already on top of the target there is nothing to travel, so back
        # off to somewhere plausible first — but as part of the same gesture, not a teleport.
        if abs(sx - x) < 40 and abs(sy - y) < 40:
            sx, sy = x - random.randint(150, 320), y + random.randint(-120, 120)

        dist = max(1.0, ((x - sx) ** 2 + (y - sy) ** 2) ** 0.5)
        # ~110Hz, and long enough that the distance is covered at a hand's pace rather than
        # a jump: roughly 900-1600 px/s.
        duration = min(1.6, max(0.35, dist / random.uniform(900, 1600)))
        steps = max(20, int(duration * 110))
        step_delay = duration / steps

        cx = (sx + x) / 2 + random.uniform(-0.18, 0.18) * dist
        cy = (sy + y) / 2 + random.uniform(-0.14, 0.14) * dist

        # NO --sync ON THE MOTION. It waits for the X server to confirm each move, which is a
        # round trip PER EVENT, and it is not free: a gesture budgeted at 6.6s of sleeps took
        # over 15s in practice and blew the caller's HTTP timeout, so the click fell back to
        # synthesised input and the box was never really pressed. Ordering does not need it —
        # X requests from one connection are processed in order, and the sleeps do the pacing.
        # The one move that DOES keep it is the final positioning before mousedown, where the
        # pointer must provably be on the target before the button goes down.
        # NEVER EMIT A NEGATIVE COORDINATE.
        #
        # xdotool parses "-25" as a command-line option and fails the WHOLE chained gesture
        # with "mousemove: unrecognized option", which the caller sees as a click that could
        # not be delivered — followed by a fallback to synthesised input that this challenge
        # does not accept. It is reachable whenever the widget sits far enough left: the
        # approach starts at x - 150..320 and the dwell ranges to x - 14, and a widget at
        # x=214 (a 1280-wide viewport, which is what a session without an explicit screen
        # size gets) puts both below zero. Caught by running this bench inside the sidecar.
        def C(v):
            return str(max(0, int(round(v))))

        cmd = ["xdotool"]
        for i in range(1, steps + 1):
            t = i / steps
            e = 3 * t * t - 2 * t * t * t          # ease-in-out
            px = (1 - e) ** 2 * sx + 2 * (1 - e) * e * cx + e * e * x
            py = (1 - e) ** 2 * sy + 2 * (1 - e) * e * cy + e * e * y
            if i < steps:                           # never jitter the landing point
                px += random.uniform(-0.7, 0.7)
                py += random.uniform(-0.7, 0.7)
            cmd += ["mousemove", C(px), C(py), "sleep", f"{step_delay:.3f}"]
        # DWELL INSIDE THE WIDGET BEFORE PRESSING.
        #
        # Turnstile lives in a CROSS-ORIGIN iframe, so the only pointer activity it can
        # observe is what happens inside its own ~300x65 box — everything on the host page is
        # invisible to it. (That is the same rule that stops the host document from seeing
        # the mousedown we deliver into it.) Read the other way round, it says where all the
        # effort has been going wrong: page-wide wandering and the shape of the approach are
        # both almost entirely OUTSIDE the box, so nothing about them can have reached the
        # thing doing the judging. What it does see, today, is: pointer appears, holds still
        # 0.2s, twitches one pixel, clicks. Two or three events in total.
        #
        # A hand clicking the same box in the VNC view spends a second or two inside it —
        # arriving, drifting, correcting, settling — and leaves dozens. That is the one
        # difference that is both large and visible to the widget, so this is where the
        # movement belongs.
        #
        # AIM AT A DURATION, NOT AT A LEG COUNT.
        #
        # What decides the outcome is how long the pointer is actually inside the widget:
        # 3-6 legs never got a press accepted, 12-16 did. But a leg count is a poor handle
        # on duration, because the SAME command list runs at wildly different speeds. Timed
        # in the production container, on one display, minutes apart: this service's own
        # gesture 5.9s, a bench issuing the same 12-16 legs 21.6s. The sleeps in both add up
        # to ~5s; the rest is xdotool's per-command overhead under whatever load the box is
        # under. The 21.6s run cleared the challenge and the 5.9s one did not.
        #
        # So the leg count is chosen from a running estimate of what a leg actually costs
        # here, to land on CAMOUFOX_DWELL_MS of real time in the box. The estimate updates
        # itself from the measured duration of every gesture, so a quiet box and a busy one
        # both end up spending the same time where it counts.
        #
        # Bounds are relative to the aim point, which sits 22px from the widget's left edge
        # and vertically centred: -14..+60 across and ±18 down still lands well inside a
        # 300x65 control, with margin for the caller's ±2px of jitter.
        dwell = []
        dwx, dwy = float(x), float(y)
        dwell_target = float(os.getenv("CAMOUFOX_DWELL_MS", "16000")) / 1000.0
        legs = int(max(12, min(60, dwell_target / max(0.05, _leg_cost[0]))))
        for _ in range(legs):
            dwx = min(max(dwx + random.uniform(-26, 34), x - 14), x + 60)
            dwy = min(max(dwy + random.uniform(-14, 14), y - 18), y + 18)
            dwell.append((dwx, dwy, random.uniform(0.12, 0.35)))
        dwell.append((float(x), float(y), random.uniform(0.12, 0.22)))  # back onto the checkbox
        pdx, pdy = float(x), float(y)
        for (tx_, ty_, tdur) in dwell:
            tsteps = max(4, int(tdur * 55))
            for i in range(1, tsteps + 1):
                t = i / tsteps
                e = 3 * t * t - 2 * t * t * t
                cmd += ["mousemove", C(pdx + (tx_ - pdx) * e), C(pdy + (ty_ - pdy) * e),
                        "sleep", f"{tdur / tsteps:.3f}"]
            pdx, pdy = tx_, ty_
            cmd += ["sleep", f"{random.uniform(0.06, 0.2):.3f}"]

        # Settle, a pixel of tremor, press, hold, release — still one process.
        cmd += ["sleep", f"{random.uniform(0.18, 0.32):.3f}",
                "mousemove", "--sync", C(x + random.choice((-1, 0, 1))), C(y + random.choice((-1, 0, 1))),
                "sleep", f"{random.uniform(0.04, 0.09):.3f}",
                "mousedown", "1",
                "sleep", f"{random.uniform(0.07, 0.14):.3f}",
                "mouseup", "1"]
        # And do not stop dead the instant the button comes up.
        dx, dy = random.choice(((1, 1), (1, -1), (-1, 1), (-1, -1)))
        px, py = float(x), float(y)
        cmd += ["sleep", f"{random.uniform(0.08, 0.16):.3f}"]
        for _ in range(random.randint(10, 18)):
            px += dx * random.uniform(0.6, 2.0)
            py += dy * random.uniform(0.3, 1.6)
            cmd += ["mousemove", C(px), C(py), "sleep", f"{random.uniform(0.012, 0.03):.3f}"]

        _t0 = time.time()
        subprocess.run(cmd, env=env, timeout=90, check=True)
        elapsed = time.time() - _t0
        # Update the estimate from what this gesture actually cost, smoothed so one blip on
        # a busy box does not swing the next one.
        _leg_cost[0] = 0.7 * _leg_cost[0] + 0.3 * (elapsed / max(1, legs))
        print(f"[os-click] {sid} display=:{disp} at {x},{y} legs={legs} took={elapsed:.1f}s "
              f"legCost={_leg_cost[0]:.2f}s", flush=True)
        return jsonify({"ok": True, "display": disp, "x": x, "y": y,
                        "legs": legs, "seconds": round(elapsed, 2)})
    except subprocess.CalledProcessError as e:
        return jsonify({"error": f"xdotool failed: {e}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/release")
def release():
    body = request.get_json(silent=True) or {}
    sid = body.get("id")
    with _lock:
        entry = _servers.pop(sid, None)
    if entry:
        _kill(entry["proc"])
        _stop_session_display(entry)
        print(f"[camoufox] released {sid}", flush=True)
    return jsonify({"ok": True})


@app.post("/release-all")
def release_all():
    """Kill every live session. The api-server calls this on boot: a restart abandons the
    tasks that owned the running sessions (they're reset to idle), so whatever is still
    launched here is an orphan that would otherwise burn RAM until the TTL reaper wakes up.
    """
    with _lock:
        entries = list(_servers.items())
        _servers.clear()
    for sid, e in entries:
        _kill(e["proc"])
        _stop_session_display(e)
        print(f"[camoufox] released {sid} (release-all)", flush=True)
    return jsonify({"ok": True, "released": len(entries)})


if __name__ == "__main__":
    print(f"camoufox-proxy starting on :{PORT}", flush=True)
    from waitress import serve
    serve(app, host="0.0.0.0", port=PORT, threads=16)
