"""Probe the TCGCSV archive endpoint and report raw HTTP status per date.

The repair path started getting 403 (not 404) on every archive URL while the
JSON API on the same host kept working, which points at the archive endpoint
specifically rather than the dates. This says, for a spread of dates, exactly
what the server answers -- enough to tell "archives are gone/gated" from
"only recent dates are withheld".

Usage:
    python pipeline/probe_archive.py 2026-09-21 2026-09-25
    python pipeline/probe_archive.py            # default spread
"""
from __future__ import annotations

import sys

import tcgcsv

DEFAULT_DATES = [
    tcgcsv.ARCHIVE_FLOOR,  # known-good floor the lake was built from
    "2025-01-15",
    "2026-06-01",
    "2026-08-06",          # our gaps
    "2026-09-21",
    "2026-09-25",
    "2026-09-28",
    "2026-09-29",          # a date we DO have, so a 403 here means the
                           # endpoint is gated, not the date
]


def main() -> int:
    dates = sys.argv[1:] or DEFAULT_DATES
    print(f"probing {len(dates)} archive URL(s)")
    print(f"  pattern: {tcgcsv.ARCHIVE_URL}")
    print(f"  user-agent: {tcgcsv.USER_AGENT}\n")
    sess = tcgcsv.session()
    worst = 0
    bodies_shown = [0]
    for d in dates:
        url = tcgcsv.ARCHIVE_URL.format(date=d)
        try:
            # HEAD avoids pulling ~100MB just to learn the status.
            r = sess.head(url, timeout=60, allow_redirects=True)
            size = r.headers.get("content-length", "?")
            print(f"  {d}  HTTP {r.status_code}  content-length={size}"
                  f"  type={r.headers.get('content-type','?')}")
            if r.status_code >= 400:
                worst = max(worst, r.status_code)
                # A small text/plain error body is the server telling us why.
                # Print the first one; they have all been identical so far.
                if bodies_shown[0] == 0 and r.status_code != 404:
                    try:
                        g = sess.get(url, timeout=60, stream=True)
                        body = g.raw.read(4096, decode_content=True)
                        g.close()
                        print("\n  --- error body ---")
                        print("  " + body.decode("utf-8", "replace").strip()
                              .replace("\n", "\n  "))
                        print("  --- end body ---\n")
                        bodies_shown[0] = 1
                    except Exception as be:
                        print(f"  (could not read body: {be})")
        except Exception as e:
            print(f"  {d}  ERROR {type(e).__name__}: {e}")
            worst = max(worst, 599)

    # Is it our User-Agent? Retry one URL with a plain browser UA.
    try:
        import requests as _rq
        u = tcgcsv.ARCHIVE_URL.format(date=tcgcsv.ARCHIVE_FLOOR)
        alt = _rq.head(u, timeout=60, allow_redirects=True, headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"})
        print(f"  UA test (browser UA, {tcgcsv.ARCHIVE_FLOOR}): HTTP {alt.status_code}")
    except Exception as e:
        print(f"  UA test failed: {e}")

    # Control: does the plain JSON API still work from here?
    try:
        groups = tcgcsv.fetch_groups()
        print(f"\n  control: JSON API OK ({len(groups)} Pokemon groups)")
    except Exception as e:
        print(f"\n  control: JSON API FAILED ({e})")
    return 0 if worst < 400 else 0  # diagnostic only; never fail the job


if __name__ == "__main__":
    sys.exit(main())
