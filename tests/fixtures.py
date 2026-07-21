"""Synthetic TCGCSV-shaped fixture data for offline pipeline validation.

Mirrors the live endpoint shapes exactly (groups / products / prices
envelopes) so the whole pipeline can be exercised without network:
several sets across eras, a hype set, a right-censored SWSH set, promo
groups, sealed products with realistic descriptions, and singles with
peaks that make the chase ranking non-trivial.
"""
from __future__ import annotations

import datetime as dt
import math

# --- groups -----------------------------------------------------------------

GROUPS = [
    {"groupId": 23237, "name": "SV: Paldea Fixture", "abbreviation": "SV01",
     "publishedOn": "2024-03-01T00:00:00", "categoryId": 3},
    {"groupId": 24700, "name": "SV: Hyped Fixture", "abbreviation": "SV09",
     "publishedOn": "2024-06-01T00:00:00", "categoryId": 3},
    {"groupId": 24710, "name": "SV: Third Fixture", "abbreviation": "SV10",
     "publishedOn": "2024-08-01T00:00:00", "categoryId": 3},
    {"groupId": 22800, "name": "SWSH: Old Fixture", "abbreviation": "SWSH12",
     "publishedOn": "2022-11-01T00:00:00", "categoryId": 3},
    {"groupId": 24655, "name": "ME04: Chaos Rising", "abbreviation": "ME04",
     "publishedOn": "2026-05-22T00:00:00", "categoryId": 3},
    {"groupId": 23400, "name": "SVP: Scarlet & Violet Promo Cards", "abbreviation": "SVP",
     "publishedOn": "2023-03-31T00:00:00", "categoryId": 3},
    {"groupId": 22900, "name": "SWSH: Sword & Shield Promo Cards", "abbreviation": "SWSHP",
     "publishedOn": "2020-02-07T00:00:00", "categoryId": 3},
]

_SETS = [23237, 24700, 24710, 22800, 24655]


def _sealed(pid, gid, name, text):
    return {"productId": pid, "groupId": gid, "name": name,
            "cleanName": name.replace(":", ""), "imageUrl": f"https://img.example/{pid}.jpg",
            "url": f"https://www.tcgplayer.com/product/{pid}",
            "extendedData": [{"name": "CardText", "value": text}]}


def _single(pid, gid, name, number, rarity):
    return {"productId": pid, "groupId": gid, "name": name,
            "cleanName": name, "imageUrl": f"https://img.example/{pid}.jpg",
            "url": f"https://www.tcgplayer.com/product/{pid}",
            "extendedData": [{"name": "Number", "value": number},
                             {"name": "Rarity", "value": rarity}]}


def _set_products(gid: int, set_tag: str) -> list[dict]:
    base = gid * 100
    out = [
        _sealed(base + 1, gid, f"{set_tag} Booster Box",
                "Contains 36 booster packs."),
        _sealed(base + 2, gid, f"{set_tag} Booster Pack",
                "1 booster pack of 10 cards."),
        _sealed(base + 3, gid, f"{set_tag} Elite Trainer Box",
                "Contains 9 booster packs and 1 full-art foil promo card featuring Pikachu."),
        _sealed(base + 4, gid, f"{set_tag} Elite Trainer Box (Pokemon Center Exclusive)",
                "Contains 9 booster packs and 1 full-art foil promo card featuring Pikachu."),
        _sealed(base + 5, gid, f"{set_tag} Booster Bundle",
                "Contains 6 booster packs."),
        _sealed(base + 6, gid, f"{set_tag} Ultra-Premium Collection",
                "Contains 16 booster packs and an etched promo card featuring Charizard (SVP 010)."),
        _sealed(base + 7, gid, f"{set_tag} Binder Collection",
                "A 9-pocket binder."),
    ]
    chase_prices = [400, 250, 180, 120, 90, 40, 20, 10]
    for i, peak in enumerate(chase_prices):
        out.append(_single(base + 10 + i, gid, f"{set_tag} Chase Mon {i}",
                           f"{i + 1:03d}/198", "Special Illustration Rare"))
    return out


def build_products() -> dict[int, list[dict]]:
    products = {}
    for g in GROUPS:
        gid = g["groupId"]
        if gid in _SETS:
            tag = g["abbreviation"]
            products[gid] = _set_products(gid, tag)
        else:
            # promo groups
            base = gid * 100
            products[gid] = [
                _single(base + 1, gid, "Pikachu - 085", "SVP085" if gid == 23400 else "SWSH085", "Promo"),
                _single(base + 2, gid, "Pikachu (Pokemon Center Exclusive) - 086",
                        "SVP086" if gid == 23400 else "SWSH086", "Promo"),
                _single(base + 3, gid, "Charizard - 010", "SVP010" if gid == 23400 else "SWSH010", "Promo"),
            ]
    return products


# --- prices -----------------------------------------------------------------

# per-set "personality": (booster box base, multiplier trajectory)
_PROFILES = {
    23237: 110.0,   # normal SV set
    24700: 330.0,   # hype: 3x the era's typical box price
    24710: 100.0,
    22800: 140.0,   # SWSH, right-censored
    24655: 120.0,   # ME
}

_TYPE_FACTORS = {1: 1.0, 2: 1 / 30, 3: 0.42, 4: 0.5, 5: 0.24, 6: 1.1}
_PROMO_PRICE = {1: 12.0, 2: 18.0, 3: 25.0}


def _trajectory(age: int, hype: bool) -> float:
    """J-curve: dip after release, slow recovery; hype sets dip less."""
    if age < 0:
        return 1.1
    dip = 0.25 if not hype else 0.10
    return (1 - dip * (1 - math.exp(-age / 45))) + 0.15 * (age / 365.0)


def prices_for_date(date: dt.date, products_by_group: dict[int, list[dict]]) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {}
    for g in GROUPS:
        gid = g["groupId"]
        release = dt.date.fromisoformat(g["publishedOn"][:10])
        rows = []
        if gid in _SETS:
            if date < release:
                continue
            age = (date - release).days
            hype = gid == 24700
            base = _PROFILES[gid]
            mult = _trajectory(age, hype)
            for slot, factor in _TYPE_FACTORS.items():
                pid = gid * 100 + slot
                price = round(base * factor * mult, 2)
                rows.append({"productId": pid, "subTypeName": "Normal",
                             "marketPrice": price, "midPrice": round(price * 1.05, 2),
                             "lowPrice": round(price * 0.9, 2),
                             "directLowPrice": round(price * 0.97, 2)})
            # binder collection: flat price
            rows.append({"productId": gid * 100 + 7, "subTypeName": "Normal",
                         "marketPrice": 30.0, "midPrice": 32.0, "lowPrice": 27.0,
                         "directLowPrice": 29.0})
            # chase singles: spike at day ~14 then decay toward 40% of peak
            peaks = [400, 250, 180, 120, 90, 40, 20, 10]
            for i, peak in enumerate(peaks):
                pid = gid * 100 + 10 + i
                if age < 14:
                    price = peak * (0.5 + 0.5 * age / 14)
                else:
                    price = peak * (0.4 + 0.6 * math.exp(-(age - 14) / 60))
                rows.append({"productId": pid, "subTypeName": "Holofoil",
                             "marketPrice": round(price, 2), "midPrice": round(price * 1.08, 2),
                             "lowPrice": round(price * 0.85, 2), "directLowPrice": None})
        else:
            for slot, price in _PROMO_PRICE.items():
                rows.append({"productId": gid * 100 + slot, "subTypeName": "Normal",
                             "marketPrice": price, "midPrice": price * 1.1,
                             "lowPrice": price * 0.8, "directLowPrice": None})
        if rows:
            out[gid] = rows
    return out


def snapshot_dates() -> list[dt.date]:
    """Two windows: the 2024 backfill era and a recent 2026 window."""
    dates = []
    d = dt.date(2024, 2, 8)
    while d <= dt.date(2024, 11, 30):
        dates.append(d)
        d += dt.timedelta(days=1)
    d = dt.date(2026, 6, 1)
    while d <= dt.date(2026, 7, 20):
        dates.append(d)
        d += dt.timedelta(days=1)
    return dates
