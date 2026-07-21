"""Sealed/single classification and sealed product-type detection.

Ports the PRODUCT_TYPE_PATTERNS concept from the original Apps Script
(Code.gs). A product is classified as a *single* when it carries a card
number in extendedData; otherwise it is checked against the sealed
patterns below.

Type matching rule (per spec): a pattern matches when ALL of its keyword
groups match (each group is a list of alternatives -- any one alternative
satisfies the group) and NO exclude term appears. Patterns are ordered
most-specific-first, so the first match wins.

When *searching* for a set's canonical product of a given type (e.g. the
plain Booster Pack used for intrinsic value), candidates are sorted by
name length ascending and the shortest is taken -- the shortest name is
the plain product, not a display/case/art-variant.
"""
from __future__ import annotations

# Ordered most-specific-first. Each entry:
#   (productType, [keywordGroup, ...], [excludeTerm, ...])
# keywordGroup = list of alternative substrings (lowercase), any one matches.
PRODUCT_TYPE_PATTERNS: list[tuple[str, list[list[str]], list[str]]] = [
    ("Booster Box Case",     [["booster box"], ["case"]], []),
    ("Booster Bundle Case",  [["booster bundle"], ["case"]], []),
    ("PKC ETB Case",         [["pokemon center"], ["elite trainer box"], ["case"]], []),
    ("ETB Case",             [["elite trainer box"], ["case"]], []),
    ("UPC",                  [["ultra-premium collection", "ultra premium collection"]], []),
    ("PKC ETB",              [["pokemon center"], ["elite trainer box"]], []),
    ("ETB",                  [["elite trainer box"]], []),
    ("Mini Tin Display",     [["mini tin"], ["display"]], []),
    ("Booster Bundle",       [["booster bundle"]], []),
    ("SPC",                  [["super-premium collection", "super premium collection"]], []),
    ("Enhanced Booster Box", [["enhanced booster", "enhanced expansion"], ["box"]], []),
    ("Booster Box",          [["booster box"]], ["case"]),
    ("Sleeved Booster Pack", [["sleeved booster"]], ["case", "display"]),
    ("Booster Pack",         [["booster pack"]], ["sleeved", "case", "display", "box", "bundle", "blister", "3-pack", "3 pack"]),
    ("Binder Collection",    [["binder collection"]], []),
    ("Poster Collection",    [["poster collection"]], []),
    ("Premium Collection",   [["premium collection"]], ["ultra", "super"]),
    ("Special Collection",   [["special collection"]], []),
    ("Build & Battle",       [["build & battle", "build and battle"]], []),
    ("3-Pack Blister",       [["3-pack blister", "3 pack blister", "three pack blister", "triple pack blister"]], []),
    ("Surprise Box",         [["surprise box"]], []),
    ("Tin",                  [["tin"]], ["mini tin", "display"]),
]

# Broader sealed detection: anything matching one of these substrings is
# sealed even when it has no canonical productType above (decks, mini
# tins, lots of oddball collections). Singles never hit this path because
# the card-number check runs first.
_SEALED_KEYWORDS = [
    "booster", "elite trainer box", "collection", "box", "pack", "tin",
    "case", "bundle", "blister", "display", "deck", "kit", "pin",
    "bag", "crate", "chest", "stadium", "academy",
]


def match_product_type(name: str) -> str | None:
    """Return the sealed productType for a product name, or None."""
    n = name.lower()
    for product_type, keyword_groups, excludes in PRODUCT_TYPE_PATTERNS:
        if any(term in n for term in excludes):
            continue
        if all(any(alt in n for alt in group) for group in keyword_groups):
            return product_type
    return None


def is_sealed_name(name: str) -> bool:
    n = name.lower()
    if match_product_type(name) is not None:
        return True
    return any(kw in n for kw in _SEALED_KEYWORDS)


def _extended(product: dict) -> dict:
    out = {}
    for item in product.get("extendedData") or []:
        out[item.get("name")] = item.get("value")
    return out


def classify_product(product: dict) -> dict:
    """Classify a raw TCGCSV product row.

    Returns {'isSealed', 'productType', 'cardNumber', 'rarity', 'cardText'}.
    A card number in extendedData marks a single; otherwise the name is
    checked against sealed patterns.
    """
    ext = _extended(product)
    card_number = ext.get("Number")
    rarity = ext.get("Rarity")
    card_text = ext.get("CardText") or ext.get("Description")
    name = product.get("name", "")

    if card_number:
        return {
            "isSealed": False,
            "productType": None,
            "cardNumber": str(card_number),
            "rarity": rarity,
            "cardText": card_text,
        }
    return {
        "isSealed": is_sealed_name(name),
        "productType": match_product_type(name),
        "cardNumber": None,
        "rarity": rarity,
        "cardText": card_text,
    }


def find_product_of_type(products: list[dict], product_type: str) -> dict | None:
    """Find a set's canonical product of the given type.

    All candidates matching the type, sorted by name length ascending;
    the shortest name is the plain product.
    """
    candidates = [
        p for p in products
        if not _extended(p).get("Number") and match_product_type(p.get("name", "")) == product_type
    ]
    if not candidates:
        return None
    return sorted(candidates, key=lambda p: len(p.get("name", "")))[0]
