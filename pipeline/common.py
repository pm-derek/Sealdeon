"""Shared orchestration: dimension building, intrinsic resolution, and
history-derived enrichment (peaks/chase/hype) used by both the daily
fetch and the backfill.
"""
from __future__ import annotations

import json
import os
import re

import duckdb
import pandas as pd

import build_parquet
import chase as chase_mod
import hype as hype_mod
import intrinsic as intrinsic_mod
from classify import classify_product
from era import enrich_set, detect_era, ERA_SPECIAL

CONFIG_DIR = os.environ.get("SEALDEON_CONFIG_DIR", "config")

_PROMO_GROUP_RE = re.compile(r"promo", re.IGNORECASE)


def build_set_dim(groups: list[dict]) -> pd.DataFrame:
    rows = [enrich_set(g) for g in groups]
    return pd.DataFrame(rows)


def _era_of_promo_group(group: dict) -> str:
    """Era family of a promo group, from its abbreviation/name prefix.

    (detect_era would return Special/Promo for these -- here we want the
    era whose sets the promos belong to.)
    """
    abbr = (group.get("abbreviation") or "").upper()
    name = group.get("name") or ""
    stripped = re.sub(r"promo(?:s| cards?)?", "", name, flags=re.IGNORECASE)
    era = detect_era(stripped, abbr, group.get("publishedOn"))
    return era


def promo_pools(groups: list[dict], products_by_group: dict[int, list[dict]]) -> dict[str, list[dict]]:
    """era -> raw promo-card products from that era's promo group(s)."""
    pools: dict[str, list[dict]] = {}
    for g in groups:
        if not _PROMO_GROUP_RE.search(g.get("name") or ""):
            continue
        era = _era_of_promo_group(g)
        pools.setdefault(era, []).extend(products_by_group.get(g["groupId"], []))
    return pools


def build_product_dim(groups: list[dict], products_by_group: dict[int, list[dict]],
                      set_dim: pd.DataFrame) -> tuple[pd.DataFrame, list[dict]]:
    """Classify all products, resolve intrinsic inputs, flag canonical
    products per (set, productType).

    Returns (products_df, quality_report_rows).
    """
    pools = promo_pools(groups, products_by_group)
    pack_overrides = intrinsic_mod.load_packcount_overrides(
        os.path.join(CONFIG_DIR, "packcount_overrides.json"))
    promo_overrides = intrinsic_mod.load_promo_overrides(
        os.path.join(CONFIG_DIR, "promo_overrides.json"))
    sets_by_id = {int(r["groupId"]): r for r in set_dim.to_dict("records")}

    product_rows: list[dict] = []
    resolutions: list[dict] = []
    for g in groups:
        gid = int(g["groupId"])
        raw_products = products_by_group.get(gid, [])
        set_row = sets_by_id.get(gid) or {"groupId": gid, "name": g.get("name"), "era": ERA_SPECIAL}
        classified = []
        for p in raw_products:
            c = classify_product(p)
            row = {
                "productId": int(p["productId"]),
                "groupId": gid,
                "name": p.get("name"),
                "cleanName": p.get("cleanName"),
                "imageUrl": p.get("imageUrl"),
                "url": p.get("url"),
                **c,
            }
            classified.append(row)
            product_rows.append(row)
        sealed = [r for r in classified if r["isSealed"]]
        if sealed:
            pool = pools.get(set_row.get("era"), [])
            resolutions.extend(intrinsic_mod.resolve_set(
                sealed, set_row, raw_products, pool, pack_overrides, promo_overrides))

    products_df = pd.DataFrame(product_rows)
    res_df = pd.DataFrame(resolutions)
    if not res_df.empty:
        products_df = products_df.merge(
            res_df.drop(columns=["groupId", "attemptedPromo"]), on="productId", how="left")
    else:
        for col in ["packCount", "packCountSource", "packProductId", "promoProductId",
                    "promoSource", "intrinsicConfidence", "decomposable"]:
            products_df[col] = None
    products_df["decomposable"] = products_df["decomposable"].fillna(False).astype(bool)

    # Multipacks / partial units ("Elite Trainer Box Set of 2", "Half Booster
    # Box", "... Lot of 3") share a productType with the single unit but are
    # priced per bundle, so they must NOT represent the type. Their pack count
    # is also per-single, so decomposing them yields a wildly inflated premium.
    is_multi = products_df["name"].fillna("").str.lower().str.contains(
        r"set of \d|\bhalf\b|lot of \d|pack of \d|\bdouble\b", regex=True)
    products_df["_multi"] = is_multi

    # Canonical product per (groupId, productType): the single unit with the
    # shortest name -- prefer non-multipack listings, so the cross-set cohort
    # series ("Booster Box" / "ETB" line per set) tracks one real box.
    products_df["isCanonical"] = False
    typed = products_df[products_df["productType"].notna()].copy()
    if not typed.empty:
        typed["_len"] = typed["name"].fillna("").str.len()
        order = typed.sort_values(["_multi", "_len"])
        first = order.groupby([order["groupId"], order["productType"]], sort=False).head(1)
        products_df.loc[first.index, "isCanonical"] = True

    # Keep multipacks/partials out of the intrinsic-premium views (they're
    # decomposed against a single unit's pack count -> false premium).
    if "intrinsicConfidence" in products_df.columns:
        products_df.loc[is_multi, "intrinsicConfidence"] = "low"
    products_df.drop(columns=["_multi"], inplace=True, errors="ignore")

    products_by_id = {r["productId"]: r for r in product_rows}
    report = intrinsic_mod.quality_report(resolutions, products_by_id, sets_by_id)
    return products_df, report


def snapshot_rows(date: str, group_id: int, price_results: list[dict]) -> list[dict]:
    """Flatten one group's /prices results into snapshot fact rows.

    highPrice is intentionally dropped; volume columns stay null (no free
    source in v1).
    """
    rows = []
    for r in price_results:
        rows.append({
            "date": date,
            "groupId": group_id,
            "productId": r.get("productId"),
            "subTypeName": r.get("subTypeName"),
            "marketPrice": r.get("marketPrice"),
            "midPrice": r.get("midPrice"),
            "lowPrice": r.get("lowPrice"),
            "directLowPrice": r.get("directLowPrice"),
            "qtyListed": None,
            "qtySold": None,
        })
    return rows


def connect_lake() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(f"""
        CREATE OR REPLACE VIEW prices AS
        SELECT * FROM read_parquet('{build_parquet.price_glob()}')
    """)
    return con


def enrich_from_history(products_df: pd.DataFrame,
                        set_dim: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Peak/chase flags + hype flags, computed against the full lake via
    DuckDB (reduced frames keep pandas small)."""
    con = connect_lake()

    # Peak per product x subtype -- enough for both peak columns and the
    # chase ranking, tiny compared to the raw lake.
    peak_rows = con.execute("""
        SELECT productId, subTypeName,
               max(marketPrice) AS marketPrice,
               arg_max(date, marketPrice) AS date
        FROM prices
        WHERE marketPrice IS NOT NULL
        GROUP BY productId, subTypeName
    """).df()
    products_df = chase_mod.flag_chase(products_df, peak_rows)
    products_df["peakDate"] = pd.to_datetime(products_df["peakDate"]).dt.date

    # Early-window rows for the canonical hype products only.
    canonical = products_df[
        products_df["isCanonical"] & products_df["productType"].isin(hype_mod.CANONICAL_TYPES)
    ]["productId"]
    id_list = ",".join(str(int(i)) for i in canonical) or "-1"
    early_rows = con.execute(
        "SELECT date, productId, max(marketPrice) AS marketPrice FROM prices "
        f"WHERE marketPrice IS NOT NULL AND productId IN ({id_list}) "
        "GROUP BY date, productId"
    ).df()
    con.close()

    set_dim = hype_mod.apply_hype(
        set_dim, early_rows, products_df,
        overrides_path=os.path.join(CONFIG_DIR, "hype_overrides.json"))
    return products_df, set_dim


def write_dimensions(set_dim: pd.DataFrame, products_df: pd.DataFrame,
                     report: list[dict]) -> None:
    build_parquet.write_sets(set_dim)
    build_parquet.write_products(products_df)
    os.makedirs(build_parquet.DATA_DIR, exist_ok=True)
    with open(os.path.join(build_parquet.DATA_DIR, "data_quality_report.json"), "w") as f:
        json.dump({"flagged": report, "count": len(report)}, f, indent=1)
