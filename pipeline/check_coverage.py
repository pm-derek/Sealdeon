"""Report (and optionally enforce) daily coverage of the price lake.

The daily snapshot can only write the day it runs, so a lost day is
invisible unless something looks for it. This prints a Markdown summary for
the Actions job summary and can fail the job when a gap persists.

Usage:
    python pipeline/check_coverage.py --lookback 45
    python pipeline/check_coverage.py --lookback 45 --fail-on-gap
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

import build_parquet

STATE_PATH = os.path.join(build_parquet.DATA_DIR, "backfill_state.json")


def _state() -> dict:
    try:
        with open(STATE_PATH) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _unavailable() -> set[str]:
    return set(_state().get("unavailableDates", []))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lookback", type=int, default=45)
    ap.add_argument("--fail-on-gap", action="store_true",
                    help="exit non-zero if a repairable gap remains")
    args = ap.parse_args()

    stored = build_parquet.stored_dates()
    if not stored:
        print("## Lake coverage\n\n**Lake is empty.**")
        return 1 if args.fail_on_gap else 0

    missing = build_parquet.missing_dates(args.lookback)
    known = _unavailable()
    # A date upstream never served is not a pipeline failure; separate it out
    # so a genuine regression is not buried under permanent archive holes.
    repairable = [d for d in missing if d not in known]
    upstream = [d for d in missing if d in known]
    latest = stored[-1]
    stale_days = (dt.date.today() - dt.date.fromisoformat(latest)).days

    print("## Lake coverage")
    print()
    print(f"- Latest stored date: **{latest}** ({stale_days}d old)")
    print(f"- Distinct dates stored: **{len(stored)}** ({stored[0]} → {latest})")
    print(f"- Window checked: last **{args.lookback}** days")
    backoff = _state().get("archiveBackoffUntil")
    if repairable and backoff:
        print(f"- ⚠️ Missing, NOT currently recoverable: **{', '.join(repairable)}**")
        print(f"  - The TCGCSV price archive is withdrawn upstream (403 on every "
              f"date). Auto-retry paused until **{backoff}**; repair resumes by "
              f"itself if the archive returns.")
    elif repairable:
        print(f"- ⚠️ Missing (repairable): **{', '.join(repairable)}**")
    if upstream:
        print(f"- Missing (upstream archive has no data): {', '.join(upstream)}")
    if not missing:
        print("- ✅ No gaps in the window")
    print()

    if args.fail_on_gap and repairable:
        print(f"::error::{len(repairable)} repairable gap(s) remain: {', '.join(repairable)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
