"""Layer 1 writer: the partitioned Parquet data lake.

Layout (browser never loads any of this):
    data/sets.parquet
    data/products.parquet
    data/prices/year=YYYY/month=MM/part.parquet

Price partitions are merged idempotently: appending rows for a date that
already exists replaces those rows (dedup on date/productId/subTypeName),
so re-running a day or a backfill month is safe.
"""
from __future__ import annotations

import os

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

DATA_DIR = os.environ.get("SEALDEON_DATA_DIR", "data")

PRICE_COLUMNS = [
    "date", "groupId", "productId", "subTypeName",
    "marketPrice", "midPrice", "lowPrice", "directLowPrice",
    # Nullable placeholders -- no free/ToS-compliant volume source in v1.
    "qtyListed", "qtySold",
]

PRICE_SCHEMA = pa.schema([
    ("date", pa.date32()),
    ("groupId", pa.int32()),
    ("productId", pa.int64()),
    ("subTypeName", pa.string()),
    ("marketPrice", pa.float64()),
    ("midPrice", pa.float64()),
    ("lowPrice", pa.float64()),
    ("directLowPrice", pa.float64()),
    ("qtyListed", pa.int64()),
    ("qtySold", pa.int64()),
])


def _prices_dir() -> str:
    return os.path.join(DATA_DIR, "prices")


def normalize_price_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Coerce a raw snapshot frame to the canonical price schema.

    highPrice is dropped on purpose (price-parking corruption).
    """
    out = df.copy()
    for col in PRICE_COLUMNS:
        if col not in out.columns:
            out[col] = None
    out = out[PRICE_COLUMNS]
    out["date"] = pd.to_datetime(out["date"]).dt.date
    for col in ["marketPrice", "midPrice", "lowPrice", "directLowPrice"]:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    for col in ["qtyListed", "qtySold"]:
        out[col] = pd.to_numeric(out[col], errors="coerce").astype("Int64")
    out["groupId"] = pd.to_numeric(out["groupId"]).astype("int32")
    out["productId"] = pd.to_numeric(out["productId"]).astype("int64")
    # Keep rows with at least one usable price.
    out = out[out[["marketPrice", "midPrice", "lowPrice"]].notna().any(axis=1)]
    return out


def append_prices(df: pd.DataFrame, replace_dates: bool = True) -> list[str]:
    """Merge snapshot rows into year/month partitions. Returns paths written.

    replace_dates=True (default): a re-fetched date REPLACES that date's stored
    rows -- correct for a full snapshot of every game, and lets corrections
    land. replace_dates=False: purely additive upsert (existing rows for the
    date survive; only same (date, productId, subTypeName) keys are updated).
    Use additive mode for any PARTIAL load -- e.g. a Magic-only backfill --
    which would otherwise delete the other game's rows for those dates. The
    lake is the durable store: it accumulates history beyond whatever window
    the upstream archive still serves, so a partial load must never truncate.
    """
    df = normalize_price_rows(df)
    if df.empty:
        return []
    dates = pd.to_datetime(pd.Series(df["date"]))
    df = df.assign(_year=dates.dt.year.values, _month=dates.dt.month.values)

    written = []
    for (year, month), part in df.groupby(["_year", "_month"]):
        part = part.drop(columns=["_year", "_month"])
        part_dir = os.path.join(_prices_dir(), f"year={year}", f"month={month:02d}")
        os.makedirs(part_dir, exist_ok=True)
        path = os.path.join(part_dir, "part.parquet")
        if os.path.exists(path):
            existing = pq.read_table(path).to_pandas()
            if replace_dates:
                new_dates = set(part["date"])
                existing = existing[~existing["date"].isin(new_dates)]
            part = pd.concat([existing, part], ignore_index=True)
        part = part.drop_duplicates(subset=["date", "productId", "subTypeName"], keep="last")
        part = part.sort_values(["date", "groupId", "productId"])
        table = pa.Table.from_pandas(part, schema=PRICE_SCHEMA, preserve_index=False)
        pq.write_table(table, path, compression="zstd")
        written.append(path)
    return written


def write_sets(df: pd.DataFrame) -> str:
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, "sets.parquet")
    df.to_parquet(path, index=False)
    return path


def write_products(df: pd.DataFrame) -> str:
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, "products.parquet")
    df.to_parquet(path, index=False)
    return path


def price_glob() -> str:
    return os.path.join(_prices_dir(), "*", "*", "*.parquet")


def lake_exists() -> bool:
    return os.path.exists(os.path.join(DATA_DIR, "sets.parquet")) and os.path.isdir(_prices_dir())
