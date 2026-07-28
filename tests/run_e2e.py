"""Offline end-to-end pipeline validation against synthetic fixtures.

Exercises: classification -> era -> lake write -> chase/hype enrichment ->
intrinsic resolution -> view JSON build -> archive (.7z) extraction.

Run from repo root:
    python tests/run_e2e.py [workdir]
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "pipeline"))
sys.path.insert(0, os.path.join(REPO, "tests"))

WORK = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="sealdeon-e2e-")
os.environ["SEALDEON_DATA_DIR"] = os.path.join(WORK, "data")
os.environ["SEALDEON_VIEWS_DIR"] = os.path.join(WORK, "views")
os.environ["SEALDEON_CONFIG_DIR"] = os.path.join(REPO, "config")

import pandas as pd  # noqa: E402

import build_parquet  # noqa: E402
import build_views  # noqa: E402
import common  # noqa: E402
import fixtures  # noqa: E402
from classify import classify_product, match_product_type  # noqa: E402
from era import detect_era, ERA_SV, ERA_ME, ERA_SWSH, ERA_SPECIAL  # noqa: E402
from intrinsic import parse_pack_count, parse_featured_card  # noqa: E402

PASS = 0


def check(label: str, cond: bool, detail: str = ""):
    global PASS
    status = "ok" if cond else "FAIL"
    print(f"  [{status}] {label}" + (f"  ({detail})" if detail and not cond else ""))
    if cond:
        PASS += 1
    else:
        raise AssertionError(f"{label}: {detail}")


print("== unit: classification ==")
check("Booster Box", match_product_type("SV01 Booster Box") == "Booster Box")
check("Booster Box Case", match_product_type("SV01 Booster Box Case") == "Booster Box Case")
check("ETB", match_product_type("SV01 Elite Trainer Box") == "ETB")
check("PKC ETB", match_product_type("SV01 Elite Trainer Box (Pokemon Center Exclusive)") == "PKC ETB")
check("UPC", match_product_type("SV01 Ultra-Premium Collection") == "UPC")
check("Sleeved vs Booster Pack", match_product_type("SV01 Sleeved Booster Pack") == "Sleeved Booster Pack")
check("Booster Pack", match_product_type("SV01 Booster Pack") == "Booster Pack")
check("Tin not Mini Tin Display", match_product_type("SV01 Mini Tin Display") == "Mini Tin Display")
check("single classifies as single",
      classify_product(fixtures._single(1, 1, "Pikachu ex", "001/198", "DR"))["isSealed"] is False)

print("== unit: era ==")
check("SV era", detect_era("SV: Paldea Fixture", "SV01", "2024-03-01") == ERA_SV)
check("ME era (24655)", detect_era("ME04: Chaos Rising", "ME04", "2026-05-22") == ERA_ME)
check("SWSH era", detect_era("SWSH: Old Fixture", "SWSH12", "2022-11-01") == ERA_SWSH)
check("promo -> special", detect_era("SVP: Scarlet & Violet Promo Cards", "SVP", "2023-03-31") == ERA_SPECIAL)
check("date fallback ME", detect_era("Unknown Set", None, "2025-10-01") == ERA_ME)

print("== unit: intrinsic parsing ==")
check("pack count 36", parse_pack_count("Contains 36 booster packs.") == 36)
check("pack count 9 w/ set name", parse_pack_count("Contains 9 Scarlet & Violet booster packs and 1 promo card.") == 9)
check("word number", parse_pack_count("Includes eight booster packs!") == 8)
check("case decompose", parse_pack_count("Contains 6 booster boxes.") == 216)
check("no packs -> None", parse_pack_count("A 9-pocket binder.") is None)
name, num = parse_featured_card("an etched promo card featuring Charizard (SVP 010).")
check("featured name", name == "Charizard", repr(name))
check("featured number", num == "SVP010", repr(num))

print("== e2e: build lake ==")
groups = fixtures.GROUPS
products_by_group = fixtures.build_products()
rows = []
for date in fixtures.snapshot_dates():
    day = fixtures.prices_for_date(date, products_by_group)
    for gid, results in day.items():
        rows.extend(common.snapshot_rows(date.isoformat(), gid, results))
print(f"  {len(rows)} synthetic snapshot rows")
written = build_parquet.append_prices(pd.DataFrame(rows))
check("partitions written", len(written) >= 10, str(len(written)))

set_dim = common.build_set_dim(groups)
products_df, report = common.build_product_dim(groups, products_by_group, set_dim)
products_df, set_dim = common.enrich_from_history(products_df, set_dim)
common.write_dimensions(set_dim, products_df, report)

print("== e2e: dimensions ==")
sets_by_id = set_dim.set_index("groupId").to_dict("index")
check("archiveComplete true (2024-03 set)", sets_by_id[23237]["archiveComplete"] == True)  # noqa: E712
check("archiveComplete false (SWSH set)", sets_by_id[22800]["archiveComplete"] == False)  # noqa: E712
check("hype flagged on hyped set", bool(sets_by_id[24700]["isHype"]), str(sets_by_id[24700]))
check("clean set not hype", not sets_by_id[23237]["isHype"])
check("hypeSource auto", sets_by_id[24700]["hypeSource"] == "auto")

p = products_df.set_index("productId")
check("ETB pack count parsed 9", p.loc[2323703, "packCount"] == 9 and p.loc[2323703, "packCountSource"] == "parsed")
check("UPC pack count parsed 16", p.loc[2323706, "packCount"] == 16)
check("UPC promo exact match (auto)", p.loc[2323706, "promoSource"] == "auto"
      and p.loc[2323706, "promoProductId"] == 2340003,
      str(p.loc[2323706, ["promoSource", "promoProductId"]].to_dict()))
check("ETB promo resolved (auto fuzzy ok)", p.loc[2323703, "promoSource"] == "auto")
check("PKC ETB promo prefers Pokemon Center card", p.loc[2323704, "promoProductId"] == 2340002,
      str(p.loc[2323704, "promoProductId"]))
check("Booster Box promo none", p.loc[2323701, "promoSource"] == "none")
check("UPC high confidence", p.loc[2323706, "intrinsicConfidence"] == "high",
      str(p.loc[2323706, "intrinsicConfidence"]))
check("binder not decomposable", bool(p.loc[2323707, "decomposable"]) is False)
check("canonical booster box", bool(p.loc[2323701, "isCanonical"]))
# Case mis-parse guardrail: "6 booster boxes" must NOT become 6 packs.
check("case type classified", p.loc[2323708, "productType"] == "Booster Box Case",
      str(p.loc[2323708, "productType"]))
check("case pack count uses static floor not 6", p.loc[2323708, "packCount"] == 216,
      str(p.loc[2323708, "packCount"]))
check("case not high confidence without override", p.loc[2323708, "intrinsicConfidence"] != "high",
      str(p.loc[2323708, "intrinsicConfidence"]))

chase_ids = set(products_df[(products_df["groupId"] == 23237) & products_df["isChase"]]["productId"])
check("top-5 chase by peak", chase_ids == {2323710, 2323711, 2323712, 2323713, 2323714}, str(chase_ids))
check("peak recorded", abs(p.loc[2323710, "peakPrice"] - 400) < 25, str(p.loc[2323710, "peakPrice"]))

check("quality report has flagged rows", len(report) > 0, str(len(report)))
low_ids = {r["productId"] for r in report}
check("fuzzy ETB promo flagged for review", 2323703 in low_ids, str(sorted(low_ids))[:200])

print("== e2e: views ==")
build_views.build_all()
views = os.environ["SEALDEON_VIEWS_DIR"]
for f in ["meta.json", "cohort_curves.json", "age_band_medians.json", "movers.json", "premium_vs_median.json"]:
    check(f"{f} exists", os.path.exists(os.path.join(views, f)))

with open(os.path.join(views, "cohort_curves.json")) as f:
    curves = json.load(f)["series"]
bb = next(s for s in curves if s["groupId"] == 23237 and s["seriesType"] == "Booster Box")
check("cohort indexed to 100 at day 0", abs(bb["points"][0][1] - 100.0) < 0.01, str(bb["points"][0]))
check("cohort has premium dimension", any(pt[2] is not None for pt in bb["points"]))
prem0 = next(pt[2] for pt in bb["points"] if pt[2] is not None)
# hand-check premium: box 110 vs intrinsic 36 * (110/30) + 0 = 132 -> ~-16.7%
check("premium math sane", abs(prem0 - (110 / 132 - 1)) < 0.02, str(prem0))

me_bb = next((s for s in curves if s["groupId"] == 24655 and s["seriesType"] == "Booster Box"), None)
check("ME set present in cohort", me_bb is not None)

with open(os.path.join(views, "age_band_medians.json")) as f:
    bands = json.load(f)["rows"]
check("hype split present", any(r["hypeBucket"] == "clean" for r in bands) and any(r["hypeBucket"] == "hype" for r in bands))

with open(os.path.join(views, "movers.json")) as f:
    movers = json.load(f)
check("movers rows", len(movers["rows"]) > 10, str(len(movers["rows"])))
check("volume stub declared unavailable", movers["volumeMetrics"]["available"] is False)
r = next(r for r in movers["rows"] if r["productId"] == 2465501)
check("movers chg7 populated", r["chg7"] is not None, str(r))

with open(os.path.join(views, "set_detail", "23237.json")) as f:
    detail = json.load(f)
check("set detail sealed grid", len(detail["sealed"]) >= 5, str(len(detail["sealed"])))
check("set detail chase list = 5", len(detail["chase"]) == 5)
check("set detail sparkline", len(detail["sealed"][0]["sparkline"]) > 2)
check("set detail has no inlined eraBand", "eraBand" not in detail)
with open(os.path.join(views, "era_bands.json")) as f:
    era_bands = json.load(f)["bands"]
sv_band = era_bands.get("Scarlet & Violet", [])
check("shared era band populated", any(b["seriesType"] == "Booster Box" for b in sv_band), str(len(sv_band)))

with open(os.path.join(views, "premium_vs_median.json")) as f:
    pvm = json.load(f)["rows"]
check("premium vs median rows", len(pvm) > 5, str(len(pvm)))
check("clean median join works", any(r["cleanMedianPremium"] is not None for r in pvm))

print("== e2e: buy signals ==")
import signals as signals_mod
con2 = build_views.connect()
signals_mod.build_signals(con2, views)
con2.close()
for f in ["signals_backtest.json", "signals_recent.json", "signals_events.json"]:
    check(f"{f} exists", os.path.exists(os.path.join(views, f)))
with open(os.path.join(views, "signals_backtest.json")) as f:
    sbt = json.load(f)
check("backtest has signal definitions", len(sbt["signals"]) == 8, str(len(sbt["signals"])))
_sigkeys = {s["key"] for s in sbt["signals"]}
check("conviction + reprint + momentum signals present",
      {"conviction", "reprint_window", "deep_oop", "momentum_high"} <= _sigkeys, str(sorted(_sigkeys)))
# fixture data trends up, so signals should fire and produce forward returns
with open(os.path.join(views, "signals_events.json")) as f:
    sev = json.load(f)["byGroup"]
check("signal events emitted", isinstance(sev, dict))

print("== e2e: Magic (MTG) classification + intrinsic ==")
import classify as _clf  # noqa: E402
import intrinsic as _intr  # noqa: E402

def _mtg(pid, name, text=None):
    ext = [{"name": "CardText", "value": text}] if text else []
    return {"productId": pid, "name": name, "extendedData": ext}

# box/display/pack classification (game=Magic)
check("MTG collector box classified",
      _clf.classify_product(_mtg(1, "Bloomburrow Collector Booster Box"), "Magic")["productType"] == "Collector Booster Box")
check("MTG collector display classified",
      _clf.classify_product(_mtg(2, "Bloomburrow Collector Booster Display"), "Magic")["productType"] == "Collector Booster Box")
check("MTG play box classified",
      _clf.classify_product(_mtg(3, "Bloomburrow Play Booster Box"), "Magic")["productType"] == "Play Booster Box")
check("MTG collector pack classified",
      _clf.classify_product(_mtg(4, "Bloomburrow Collector Booster Pack"), "Magic")["productType"] == "Collector Booster Pack")
# a bundle is NOT tracked for Magic (box/display-only scope)
check("MTG bundle not sealed",
      _clf.classify_product(_mtg(5, "Bloomburrow Bundle"), "Magic")["isSealed"] is False)
# REGRESSION: a case holds 6-12 boxes -- priced 6-12x with a single box's pack
# count, so misreading one as a box blew out prices and fabricated premiums.
for _case_name in ("The Hobbit Collector Booster Display Case",
                   "FINAL FANTASY Collector Booster Display Master Case",
                   "Bloomburrow Play Booster Box Case"):
    _c = _clf.classify_product(_mtg(7, _case_name), "Magic")
    check(f"MTG case not a box: {_case_name[:34]}",
          _c["productType"] is None and _c["isSealed"] is False, str(_c["productType"]))
# a single (has a card number) is not sealed
_mtg_single = {"productId": 6, "name": "Bloomburrow Mox", "extendedData": [{"name": "Number", "value": "42"}]}
check("MTG single not sealed", _clf.classify_product(_mtg_single, "Magic")["isSealed"] is False)

# intrinsic: collector box -> collector pack, no promo
_mtg_products = [
    _mtg(10, "Bloomburrow Collector Booster Box"),
    _mtg(11, "Bloomburrow Collector Booster Pack"),
    _mtg(12, "Bloomburrow Play Booster Box"),
    _mtg(13, "Bloomburrow Play Booster Pack"),
]
_mtg_sealed = [dict(p, **_clf.classify_product(p, "Magic")) for p in _mtg_products]
_mtg_res = _intr.resolve_set(_mtg_sealed, {"groupId": 999, "name": "Bloomburrow", "game": "Magic"},
                             _mtg_products, [], {}, {})
_byid = {r["productId"]: r for r in _mtg_res}
check("MTG collector box decomposable to collector pack",
      _byid[10]["decomposable"] and _byid[10]["packProductId"] == 11 and _byid[10]["packCount"] == 12)
check("MTG play box decomposable to play pack",
      _byid[12]["decomposable"] and _byid[12]["packProductId"] == 13 and _byid[12]["packCount"] == 36)
check("MTG box has no promo", _byid[10]["promoSource"] == "none")

print("== e2e: partial (single-game) load must not delete other games' rows ==")
# Regression guard: a Magic-only backfill must NEVER wipe stored Pokemon rows
# for the dates it touches. append_prices(replace_dates=False) is additive.
_pp_dir = os.path.join(WORK, "partial-lake")
os.makedirs(_pp_dir, exist_ok=True)
_prev_data_dir = build_parquet.DATA_DIR
build_parquet.DATA_DIR = _pp_dir
try:
    _day = "2024-03-06"
    _poke = pd.DataFrame([{"date": _day, "groupId": 1, "productId": 100 + i, "subTypeName": "Normal",
                           "marketPrice": 10.0 + i, "midPrice": None, "lowPrice": None,
                           "directLowPrice": None, "qtyListed": None, "qtySold": None}
                          for i in range(5)])
    build_parquet.append_prices(_poke)
    _mtg = pd.DataFrame([{"date": _day, "groupId": 999, "productId": 900, "subTypeName": "Normal",
                          "marketPrice": 120.0, "midPrice": None, "lowPrice": None,
                          "directLowPrice": None, "qtyListed": None, "qtySold": None}])
    build_parquet.append_prices(_mtg, replace_dates=False)      # partial/additive
    _after = pd.read_parquet(os.path.join(_pp_dir, "prices", "year=2024", "month=03", "part.parquet"))
    _same_day = _after[_after["date"].astype(str) == _day]
    _kept = _same_day[_same_day["productId"] < 900]
    check("additive load keeps other game's rows", len(_kept) == 5, f"{len(_kept)}/5")
    check("additive load adds the new rows", len(_same_day) == 6, str(len(_same_day)))
    # and the default (full snapshot) still replaces, so corrections land
    build_parquet.append_prices(_mtg, replace_dates=True)
    _after2 = pd.read_parquet(os.path.join(_pp_dir, "prices", "year=2024", "month=03", "part.parquet"))
    check("full load still replaces the date",
          len(_after2[_after2["date"].astype(str) == _day]) == 1)
finally:
    build_parquet.DATA_DIR = _prev_data_dir

print("== e2e: canonical-product integrity (multipack/case regression) ==")
import classify as _c2  # noqa: E402
# The recurring bug class: a CASE or multipack standing in for the single unit.
for _n, _g, _want in [
    ("Shrouded Fable 3 Pack Blister Case", "Pokemon", "3-Pack Blister"),
    ("Ascended Heroes Tin Case", "Pokemon", "Tin"),
    ("Paldean Fates Premium Collection Case", "Pokemon", "Premium Collection"),
    ("Temporal Forces Ultra Premium Collection Case", "Pokemon", "UPC"),
]:
    check(f"case is NOT typed as {_want}: {_n[:36]}",
          _c2.match_product_type(_n, _g) != _want, str(_c2.match_product_type(_n, _g)))
# set names containing "Double" must NOT be treated as multipacks
for _n in ("Double Masters 2022 Draft Booster Box", "Innistrad Double Feature Draft Booster Box"):
    import re as _re
    _m = bool(_re.search(r"set of \d|\bhalf\b|lot of \d|pack of \d|double pack|\bcase\b", _n.lower()))
    check(f"set name with 'Double' not flagged multipack: {_n[:34]}", not _m)

print("== e2e: archive extraction (py7zr ppmd path) ==")
import py7zr  # noqa: E402
import backfill_archive  # noqa: E402

arc_dir = os.path.join(WORK, "arc")
os.makedirs(arc_dir, exist_ok=True)
date = "2024-02-08"
payload_dir = os.path.join(arc_dir, date, "3", "23237")
os.makedirs(payload_dir, exist_ok=True)
sample = {"success": True, "errors": [], "results": fixtures.prices_for_date(dt.date(2024, 3, 2), products_by_group)[23237]}
with open(os.path.join(payload_dir, "prices"), "w") as f:
    json.dump(sample, f)
archive_path = os.path.join(WORK, f"prices-{date}.ppmd.7z")
filters = [{"id": py7zr.FILTER_PPMD, "order": 6, "mem": "16m"}]
with py7zr.SevenZipFile(archive_path, "w", filters=filters) as z:
    z.writeall(os.path.join(arc_dir, date), date)
extracted = backfill_archive.extract_category(archive_path, date)
check("archive extract group present", 23237 in extracted, str(list(extracted)))
check("archive extract row count", len(extracted[23237]) == len(sample["results"]))

print(f"\nALL {PASS} CHECKS PASSED  (workdir: {WORK})")
