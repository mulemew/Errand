"""What Firefox itself has open, read from the profile it is running on.

Playwright only reports pages IT created. A tab opened from the browser's own UI is
invisible to it — measured against a live session: three tabs open, one page reported.
That is not a bug to work around in the app; the information simply never reaches it.

Firefox does know, and writes it down. `sessionstore-backups/recovery.jsonlz4` inside the
profile is refreshed every few seconds with the current windows and tabs. Reading that
gives the real list, and needs no change to how the browser is launched — which the
alternative, a persistent on-disk profile, would: Playwright's launchServer cannot expose
one, so that route means rebuilding how everything reaches the browser.

mozLz4 is a 12-byte header (the magic, then a little-endian decompressed size) followed by
a raw LZ4 block. The decoder here is the block format in full — about thirty lines, which
is cheaper than adding a dependency to an image that is deliberately spare.
"""

import glob
import json
import os
import struct

MOZ_LZ4_MAGIC = b"mozLz40" + bytes([0])


def lz4_block_decompress(src: bytes, out_len: int) -> bytes:
    """LZ4 block format. Enough to read a session store; not a general-purpose codec."""
    out = bytearray()
    i, n = 0, len(src)
    while i < n:
        token = src[i]
        i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = src[i]
                i += 1
                lit += b
                if b != 255:
                    break
        out += src[i : i + lit]
        i += lit
        if i >= n:
            break
        offset = src[i] | (src[i + 1] << 8)
        i += 2
        match = token & 0x0F
        if match == 15:
            while True:
                b = src[i]
                i += 1
                match += b
                if b != 255:
                    break
        match += 4
        start = len(out) - offset
        # Overlapping copies are legal and common in LZ4, so this copies a byte at a time
        # on purpose — a slice would read the buffer as it was before the copy began.
        for k in range(match):
            out.append(out[start + k])
    return bytes(out[:out_len])


def profile_dir_for_pgid(pgid) -> str:
    """The -profile directory of the Firefox in this session's process group."""
    if pgid is None:
        return ""
    sep = bytes([0])
    for path in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            pid = int(path.split("/")[2])
            if os.getpgid(pid) != pgid:
                continue
            with open(path, "rb") as fh:
                args = fh.read().split(sep)
            if b"-profile" in args:
                return args[args.index(b"-profile") + 1].decode()
        except Exception:
            continue
    return ""


def _urls_from_store(path: str) -> list:
    with open(path, "rb") as fh:
        raw = fh.read()
    if raw[:8] != MOZ_LZ4_MAGIC:
        return []
    size = struct.unpack("<I", raw[8:12])[0]
    data = json.loads(lz4_block_decompress(raw[12:], size))

    urls = []
    for win in data.get("windows", []):
        for tab in win.get("tabs", []):
            entries = tab.get("entries") or []
            if not entries:
                continue
            # `index` is 1-based and points at the current entry in that tab's history.
            idx = tab.get("index", len(entries))
            idx = min(max(int(idx), 1), len(entries))
            url = entries[idx - 1].get("url", "")
            if url.startswith("http://") or url.startswith("https://"):
                urls.append(url)
    return urls


def open_tab_urls(pgid) -> list:
    """Every http(s) tab open in this session's Firefox, in window/tab order.

    Empty when the profile cannot be found or the store cannot be read — this is a nicety,
    and nothing about closing a browser should fail because of it.
    """
    prof = profile_dir_for_pgid(pgid)
    if not prof:
        return []
    # recovery is the live one; sessionstore is written on a clean shutdown.
    for name in ("sessionstore-backups/recovery.jsonlz4", "sessionstore.jsonlz4"):
        try:
            urls = _urls_from_store(os.path.join(prof, name))
        except Exception:
            continue
        if urls:
            return urls
    return []
