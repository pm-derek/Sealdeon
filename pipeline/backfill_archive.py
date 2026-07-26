"""Historical backfill from the TCGCSV daily price archive.

Archive: https://tcgcsv.com/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z
Floor:   2024-02-08 (hard -- nothing free exists before it)
Layout inside the 7z: YYYY-MM-DD/{categoryId}/{groupId}/prices  (JSON)

The 7z uses PPMd compression; extraction is via py7zr (bundles pyppmd)
with a fallback to a system `7z` binary if present.

Usage:
    python pipeline/backfill_archive.py --validate            # ONE date (the floor), inspect structure
    python pipeline/backfill_archive.py                       # full range, resumes from checkpoint
    python pipeline/backfill_archive.py --start 2024-02-08 --end 2024-03-31
    python pipeline/backfill_archive.py --finalize            # dims + flags + views after row loading

Checkpointing: data/backfill_state.json records the last completed date;
partitions are written after each month so an interrupted run resumes
cleanly (append_prices is idempotent per date).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile

import pandas as pd

import build_parquet
import common
import tcgcsv

STATE_PATH = os.path.join(build_parquet.DATA_DIR, "backfill_state.json")


def _load_state() -> dict:
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    return {}


def _save_state(state: dict) -> None:
    os.makedirs(build_parquet.DATA_DIR, exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=1)


def extract_category(archive_path: str, date: str,
                     category_id: int = tcgcsv.POKEMON_CATEGORY_ID) -> dict[int, list[dict]]:
    """Extract one category's price files from a daily archive.

    Returns {groupId: price_results}. Tries py7zr first (PPMd support via
    pyppmd); falls back to a system 7z binary.
    """
    prefix = f"{date}/{category_id}/"
    try:
        import py7zr
        with tempfile.TemporaryDirectory() as tmp:
            with py7zr.SevenZipFile(archive_path, mode="r") as z:
                targets = [n for n in z.getnames()
                           if n.startswith(prefix) and n.endswith("prices")]
                if targets:
                    z.extract(path=tmp, targets=targets)
            out: dict[int, list[dict]] = {}
            for name in targets:
                gid = int(name[len(prefix):].split("/")[0])
                with open(os.path.join(tmp, name), encoding="utf-8") as f:
                    out[gid] = json.load(f).get("results", [])
            return out
    except Exception as e:  # py7zr missing or PPMd unsupported -> shell out
        if shutil.which("7z") is None:
            raise RuntimeError(f"py7zr failed ({e}) and no system 7z available") from e
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(
                ["7z", "x", "-y", f"-o{tmp}", archive_path, f"{prefix}*"],
                check=True, capture_output=True)
            out = {}
            cat_dir = os.path.join(tmp, date, str(category_id))
            if os.path.isdir(cat_dir):
                for gid in os.listdir(cat_dir):
                    prices_file = os.path.join(cat_dir, gid, "prices")
                    if os.path.exists(prices_file):
                        with open(prices_file) as f:
                            out[int(gid)] = json.load(f).get("results", [])
            return out


def load_date(date: str, workdir: str, keep_ids: set[int] | None = None) -> pd.DataFrame:
    """Download + extract one archive date (both games); return snapshot rows,
    filtered to keep_ids (drops Magic single-card prices)."""
    archive_path = os.path.join(workdir, f"prices-{date}.7z")
    tcgcsv.download_archive(date, archive_path)
    rows: list[dict] = []
    for _, cat in common.GAMES:
        by_group = extract_category(archive_path, date, cat)
        for gid, results in by_group.items():
            rows.extend(common.snapshot_rows(date, gid, results))
    os.remove(archive_path)
    df = pd.DataFrame(rows)
    if keep_ids is not None and not df.empty:
        df = df[df["productId"].astype("int64").isin(keep_ids)].reset_index(drop=True)
    return df


def validate_one(date: str = tcgcsv.ARCHIVE_FLOOR) -> None:
    """Step-4 sanity check from the spec: ONE date, inspect, no writes."""
    with tempfile.TemporaryDirectory() as tmp:
        archive_path = os.path.join(tmp, f"prices-{date}.7z")
        print(f"downloading archive for {date} ...")
        tcgcsv.download_archive(date, archive_path)
        size_mb = os.path.getsize(archive_path) / 1e6
        print(f"  {size_mb:.1f} MB")
        by_group = extract_category(archive_path, date)
        n_rows = sum(len(v) for v in by_group.values())
        print(f"  category 3: {len(by_group)} groups, {n_rows} price rows")
        gid = next(iter(sorted(by_group)))
        print(f"  sample rows from group {gid}:")
        for r in by_group[gid][:3]:
            print("   ", {k: r.get(k) for k in ("productId", "subTypeName", "marketPrice", "midPrice", "lowPrice", "directLowPrice")})


def run_backfill(start: str, end: str) -> None:
    state = _load_state()
    resume = state.get("lastCompleted")
    d = dt.date.fromisoformat(start)
    if resume and dt.date.fromisoformat(resume) >= d:
        d = dt.date.fromisoformat(resume) + dt.timedelta(days=1)
        print(f"resuming after checkpoint {resume}")
    end_d = dt.date.fromisoformat(end)

    # Which product ids to retain: all Pokemon + Magic sealed only. Fetched
    # once so archive loading can drop the flood of Magic single-card prices.
    print("resolving relevant product ids (both games) ...")
    _, products_df, _ = common.build_all_dims_live()
    keep_ids = common.keep_ids_from_products(products_df)
    print(f"  keeping {len(keep_ids)} product ids")

    workdir = tempfile.mkdtemp(prefix="sealdeon-backfill-")
    month_rows: list[pd.DataFrame] = []
    current_month = None
    try:
        while d <= end_d:
            date = d.isoformat()
            month = date[:7]
            if current_month and month != current_month:
                _flush_month(month_rows, current_month, state)
                month_rows = []
            current_month = month
            try:
                df = load_date(date, workdir, keep_ids)
                month_rows.append(df)
                print(f"  {date}: {len(df)} rows")
            except Exception as e:
                # Missing archive days exist (rare gaps) -- log and move on.
                print(f"  {date}: SKIPPED ({e})", file=sys.stderr)
            d += dt.timedelta(days=1)
        if month_rows:
            _flush_month(month_rows, current_month, state)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    print("backfill rows loaded; run with --finalize to build dims + views")


def _flush_month(frames: list[pd.DataFrame], month: str, state: dict) -> None:
    if frames:
        combined = pd.concat(frames, ignore_index=True)
        build_parquet.append_prices(combined)
        last = max(str(x) for x in combined["date"].astype(str))
    else:
        last = month + "-28"
    state["lastCompleted"] = last
    _save_state(state)
    print(f"  checkpoint: {month} written ({last})")


def finalize() -> None:
    """Steps 1,3-9: dims from live metadata, peaks/chase, hype, intrinsic,
    quality report, then views."""
    print("fetching current metadata (groups/products, both games) ...")
    set_dim, products_df, report = common.build_all_dims_live()
    products_df, set_dim = common.enrich_from_history(products_df, set_dim)
    common.write_dimensions(set_dim, products_df, report)
    print(f"  {len(report)} sealed products flagged medium/low -> data/data_quality_report.json")
    import build_views
    build_views.build_all()
    print("  view JSON built")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true", help="validate ONE archive date, no writes")
    ap.add_argument("--start", default=tcgcsv.ARCHIVE_FLOOR)
    ap.add_argument("--end", default=dt.date.today().isoformat())
    ap.add_argument("--finalize", action="store_true", help="build dims + flags + views after loading")
    args = ap.parse_args()
    if args.validate:
        validate_one()
    elif args.finalize:
        finalize()
    else:
        run_backfill(args.start, args.end)
        finalize()
