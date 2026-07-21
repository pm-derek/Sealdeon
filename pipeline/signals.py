"""Buy-signal backtesting over the Parquet lake.

Turns qualitative "buy signal" heuristics into testable rules, fires them
at every historical date (no look-ahead: each signal uses only data
available on its own date), then measures the forward price return at
+30 / +60 / +90 days. Produces:

    signals_backtest.json  -- per-signal win rate + median forward return
    signals_recent.json    -- individual firings (last ~180d) w/ outcome
    signals_events.json     -- firings per product, for chart markers

Signals (all "buy" signals on sealed product):
  value_rebound  : still cheaper than peers AND premium already turning up
                   (Derek's Stellar Crown pattern).
  below_peers    : sealed premium >= 15pp BELOW the same-day clean-set
                   median premium for its product type (cheaper than peers).
  cheap_premium  : absolute sealed premium <= 10% (the analyst's ~12.5%
                   threshold; negative = box under pack value).
  off_peak       : price <= 60% of its trailing-180d peak (deep dip).
  reprint_window : product age >= ~18 months. Main-set ("standard
                   expansion") print runs typically end 12-18 months after
                   launch; once no new supply is printed, scarcity should
                   push sealed up. (Special/collector sets run shorter,
                   ~6-9 months -- see deep_oop for the older cohort.)
  deep_oop       : product age >= ~24 months -- long out of print across
                   both main and special sets. Tests whether "older = more
                   scarce = better" holds, and how much of the reprint edge
                   is age.
  momentum_high  : price at >= 98% of its trailing-180d peak (making new
                   highs). The mirror image of off_peak -- does momentum
                   continue, or does buying strength lose like buying dips?

Only modern-era (SWSH/SV/ME), decomposable, non-low-confidence sealed
products priced > $20 are considered, to keep the intrinsic-value noise
and vintage price-parking out of the backtest.
"""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

HORIZONS = [30, 60, 90]
GAP_DAYS = 21           # min days between two events of the same signal/product
MODERN = ('Sword & Shield', 'Scarlet & Violet', 'Mega Evolution')
PEAK_WINDOW = 180

REPRINT_AGE = 540       # ≈18 months: main-set print run typically ended
DEEP_OOP_AGE = 730      # ≈24 months: long out of print

SIGNALS = {
    'value_rebound': {'label': 'Value + turning up (below peers AND premium rising)', 'kind': 'premium'},
    'below_peers':  {'label': 'Below peers (premium ≥15pp under clean median)', 'kind': 'premium'},
    'cheap_premium': {'label': 'Cheap premium (≤10% over pack value)', 'kind': 'premium'},
    'off_peak':     {'label': 'Deep dip (≤60% of trailing peak)', 'kind': 'price'},
    'reprint_window': {'label': 'Reprint window closing (age ≥ ~18mo, main-set print run ending)', 'kind': 'age'},
    'deep_oop':     {'label': 'Long out of print (age ≥ ~24mo)', 'kind': 'age'},
    'momentum_high': {'label': 'Momentum / new high (≥98% of trailing peak)', 'kind': 'price'},
}


def _materialize(con) -> None:
    """sealed_daily / px are multi-join views; materialize once so the
    signal queries don't recompute them repeatedly."""
    con.execute("CREATE TEMP TABLE IF NOT EXISTS sd_mat AS SELECT * FROM sealed_daily")
    con.execute("CREATE TEMP TABLE IF NOT EXISTS px_mat AS SELECT * FROM px")


def _base_frame(con) -> pd.DataFrame:
    """Per-day sealed premium + same-day clean-median premium + price."""
    return con.execute(f"""
        WITH clean_med AS (
            SELECT sd.date, sd.productType, median(sd.sealedPremiumPct) AS cleanMed
            FROM sd_mat sd JOIN sets s ON s.groupId = sd.groupId
            WHERE NOT s.isHype AND sd.intrinsicConfidence <> 'low'
            GROUP BY sd.date, sd.productType
        )
        SELECT sd.date, sd.productId, sd.groupId, sd.productType,
               sd.sealedPrice AS price, sd.sealedPremiumPct AS prem,
               cm.cleanMed, s.era, s.isHype, s.name AS setName,
               date_diff('day', s.releaseDate, sd.date) AS ageDays
        FROM sd_mat sd
        JOIN sets s ON s.groupId = sd.groupId
        LEFT JOIN clean_med cm ON cm.date = sd.date AND cm.productType = sd.productType
        WHERE sd.intrinsicConfidence <> 'low' AND sd.sealedPrice > 20
          AND s.era IN {MODERN}
        ORDER BY sd.productId, sd.date
    """).df()


def _fire_flags(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df['date'] = pd.to_datetime(df['date'])
    df['dev'] = df['prem'] - df['cleanMed']
    # trailing 180d peak per product
    df = df.sort_values(['productId', 'date'])
    df['trailmax'] = (
        df.set_index('date').groupby('productId')['price']
        .rolling(f'{PEAK_WINDOW}D').max().reset_index(level=0, drop=True).values
    )
    df['offpeak'] = df['price'] / df['trailmax']
    df['below_peers'] = df['dev'] <= -0.15
    df['cheap_premium'] = df['prem'] <= 0.10
    df['off_peak'] = df['offpeak'] <= 0.60
    df['momentum_high'] = df['offpeak'] >= 0.98
    # Lifecycle / reprint-cycle signals: monotonic in age, so each product
    # fires exactly once (the day it first crosses the threshold, or its
    # first observation if already older).
    df['reprint_window'] = df['ageDays'] >= REPRINT_AGE
    df['deep_oop'] = df['ageDays'] >= DEEP_OOP_AGE
    # "value + turning up": still cheaper than peers, but the premium has
    # started recovering vs ~14 obs ago (Derek's Stellar Crown pattern).
    df['prem_lag'] = df.groupby('productId')['prem'].shift(14)
    df['value_rebound'] = (df['dev'] <= -0.10) & (df['prem'] > df['prem_lag'] + 0.01)
    return df


def _events(df: pd.DataFrame, signal: str) -> pd.DataFrame:
    """First day of each firing streak (>GAP_DAYS since the prior firing)."""
    fires = df[df[signal]].copy()
    if fires.empty:
        return fires
    fires = fires.sort_values(['productId', 'date'])
    gap = fires.groupby('productId')['date'].diff().dt.days
    fires['is_event'] = gap.isna() | (gap > GAP_DAYS)
    return fires[fires['is_event']].copy()


def _forward_returns(events: pd.DataFrame, price_lookup: dict, latest_ord: int) -> pd.DataFrame:
    rows = []
    for e in events.itertuples():
        dates, prices = price_lookup[e.productId]
        d0 = e.date.toordinal()
        row = {'productId': e.productId, 'groupId': e.groupId, 'setName': e.setName,
               'productType': e.productType, 'date': e.date.date().isoformat(),
               'price': round(float(e.price), 2), 'prem': round(float(e.prem), 4),
               'dev': round(float(e.dev), 4) if pd.notna(e.dev) else None}
        for h in HORIZONS:
            target = d0 + h
            j = np.searchsorted(dates, target, side='left')
            matured = (latest_ord - d0) >= h and j < len(dates)
            if matured:
                fwd = prices[j]
                row[f'ret{h}'] = round(float(fwd / e.price - 1), 4)
                row[f'mat{h}'] = True
            else:
                # partial: return so far to the latest observation
                row[f'ret{h}'] = round(float(prices[-1] / e.price - 1), 4)
                row[f'mat{h}'] = False
        rows.append(row)
    return pd.DataFrame(rows)


def _price_lookup(con, product_ids) -> dict:
    ids = ','.join(str(int(i)) for i in product_ids) or '-1'
    px = con.execute(
        f"SELECT productId, date, price FROM px_mat WHERE productId IN ({ids}) ORDER BY productId, date"
    ).df()
    px['ord'] = pd.to_datetime(px['date']).map(lambda d: d.toordinal())
    out = {}
    for pid, g in px.groupby('productId'):
        out[int(pid)] = (g['ord'].to_numpy(), g['price'].to_numpy())
    return out


def build_signals(con, views_dir: str) -> dict:
    _materialize(con)
    base = _base_frame(con)
    if base.empty:
        for f in ('signals_backtest', 'signals_recent', 'signals_events'):
            _write(views_dir, f, {'rows': [], 'signals': []})
        return {'events': 0}
    flagged = _fire_flags(base)
    latest_ord = pd.to_datetime(base['date']).max().toordinal()

    all_events = []
    for sig in SIGNALS:
        ev = _events(flagged, sig)
        if not ev.empty:
            ev['signal'] = sig
            all_events.append(ev)
    if not all_events:
        for f in ('signals_backtest', 'signals_recent', 'signals_events'):
            _write(views_dir, f, {'rows': [], 'signals': []})
        return {'events': 0}
    events = pd.concat(all_events, ignore_index=True)
    pl = _price_lookup(con, events['productId'].unique())

    enriched = []
    for sig, grp in events.groupby('signal'):
        fr = _forward_returns(grp, pl, latest_ord)
        fr['signal'] = sig
        enriched.append(fr)
    ev = pd.concat(enriched, ignore_index=True)

    # ---- Backtest leaderboard: matured events only ----
    backtest = []
    for sig in SIGNALS:
        for h in HORIZONS:
            m = ev[(ev['signal'] == sig) & (ev[f'mat{h}'])]
            if len(m) < 3:
                continue
            r = m[f'ret{h}']
            backtest.append({
                'signal': sig, 'label': SIGNALS[sig]['label'], 'horizon': h,
                'n': int(len(m)),
                'winRate': round(float((r > 0).mean()), 3),
                'medianReturn': round(float(r.median()), 4),
                'avgReturn': round(float(r.mean()), 4),
                'p25': round(float(r.quantile(0.25)), 4),
                'p75': round(float(r.quantile(0.75)), 4),
            })
    # ---- Baseline: unconditional forward return of ALL sealed product-days,
    # so signal edge = signal win rate minus the market's own drift. ----
    baseline = []
    samp = flagged[['date', 'productId', 'groupId', 'setName', 'productType', 'price', 'prem']].copy()
    samp['dev'] = 0.0
    # thin to ~1 obs / product / 20 days to reduce autocorrelation
    samp = samp.sort_values(['productId', 'date'])
    samp = samp[samp.groupby('productId').cumcount() % 20 == 0]
    bl = _forward_returns(samp, _price_lookup(con, samp['productId'].unique()), latest_ord)
    for h in HORIZONS:
        m = bl[bl[f'mat{h}']]
        if len(m) < 3:
            continue
        r = m[f'ret{h}']
        baseline.append({'horizon': h, 'n': int(len(m)),
                         'winRate': round(float((r > 0).mean()), 3),
                         'medianReturn': round(float(r.median()), 4),
                         'avgReturn': round(float(r.mean()), 4)})

    _write(views_dir, 'signals_backtest', {
        'rows': backtest, 'baseline': baseline,
        'signals': [{'key': k, **v} for k, v in SIGNALS.items()],
        'horizons': HORIZONS,
        'note': 'Forward price return after each signal fired. Matured firings only '
                '(outcome window elapsed). Modern eras, decomposable sealed, '
                'confidence≥medium, price>$20. Baseline = same measure over all '
                'sealed product-days (the market drift to beat).',
    })

    # ---- Recent firings (last 180d), most recent first ----
    cutoff = _iso_days_ago(latest_ord, 180)
    recent = ev[ev['date'] >= cutoff].sort_values('date', ascending=False)
    _write(views_dir, 'signals_recent', {
        'rows': recent.head(400).to_dict('records'),
        'signals': [{'key': k, **v} for k, v in SIGNALS.items()],
        'horizons': HORIZONS, 'latestDate': _ord_iso(latest_ord),
    })

    # ---- Events per product (for chart markers) ----
    by_prod = {}
    for r in ev.to_dict('records'):
        by_prod.setdefault(int(r['groupId']), []).append({
            'productId': r['productId'], 'productType': r['productType'],
            'date': r['date'], 'signal': r['signal'],
            'price': r['price'], 'ret30': r.get('ret30'), 'mat30': r.get('mat30'),
        })
    _write(views_dir, 'signals_events', {'byGroup': by_prod})

    return {'events': int(len(ev))}


def _iso_days_ago(latest_ord: int, days: int) -> str:
    import datetime as dt
    return dt.date.fromordinal(latest_ord - days).isoformat()


def _ord_iso(o: int) -> str:
    import datetime as dt
    return dt.date.fromordinal(o).isoformat()


def _clean(o):
    if isinstance(o, float):
        return None if (o != o or o in (float('inf'), float('-inf'))) else o
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean(v) for v in o]
    return o


def _write(views_dir: str, name: str, payload) -> None:
    os.makedirs(views_dir, exist_ok=True)
    with open(os.path.join(views_dir, f'{name}.json'), 'w') as f:
        json.dump(_clean(payload), f, separators=(',', ':'), allow_nan=False)
