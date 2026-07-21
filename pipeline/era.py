"""Era detection and archive-completeness flags for sets.

Dynamic rules (no hardcoded groupIds) so new sets self-classify:
- name contains Promo / McDonald's / Miscellaneous          -> Special/Promo
- abbreviation/name signals (SWSH / SV / ME) win over dates
- release date windows fill in when the abbreviation is absent
- anything earlier                                          -> Legacy

An optional alias map (config/aliases.json) provides shorthand names for
the UI ("151", "Prismatic"); it never affects era logic.
"""
from __future__ import annotations

import datetime as dt
import re

from tcgcsv import ARCHIVE_FLOOR

ERA_SWSH = "Sword & Shield"
ERA_SV = "Scarlet & Violet"
ERA_ME = "Mega Evolution"
ERA_LEGACY = "Legacy"
ERA_SPECIAL = "Special/Promo"

_SPECIAL_RE = re.compile(r"promo|mcdonald|miscellaneous", re.IGNORECASE)

_SWSH_START = dt.date(2020, 2, 1)
_SV_START = dt.date(2023, 3, 1)
_ME_START = dt.date(2025, 9, 1)


def parse_date(value) -> dt.date | None:
    """Parse TCGCSV publishedOn ('2026-05-22T00:00:00' or '2026-05-22')."""
    if value in (None, ""):
        return None
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    return dt.date.fromisoformat(str(value)[:10])


def detect_era(name: str, abbreviation: str | None, release_date) -> str:
    name = name or ""
    abbr = (abbreviation or "").upper()
    date = parse_date(release_date)

    if _SPECIAL_RE.search(name):
        return ERA_SPECIAL

    # Abbreviation/name signals first -- most reliable.
    if abbr.startswith("SWSH"):
        return ERA_SWSH
    if abbr.startswith("SV") or name.strip().upper().startswith("SV"):
        return ERA_SV
    if abbr.startswith("ME") or re.match(r"^ME\d*\b|^ME:", name.strip(), re.IGNORECASE):
        return ERA_ME
    if "mega evolution" in name.lower():
        return ERA_ME

    # Date windows as fallback.
    if date is not None:
        if date >= _ME_START:
            return ERA_ME
        if date >= _SV_START:
            return ERA_SV
        if date >= _SWSH_START:
            return ERA_SWSH
    return ERA_LEGACY


def archive_complete(release_date) -> bool:
    """True when the TCGCSV archive contains the set's true day 0."""
    date = parse_date(release_date)
    floor = dt.date.fromisoformat(ARCHIVE_FLOOR)
    return date is not None and date >= floor


def enrich_set(group: dict) -> dict:
    """Attach era + archiveComplete to a raw TCGCSV group row."""
    release = parse_date(group.get("publishedOn"))
    return {
        "groupId": group["groupId"],
        "name": group.get("name"),
        "abbreviation": group.get("abbreviation"),
        "releaseDate": release.isoformat() if release else None,
        "era": detect_era(group.get("name", ""), group.get("abbreviation"), release),
        "archiveComplete": archive_complete(release),
    }
