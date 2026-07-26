"""Daily snapshot: fetch live TCGCSV data, refresh dimensions, append
today's price rows to the lake, re-derive flags, rebuild view JSON.

Usage:
    python pipeline/fetch_current.py            # full daily run
    python pipeline/fetch_current.py --sample   # print sample rows, write nothing
"""
from __future__ import annotations

import argparse
import datetime as dt
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


def run_daily(snapshot_date: str | None = None) -> None:
    date = snapshot_date or dt.date.today().isoformat()
    print(f"daily snapshot for {date}")

    set_dims, product_dims, reports = [], [], []
    rows: list[dict] = []
    keep_ids: set[int] = set()
    for game, cat in common.GAMES:
        groups, products_by_group, prices_by_group = fetch_all(cat)
        print(f"  {game}: {len(groups)} groups")
        set_dim = common.build_set_dim(groups, game)
        products_df, report = common.build_product_dim(groups, products_by_group, set_dim, game)
        set_dims.append(set_dim)
        product_dims.append(products_df)
        reports.extend(report)
        keep_ids |= common.relevant_ids(products_df, game)
        for gid, results in prices_by_group.items():
            rows.extend(common.snapshot_rows(date, gid, results))

    set_dim = pd.concat(set_dims, ignore_index=True)
    products_df = pd.concat(product_dims, ignore_index=True)
    report = reports
    # keep all Pokemon prices (singles feed chase) but only Magic sealed prices
    rows = [r for r in rows if int(r["productId"]) in keep_ids]
    written = build_parquet.append_prices(pd.DataFrame(rows))
    print(f"  {len(rows)} price rows -> {len(written)} partition(s)")

    products_df, set_dim = common.enrich_from_history(products_df, set_dim)
    common.write_dimensions(set_dim, products_df, report)
    print(f"  dimensions written ({len(products_df)} products, "
          f"{len(report)} flagged for data-quality review)")

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
    args = ap.parse_args()
    if args.sample:
        print_sample()
    else:
        run_daily(args.date)
