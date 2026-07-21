"""Shared TCGCSV.com HTTP client.

Polite by design: identifiable User-Agent and a ~0.25s minimum interval
between live API calls (per the TCGCSV FAQ). Archive downloads are large
single files and use the same session but no artificial delay beyond the
per-call gate.
"""
from __future__ import annotations

import time

import requests

BASE_URL = "https://tcgcsv.com"
ARCHIVE_URL = BASE_URL + "/archive/tcgplayer/prices-{date}.ppmd.7z"

POKEMON_CATEGORY_ID = 3
MAGIC_CATEGORY_ID = 1  # future seam; not fetched in v1

# Categories TCGCSV documents as permanently empty -- never fetch these.
EMPTY_CATEGORY_IDS = {9, 10, 12, 14, 21, 55, 69, 70}

# Hard floor of the TCGCSV daily price archive.
ARCHIVE_FLOOR = "2024-02-08"

USER_AGENT = "sealdeon/1.0 (Pokemon sealed-market analytics; github.com/pm-derek/sealdeon)"
RATE_LIMIT_SECONDS = 0.25

_session: requests.Session | None = None
_last_call = 0.0


def session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers["User-Agent"] = USER_AGENT
    return _session


def _throttle() -> None:
    global _last_call
    wait = RATE_LIMIT_SECONDS - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.monotonic()


def get_json(path: str, retries: int = 3) -> dict:
    """GET a TCGCSV endpoint (e.g. '/tcgplayer/3/groups') and return parsed JSON."""
    url = BASE_URL + path
    for attempt in range(retries + 1):
        _throttle()
        try:
            resp = session().get(url, timeout=60)
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError):
            if attempt == retries:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def get_results(path: str) -> list[dict]:
    """GET an endpoint and unwrap TCGCSV's {'results': [...]} envelope."""
    payload = get_json(path)
    return payload.get("results", [])


def fetch_groups(category_id: int = POKEMON_CATEGORY_ID) -> list[dict]:
    return get_results(f"/tcgplayer/{category_id}/groups")


def fetch_products(group_id: int, category_id: int = POKEMON_CATEGORY_ID) -> list[dict]:
    return get_results(f"/tcgplayer/{category_id}/{group_id}/products")


def fetch_prices(group_id: int, category_id: int = POKEMON_CATEGORY_ID) -> list[dict]:
    return get_results(f"/tcgplayer/{category_id}/{group_id}/prices")


def download_archive(date: str, dest_path: str, retries: int = 3) -> str:
    """Download the daily price archive for YYYY-MM-DD to dest_path."""
    url = ARCHIVE_URL.format(date=date)
    for attempt in range(retries + 1):
        _throttle()
        try:
            with session().get(url, timeout=600, stream=True) as resp:
                resp.raise_for_status()
                with open(dest_path, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
            return dest_path
        except requests.RequestException:
            if attempt == retries:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")
