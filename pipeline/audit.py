"""Data-integrity audit over the built lake.

Catches the class of bug that has bitten us repeatedly: the wrong PRODUCT
standing in for a (set, productType) line -- multipacks, cases, and other
multi-unit SKUs whose price is a multiple of the single unit's, and whose
pack count then fabricates a premium.

Run:  python pipeline/audit.py            (exit 1 if any ERROR-level finding)
"""
from __future__ import annotations

import sys

import build_views

# Words that mean "more than one unit". A canonical product for a type must
# never match these -- its price would be a multiple of the real unit.
MULTI_UNIT = ("case", "set of", "lot of", "pack of", "half", "double pack", "bundle of")

# Sanity ceilings for a SINGLE unit, by type (USD). Deliberately generous --
# these flag "this is probably a case", not "this is expensive".
MAX_SANE = {
    "ETB": 1200, "PKC ETB": 2000, "Booster Bundle": 400, "UPC": 1500,
    "Collector Booster Box": 3000, "Set Booster Box": 1500,
    "Play Booster Box": 1500, "Draft Booster Box": 1500,
}


def run(con) -> list[tuple[str, str, str]]:
    """Returns [(level, check, detail)]."""
    out: list[tuple[str, str, str]] = []

    def err(check, detail): out.append(("ERROR", check, detail))
    def warn(check, detail): out.append(("WARN", check, detail))
    def ok(check, detail=""): out.append(("ok", check, detail))

    # 1. exactly one canonical product per (set, productType)
    n = con.execute("""SELECT count(*) FROM (SELECT groupId, productType FROM products
        WHERE isCanonical AND productType IS NOT NULL
        GROUP BY 1,2 HAVING count(*)>1)""").fetchone()[0]
    (ok if n == 0 else err)("one canonical product per (set,type)", f"{n} duplicated")

    # 2. no canonical product is a multi-unit SKU
    like = " OR ".join(f"lower(cleanName) LIKE '%{w}%'" for w in MULTI_UNIT)
    rows = con.execute(f"""SELECT s.name, p.cleanName, p.productType
        FROM products p JOIN sets s USING(groupId)
        WHERE p.isCanonical AND p.productType IS NOT NULL
          AND p.productType NOT LIKE '%Case%' AND p.productType NOT LIKE '%Display%'
          AND ({like}) LIMIT 20""").df()
    (ok if rows.empty else err)("canonical is a single unit (not a case/multipack)",
                                "; ".join(f"{r.cleanName} [{r.productType}]" for r in rows.itertuples()) or "clean")

    # 3. the plotted line equals the canonical product's own price
    d = con.execute("""
        WITH sd AS (SELECT groupId, seriesType, arg_max(price,date) px FROM series_daily
                    WHERE seriesType<>'Chase Singles' GROUP BY 1,2),
             c AS (SELECT p.groupId, p.productType, arg_max(x.price,x.date) px
                   FROM products p JOIN px x USING(productId) WHERE p.isCanonical GROUP BY 1,2)
        SELECT count(*) n, sum(CASE WHEN abs(sd.px-c.px)>0.01 THEN 1 ELSE 0 END) bad
        FROM sd JOIN c ON c.groupId=sd.groupId AND c.productType=sd.seriesType""").fetchone()
    (ok if not d[1] else err)("cohort line == canonical product price", f"{d[1]}/{d[0]} mismatched")

    # 4. single-unit price sanity (a case masquerading as a unit shows up here)
    cases = ",".join(f"('{k}',{v})" for k, v in MAX_SANE.items())
    rows = con.execute(f"""
        WITH lim(t,mx) AS (VALUES {cases}),
             latest AS (SELECT productId, arg_max(price,date) px FROM px GROUP BY 1)
        SELECT s.name, p.cleanName, p.productType, round(l.px,2) px, lim.mx
        FROM products p JOIN sets s USING(groupId) JOIN latest l USING(productId)
        JOIN lim ON lim.t=p.productType
        WHERE p.isCanonical AND l.px > lim.mx ORDER BY l.px DESC LIMIT 20""").df()
    (ok if rows.empty else warn)("single-unit price within sane ceiling",
                                 "; ".join(f"{r.cleanName}={r.px}>{r.mx}" for r in rows.itertuples()) or "clean")

    # 5. premium sanity on decomposable canonical sealed
    d = con.execute("""SELECT count(*) FROM sealed_daily sd
        JOIN products p ON p.productId=sd.productId AND p.isCanonical
        WHERE sd.date=(SELECT max(date) FROM px)
          AND sd.intrinsicConfidence IN ('high','medium') AND abs(sd.sealedPremiumPct)>1.5""").fetchone()[0]
    (ok if d == 0 else warn)("no wild premiums at high/medium confidence", f"{d} rows |prem|>150%")

    # 6. price continuity: a >3x single-day jump means the listing changed meaning
    d = con.execute("""
        WITH j AS (SELECT productId, date, price,
                          lag(price) OVER (PARTITION BY productId ORDER BY date) prev
                   FROM px)
        SELECT count(*) FROM j JOIN products p USING(productId)
        WHERE p.isCanonical AND prev>1 AND (price/prev>3 OR price/prev<0.33)""").fetchone()[0]
    (ok if d == 0 else warn)("no >3x single-day price jumps on canonical products", f"{d} jumps")

    return out


def main() -> int:
    con = build_views.connect()
    try:
        results = run(con)
    finally:
        con.close()
    errors = 0
    for level, check, detail in results:
        mark = {"ok": "  [ok]", "WARN": "  [warn]", "ERROR": "  [FAIL]"}[level]
        print(f"{mark} {check}" + (f"  ({detail})" if detail else ""))
        errors += level == "ERROR"
    print(f"\n{'AUDIT FAILED' if errors else 'AUDIT PASSED'} — {errors} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
