"""Daily snapshot: fetch live TCGCSV data, refresh dimensions, append
today's price rows to the lake, re-derive flags, rebuild view JSON.

Usage:
    python pipeline/fetch_current.py            # full daily run
    python pipeline/fetch_current.py --sample   # print sample rows, write nothing
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys

import pandas as pd

import build_parquet
import common
import tcgcsv


def fetch_all(category_id: int = tcgcsv.POKEMON_CATEGORY_ID):
    """groups, products per group, prices per group -- live endpoints."""
    groups = tcgcsv.fetch_groups(category_id)
    products_by_group: dict[int, list[dict]] = {}
    prices_by_group: dict[int, list[dict]] = {}
    for i, g in enumerate(groups):
        gid = int(g["groupId"])
        products_by_group[gid] = tcgcsv.fetch_products(gid, category_id)
        prices_by_group[gid] = tcgcsv.fetch_prices(gid, category_id)
        if (i + 1) % 25 == 0:
            print(f"  fetched {i + 1}/{len(groups)} groups", file=sys.stderr)
    return groups, products_by_group, prices_by_group


# The scheduled run is late far more often than it is on time: GitHub queues
# cron workflows behind everyone else's and has delayed this one by 1.5-8h.
# Stamping rows with the wall-clock date therefore loses a day outright
# whenever a run crosses UTC midnight -- it writes tomorrow's date, and
# tomorrow's own run then replaces those rows. Any run landing before this
# hour is a delayed run for the previous day. The cron fires at ~21:00 UTC,
# so this absorbs a delay of up to ~15h and still dates the rows correctly.
DELAYED_RUN_CUTOFF_UTC = 12


def snapshot_date_for(now: dt.datetime) -> str:
    """The date a run started at `now` (UTC) is a snapshot OF."""
    day = now.date()
    if now.hour < DELAYED_RUN_CUTOFF_UTC:
        day -= dt.timedelta(days=1)
    return day.isoformat()


def run_daily(snapshot_date: str | None = None, repair: bool = True) -> None:
    date = snapshot_date or snapshot_date_for(dt.datetime.now(dt.timezone.utc))
    print(f"daily snapshot for {date}")
    # Let the workflow label its commit with the date actually written rather
    # than its own wall clock, which is what drifted in the first place.
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            fh.write(f"snapshot_date={date}\n")

    set_dims, product_dims, reports = [], [], []
    rows: list[dict] = []
    skipped: list[str] = []
    for game, cat in common.GAMES:
        try:
            groups, products_by_group, prices_by_group = fetch_all(cat)
        except Exception as e:
            # A second game failing must not break the primary (Pokemon) run.
            print(f"  {game}: FETCH FAILED ({e}) -- skipping this game", file=sys.stderr)
            if game == common.GAMES[0][0]:
                raise
            skipped.append(game)
            continue
        print(f"  {game}: {len(groups)} groups")
        set_dim = common.build_set_dim(groups, game)
        products_df, report = common.build_product_dim(groups, products_by_group, set_dim, game)
        set_dims.append(set_dim)
        product_dims.append(products_df)
        reports.extend(report)
        # Filter only the non-primary game (Magic sealed only); Pokemon rows
        # are kept unconditionally so nothing is ever silently dropped.
        keep = common.relevant_ids(products_df, game)
        for gid, results in prices_by_group.items():
            for r in common.snapshot_rows(date, gid, results):
                if game == "Pokemon" or int(r["productId"]) in keep:
                    rows.append(r)

    set_dim = pd.concat(set_dims, ignore_index=True)
    products_df = pd.concat(product_dims, ignore_index=True)
    report = reports
    # A skipped game means this is a PARTIAL snapshot: load additively so a
    # same-day re-run can't delete the skipped game's already-stored rows,
    # and carry that game's existing dimension rows forward (write_dimensions
    # overwrites the parquet wholesale).
    written = build_parquet.append_prices(pd.DataFrame(rows), replace_dates=not skipped)
    print(f"  {len(rows)} price rows -> {len(written)} partition(s)")
    if skipped:
        set_dim, products_df = common.carry_forward_dims(set_dim, products_df, skipped)
        print(f"  preserved existing dimension rows for skipped: {', '.join(skipped)}")

    products_df, set_dim = common.enrich_from_history(products_df, set_dim)
    common.write_dimensions(set_dim, products_df, report)
    print(f"  dimensions written ({len(products_df)} products, "
          f"{len(report)} flagged for data-quality review)")

    # Self-heal before rebuilding views, so a repaired day is reflected in
    # the JSON this same run rather than a day later.
    if repair:
        try:
            import backfill_archive
            repaired, still = backfill_archive.repair_gaps(
                today=date, products_df=products_df)
            if repaired:
                print(f"  gap repair: filled {len(repaired)} date(s): {', '.join(repaired)}")
            if still:
                print(f"  gap repair: STILL MISSING {len(still)}: {', '.join(still)}", file=sys.stderr)
        except Exception as e:
            # Never let the repair path break the day's snapshot.
            print(f"  gap repair FAILED ({e}) -- snapshot itself is unaffected", file=sys.stderr)

    import build_views
    build_views.build_all()
    print("  view JSON rebuilt")


def print_sample() -> None:
    groups = tcgcsv.fetch_groups()
    print(f"{len(groups)} Pokemon groups; newest 5:")
    newest = sorted(groups, key=lambda g: g.get("publishedOn") or "", reverse=True)[:5]
    for g in newest:
        print(f"  {g['groupId']}  {g.get('abbreviation') or '':8} {g['name']}  ({g.get('publishedOn')})")
    gid = int(newest[0]["groupId"])
    products = tcgcsv.fetch_products(gid)
    prices = tcgcsv.fetch_prices(gid)
    print(f"\ngroup {gid}: {len(products)} products, {len(prices)} price rows; samples:")
    for p in products[:3]:
        print("  product:", {k: p.get(k) for k in ("productId", "name", "cleanName")})
    for r in prices[:3]:
        print("  price:  ", {k: r.get(k) for k in ("productId", "subTypeName", "marketPrice", "midPrice", "lowPrice", "directLowPrice")})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true", help="print sample rows only")
    ap.add_argument("--date", help="snapshot date override (YYYY-MM-DD)")
    ap.add_argument("--no-repair", action="store_true",
                    help="skip the trailing-window gap repair")
    args = ap.parse_args()
    if args.sample:
        print_sample()
    else:
        run_daily(args.date, repair=not args.no_repair)
