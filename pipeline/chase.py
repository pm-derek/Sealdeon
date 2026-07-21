"""Chase-single flagging: top 5 singles per set by PEAK observed price.

Peak (max marketPrice across the full available history), not current
price -- a card that spiked to $400 and fell to $80 is still a chase and
its full trajectory belongs in the dataset.

Restricted to real card subTypes; alt-print oddities are excluded.
"""
from __future__ import annotations

import pandas as pd

CHASE_COUNT = 5

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


def flag_chase(products: pd.DataFrame, prices: pd.DataFrame) -> pd.DataFrame:
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

    out["isChase"] = False
    singles = out[
        (~out["isSealed"])
        & out["peakPrice"].notna()
        & out["productId"].isin(eligible_ids)
    ]
    for _, group in singles.groupby("groupId"):
        top = group.sort_values("peakPrice", ascending=False).head(CHASE_COUNT)
        out.loc[out["productId"].isin(top["productId"]), "isChase"] = True
    return out
