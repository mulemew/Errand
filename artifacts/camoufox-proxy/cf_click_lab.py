#!/usr/bin/env python3
"""cf_click_lab — a bench for ONE question: which click clears a full-page Turnstile?

NOT part of the service. Nothing imports it, the image does not need it, and it changes
no production behaviour. It exists because every hypothesis about this click has cost a
~30-minute image rebuild to test, and most of them were wrong. Copy it into the running
sidecar and try six of them in five minutes instead:

    docker cp cf_click_lab.py <camoufox-container>:/tmp/
    docker exec -it <camoufox-container> python /tmp/cf_click_lab.py --variant baseline

Run --variant manual FIRST. That is the control: it sets everything up exactly as the
automated run does and then waits for YOU to click in the VNC view. It is the one case
known to pass, so if it ever fails the difference is not in the click at all and every
other result here is noise.

Variants, chosen so each one falsifies something specific:

  manual    you click in VNC — the control
  proven    the exact recipe that passes on a Windows box against this same site:
            approach, 12-16 eased legs INSIDE the widget (~5s), press, then repeat up
            to four times with a 12s quiet gap. Nothing else differs from what the
            service does, so:
            → passes here ⇒ the gesture is fine in this container and the difference
                            is in how the api-server drives it
            → fails here  ⇒ the difference is this container's input path (xdotool +
                            Xvfb) versus SendInput, and that is where to look next
  baseline  the gesture the service ships today (via the sidecar's own /os-click)
  teleport  no motion at all: jump to the point and press

Everything runs against the real site through the sidecar's own launcher, so the
fingerprint, the proxy and the display are the ones a task gets.
"""
import argparse
import io
import json
import os
import random
import subprocess
import sys
import time
import urllib.request

SIDECAR = os.getenv("SIDECAR", "http://127.0.0.1:7318")
URL = os.getenv("TARGET_URL", "https://hub.weirdhost.xyz/auth/login")


def get(path):
    with urllib.request.urlopen(SIDECAR + path, timeout=30) as r:
        return json.loads(r.read().decode())


def post(path, body):
    req = urllib.request.Request(
        SIDECAR + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # The sidecar puts the reason in the body; a bare "HTTP Error 500" hides it.
        raise SystemExit(f"{path} -> {e.code}: {e.read().decode()[:300]}")


# ── the page-side measurements, kept identical to the service's ──────────────
# Same selectors and the same 22px offset, so a result here transfers. If these drift
# apart the bench stops answering the question it was built for.
FIND_TARGET = """() => {
  const resp = document.querySelector(
    'input[name="cf-turnstile-response"], input[id^="cf-chl-widget-"][id$="_response"]');
  const host = (resp && resp.parentElement) || document.querySelector('.cf-turnstile, [data-sitekey]');
  if (!host) return null;
  const r = host.getBoundingClientRect();
  return {
    x: Math.round(r.x + Math.min(Math.max(r.width - 8, 8), 22)),
    y: Math.round(r.y + r.height / 2),
    w: Math.round(r.width), h: Math.round(r.height),
    ox: window.mozInnerScreenX || 0, oy: window.mozInnerScreenY || 0,
  };
}"""

# GROUND TRUTH IS THE LOGIN FORM. _cf_chl_opt.cType goes missing for a moment every time
# the challenge tears itself down and builds a fresh instance, so a run that reads it will
# report a pass while the page still plainly says "Just a moment". A password field only
# exists on the real page.
STATE = """() => ({
  dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight, sw: screen.width, sh: screen.height,
  url: location.href,
  title: document.title,
  chl: !!(window._cf_chl_opt && window._cf_chl_opt.cType),
  ctype: (window._cf_chl_opt && window._cf_chl_opt.cType) || '',
  form: !!document.querySelector('input[type=password]'),
})"""


def xdo(display, *args):
    env = dict(os.environ, DISPLAY=f":{display}")
    subprocess.run(["xdotool", *[str(a) for a in args]], env=env, timeout=60, check=True)


def C(v):
    """Never emit a negative coordinate: xdotool reads "-25" as a command-line option and
    fails the entire chained gesture."""
    return str(max(0, int(round(v))))


def ease_to(cmd, px, py, tx, ty, dur, hz):
    """Append an eased leg. No --sync: it costs an X round trip per event, which is what
    made the shipped gesture overrun its caller's timeout and never press at all."""
    n = max(4, int(dur * hz))
    for i in range(1, n + 1):
        t = i / n
        e = 3 * t * t - 2 * t * t * t
        cmd += ["mousemove", C(px + (tx - px) * e), C(py + (ty - py) * e), "sleep", f"{dur / n:.3f}"]
    return tx, ty


def approach(cmd, sx, sy, x, y):
    return ease_to(cmd, sx, sy, x, y, random.uniform(0.5, 0.9), 110)


def run_variant(variant, display, x, y, page):
    """Deliver the press. x,y are SCREEN coordinates."""
    if variant == "manual":
        print(f"\n  >>> click the checkbox yourself in the VNC view. It is at screen {x},{y}.")
        print("  >>> watching for 60s\n")
        return

    if variant == "proven":
        for n in range(1, ARGS.presses + 1):
            cmd = ["xdotool"]
            sx, sy = x - random.randint(150, 320), y + random.randint(-120, 120)
            px, py = ease_to(cmd, sx, sy, x, y, random.uniform(0.35, 1.0), 110)
            for _ in range(random.randint(12, 16)):
                tx = min(max(px + random.uniform(-26, 34), x - 14), x + 60)
                ty = min(max(py + random.uniform(-14, 14), y - 18), y + 18)
                px, py = ease_to(cmd, px, py, tx, ty, random.uniform(0.12, 0.35), 55)
                cmd += ["sleep", f"{random.uniform(0.06, 0.2):.3f}"]
            ease_to(cmd, px, py, x, y, random.uniform(0.12, 0.22), 55)
            cmd += ["sleep", f"{random.uniform(0.18, 0.32):.3f}",
                    "mousemove", "--sync", C(x), C(y),
                    "sleep", f"{random.uniform(0.04, 0.09):.3f}",
                    "mousedown", "1", "sleep", f"{random.uniform(0.07, 0.14):.3f}", "mouseup", "1"]
            env = dict(os.environ, DISPLAY=f":{display}")
            t0 = time.time()
            subprocess.run(cmd, env=env, timeout=60, check=True)
            st = page.evaluate(STATE)
            print(f"  press {n}: gesture {time.time() - t0:.1f}s  ->  {st['url'][:80]} "
                  f"chl={st['chl']} form={st['form']}")
            if st["form"]:
                return
            if n < ARGS.presses:
                time.sleep(ARGS.gap)
        return

    if variant == "baseline":
        # Timed, because the service's own gesture and this bench's take wildly different
        # wall clocks in the same container for nominally the same parameters, and the time
        # the pointer spends inside the widget is the variable already shown to decide the
        # outcome.
        sid = page._lab_sid
        for n in range(1, ARGS.presses + 1):
            if ARGS.framequery:
                probed = []
                for fr in page.frames[1:]:
                    try:
                        u = fr.url
                        el = fr.query_selector("body")
                        bb = el.bounding_box() if el else None
                        probed.append(f"{u[:40]!r}->{bb}")
                    except Exception as e:
                        probed.append(f"{type(e).__name__}")
                print(f"    frame probe before press {n}: {probed}")
            if ARGS.synthetic:
                # simulateHumanMouseMovement's camoufox path, verbatim: two humanized moves
                # to random points in the middle of the viewport, ~200ms apart.
                vp = page.viewport_size or {"width": 1280, "height": 720}
                page.mouse.move(random.uniform(vp["width"] * 0.25, vp["width"] * 0.65),
                                random.uniform(vp["height"] * 0.25, vp["height"] * 0.65))
                time.sleep(random.uniform(0.12, 0.26))
                page.mouse.move(random.uniform(vp["width"] * 0.35, vp["width"] * 0.75),
                                random.uniform(vp["height"] * 0.35, vp["height"] * 0.75))
                time.sleep(random.uniform(0.6, 1.5))
            t0 = time.time()
            post(f"/sessions/{sid}/os-click", {"x": x, "y": y})
            st = page.evaluate(STATE)
            print(f"  press {n}: SERVICE gesture {time.time() - t0:.1f}s  ->  "
                  f"{st['url'][:70]} form={st['form']}")
            if st["form"]:
                return
            if n < ARGS.presses:
                time.sleep(ARGS.gap)
        return

    # Everything below drives xdotool directly so the gesture can be varied without
    # touching the service.
    sx, sy = x - random.randint(160, 300), y + random.randint(-100, 100)
    cmd = ["xdotool"]

    if variant == "teleport":
        cmd += ["mousemove", "--sync", C(x), C(y), "sleep", "0.05"]
    else:
        px, py = ease_to(cmd, sx, sy, x, y, random.uniform(0.5, 0.9), 110)
        if variant == "dwell":
            # Five seconds INSIDE the box. The widget is cross-origin, so this is the only
            # region whose pointer activity it can see at all.
            for _ in range(14):
                tx = min(max(px + random.uniform(-26, 34), x - 14), x + 60)
                ty = min(max(py + random.uniform(-14, 14), y - 18), y + 18)
                px, py = ease_to(cmd, px, py, tx, ty, random.uniform(0.12, 0.3), 55)
                cmd += ["sleep", f"{random.uniform(0.05, 0.18):.3f}"]
            ease_to(cmd, px, py, x, y, 0.15, 55)
        cmd += ["sleep", f"{random.uniform(0.18, 0.32):.3f}",
                "mousemove", "--sync", C(x), C(y)]

    hold = 0.4 if variant == "hold" else random.uniform(0.07, 0.14)
    cmd += ["mousedown", "1", "sleep", f"{hold:.3f}", "mouseup", "1"]
    env = dict(os.environ, DISPLAY=f":{display}")
    t0 = time.time()
    subprocess.run(cmd, env=env, timeout=60, check=True)
    print(f"  gesture took {time.time() - t0:.1f}s ({len(cmd)} argv)")


ARGS = None


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="proven",
                    choices=["manual", "proven", "baseline", "teleport"])
    ap.add_argument("--presses", type=int, default=4)
    ap.add_argument("--launchbody", default="",
                    help="path to a JSON file holding the EXACT /launch body a task sent "
                         "(recorded by the sidecar). Replayed verbatim except for the proxy "
                         "server, which --proxy replaces. This ends the guessing about which "
                         "field differs: there is no reconstruction left to get wrong.")
    ap.add_argument("--fpfile", default="",
                    help="path to a JSON {os,preset,locale,timezone} exported from a saved "
                         "fingerprint profile. A task launches with one; every bench run so "
                         "far has let camoufox generate a fresh random one, which is a "
                         "different devicePixelRatio and therefore a different mapping from "
                         "the page's CSS pixels to the X server's device pixels.")
    ap.add_argument("--prewarm", action="store_true",
                    help="visit the site once and poll it before going to the login page, "
                         "the way cookie-mode's session check does. A task has already been "
                         "through one round on this site before the challenge it fails; this "
                         "bench has always arrived cold.")
    ap.add_argument("--framequery", action="store_true",
                    help="before each press, reach into the CROSS-ORIGIN Turnstile iframe "
                         "the way locateCheckboxInCfFrame does: enumerate frames, query "
                         "body, take its bounding box. The service does this before every "
                         "press; this bench never has.")
    ap.add_argument("--viewport", default="",
                    help="e.g. 1920x1080 — a task creates its context with an explicit "
                         "viewport, and on a 1920x1080 Xvfb that asks for a content area as "
                         "large as the whole screen. The bench has been using Playwright's "
                         "1280x720 default, which is why its widget sits at x=214 and the "
                         "task's at x=512.")
    ap.add_argument("--synthetic", action="store_true",
                    help="do what the service does before each press and this bench never "
                         "has: move PLAYWRIGHT's cursor around the viewport first. The page "
                         "then holds two pointer histories that disagree — a synthesised one "
                         "and the real one that does the pressing.")
    ap.add_argument("--proxy", default="",
                    help="e.g. socks5://172.18.0.6:11080 — run the session through the same "
                         "tunnel a task uses, so the exit IP is a controlled variable rather "
                         "than an untested one")
    ap.add_argument("--screen", default="",
                    help="e.g. 1920x1080 — a task session gets its screen from a fingerprint "
                         "profile, and the widget's position on the page follows from it")
    ap.add_argument("--gap", type=int, default=12)
    ap.add_argument("--url", default=URL)
    ap.add_argument("--watch", type=int, default=60, help="seconds to watch for a verdict")
    ap.add_argument("--keep", action="store_true", help="leave the session running afterwards")
    args = ap.parse_args()
    ARGS = args

    from playwright.sync_api import sync_playwright

    print(f"launching a session via {SIDECAR} …")
    body = {}
    if args.launchbody:
        body = json.loads(io.open(args.launchbody, encoding="utf-8").read())
        body.pop("proxy", None)
    if args.screen:
        body["screen"] = args.screen
    if args.proxy:
        body["proxy"] = {"server": args.proxy}
    if args.fpfile:
        fp = json.loads(io.open(args.fpfile, encoding="utf-8").read())
        body["fingerprint"] = fp
        if fp.get("os"):
            body["os"] = fp["os"]
        for k in ("locale", "timezone"):
            if fp.get(k):
                body[k] = fp[k]
    sess = post("/launch", body)
    sid, ws = sess["id"], sess["ws"]
    print(f"  session {sid}")

    # GET /sessions/<id>/view reports the display without touching the pointer. The first
    # attempt asked by clicking at 1,1 to read the display out of the reply, which the
    # sidecar answered with a 500: the gesture derives its start point and its dwell bounds
    # by offsetting the target, and from a corner those come out negative.
    display = get(f"/sessions/{sid}/view").get("display")
    print(f"  display :{display}   (open the VNC view for this session now)")

    with sync_playwright() as pw:
        browser = pw.firefox.connect(ws)
        if args.viewport:
            _w, _h = args.viewport.lower().split("x", 1)
            page = browser.new_context(viewport={"width": int(_w), "height": int(_h)}).new_page()
        else:
            page = browser.new_page()
        page._lab_sid = sid
        try:
            if args.prewarm:
                print("prewarming: one visit + a session-check style poll, then the login page")
                try:
                    page.goto(args.url, wait_until="domcontentloaded", timeout=45_000)
                except Exception:
                    pass
                for _ in range(13):
                    try:
                        page.evaluate(STATE)
                    except Exception:
                        pass
                    time.sleep(1)
            print(f"navigating to {args.url} …")
            try:
                page.goto(args.url, wait_until="domcontentloaded", timeout=45_000)
            except Exception as e:
                print(f"  (navigation reported {type(e).__name__} — normal on an interstitial)")

            for _ in range(20):
                st = page.evaluate(STATE)
                if st["chl"] or st["form"]:
                    break
                time.sleep(1)
            st = page.evaluate(STATE)
            print(f"  title={st['title']!r} challenge={st['chl']} cType={st['ctype']!r} "
                  f"render={st.get('vw')}x{st.get('vh')} dpr={st.get('dpr')} "
                  f"screen={st.get('sw')}x{st.get('sh')}"
                  + ("   <<< VIEWPORT BIGGER THAN SCREEN — impossible on a real browser"
                     if st.get('vw') and st.get('sw') and st['vw'] > st['sw'] else ""))
            # Only a login FORM proves there is nothing to test. cType blinks out for a
            # moment every time the challenge rebuilds itself, and bailing on that reported
            # "no challenge" against a page whose title still said "Un instant…".
            if st["form"]:
                print("  already past the challenge — nothing to test")
                return 2

            if args.variant == "late":
                print("  sitting on the challenge for 25s before touching it …")
                time.sleep(25)

            # Wait for the widget to have HEIGHT. Its container's rect exists before the
            # widget inside it renders, and a 896x0 rect puts the aim on the top edge.
            tgt = None
            for _ in range(40):
                t = page.evaluate(FIND_TARGET)
                if t and t["h"] >= 30:
                    tgt = t
                    break
                time.sleep(0.5)
            if not tgt:
                print("  widget never reached a usable size — cannot aim")
                return 2
            sx, sy = tgt["ox"] + tgt["x"], tgt["oy"] + tgt["y"]
            print(f"  widget container {tgt['w']}x{tgt['h']}, aim page {tgt['x']},{tgt['y']} "
                  f"-> screen {sx},{sy} (origin {tgt['ox']},{tgt['oy']})")

            print(f"\nvariant: {args.variant}")
            run_variant(args.variant if args.variant != "late" else "baseline",
                        display, sx, sy, page)

            # Watch quietly. page.url()/title are read through the protocol, but nothing is
            # injected into the page while the verdict is being formed.
            t0, last = time.time(), None
            while time.time() - t0 < args.watch:
                try:
                    st = page.evaluate(STATE)
                except Exception:
                    time.sleep(0.5)
                    continue
                line = f"{st['url'][:90]} | {st['title'][:40]} | chl={st['chl']} form={st['form']}"
                if line != last:
                    print(f"  [{time.time() - t0:5.1f}s] {line}")
                    last = line
                if not st["chl"]:
                    print(f"\nPASSED after {time.time() - t0:.1f}s — variant {args.variant}")
                    return 0
                time.sleep(0.5)
            print(f"\nSTILL CHALLENGED after {args.watch}s — variant {args.variant}")
            return 1
        finally:
            try:
                page.screenshot(path=f"/tmp/cf_{args.variant}.png")
                print(f"  screenshot: /tmp/cf_{args.variant}.png")
            except Exception:
                pass
            browser.close()
            if not args.keep:
                post("/release", {"id": sid})


if __name__ == "__main__":
    sys.exit(main())
