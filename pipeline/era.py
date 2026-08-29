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

# Supplemental / promo / vintage-reissue groups. TCGCSV often stamps these
# with a recent publishedOn (re-catalogued), which would otherwise push them
# into a modern era by the date fallback. Name-match them to Special/Promo.
_SPECIAL_RE = re.compile(
    r"promo|mcdonald|miscellaneous|pop series|trainer kit|first partner|"
    r"blister exclusive|prize pack|battle academy|trick or trade|burger king|"
    r"nintendo|prerelease|pre-release|jumbo|world championship|"
    r"theme deck|starter deck|battle deck",
    re.IGNORECASE,
)

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


ERA_MAGIC = "Magic"


def detect_era(name: str, abbreviation: str | None, release_date, game: str = "Pokemon") -> str:
    name = name or ""
    abbr = (abbreviation or "").upper()
    date = parse_date(release_date)

    # Magic has no Pokemon-style eras; bucket by release year for the filter.
    if game == "Magic":
        return f"{ERA_MAGIC} {date.year}" if date else ERA_MAGIC

    if _SPECIAL_RE.search(name):
        return ERA_SPECIAL

    # Abbreviation/name signals win over dates -- but ONLY when the release
    # date doesn't contradict them. Abbreviations are reused across decades:
    # "Supreme Victors" (2009) is abbreviated SV and was being read as
    # Scarlet & Violet, so a 2009 set showed up under a modern-era filter.
    def plausible(start):
        return date is None or date >= start - dt.timedelta(days=180)

    if abbr.startswith("SWSH") and plausible(_SWSH_START):
        return ERA_SWSH
    if (abbr.startswith("SV") or name.strip().upper().startswith("SV")) and plausible(_SV_START):
        return ERA_SV
    if (abbr.startswith("ME") or re.match(r"^ME\d*\b|^ME:", name.strip(), re.IGNORECASE)) \
            and plausible(_ME_START):
        return ERA_ME
    if "mega evolution" in name.lower() and plausible(_ME_START):
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


def enrich_set(group: dict, game: str = "Pokemon") -> dict:
    """Attach game + era + archiveComplete to a raw TCGCSV group row."""
    release = parse_date(group.get("publishedOn"))
    return {
        "groupId": group["groupId"],
        "name": group.get("name"),
        "abbreviation": group.get("abbreviation"),
        "releaseDate": release.isoformat() if release else None,
        "game": game,
        "era": detect_era(group.get("name", ""), group.get("abbreviation"), release, game),
        "archiveComplete": archive_complete(release),
    }
