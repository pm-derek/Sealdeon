"""Market pulse: the trend / winners-vs-losers analysis as a daily view.

Everything here is a pure function of the lake, so the page refreshes with
every snapshot. Writes market.json, one block per game:

  pulse     headline numbers + a regime label
  index     weekly chain-linked index per segment, last 12 months
  supply    weekly ask-book tightness, last 12 months
  segments  30/90d moves by product type
  movers    biggest 30/90d winners and losers
  factors   "what has worked": forward 90d return by what an item looked
            like beforehand, over all history and over the latest matured
            window, scored at a buyer's realistic entry price
  screens   live lists built from the factors that held up

Method notes that matter for reading it:
- Universe: canonical single-unit sealed (no cases/multipacks). Pokemon is
  modern eras only (vintage history is thin and full of listing artifacts);
  Magic is sets from 2019 on.
- Index: median week-over-week return across products, chained. Products
  only count once they are >120 days old, so a wave of new releases decaying
  from preorder prices cannot masquerade as a market move.
- Entry price: a buyer pays the lowest listing whenever it sits ABOVE market
  (thin supply), and is assumed to pay market otherwise. Scoring at market
  price instead manufactures a fake "thin supply" edge: market price simply
  catches up to the ask, a move no buyer captures.
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd

MODERN_POKEMON = ("Sword & Shield", "Scarlet & Violet", "Mega Evolution")
MAGIC_FROM_YEAR = 2019
SEASONED_DAYS = 120          # index ignores products younger than this
HORIZON = 90                 # forward window for the factor scoreboard
STEP = 14                    # sampling cadence for the factor panel
MIN_BUCKET = 30              # buckets thinner than this are not shown

GAMES = {
    "Pokemon": {
        "types": ["Booster Box", "ETB", "PKC ETB", "Booster Bundle", "UPC"],
        "segments": {"Booster Box": ["Booster Box"], "ETB": ["ETB", "PKC ETB"],
                     "Bundle / UPC": ["Booster Bundle", "UPC"]},
        "minPrice": 30,
    },
    "Magic": {
        "types": ["Collector Booster Box", "Play Booster Box", "Set Booster Box", "Draft Booster Box"],
        "segments": {"Collector": ["Collector Booster Box"], "Play": ["Play Booster Box"],
                     "Set": ["Set Booster Box"], "Draft": ["Draft Booster Box"]},
        "minPrice": 60,
    },
}


def _universe_sql(game: str) -> str:
    cfg = GAMES[game]
    types = ",".join(f"'{t}'" for t in cfg["types"])
    if game == "Pokemon":
        eras = ",".join(f"'{e}'" for e in MODERN_POKEMON)
        scope = f"s.era IN ({eras})"
    else:
        scope = f"year(s.releaseDate) >= {MAGIC_FROM_YEAR}"
    return f"""
        SELECT p.productId, p.productType AS type, p.cleanName AS item, p.url,
               s.groupId, s.name AS setName, s.abbreviation AS ab, s.releaseDate
        FROM products p JOIN sets s USING (groupId)
        WHERE p.isCanonical AND s.game = '{game}' AND p.productType IN ({types})
          AND {scope} AND s.releaseDate IS NOT NULL"""


def _prep(con, game: str, d0) -> None:
    """Materialise the game's universe and its price history once."""
    con.execute(f"CREATE OR REPLACE TEMP TABLE mk_u AS {_universe_sql(game)}")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE mk_px AS
        SELECT x.productId, x.date, x.price,
               max(x.price) OVER (PARTITION BY x.productId ORDER BY x.date) AS ath
        FROM px x JOIN mk_u USING (productId) WHERE x.price > 0""")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE mk_ask AS
        SELECT sp.productId, sp.date, sp.askFloor AS ask
        FROM supply_daily sp JOIN mk_u USING (productId) WHERE sp.askFloor IS NOT NULL""")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE mk_prem AS
        SELECT sd.productId, sd.date, sd.sealedPremiumPct AS prem
        FROM sealed_daily sd JOIN mk_u USING (productId)
        WHERE sd.intrinsicConfidence IN ('high', 'medium')""")


def _asof(tbl: str, col: str, at: str, tol: int = 7) -> str:
    """Value of `col` at the last observation on/before `at`, within tol days."""
    return f"""(SELECT g.productId, CASE WHEN a.date > g.tt - {tol} THEN a.{col} END AS v
                FROM (SELECT productId, ({at})::DATE AS tt FROM mk_u) g
                ASOF JOIN {tbl} a ON a.productId = g.productId AND a.date <= g.tt)"""


def _snapshot(con, d0) -> pd.DataFrame:
    """One row per universe product: prices now / 30 / 90 / 365 days ago."""
    D = f"DATE '{d0}'"
    df = con.execute(f"""
        SELECT u.*, date_diff('day', u.releaseDate, {D}) AS age,
               p0.v AS p0, p30.v AS p30, p90.v AS p90, p365.v AS p365,
               ath.v AS ath, ask.v AS ask, prem.v AS prem
        FROM mk_u u
        LEFT JOIN {_asof('mk_px', 'price', D)} p0 USING (productId)
        LEFT JOIN {_asof('mk_px', 'price', D + ' - 30')} p30 USING (productId)
        LEFT JOIN {_asof('mk_px', 'price', D + ' - 90')} p90 USING (productId)
        LEFT JOIN {_asof('mk_px', 'price', D + ' - 365')} p365 USING (productId)
        LEFT JOIN {_asof('mk_px', 'ath', D)} ath USING (productId)
        LEFT JOIN {_asof('mk_ask', 'ask', D)} ask USING (productId)
        LEFT JOIN {_asof('mk_prem', 'prem', D)} prem USING (productId)
    """).df()
    df = df[df.p0.notna()].copy()
    df["r30"] = df.p0 / df.p30 - 1
    df["r90"] = df.p0 / df.p90 - 1
    df["r365"] = df.p0 / df.p365 - 1
    df["offHigh"] = df.p0 / df.ath - 1
    return df


def _weekly_index(con, d0, segments: dict[str, list[str]], extra: dict[str, str] | None = None):
    """Chain-linked median weekly return per segment, rebased to 100."""
    case = " ".join(
        f"WHEN u.type IN ({','.join(repr(t) for t in ts)}) THEN '{name}'"
        for name, ts in segments.items())
    rets = con.execute(f"""
        WITH w AS (
            SELECT CASE {case} END AS seg, x.productId,
                   date_trunc('week', x.date)::DATE AS wk, arg_max(x.price, x.date) AS px,
                   any_value(u.releaseDate) AS rel
            FROM mk_px x JOIN mk_u u USING (productId)
            WHERE x.date > DATE '{d0}' - 371
            GROUP BY ALL),
        r AS (SELECT seg, wk, px / lag(px) OVER (PARTITION BY productId ORDER BY wk) - 1 AS r, rel FROM w)
        SELECT seg, wk, median(r) AS r FROM r
        WHERE r IS NOT NULL AND abs(r) < 0.6 AND date_diff('day', rel, wk) > {SEASONED_DAYS}
        GROUP BY ALL
        UNION ALL
        SELECT 'All' AS seg, wk, median(r) AS r FROM r
        WHERE r IS NOT NULL AND abs(r) < 0.6 AND date_diff('day', rel, wk) > {SEASONED_DAYS}
        GROUP BY ALL
    """).df()
    if extra:
        rets = pd.concat([rets] + [con.execute(sql).df() for sql in extra.values()], ignore_index=True)
    out = {}
    for seg, g in rets.groupby("seg"):
        g = g.sort_values("wk")
        lvl = 100 * np.cumprod(1 + g.r.to_numpy())
        out[seg] = [[d.isoformat(), round(float(v), 2)] for d, v in zip(g.wk.dt.date, lvl)]
    return out


def _chase_index_sql(d0) -> str:
    """Top-5 chase basket (mean of the set's chase cards), modern sets."""
    eras = ",".join(f"'{e}'" for e in MODERN_POKEMON)
    return f"""
        WITH c AS (
            SELECT p.groupId, x.productId, date_trunc('week', x.date)::DATE AS wk,
                   arg_max(x.price, x.date) AS px, any_value(s.releaseDate) AS rel
            FROM px x JOIN products p USING (productId) JOIN sets s ON s.groupId = p.groupId
            WHERE p.isChase AND s.game = 'Pokemon' AND s.era IN ({eras})
              AND x.price > 0 AND x.date > DATE '{d0}' - 371
            GROUP BY ALL),
        r AS (SELECT wk, px / lag(px) OVER (PARTITION BY productId ORDER BY wk) - 1 AS r, rel FROM c)
        SELECT 'Chase singles' AS seg, wk, median(r) AS r FROM r
        WHERE r IS NOT NULL AND abs(r) < 0.6 AND date_diff('day', rel, wk) > {SEASONED_DAYS}
        GROUP BY ALL"""


def _supply(con, d0):
    rows = con.execute(f"""
        SELECT date_trunc('week', a.date)::DATE AS wk,
               median(a.ask) AS medAsk,
               avg(CASE WHEN a.ask >= 1.0 THEN 1.0 ELSE 0 END) AS thin,
               avg(CASE WHEN a.ask < 0.9 THEN 1.0 ELSE 0 END) AS glut
        FROM mk_ask a JOIN mk_u u USING (productId)
        WHERE a.date > DATE '{d0}' - 371 AND date_diff('day', u.releaseDate, a.date) > {SEASONED_DAYS}
        GROUP BY 1 ORDER BY 1""").df()
    return [[pd.Timestamp(r.wk).date().isoformat(), round(float(r.medAsk), 4),
             round(float(r.thin), 4), round(float(r.glut), 4)] for r in rows.itertuples()]


def _panel(con, d0) -> pd.DataFrame:
    """Every product every STEP days: features at t, realistic forward return."""
    last_t = d0 - dt.timedelta(days=HORIZON)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE mk_grid AS
        SELECT u.productId, u.releaseDate, g.t,
               (g.t - 30)::DATE AS t30, (g.t + {HORIZON})::DATE AS tf
        FROM mk_u u, (SELECT unnest(generate_series(DATE '2024-05-15', DATE '{last_t}',
                                                    INTERVAL {STEP} DAY))::DATE AS t) g
        WHERE u.releaseDate <= g.t""")

    def at(tbl, col, tcol="t", tol=7):
        return f"""(SELECT g.productId, g.t, CASE WHEN a.date > g.{tcol} - {tol} THEN a.{col} END AS v
                    FROM mk_grid g ASOF JOIN {tbl} a ON a.productId = g.productId AND a.date <= g.{tcol})"""
    df = con.execute(f"""
        SELECT g.productId, g.t, date_diff('day', g.releaseDate, g.t) AS age,
               pt.v AS p_t, ath.v AS ath_t, p30.v AS p_m30, pf.v AS p_f,
               pr.v AS prem_t, ak.v AS ask_t
        FROM mk_grid g
        LEFT JOIN {at('mk_px', 'price')} pt USING (productId, t)
        LEFT JOIN {at('mk_px', 'ath')} ath USING (productId, t)
        LEFT JOIN {at('mk_px', 'price', 't30')} p30 USING (productId, t)
        LEFT JOIN {at('mk_px', 'price', 'tf')} pf USING (productId, t)
        LEFT JOIN {at('mk_prem', 'prem')} pr USING (productId, t)
        LEFT JOIN {at('mk_ask', 'ask')} ak USING (productId, t)
    """).df()
    df = df[df.p_t.notna() & df.p_f.notna() & (df.p_t >= 20)].copy()
    entry = df.p_t * df.ask_t.clip(lower=1.0).fillna(1.0)
    df["fwd"] = (df.p_f / entry - 1).clip(-0.6, 1.5)   # winsorise listing artifacts
    df["mom30"] = df.p_t / df.p_m30 - 1
    df["dd"] = df.p_t / df.ath_t - 1
    return df


FACTORS = [
    ("prem_t", "Price vs pack value", "How far the sealed price sits above the value of the packs inside it.",
     [-np.inf, -0.10, 0.10, 0.30, 0.60, np.inf], ["below −10%", "−10…+10%", "+10…30%", "+30…60%", "above +60%"]),
    ("age", "Age of set", "Days since release.",
     [-1e9, 180, 365, 730, 1095, np.inf], ["under 6 mo", "6–12 mo", "1–2 yr", "2–3 yr", "3 yr+"]),
    ("mom30", "Last 30 days", "Price change over the 30 days before.",
     [-np.inf, -0.03, 0.03, 0.10, np.inf], ["down >3%", "flat", "up 3–10%", "up >10%"]),
    ("dd", "Distance from high", "How far below its all-time high it was.",
     [-np.inf, -0.30, -0.05, np.inf], [">30% below", "5–30% below", "at its high"]),
    ("ask_t", "Cheapest listing vs market", "Lowest ask ÷ market price. Below 1 = sellers undercutting.",
     [-np.inf, 0.90, 0.97, 1.03, np.inf], ["under 0.90", "0.90–0.97", "0.97–1.03", "over 1.03"]),
]


def _factors(df: pd.DataFrame, d0) -> dict:
    recent_from = pd.Timestamp(d0) - pd.Timedelta(days=HORIZON + 180)
    windows = {"all": df, "recent": df[pd.to_datetime(df.t) >= recent_from]}
    base = {k: _stats(w.fwd) for k, w in windows.items()}
    out = []
    for col, label, desc, bins, names in FACTORS:
        if df[col].notna().mean() < 0.3:
            continue
        buckets = []
        for name, lo, hi in zip(names, bins[:-1], bins[1:]):
            row = {"bucket": name}
            for k, w in windows.items():
                s = w.loc[(w[col] > lo) & (w[col] <= hi), "fwd"]
                st = _stats(s)
                if st["n"] >= MIN_BUCKET:
                    st["excess"] = round(st["mean"] - base[k]["mean"], 4)
                    row[k] = st
            buckets.append(row)
        out.append({"key": col, "label": label, "desc": desc, "buckets": buckets})
    return {
        "horizonDays": HORIZON,
        "windows": {
            "all": {"label": "All history", "from": str(pd.to_datetime(df.t).min().date()), **base["all"]},
            "recent": {"label": "Latest 6 months", "from": str(recent_from.date()), **base["recent"]},
        },
        "factors": out,
    }


def _stats(s: pd.Series) -> dict:
    s = s.dropna()
    if s.empty:
        return {"n": 0, "mean": None, "hit": None}
    return {"n": int(len(s)), "mean": round(float(s.mean()), 4),
            "hit": round(float((s > 0.02).mean()), 3), "loss": round(float((s < -0.05).mean()), 3)}


def _rows(df: pd.DataFrame, cols=("item", "setName", "ab", "type", "url", "age", "p0",
                                  "r30", "r90", "r365", "prem", "ask", "offHigh")) -> list[dict]:
    out = []
    for r in df.to_dict("records"):
        row = {}
        for c in cols:
            v = r.get(c)
            if isinstance(v, float):
                v = None if np.isnan(v) else round(v, 4)
            elif isinstance(v, (np.integer,)):
                v = int(v)
            row[c] = v
        out.append(row)
    return out


def _regime(r30: float | None, r90: float | None, off_high: float | None) -> str:
    """Plain-English state of the index. Uses distance from the 12-month high
    as well as the 90d change, so a slow grind lower off a peak is not called
    flat just because no single quarter crossed a threshold."""
    if r30 is None or r90 is None:
        return "Not enough data"
    if r90 >= 0.03:
        return "Rising" if r30 >= 0 else "Cooling"
    if r90 < 0 and (r90 <= -0.03 or (off_high or 0) <= -0.03):
        return "Drifting lower" if r30 < -0.005 else "Stabilizing"
    return "Flat"


def _change(series: list, days: int) -> float | None:
    if not series:
        return None
    last_d, last_v = dt.date.fromisoformat(series[-1][0]), series[-1][1]
    past = [v for d, v in series if dt.date.fromisoformat(d) <= last_d - dt.timedelta(days=days)]
    return round(last_v / past[-1] - 1, 4) if past else None


def build_game(con, game: str, d0) -> dict:
    cfg = GAMES[game]
    _prep(con, game, d0)
    snap = _snapshot(con, d0)
    liquid = snap[snap.p0 >= cfg["minPrice"]]

    extra = {"chase": _chase_index_sql(d0)} if game == "Pokemon" else None
    index = _weekly_index(con, d0, cfg["segments"], extra)
    all_idx = index.get("All", [])
    lvl = [v for _, v in all_idx]

    def breadth(col):
        moved = snap[col].dropna()
        moved = moved[moved.abs() > 0.02]
        return round(float((moved > 0).mean()), 3) if len(moved) else None

    pulse = {
        "index30": _change(all_idx, 28), "index90": _change(all_idx, 91),
        "offYearHigh": round(lvl[-1] / max(lvl) - 1, 4) if lvl else None,
        "breadth30": breadth("r30"), "breadth90": breadth("r90"),
        "median30": _r(snap.r30.median()), "median90": _r(snap.r90.median()),
        "products": int(len(snap)),
        "chase90": _change(index.get("Chase singles", []), 91),
    }
    pulse["regime"] = _regime(pulse["index30"], pulse["index90"], pulse["offYearHigh"])

    segments = []
    for t in cfg["types"]:
        s = snap[snap.type == t]
        if len(s) < 3:
            continue
        segments.append({"type": t, "n": int(len(s)), "median30": _r(s.r30.median()),
                         "median90": _r(s.r90.median()),
                         "up90": _r(((s.r90 > 0.02).sum() / max(1, (s.r90.abs() > 0.02).sum())))})

    movers = {}
    for k in ("r30", "r90"):
        m = liquid[liquid[k].notna()].sort_values(k)
        movers[k] = {"up": _rows(m.tail(8).iloc[::-1]), "down": _rows(m.head(8))}

    panel = _panel(con, d0)
    factors = _factors(panel, d0)
    screens = _screens(snap, game, cfg)
    return {"pulse": pulse, "index": index, "supply": _supply(con, d0),
            "segments": segments, "movers": movers, "factors": factors, "screens": screens}


def _r(v):
    return None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), 4)


def _screens(snap: pd.DataFrame, game: str, cfg: dict) -> list[dict]:
    s = snap[snap.p0 >= cfg["minPrice"]]
    out = []
    if game == "Pokemon":
        out.append({
            "key": "passes", "tone": "pos", "title": "Passes every filter that held up",
            "why": "Past the new-release decay (6+ months), priced under 30% above its packs, "
                   "the cheapest listing is at or below market, and not falling over 30 days.",
            "rows": _rows(s[(s.age > 180) & (s.prem < 0.30) & (s.ask <= 1.0) & (s.r30 >= 0)]
                          .sort_values("prem").head(12))})
        out.append({
            "key": "below_packs", "tone": "pos", "title": "Boxes trading below pack value",
            "why": "Over a year old and cheaper sealed than the 36 packs inside. Relative value, "
                   "not a timing signal: this edge was strong in the bull market and faded to "
                   "average in the latest window.",
            "rows": _rows(s[(s.type == "Booster Box") & (s.age > 365) & (s.prem < -0.10)]
                          .sort_values("prem").head(12))})
        out.append({
            "key": "high_premium", "tone": "neg", "title": "Avoid: priced 60%+ above its packs",
            "why": "The one warning that held in every market and under every entry price. "
                   "These lagged the market every period we checked.",
            "rows": _rows(s[s.prem >= 0.60].sort_values("prem", ascending=False).head(12))})
    else:
        out.append({
            "key": "seasoned_cbb", "tone": "pos", "title": "Seasoned collector boxes with momentum",
            "why": "Collector boxes 1–4 years old that are not falling over 30 days -- the "
                   "segment that has led Magic's rise.",
            "rows": _rows(s[(s.type == "Collector Booster Box") & s.age.between(365, 1460) & (s.r30 >= 0)]
                          .sort_values("r90", ascending=False).head(12))})
    out.append({
        "key": "new_release", "tone": "neg", "title": "Avoid: under 6 months old",
        "why": "New releases are the worst-performing age bucket in both games: prices decay "
               "from preorder levels as supply lands.",
        "rows": _rows(s[s.age < 180].sort_values("r30").head(12))})
    return out


def build(con) -> dict:
    con.execute("SET enable_progress_bar = false")
    d0 = con.execute("SELECT max(date) FROM px").fetchone()[0]
    games = {}
    for game in GAMES:
        games[game] = build_game(con, game, d0)
    return {"asOf": d0.isoformat(), "games": games}
