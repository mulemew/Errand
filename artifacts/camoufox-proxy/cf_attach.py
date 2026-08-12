#!/usr/bin/env python3
"""Press the checkbox on a session the API SERVER built, not one this bench built.

The one experiment that separates the two remaining explanations. A bench session clears
hub.weirdhost's challenge every time and a task session never does, and every difference
between them that could be named has been matched and ruled out — the proxy and its exit
IP, the fingerprint, the whole /launch body replayed verbatim, the viewport and the
resulting coordinates, the synthesised pre-click mouse moves, probing the cross-origin
frame, a prior visit to the site, and finally the scripts injected between presses, which
a tracer showed had already fallen to zero.

So stop varying the bench and take the task's own browser instead. The session is held
open past the failure by HOLD_SESSIONS; this attaches to it and presses exactly the way
the bench does.

  passes  ⇒ the session is fine and the fault is in how the service drives the press
  fails   ⇒ the fault is in the session itself — how the service builds the browser and
            its context — and pressing was never the problem

Usage: cf_attach.py <ws-endpoint> [--presses 4] [--gap 12]
"""
import argparse
import json
import os
import sys
import time
import urllib.request

SIDECAR = os.getenv("SIDECAR", "http://127.0.0.1:7318")

FIND_TARGET = """() => {
  const resp = document.querySelector(
    'input[name="cf-turnstile-response"], input[id^="cf-chl-widget-"][id$="_response"]');
  const host = (resp && resp.parentElement) || document.querySelector('.cf-turnstile, [data-sitekey]');
  if (!host) return null;
  const r = host.getBoundingClientRect();
  return {x: Math.round(r.x + Math.min(Math.max(r.width - 8, 8), 22)),
          y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height),
          ox: window.mozInnerScreenX || 0, oy: window.mozInnerScreenY || 0};
}"""

STATE = """() => ({url: location.href, title: document.title,
  dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight,
  chl: !!(window._cf_chl_opt && window._cf_chl_opt.cType),
  form: !!document.querySelector('input[type=password]')})"""


def post(path, body):
    req = urllib.request.Request(SIDECAR + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def state(page):
    try:
        return page.evaluate(STATE)
    except Exception:
        return {"url": "", "title": "", "chl": False, "form": False}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ws")
    ap.add_argument("--sid", required=True, help="sidecar session id, for /os-click")
    ap.add_argument("--presses", type=int, default=4)
    ap.add_argument("--gap", type=int, default=12)
    ap.add_argument("--watch", type=int, default=90)
    ap.add_argument("--reload", action="store_true",
                    help="reload the page first — the held session has already failed a "
                         "challenge, so its current one may be spent")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.firefox.connect(args.ws)
        ctxs = browser.contexts
        print(f"attached: {len(ctxs)} context(s)")
        pages = [p for c in ctxs for p in c.pages]
        print(f"  {len(pages)} page(s): {[p.url[:70] for p in pages]}")
        if not pages:
            print("no page to work with"); return 2
        page = pages[0]

        if args.reload:
            print("reloading …")
            try:
                page.goto(page.url, wait_until="domcontentloaded", timeout=45_000)
            except Exception as e:
                print(f"  ({type(e).__name__} — normal on an interstitial)")

        st = state(page)
        print(f"  url={st['url'][:80]}")
        print(f"  title={st['title']!r} chl={st['chl']} form={st['form']} "
              f"dpr={st.get('dpr')} viewport={st.get('vw')}x{st.get('vh')}")
        if st["form"]:
            print("already past the challenge — nothing to press"); return 2

        tgt = None
        for _ in range(40):
            try:
                t = page.evaluate(FIND_TARGET)
            except Exception:
                t = None
            if t and t["h"] >= 30:
                tgt = t
                break
            time.sleep(0.5)
        if not tgt:
            print("no widget with a usable size"); return 2
        x, y = int(round(tgt["ox"] + tgt["x"])), int(round(tgt["oy"] + tgt["y"]))
        print(f"  widget {tgt['w']}x{tgt['h']}  aim page {tgt['x']},{tgt['y']} -> screen {x},{y}")

        for n in range(1, args.presses + 1):
            t0 = time.time()
            post(f"/sessions/{args.sid}/os-click", {"x": x, "y": y})
            s = state(page)
            print(f"  press {n}: gesture {time.time()-t0:.1f}s -> {s['url'][:70]} form={s['form']}")
            if s["form"]:
                break
            if n < args.presses:
                time.sleep(args.gap)

        t0, last = time.time(), None
        while time.time() - t0 < args.watch:
            s = state(page)
            line = f"{s['url'][:80]} | {s['title'][:36]} | form={s['form']}"
            if line != last:
                print(f"  [{time.time()-t0:5.1f}s] {line}")
                last = line
            if s["form"]:
                print(f"\nPASSED after {time.time()-t0:.1f}s — on the SERVICE's own session")
                return 0
            time.sleep(0.5)
        print(f"\nSTILL CHALLENGED after {args.watch}s — on the SERVICE's own session")
        return 1


if __name__ == "__main__":
    sys.exit(main())
