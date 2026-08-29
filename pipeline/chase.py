"""Chase-single flagging: the top 5 singles per set.

Ranked by RECENT SUSTAINED value (median marketPrice over the trailing 90
days), NOT by the all-time single-day peak. peakPrice/peakDate are still
computed and shown (the set page reports "% off peak") -- they are just no
longer the ranking key, because one launch-week day should not decide which
cards represent a set.

Restricted to real card subTypes; alt-print oddities are excluded.
"""
from __future__ import annotations

import pandas as pd

CHASE_COUNT = 5
RECENT_DAYS = 90

# Real card subtypes eligible for chase ranking.
CARD_SUBTYPES = {
    "Normal",
    "Holofoil",
    "Reverse Holofoil",
    "1st Edition",
    "1st Edition Holofoil",
    "1st Edition Normal",
}


def compute_peaks(prices: pd.DataFrame) -> pd.DataFrame:
    """Peak marketPrice + date per product across all snapshots.

    `prices` columns: date, productId, subTypeName, marketPrice.
    Returns one row per productId: peakPrice, peakDate.
    """
    eligible = prices[prices["marketPrice"].notna()]
    if eligible.empty:
        return pd.DataFrame(columns=["productId", "peakPrice", "peakDate"])
    idx = eligible.groupby("productId")["marketPrice"].idxmax()
    peaks = eligible.loc[idx, ["productId", "marketPrice", "date"]].rename(
        columns={"marketPrice": "peakPrice", "date": "peakDate"}
    )
    return peaks.reset_index(drop=True)


def flag_chase(products: pd.DataFrame, prices: pd.DataFrame,
               recent: pd.DataFrame | None = None) -> pd.DataFrame:
    """Attach peakPrice/peakDate/isChase to the product dimension.

    `products` columns include: productId, groupId, isSealed.
    `prices` columns include: date, productId, subTypeName, marketPrice.
    """
    peaks = compute_peaks(prices)
    out = products.merge(peaks, on="productId", how="left")

    # Chase candidates: singles only, priced under a real card subtype.
    card_rows = prices[
        prices["subTypeName"].isin(CARD_SUBTYPES) & prices["marketPrice"].notna()
    ]
    eligible_ids = set(card_rows["productId"].unique())

    # Rank on SUSTAINED recent value, not the all-time single-day peak. A peak
    # is set by one day, and for a fresh set that day is launch-week price
    # discovery: Prismatic's "Umbreon Master Ball Pattern" peaked $550 on
    # release day and trades at $82 today, displacing Vaporeon ex ($303) and
    # Glaceon ex ($284) from the basket. Fall back to peak when no recent
    # frame is supplied, so callers with peaks only still work.
    out = out.drop(columns=["recentValue"], errors="ignore")
    if recent is not None and not recent.empty:
        out = out.merge(recent[["productId", "recentValue"]], on="productId", how="left")
        out["_chaseRank"] = out["recentValue"].fillna(out["peakPrice"])
    else:
        out["_chaseRank"] = out["peakPrice"]

    # A chase candidate must be an actual CARD -- i.e. carry a card number.
    # "not sealed" is not the same thing: a product can be excluded from the
    # sealed taxonomy yet still be a box. Magic "Collector Booster Display
    # Master Case" listings are exactly that (deliberately unclassified, so
    # isSealed=False) and they still have prices, so the old ~isSealed test
    # promoted $35k cases into Magic's "Chase Singles" basket.
    is_card = (out["cardNumber"].notna() if "cardNumber" in out.columns
               else ~out["isSealed"])

    out["isChase"] = False
    singles = out[
        is_card
        & (~out["isSealed"])
        & out["_chaseRank"].notna()
        & out["productId"].isin(eligible_ids)
    ]
    for _, group in singles.groupby("groupId"):
        top = group.sort_values("_chaseRank", ascending=False).head(CHASE_COUNT)
        out.loc[out["productId"].isin(top["productId"]), "isChase"] = True
    return out.drop(columns=["_chaseRank", "recentValue"], errors="ignore")
