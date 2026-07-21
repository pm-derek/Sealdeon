"""Intrinsic value resolution for sealed products.

    intrinsicValue   = packCount * packPrice + promoPrice
    sealedPremiumPct = sealedPrice / intrinsicValue - 1

This module resolves the *per-product* inputs (pack count, canonical pack
product, promo card product) and a confidence flag. The per-DAY time
series (intrinsicValue / sealedPremiumPct for every historical date) is
computed later in SQL by joining these resolutions against the daily
price snapshots -- see queries/ and build_views.py.

Data-quality design (the called-out fix, not the inherited bug):

Pack count -- parse-first:
  1. config/packcount_overrides.json (productId -> count) wins over all
  2. parsed from the product description (extendedData CardText)
  3. static PACK_COUNTS table by productType, only as fallback
  packCountSource records which path was used.

Promo -- widened auto-search:
  1. config/promo_overrides.json ("groupId:productType" -> promo) wins
  2. auto: parse the featured card from the description, then scan the
     era's promo group(s) for a matching card (name + optional number).
     Exact single match -> "auto"; multiple candidates narrowed by
     heuristics -> "auto" with fuzzy=True (medium confidence).
  3. product types that legitimately carry no promo -> "none", price 0
  4. otherwise -> "unresolved" (never silently zero)

Confidence:
  high   -- pack count parsed/overridden AND promo resolved (or none)
  medium -- pack count from static fallback, OR promo fuzzy-matched
  low    -- pack count undetermined AND/OR promo unresolved, or any
            specialty item (UPC/SPC/special collection) not confirmed
            by parse/override
"""
from __future__ import annotations

import json
import os
import re

# Product types with no meaningful pack decomposition: intrinsic value is
# null and they are excluded from premium views.
NON_DECOMPOSABLE_TYPES = {"Binder Collection", "Poster Collection"}

# Types that legitimately ship without a promo card.
NO_PROMO_TYPES = {
    "Booster Box", "Booster Box Case", "Booster Pack", "Sleeved Booster Pack",
    "Booster Bundle", "Mini Tin Display", "Tin", "3-Pack Blister",
    "Enhanced Booster Box", "Surprise Box", "Build & Battle",
}

# Types expected to carry a promo card.
PROMO_TYPES = {
    "ETB", "PKC ETB", "ETB Case", "PKC ETB Case", "UPC", "SPC",
    "Premium Collection", "Special Collection",
}

# Specialty types where a static/default pack count is unreliable; these
# stay low-confidence until confirmed by parse or override.
SPECIALTY_TYPES = {"UPC", "SPC", "Special Collection", "Premium Collection"}

# "Case" types hold multiple sub-units, so their pack count is the most
# error-prone to parse ("6 booster boxes" vs "6 packs"). They reach high
# confidence only via an explicit override; a parsed count below the
# static floor is treated as a mis-parse (see resolve_pack_count).
CASE_TYPES = {"Booster Box Case", "Booster Bundle Case", "ETB Case", "PKC ETB Case"}

# Static fallback table (used only when description parsing fails).
# Values are the modern-era conventions; anything reached through this
# table is at most medium confidence and lands in the quality report.
PACK_COUNTS: dict[str, int] = {
    "Booster Box": 36,
    "Booster Box Case": 216,   # 6 x 36-pack boxes
    "Booster Pack": 1,
    "Sleeved Booster Pack": 1,
    "ETB": 9,
    "PKC ETB": 9,
    "ETB Case": 90,            # 10 x 9-pack ETBs
    "PKC ETB Case": 90,
    "Booster Bundle": 6,
    "Booster Bundle Case": 60,  # ~10 bundles x 6 packs
    "Build & Battle": 4,
    "3-Pack Blister": 3,
    "Tin": 4,
    "UPC": 16,
}

_WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "fifteen": 15, "sixteen": 16, "eighteen": 18,
    "twenty": 20, "twenty-four": 24, "thirty": 30, "thirty-six": 36,
}
_NUM = r"(\d+|" + "|".join(_WORD_NUMBERS) + r")"

_PACK_RES = [
    re.compile(_NUM + r"\s+(?:[\w\s:&'\.\-]{0,60}?\s)?booster\s+packs?\b", re.IGNORECASE),
    re.compile(_NUM + r"\s+(?:additional\s+)?packs?\b", re.IGNORECASE),
]
_BOX_RE = re.compile(_NUM + r"\s+(?:[\w\s:&'\.\-]{0,60}?\s)?booster\s+box(?:es)?\b", re.IGNORECASE)

# Capture a capitalized word sequence after "featuring" -- stops at
# punctuation, parentheses, or lowercase filler ("promo", "ex", ...).
_FEATURED_RES = [
    re.compile(r"(?:promo|foil)\s+cards?\s+(?:of|featuring)\s+(?:an?\s+)?([A-Z][\w'\-]*(?:\s+[A-Z][\w'\-]*)*)"),
    re.compile(r"featuring\s+(?:an?\s+)?([A-Z][\w'\-]*(?:\s+[A-Z][\w'\-]*)*)"),
]
# Promo numbers like "SWSH284", "SVP 085", "123/456"
_PROMO_NUM_RE = re.compile(r"\b(SWSH\s?\d{1,3}|SVP?\s?\d{1,3}|MEP?\s?\d{1,3}|\d{1,3}/\d{1,3})\b")


def _to_int(token: str) -> int | None:
    token = token.strip().lower()
    if token.isdigit():
        return int(token)
    return _WORD_NUMBERS.get(token)


def parse_pack_count(text: str | None) -> int | None:
    """Parse the number of booster packs from a product description.

    Handles both direct pack statements ("Contains 36 booster packs") and
    case-style decomposition ("6 booster boxes" -> 6 * 36).
    """
    if not text:
        return None
    for regex in _PACK_RES:
        m = regex.search(text)
        if m:
            n = _to_int(m.group(1))
            if n and 0 < n <= 720:
                return n
    m = _BOX_RE.search(text)
    if m:
        n = _to_int(m.group(1))
        if n and 0 < n <= 20:
            return n * PACK_COUNTS["Booster Box"]
    return None


def parse_featured_card(text: str | None) -> tuple[str | None, str | None]:
    """Extract (featuredName, cardNumber) hints from a description."""
    if not text:
        return None, None
    name = None
    for regex in _FEATURED_RES:
        m = regex.search(text)
        if m:
            name = m.group(1).strip().rstrip(".,;:!")
            break
    number = None
    m = _PROMO_NUM_RE.search(text)
    if m:
        number = m.group(1).replace(" ", "")
    return name, number


def _load_json(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        raw = json.load(f)
    return {k: v for k, v in raw.items() if not str(k).startswith("_")}


def load_packcount_overrides(path: str = "config/packcount_overrides.json") -> dict[int, int]:
    return {int(k): int(v) for k, v in _load_json(path).items()}


def load_promo_overrides(path: str = "config/promo_overrides.json") -> dict[str, dict]:
    """Keys are 'groupId:productType' (e.g. '23237:ETB')."""
    return _load_json(path)


def resolve_pack_count(product: dict, overrides: dict[int, int]) -> tuple[int | None, str | None]:
    """Return (packCount, packCountSource)."""
    pid = int(product["productId"])
    ptype = product.get("productType")
    if pid in overrides:
        return overrides[pid], "override"
    parsed = parse_pack_count(product.get("cardText"))
    if parsed is not None:
        # Plausibility guard for Case types: a case must hold at least as
        # many packs as its static floor. A lower parsed value means the
        # parser grabbed a sub-unit count ("6 booster boxes" -> 6). Trust
        # the static floor instead and let confidence flag it.
        if ptype in CASE_TYPES and ptype in PACK_COUNTS and parsed < PACK_COUNTS[ptype]:
            return PACK_COUNTS[ptype], "static"
        return parsed, "parsed"
    if ptype in PACK_COUNTS:
        return PACK_COUNTS[ptype], "static"
    return None, None


def _match_promo_candidates(promo_products: list[dict], featured: str | None,
                            number: str | None, set_name: str) -> list[dict]:
    def ext_number(p: dict) -> str:
        for item in p.get("extendedData") or []:
            if item.get("name") == "Number":
                return str(item.get("value") or "").replace(" ", "")
        return ""

    candidates = promo_products
    if number:
        exact = [p for p in candidates if ext_number(p).lower() == number.lower()]
        if exact:
            return exact
    if featured:
        f = featured.lower()
        named = [p for p in candidates if f in (p.get("name") or "").lower()]
        if named:
            # Prefer promos that reference this set in their name/text.
            sn = set_name.lower()
            set_scoped = [
                p for p in named
                if sn in (p.get("name") or "").lower()
                or sn in (p.get("cleanName") or "").lower()
            ]
            return set_scoped or named
    return []


def resolve_promo(product: dict, set_row: dict, promo_products: list[dict],
                  overrides: dict[str, dict]) -> dict:
    """Resolve the promo card for one sealed product.

    Returns {promoProductId, promoSource, promoFuzzy, attemptedPromo}.
    promoSource: "auto" | "override" | "none" | "unresolved".
    """
    ptype = product.get("productType")
    key = f"{set_row['groupId']}:{ptype}"

    if key in overrides:
        ov = overrides[key]
        return {
            "promoProductId": ov.get("productId"),
            "promoSource": "override",
            "promoFuzzy": False,
            "attemptedPromo": ov.get("cardName"),
        }

    text = product.get("cardText") or ""
    mentions_promo = "promo" in text.lower()

    if ptype in NO_PROMO_TYPES and not mentions_promo:
        return {"promoProductId": None, "promoSource": "none",
                "promoFuzzy": False, "attemptedPromo": None}

    if ptype not in PROMO_TYPES and not mentions_promo:
        # Untyped sealed item with no promo language: treat as no promo.
        return {"promoProductId": None, "promoSource": "none",
                "promoFuzzy": False, "attemptedPromo": None}

    featured, number = parse_featured_card(text)
    candidates = _match_promo_candidates(promo_products, featured, number,
                                         set_row.get("name") or "")
    if len(candidates) == 1:
        return {"promoProductId": int(candidates[0]["productId"]),
                "promoSource": "auto", "promoFuzzy": False,
                "attemptedPromo": candidates[0].get("name")}
    if len(candidates) > 1:
        # Multiple plausible promos (e.g. standard vs Pokemon Center
        # versions differing by card number): shortest name is the plain
        # version; PKC products prefer a candidate mentioning "Pokemon Center".
        pool = candidates
        if ptype and ptype.startswith("PKC"):
            pkc = [c for c in candidates if "pokemon center" in (c.get("name") or "").lower()]
            pool = pkc or candidates
        best = sorted(pool, key=lambda p: len(p.get("name") or ""))[0]
        return {"promoProductId": int(best["productId"]),
                "promoSource": "auto", "promoFuzzy": True,
                "attemptedPromo": best.get("name")}
    return {"promoProductId": None, "promoSource": "unresolved",
            "promoFuzzy": False,
            "attemptedPromo": featured or number}


def confidence(pack_source: str | None, promo: dict, ptype: str | None) -> str:
    pack_ok = pack_source in ("parsed", "override")
    promo_ok = promo["promoSource"] in ("auto", "override", "none") and not promo["promoFuzzy"]

    # Case types are multi-unit and the most error-prone to decompose;
    # they reach high confidence only when the pack count is overridden.
    if ptype in CASE_TYPES and pack_source != "override":
        return "low" if promo["promoSource"] == "unresolved" else "medium"
    if ptype in SPECIALTY_TYPES and not pack_ok:
        return "low"
    if pack_source is None or promo["promoSource"] == "unresolved":
        return "low"
    if pack_ok and promo_ok:
        return "high"
    return "medium"


def resolve_set(sealed_products: list[dict], set_row: dict, set_products: list[dict],
                promo_products: list[dict],
                packcount_overrides: dict[int, int],
                promo_overrides: dict[str, dict]) -> list[dict]:
    """Resolve intrinsic inputs for every sealed product in one set.

    sealed_products: classified product dicts (productId, productType, cardText...)
    set_products:    ALL raw products in the set (to locate the pack product)
    promo_products:  raw products from the era's promo group(s)

    Returns one resolution row per sealed product.
    """
    from classify import find_product_of_type

    pack = find_product_of_type(set_products, "Booster Pack") \
        or find_product_of_type(set_products, "Sleeved Booster Pack")
    pack_product_id = int(pack["productId"]) if pack else None

    rows = []
    for product in sealed_products:
        ptype = product.get("productType")
        pid = int(product["productId"])

        if ptype in NON_DECOMPOSABLE_TYPES:
            rows.append({
                "productId": pid, "groupId": set_row["groupId"],
                "packCount": None, "packCountSource": None,
                "packProductId": None, "promoProductId": None,
                "promoSource": "none", "intrinsicConfidence": None,
                "decomposable": False, "attemptedPromo": None,
            })
            continue

        count, source = resolve_pack_count(product, packcount_overrides)
        promo = resolve_promo(product, set_row, promo_products, promo_overrides)
        conf = confidence(source, promo, ptype)
        decomposable = count is not None and pack_product_id is not None \
            and pid != pack_product_id
        rows.append({
            "productId": pid, "groupId": set_row["groupId"],
            "packCount": count, "packCountSource": source,
            "packProductId": pack_product_id if decomposable else None,
            "promoProductId": promo["promoProductId"],
            "promoSource": promo["promoSource"],
            "intrinsicConfidence": conf if decomposable else ("low" if count is None else None),
            "decomposable": decomposable,
            "attemptedPromo": promo["attemptedPromo"],
        })
    return rows


def quality_report(resolutions: list[dict], products_by_id: dict[int, dict],
                   sets_by_id: dict[int, dict]) -> list[dict]:
    """Rows for data_quality_report.json: every sealed product at
    medium/low confidence, with what auto-resolution DID produce, so the
    override files can be populated surgically."""
    report = []
    for r in resolutions:
        conf = r.get("intrinsicConfidence")
        if conf not in ("medium", "low"):
            continue
        product = products_by_id.get(r["productId"], {})
        set_row = sets_by_id.get(r["groupId"], {})
        report.append({
            "productId": r["productId"],
            "productName": product.get("name"),
            "productType": product.get("productType"),
            "groupId": r["groupId"],
            "setName": set_row.get("name"),
            "confidence": conf,
            "attemptedPackCount": r.get("packCount"),
            "packCountSource": r.get("packCountSource"),
            "attemptedPromo": r.get("attemptedPromo"),
            "promoSource": r.get("promoSource"),
            "howToFix": {
                "packCount": "add to config/packcount_overrides.json as \"%d\": <count>" % r["productId"],
                "promo": "add to config/promo_overrides.json as \"%d:%s\": {\"productId\": <promoProductId>, \"cardName\": \"...\"}"
                         % (r["groupId"], product.get("productType")),
            },
        })
    report.sort(key=lambda x: (x["confidence"] != "low", x["setName"] or "", x["productName"] or ""))
    return report
