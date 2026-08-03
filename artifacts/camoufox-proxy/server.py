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
import json
import os
import re
import signal
import subprocess
import sys
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
            preset = get_random_preset(os=os_name)
            if not preset:
                return jsonify({"error": f"no bundled preset available for os={os_name}"}), 404
            summary = _summ_from_preset(preset, os_name)
            return jsonify({"config": {"source": "preset", "os": os_name, "preset": preset, "summary": summary}, "summary": summary})
        # default: browserforge synthetic — pickle the Fingerprint so /launch reproduces it EXACTLY
        from browserforge.fingerprints import FingerprintGenerator
        import base64
        import pickle
        # MUST be a Firefox fingerprint — Camoufox is patched Firefox and rejects Chrome/
        # other-browser fingerprints (NonFirefoxFingerprint). browser= flows through to the
        # header generator, forcing a Firefox UA the rest of the fingerprint is built around.
        fp = FingerprintGenerator().generate(os=os_name, browser="firefox")
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


def _start_session_display():
    """Xvfb + x11vnc + websockify for one session.

    Returns (display_num, view_port, [procs]) — or (None, None, []) if anything failed, in
    which case the caller uses the shared :99 and simply cannot be watched individually.
    """
    n = _alloc_display()
    if n is None:
        print("[display] none free — session will share :99", flush=True)
        return None, None, []
    procs = []
    try:
        # A crashed Xvfb leaves its lock behind, and the next Xvfb on that number refuses to
        # start ("Server is already active"). Without this the number would fail forever
        # after one crash — sessions would still run, just always on the shared display.
        for stale in (f"/tmp/.X{n}-lock", f"/tmp/.X11-unix/X{n}"):
            try:
                os.unlink(stale)
            except OSError:
                pass
        xvfb = subprocess.Popen(
            ["Xvfb", f":{n}", "-screen", "0", _screen_geometry(), "-ac"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        procs.append(xvfb)
        time.sleep(1.0)
        if xvfb.poll() is not None:
            raise RuntimeError(f"Xvfb :{n} exited immediately")

        view_port = None
        if not _VNC_DISABLED:
            view_port = _VIEW_PORT_BASE + (n - _DISPLAY_BASE)
            # 5900 belongs to the container-wide viewer the entrypoint starts on :99.
            # Starting at 5901 keeps the first session from colliding with it — x11vnc
            # would fail to bind, websockify would still come up, and the view would be a
            # port that answers and never shows anything.
            vnc_port = 5901 + (n - _DISPLAY_BASE)
            # -bg would daemonise out of our process tree; keep it in the foreground so the
            # teardown below actually owns it.
            procs.append(subprocess.Popen(
                ["x11vnc", "-display", f":{n}", "-nopw", "-rfbport", str(vnc_port),
                 "-forever", "-shared", "-quiet"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            ))
            procs.append(subprocess.Popen(
                ["websockify", "--web", "/usr/share/novnc", str(view_port), f"localhost:{vnc_port}"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            ))
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
    for pr in entry.get("view_procs") or []:
        try:
            pr.kill()
        except Exception:
            pass
    _free_display(entry.get("display"))


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
        }
    # Drain the child's remaining stdout in the background so it never blocks on a full pipe.
    threading.Thread(target=_drain, args=(proc,), daemon=True).start()
    print(f"[camoufox] launched {sid} ws={ws} os={opts.get('os')} display=:{_display}", flush=True)
    # viewPort lets the app proxy THIS session's screen rather than the whole container's.
    return jsonify({"id": sid, "ws": ws, "viewPort": _view_port})


def _drain(proc):
    try:
        for _ in proc.stdout:
            pass
    except Exception:
        pass


def _kill(proc):
    """Kill the launcher AND everything it started.

    Signalling just the launcher leaves camoufox-bin (and its content processes) running:
    they are grandchildren via Playwright's driver, and nothing reaps them. Because /launch
    starts each session in its own process group, one killpg takes down the whole tree.
    """
    try:
        pgid = os.getpgid(proc.pid)
    except Exception:
        pgid = None

    try:
        if pgid is not None:
            os.killpg(pgid, signal.SIGTERM)
        else:
            proc.send_signal(signal.SIGTERM)
    except ProcessLookupError:
        pgid = None
    except Exception:
        pass

    try:
        proc.wait(timeout=8)
    except Exception:
        pass

    # Anything still alive in the group gets SIGKILL — a Firefox that ignored SIGTERM (or
    # was mid-startup when we asked) must not survive the session.
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
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


def _kill_group_of(entry):
    """Best-effort sweep of a session's process group, recorded at launch time so it works
    even after the launcher itself has exited (os.getpgid would fail then)."""
    pgid = entry.get("pgid")
    if not pgid:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return
        except Exception:
            return
        time.sleep(0.5)


# Background reaper: without it a session whose task hung (never called /release) would
# leave its launcher+firefox subprocess running forever, and a crashed launcher would sit
# as a zombie (nobody wait()s it). Every 20s we (a) reap dead procs — Popen.poll() collects
# the zombie and sets returncode — and (b) SIGTERM/kill sessions older than the TTL.
# Must stay comfortably ABOVE the app's task timeout (default 30 min): the reaper cannot
# tell "hung" from "still working", so a TTL equal to the task timeout would kill the
# browser out from under a task that is merely slow. This is the orphan net, not a limit.
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
