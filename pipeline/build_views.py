"""Layer 2 builder: run the fixed view queries (DuckDB over the Parquet
lake) and write the small JSON files the frontend loads.

Outputs (web/public/views/):
    meta.json                 -- set dimension + latest date (shared by all views)
    cohort_curves.json        -- indexed price + premium series per (set, seriesType)
    age_band_medians.json     -- pooled medians with hype split
    movers.json               -- gainers/losers + premium swings
    premium_vs_median.json    -- current premium vs historical clean median
    set_detail/{groupId}.json -- per-set page payloads
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os

import duckdb
import pandas as pd

import build_parquet

QUERY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "queries")
VIEWS_DIR = os.environ.get("SEALDEON_VIEWS_DIR", os.path.join("web", "public", "views"))
CONFIG_DIR = os.environ.get("SEALDEON_CONFIG_DIR", "config")

SPARKLINE_DAYS = 120


def _sql(name: str) -> str:
    with open(os.path.join(QUERY_DIR, name)) as f:
        return f.read()


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    setup = _sql("_setup.sql").format(
        prices_glob=build_parquet.price_glob(),
        sets_path=os.path.join(build_parquet.DATA_DIR, "sets.parquet"),
        products_path=os.path.join(build_parquet.DATA_DIR, "products.parquet"),
    )
    con.execute(setup)
    return con


def _clean(value):
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()[:10]
    if isinstance(value, pd.Timestamp):
        return value.date().isoformat()
    return value


def records(df: pd.DataFrame) -> list[dict]:
    out = []
    for row in df.to_dict("records"):
        out.append({k: _clean(v) for k, v in row.items()})
    return out


def write_json(rel_path: str, payload) -> str:
    path = os.path.join(VIEWS_DIR, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(payload, f, separators=(",", ":"), allow_nan=False)
    return path


def _load_aliases() -> dict:
    path = os.path.join(CONFIG_DIR, "aliases.json")
    if os.path.exists(path):
        with open(path) as f:
            return {k: v for k, v in json.load(f).items() if not k.startswith("_")}
    return {}


def build_meta(con) -> dict:
    sets = records(con.execute("SELECT * FROM sets ORDER BY releaseDate DESC NULLS LAST").df())
    latest = con.execute("SELECT max(date) FROM px").fetchone()[0]
    meta = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "latestDate": _clean(latest),
        "archiveFloor": "2024-02-08",
        "seriesTypes": ["Booster Box", "ETB", "PKC ETB", "Booster Bundle", "UPC", "Chase Singles"],
        "ageBands": ["0-1mo", "1-3mo", "3-6mo", "6-12mo", "12mo+"],
        "aliases": _load_aliases(),
        "sets": sets,
    }
    write_json("meta.json", meta)
    return meta


def build_cohort_curves(con) -> None:
    df = con.execute(_sql("cohort_curves.sql")).df()
    series = []
    for (gid, stype), rows in df.groupby(["groupId", "seriesType"], sort=True):
        points = [
            [int(r.ageDays),
             _clean(r.idx),
             _clean(r.prem),
             _clean(r.price)]
            for r in rows.itertuples()
        ]
        series.append({
            "groupId": int(gid),
            "seriesType": stype,
            "lowConfidence": bool((rows["conf"] == "low").any()),
            "points": points,  # [ageDays, idxPrice, premiumPct, price]
        })
    write_json("cohort_curves.json", {"series": series})


def build_age_band_medians(con) -> None:
    df = con.execute(_sql("age_band_medians.sql")).df()
    write_json("age_band_medians.json", {"rows": records(df)})


def build_movers(con) -> None:
    df = con.execute(_sql("movers.sql")).df()
    payload = {
        "rows": records(df),
        # Explicit stub: these light up only if a paid listings/sales
        # feed (TCGplayer API / TCGAPIs) is ever added.
        "volumeMetrics": {"available": False, "reason": "no free ToS-compliant source",
                          "columns": ["qtyListed", "qtySold"]},
    }
    write_json("movers.json", payload)


def build_premium_vs_median(con) -> None:
    df = con.execute(_sql("premium_vs_median.sql")).df()
    write_json("premium_vs_median.json", {"rows": records(df)})


def build_set_details(con, meta: dict) -> None:
    detail = con.execute(_sql("set_detail.sql")).df()
    if detail.empty:
        return

    ids = ",".join(str(int(i)) for i in detail["productId"].unique())
    sparks = con.execute(
        f"WITH latest AS (SELECT max(date) AS d FROM px) "
        f"SELECT productId, date, round(price,2) AS price FROM px, latest "
        f"WHERE productId IN ({ids}) AND date >= d - {SPARKLINE_DAYS} "
        # Weekly sampling (+ the latest point): a 90px thumbnail needs
        # ~18 points, not 121 daily ones. Cuts per-set-file size ~6x and
        # keeps the daily commit small.
        f"AND (date_diff('day', date, d) % 7 = 0 OR date = d) "
        f"ORDER BY productId, date"
    ).df()
    spark_map: dict[int, list] = {}
    for pid, rows in sparks.groupby("productId"):
        spark_map[int(pid)] = [[_clean(r.date), _clean(r.price)] for r in rows.itertuples()]

    bands = con.execute("""
        SELECT s.era, si.seriesType, si.ageDays,
               round(quantile_cont(si.idxPrice, 0.25), 2) AS p25,
               round(quantile_cont(si.idxPrice, 0.50), 2) AS p50,
               round(quantile_cont(si.idxPrice, 0.75), 2) AS p75,
               round(quantile_cont(si.premiumPct, 0.25), 4) AS premP25,
               round(quantile_cont(si.premiumPct, 0.50), 4) AS premP50,
               round(quantile_cont(si.premiumPct, 0.75), 4) AS premP75
        FROM series_indexed si JOIN sets s USING (groupId)
        WHERE si.ageDays >= 0 AND (si.ageDays <= 120 OR si.ageDays % 7 = 0)
          -- SetDetail renders only the Booster Box era band; scoping here
          -- keeps the shared file small.
          AND si.seriesType = 'Booster Box'
        GROUP BY s.era, si.seriesType, si.ageDays
        ORDER BY s.era, si.seriesType, si.ageDays
    """).df()
    band_map: dict[str, list[dict]] = {}
    for era, rows in bands.groupby("era"):
        band_map[era] = records(rows.drop(columns=["era"]))
    # Era bands are per-era, not per-set -- write once and let SetDetail
    # load the shared file, instead of duplicating ~200KB into all 212
    # set files (which would churn the whole lake on every daily commit).
    write_json("era_bands.json", {"bands": band_map})

    curves = con.execute(_sql("cohort_curves.sql")).df()
    sets_by_id = {int(s["groupId"]): s for s in meta["sets"]}
    latest = meta["latestDate"]

    for gid, rows in detail.groupby("groupId"):
        gid = int(gid)
        set_row = sets_by_id.get(gid, {})
        rel = set_row.get("releaseDate")
        age = None
        if rel and latest:
            age = (dt.date.fromisoformat(latest) - dt.date.fromisoformat(rel)).days

        sealed_rows, chase_rows = [], []
        for r in records(rows.drop(columns=["groupId"])):
            r["sparkline"] = spark_map.get(int(r["productId"]), [])
            (chase_rows if r.pop("isChase") else sealed_rows).append(r)
        chase_rows.sort(key=lambda r: -(r.get("peakPrice") or 0))

        set_curves = []
        for stype, crows in curves[curves["groupId"] == gid].groupby("seriesType"):
            set_curves.append({
                "seriesType": stype,
                "points": [[int(r.ageDays), _clean(r.idx), _clean(r.prem), _clean(r.price)]
                           for r in crows.itertuples()],
            })

        write_json(f"set_detail/{gid}.json", {
            "set": set_row,
            "ageDays": age,
            "sealed": sealed_rows,
            "chase": chase_rows,
            "curves": set_curves,
            # eraBand lives in the shared era_bands.json (keyed by era);
            # the frontend joins on set.era. Kept out of per-set files.
        })


def build_all() -> None:
    import signals
    con = connect()
    try:
        meta = build_meta(con)
        build_cohort_curves(con)
        build_age_band_medians(con)
        build_movers(con)
        build_premium_vs_median(con)
        build_set_details(con, meta)
        signals.build_signals(con, VIEWS_DIR)
    finally:
        con.close()
    print(f"views written to {VIEWS_DIR}")


if __name__ == "__main__":
    build_all()
