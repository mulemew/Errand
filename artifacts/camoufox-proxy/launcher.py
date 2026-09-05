"""Launch ONE Camoufox Playwright server from a JSON config in $CAMOUFOX_CFG.

Runs as a subprocess of server.py. Camoufox/browserforge want a `Screen` OBJECT (it
calls screen.is_set()), not a plain dict — so we convert `screen: {width,height}` here,
inside the process that has camoufox importable. launch_server() blocks and prints the
ws:// endpoint to stdout, which server.py reads back.
"""
import json
import os
import signal

from camoufox.server import launch_server


def _terminate(_signum, _frame):
    """Unwind on SIGTERM so Playwright's context manager closes the browser itself.

    server.py kills this process's whole GROUP as the guarantee, which reliably removes
    camoufox-bin — but a graceful exit is still preferable: it lets Firefox shut down
    normally instead of being killed mid-write. SystemExit propagates through
    launch_server's context managers, which is exactly what we want.
    """
    raise SystemExit(0)


signal.signal(signal.SIGTERM, _terminate)

cfg = json.loads(os.environ["CAMOUFOX_CFG"])

# FIXED fingerprint (from a saved profile):
#  _fp_pickle → a pickled browserforge Fingerprint → launch_server(fingerprint=...),
#              reproduces the EXACT same fingerprint every launch.
#  _preset    → a real captured preset dict → launch_server(fingerprint_preset=...).
# Both funnel into config internally (from_browserforge / from_preset), same as a fresh
# generation — just fixed. When neither is set, Camoufox generates a fresh one from os.
_fp_b64 = cfg.pop("_fp_pickle", None)
_preset = cfg.pop("_preset", None)
if _fp_b64:
    import base64
    import pickle
    cfg["fingerprint"] = pickle.loads(base64.b64decode(_fp_b64))
    # A pinned fingerprint carries its own screen — don't also constrain it.
    cfg.pop("screen", None)
elif _preset:
    cfg["fingerprint_preset"] = _preset
    cfg.pop("screen", None)

scr = cfg.pop("screen", None)
if isinstance(scr, dict) and scr.get("width") and scr.get("height"):
    try:
        from browserforge.fingerprints import Screen
        w, h = int(scr["width"]), int(scr["height"])
        # Pin the fingerprint's screen to exactly this resolution.
        cfg["screen"] = Screen(min_width=w, max_width=w, min_height=h, max_height=h)
    except Exception:
        pass  # fall back to Camoufox's own random screen

# Bind the Playwright ws server to ALL interfaces, not just loopback. The api-server
# runs in a SEPARATE container and connects across the docker network; the default bind
# only reports a loopback host (ws://[::1]:PORT), which the api-server can't reach
# (ECONNREFUSED). This key falls through launch_options' **kwargs into Playwright's
# launchServer({host}). The api-server rewrites the reported host to the camoufox-proxy
# service name, so the actual reachable address is host=camoufox-proxy:PORT.
cfg["host"] = "0.0.0.0"

# How stale the tab list is allowed to be.
#
# Closing a browser saves the tabs it had open, and the only source that can see a tab a
# person opened themselves is Firefox's own session store — which it rewrites on a timer,
# 15 seconds by default. A tab opened in the last few seconds before closing is simply not
# in the file yet, and comes back missing.
#
# One second instead. The profile is a temp directory that is thrown away with the browser,
# so this costs a small write on a tmpfs and buys a list that is actually current.
_prefs = dict(cfg.get("firefox_user_prefs") or {})
_prefs.setdefault("browser.sessionstore.interval", 1000)
cfg["firefox_user_prefs"] = _prefs

# Pinning the screen is an optimisation, not a requirement.
#
# With no fixed fingerprint, Camoufox synthesises one with browserforge, and asking for an
# exact screen rectangle asks browserforge for a fingerprint with those precise dimensions.
# That is a much harder question than it looks — measured on this image, three of the six
# viewport sizes the app picks from fail outright, and not because the sizes are unusual:
#
#     1920x1080 ok    1536x864 FAIL    1440x900 ok
#     1366x768  FAIL  1280x800 FAIL    1280x720 ok
#
# 1536x864 is the SECOND most common screen in browserforge's own data (47 of 300 samples).
# Pinning both bounds constrains its Bayesian network to a subset with no probability mass
# left for the header attributes, and the failure surfaces as "No headers based on this
# input can be generated" — which says nothing about screens. The viewport is chosen at
# random from that pool, so creating a browser without a fingerprint profile failed about
# half the time, at random, for a reason the message never mentioned.
#
# Three steps, each giving up a little precision and none of them giving up the browser:
#
#   1. the exact size, which is what we actually want
#   2. a lower bound — the property that matters is that a window fits INSIDE its screen,
#      not that they are equal. Never failed in testing, though browserforge treats it as
#      a preference rather than a guarantee and can still come back smaller.
#   3. no constraint at all, rather than no browser
def _launch_with_screen_fallbacks(config):
    screen = config.get("screen")
    attempts = [("exact", config)]
    if screen is not None:
        loose = dict(config)
        try:
            from browserforge.fingerprints import Screen
            loose["screen"] = Screen(min_width=screen.min_width, min_height=screen.min_height)
            attempts.append(("lower-bound", loose))
        except Exception:
            pass
        bare = dict(config)
        bare.pop("screen", None)
        attempts.append(("unconstrained", bare))

    last = None
    for label, attempt in attempts:
        try:
            launch_server(**attempt)
            return  # launch_server blocks forever; reaching here means it stopped on its own
        except Exception as e:
            last = e
            print(f"[launcher] screen constraint '{label}' failed: {e}", flush=True)
    raise last


_launch_with_screen_fallbacks(cfg)
