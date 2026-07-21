"""Hype tagging: algorithmic default + manual override.

Auto rule (per spec): a set is hype when its early price (first ~30-90
days since release) runs > 2x the era median at the same age. We compare
on the set's canonical sealed product (Booster Box preferred, ETB
fallback) because those exist for nearly every set and are the most
price-comparable products across sets.

Manual override: config/hype_overrides.json maps groupId -> true/false
and ALWAYS wins (hypeSource = "manual"). Derek's judgment beats a fixed
multiplier.
"""
from __future__ import annotations

import json
import os

import pandas as pd

HYPE_MULTIPLIER = 2.0
EARLY_AGE_MAX_DAYS = 90
MIN_OBSERVATIONS = 10  # snapshot-days needed before the auto flag can fire
MIN_ERA_COHORT = 3     # sets needed in an era before a median is meaningful

CANONICAL_TYPES = ["Booster Box", "ETB"]


def load_overrides(path: str = "config/hype_overrides.json") -> dict[int, bool]:
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        raw = json.load(f)
    return {int(k): bool(v) for k, v in raw.items() if not str(k).startswith("_")}


def _canonical_prices(prices: pd.DataFrame, products: pd.DataFrame, sets: pd.DataFrame) -> pd.DataFrame:
    """Daily price of each set's canonical sealed product, with age."""
    dims = products[products["productType"].isin(CANONICAL_TYPES)][
        ["productId", "groupId", "productType"]
    ]
    merged = prices.merge(dims, on="productId").merge(
        sets[["groupId", "releaseDate", "era"]], on="groupId"
    )
    merged = merged[merged["marketPrice"].notna() & merged["releaseDate"].notna()]
    if merged.empty:
        return merged.assign(ageDays=pd.Series(dtype=int))
    merged["ageDays"] = (
        pd.to_datetime(merged["date"]) - pd.to_datetime(merged["releaseDate"])
    ).dt.days
    early = merged[(merged["ageDays"] >= 0) & (merged["ageDays"] <= EARLY_AGE_MAX_DAYS)]

    # Booster Box preferred; ETB only for sets without one.
    has_bb = set(early.loc[early["productType"] == "Booster Box", "groupId"])
    return early[
        (early["productType"] == "Booster Box")
        | (~early["groupId"].isin(has_bb) & (early["productType"] == "ETB"))
    ]


def compute_auto_hype(prices: pd.DataFrame, products: pd.DataFrame, sets: pd.DataFrame) -> dict[int, bool]:
    """groupId -> auto hype flag."""
    early = _canonical_prices(prices, products, sets)
    if early.empty:
        return {}

    # One price per set/type/age (median across snapshots on the same age).
    per_set = (
        early.groupby(["era", "productType", "groupId", "ageDays"])["marketPrice"]
        .median()
        .reset_index()
    )
    # Era median at each age, per product type (BB vs BB, ETB vs ETB).
    cohort_sizes = per_set.groupby(["era", "productType"])["groupId"].nunique()
    era_median = (
        per_set.groupby(["era", "productType", "ageDays"])["marketPrice"]
        .median()
        .rename("eraMedian")
        .reset_index()
    )
    joined = per_set.merge(era_median, on=["era", "productType", "ageDays"])
    joined = joined[joined["eraMedian"] > 0]
    joined["ratio"] = joined["marketPrice"] / joined["eraMedian"]

    flags: dict[int, bool] = {}
    for (era, ptype, group_id), rows in joined.groupby(["era", "productType", "groupId"]):
        if cohort_sizes.get((era, ptype), 0) < MIN_ERA_COHORT:
            flags[int(group_id)] = False
            continue
        if len(rows) < MIN_OBSERVATIONS:
            flags[int(group_id)] = False
            continue
        flags[int(group_id)] = bool(rows["ratio"].median() > HYPE_MULTIPLIER)
    return flags


def apply_hype(sets: pd.DataFrame, prices: pd.DataFrame, products: pd.DataFrame,
               overrides_path: str = "config/hype_overrides.json") -> pd.DataFrame:
    """Attach final isHype + hypeSource to the set dimension."""
    auto = compute_auto_hype(prices, products, sets)
    overrides = load_overrides(overrides_path)

    out = sets.copy()
    out["isHype"] = out["groupId"].map(lambda g: overrides.get(int(g), auto.get(int(g), False)))
    out["hypeSource"] = out["groupId"].map(
        lambda g: "manual" if int(g) in overrides else "auto"
    )
    return out
