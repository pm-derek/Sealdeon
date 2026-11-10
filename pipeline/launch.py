"""Launch anchoring: how much of a fall is launch hype vs the market.

Launch prices are not a baseline. Sealed peaks ~2 months BEFORE release, in
thin preorder trading (Destined Rivals' Pokemon Center ETB first traded at
$2,000, preorders averaged $865, it settled at $184); singles peak around
prerelease, when half the listings have no sales behind them at all. A curve
measured from that peak mostly measures the hype.

The anchor is the SETTLED price: the median over days 30-59 after release.
Scored against what items did next (market move removed), it is far better
than any earlier window -- at day 90 only ~5% of sealed and ~17% of singles
sit >30% away from it, against ~88% from the launch peak.

Every item's peak -> now move then splits, additively in log space, into:
  unwind    peak -> settled             the launch premium leaving
  decay     typical drift after settling at this age, from the curve below
            (sealed: ~flat; singles: keep falling ~a third as packs get opened)
  market    the market index over the same dates
  specific  what is left: this set/card versus a normal one

Universe: sets released after the archive floor's preorder window opened
(full launch history) and at least 75 days old. Sealed = canonical
box/ETB/PKC ETB/bundle (Magic: its box types). Singles (Pokemon only) = each
set's top 10 cards by median price over days 7-29, chosen at the time, so the
sample is not survivors picked with hindsight.
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd

ANCHOR = (30, 59)              # settled window, days since release
FIRST_RELEASE = "2024-03-01"   # earliest release with preorder history in the lake
MIN_AGE = 75                   # need the anchor window plus a little after it
SEASONED = 120                 # index constituents must be this old
CURVE_AGES = [45, 60, 90, 120, 150, 180, 240, 300, 365, 450, 540, 720]
MIN_CURVE_N = 8
SINGLES_PER_SET = 10
MODERN_POKEMON = ("Sword & Shield", "Scarlet & Violet", "Mega Evolution")

SEALED_TYPES = {
    "Pokemon": ["Booster Box", "ETB", "PKC ETB", "Booster Bundle"],
    "Magic": ["Collector Booster Box", "Play Booster Box", "Set Booster Box", "Draft Booster Box"],
}


def _scope(game: str) -> str:
    if game == "Pokemon":
        return "s.era IN (" + ",".join(f"'{e}'" for e in MODERN_POKEMON) + ")"
    return "year(s.releaseDate) >= 2019"


def _index(con, where: str) -> pd.Series:
    """Chain-linked weekly median return across seasoned items -> level series."""
    df = con.execute(f"""
        WITH w AS (SELECT productId, date_trunc('week', date)::DATE wk, arg_max(price, date) px,
                          any_value(releaseDate) rel
                   FROM ln_px WHERE {where} GROUP BY 1, 2),
             r AS (SELECT wk, rel, px / lag(px) OVER (PARTITION BY productId ORDER BY wk) - 1 r FROM w)
        SELECT wk, median(r) r FROM r
        WHERE r IS NOT NULL AND abs(r) < 0.6 AND date_diff('day', rel, wk) > {SEASONED}
        GROUP BY 1 ORDER BY 1""").df()
    if df.empty:
        return pd.Series(dtype=float)
    return pd.Series(100 * np.cumprod(1 + df.r.to_numpy()), index=pd.to_datetime(df.wk))


def _level(idx: pd.Series, when) -> float:
    if idx.empty:
        return np.nan
    before = idx[idx.index <= pd.Timestamp(when)]
    # preorder dates can precede the index's first week: clamp to its start
    return float(before.iloc[-1] if len(before) else idx.iloc[0])


def build(con, game: str, d0) -> dict | None:
    types = ",".join(f"'{t}'" for t in SEALED_TYPES[game])
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE ln_px AS
        SELECT x.productId, x.date, x.price, p.groupId, s.releaseDate,
               date_diff('day', s.releaseDate, x.date) AS age,
               p.isCanonical AND p.productType IN ({types}) AS isSealedLine,
               p.cardNumber IS NOT NULL AND NOT p.isSealed AS isCard
        FROM px x JOIN products p USING (productId) JOIN sets s ON s.groupId = p.groupId
        WHERE s.game = '{game}' AND {_scope(game)} AND s.releaseDate IS NOT NULL AND x.price > 0
          AND ((p.isCanonical AND p.productType IN ({types}))
               OR (p.cardNumber IS NOT NULL AND NOT p.isSealed))""")

    sets = con.execute(f"""
        SELECT s.groupId, s.abbreviation ab, s.name, s.releaseDate
        FROM sets s WHERE s.game = '{game}' AND {_scope(game)}
          AND s.releaseDate >= DATE '{FIRST_RELEASE}' AND s.releaseDate <= DATE '{d0}' - {MIN_AGE}
          AND s.name NOT ILIKE '%energ%'
        ORDER BY s.releaseDate""").df()
    if sets.empty:
        return None
    gids = ",".join(str(int(g)) for g in sets.groupId)

    idx = {"sealed": _index(con, "isSealedLine")}
    single_ids: list[int] = []
    if game == "Pokemon":
        idx["single"] = _index(con, """isCard AND productId IN (
            SELECT productId FROM ln_px WHERE isCard GROUP BY 1 HAVING max(price) >= 20)""")
        single_ids = con.execute(f"""
            WITH m AS (SELECT groupId, productId, median(price) med FROM ln_px
                       WHERE isCard AND groupId IN ({gids}) AND age BETWEEN 7 AND 29 GROUP BY 1, 2)
            SELECT productId FROM m
            QUALIFY row_number() OVER (PARTITION BY groupId ORDER BY med DESC) <= {SINGLES_PER_SET}
        """).df().productId.astype(int).tolist()

    sealed_ids = con.execute(f"""SELECT DISTINCT productId FROM ln_px
        WHERE isSealedLine AND groupId IN ({gids})""").df().productId.astype(int).tolist()
    ids = sealed_ids + single_ids
    if not ids:
        return None
    paths = con.execute(f"""
        SELECT l.productId, l.groupId, l.date, l.age, l.price, p.cleanName AS item, p.productType AS type, p.url
        FROM ln_px l JOIN products p USING (productId)
        WHERE l.productId IN ({",".join(map(str, ids))}) ORDER BY l.productId, l.date""").df()
    paths["date"] = pd.to_datetime(paths.date)
    kind_of = {i: "sealed" for i in sealed_ids} | {i: "single" for i in single_ids}

    # ---- per-item anchors ---------------------------------------------------
    items = []
    for pid, g in paths.groupby("productId", sort=False):
        kind = kind_of[int(pid)]
        win = g[g.age.between(*ANCHOR)]
        early = g[g.age <= 30]
        if len(win) < 8 or early.empty:
            continue
        pk = early.loc[early.price.idxmax()]
        last = g.iloc[-1]
        items.append({
            "productId": int(pid), "groupId": int(g.groupId.iloc[0]), "kind": kind,
            "item": g.item.iloc[0], "type": g.type.iloc[0] if kind == "sealed" else "Single",
            "url": g.url.iloc[0], "g": g,
            "peak": float(pk.price), "peakDate": pk.date, "peakAge": int(pk.age),
            "preorder": float(g[g.age < 0].price.median()) if (g.age < 0).any() else None,
            "settled": float(win.price.median()), "settledDate": win.date.iloc[len(win) // 2],
            "now": float(last.price), "nowDate": last.date, "ageNow": int(last.age),
        })
    if not items:
        return None

    # ---- typical post-settle curve (market removed) ---------------------------
    curve_obs = []
    for it in items:
        ix = idx.get(it["kind"])
        if ix is None or ix.empty:
            continue
        g, base = it["g"], _level(ix, it["settledDate"])
        for a in CURVE_AGES:
            h = g[(g.age <= a) & (g.age > a - 7)]
            if len(h):
                curve_obs.append((it["kind"], a, np.log(h.price.iloc[-1] / it["settled"])
                                  - np.log(_level(ix, h.date.iloc[-1]) / base)))
    cv = pd.DataFrame(curve_obs, columns=["kind", "age", "x"])
    curve = {}
    for kind, c in cv.groupby("kind"):
        s = c.groupby("age").x.agg(["size", "median"])
        s = s[s["size"] >= MIN_CURVE_N]
        curve[kind] = [[int(a), round(float(np.expm1(m)), 4), int(n)] for a, (n, m) in s.iterrows()]

    def expected(kind, age):
        pts = curve.get(kind) or []
        if age <= ANCHOR[0] + 15 or not pts:
            return 0.0
        ages = [p[0] for p in pts]; vals = [np.log1p(p[1]) for p in pts]
        return float(np.interp(age, ages, vals))    # flat beyond the last point

    # ---- decomposition ---------------------------------------------------------
    for it in items:
        ix = idx.get(it["kind"])
        total = np.log(it["now"] / it["peak"])
        unwind = np.log(it["settled"] / it["peak"])
        market = (np.log(_level(ix, it["nowDate"]) / _level(ix, it["settledDate"]))
                  if ix is not None and not ix.empty else 0.0)
        decay = expected(it["kind"], it["ageNow"])
        it.update(total=total, unwind=unwind, market=market, decay=decay,
                  specific=total - unwind - market - decay)

    pct = lambda v: round(float(np.expm1(v)), 4)
    by_set = {}
    for it in items:
        by_set.setdefault(it["groupId"], []).append(it)
    set_rows = []
    for s in sets.itertuples():
        its = by_set.get(int(s.groupId))
        if not its:
            continue
        row = {"groupId": int(s.groupId), "ab": s.ab, "name": s.name,
               "releaseDate": pd.Timestamp(s.releaseDate).date().isoformat(),
               "age": int((pd.Timestamp(d0) - pd.Timestamp(s.releaseDate)).days)}
        for kind in ("sealed", "single"):
            k = [i for i in its if i["kind"] == kind]
            if not k:
                continue
            med = lambda f: float(np.median([i[f] for i in k]))
            row[kind] = {
                "n": len(k), "total": pct(med("total")), "unwind": pct(med("unwind")),
                "decay": pct(med("decay")), "market": pct(med("market")), "specific": pct(med("specific")),
                "items": [{"item": i["item"], "type": i["type"], "url": i["url"],
                           "peak": round(i["peak"], 2), "peakAge": i["peakAge"],
                           "settled": round(i["settled"], 2), "now": round(i["now"], 2),
                           "unwind": pct(i["unwind"]), "decay": pct(i["decay"]),
                           "market": pct(i["market"]), "specific": pct(i["specific"]),
                           "total": pct(i["total"])}
                          for i in sorted(k, key=lambda i: -i["settled"])],
            }
        set_rows.append(row)

    # ---- release-year summary ----------------------------------------------------
    years = []
    yr = {int(s.groupId): pd.Timestamp(s.releaseDate).year for s in sets.itertuples()}
    for kind in ("sealed", "single"):
        for y in sorted({yr[i["groupId"]] for i in items if i["kind"] == kind}):
            k = [i for i in items if i["kind"] == kind and yr[i["groupId"]] == y]
            med = lambda f: float(np.median([i[f] for i in k]))
            years.append({"kind": kind, "year": int(y), "n": len(k), "unwind": pct(med("unwind")),
                          "market": pct(med("market")),
                          "afterSettle": pct(float(np.median([i["total"] - i["unwind"] for i in k]))),
                          "total": pct(med("total"))})

    # ---- how good is each anchor? (miss rate at day 90, market removed) -------------
    candidates = {"Launch peak": None, "Day 0": None, "Days 7–13": (7, 13),
                  "Days 7–29": (7, 29), "Days 30–59 (settled)": ANCHOR}
    board = []
    for kind in ("sealed", "single"):
        ix = idx.get(kind)
        if ix is None or ix.empty:
            continue
        for name, w in candidates.items():
            misses = []
            for it in (i for i in items if i["kind"] == kind):
                g = it["g"]
                h = g[(g.age <= 90) & (g.age > 83)]
                if h.empty:
                    continue
                if name == "Launch peak":
                    a, t = it["peak"], it["peakDate"]
                elif name == "Day 0":
                    d = g[(g.age <= 0) & (g.age > -14)]
                    if d.empty:
                        continue
                    a, t = float(d.price.iloc[-1]), d.date.iloc[-1]
                else:
                    d = g[g.age.between(*w)]
                    if len(d) < 3:
                        continue
                    a, t = float(d.price.median()), d.date.iloc[len(d) // 2]
                x = np.log(h.price.iloc[-1] / a) - np.log(_level(ix, h.date.iloc[-1]) / _level(ix, t))
                misses.append(abs(x) > np.log(1.3))
            if len(misses) >= 10:
                board.append({"kind": kind, "anchor": name, "n": len(misses),
                              "miss30": round(float(np.mean(misses)), 3)})

    return {
        "anchorWindow": list(ANCHOR),
        "firstRelease": FIRST_RELEASE,
        "curve": curve,
        "sets": set_rows,
        "years": years,
        "scoreboard": board,
        "hasSingles": game == "Pokemon",
    }
