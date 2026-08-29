-- Shared derived views over the Parquet lake. Executed before any view
-- query. Placeholders {prices_glob}/{sets_path}/{products_path} are
-- filled in by build_views.py.

CREATE OR REPLACE VIEW prices AS
SELECT * FROM read_parquet('{prices_glob}');

CREATE OR REPLACE VIEW sets AS
SELECT * REPLACE (CAST(releaseDate AS DATE) AS releaseDate)
FROM read_parquet('{sets_path}');

CREATE OR REPLACE VIEW products AS
SELECT * FROM read_parquet('{products_path}');

-- One usable price per product per day. marketPrice primary, midPrice
-- fallback, lowPrice last resort; highPrice is never stored (price
-- parking). Sealed products have a single subtype; singles with several
-- print subtypes take the max, matching the peak-based chase ranking.
-- NOTE: `price` and `marketPrice` semantics are load-bearing (audit check 3
-- asserts the cohort line equals the canonical product's price) -- do not
-- change them. lowPrice/midPrice are carried through ADDITIVELY for the
-- supply-tightness proxies below.
CREATE OR REPLACE VIEW px AS
SELECT date, groupId, productId,
       max(COALESCE(marketPrice, midPrice, lowPrice)) AS price,
       max(marketPrice) AS marketPrice,
       max(lowPrice)    AS lowPrice,
       max(midPrice)    AS midPrice
FROM prices
GROUP BY date, groupId, productId;

-- Supply-tightness PROXIES (not quantities -- TCGCSV publishes no listing
-- counts). The cheapest ask relative to the blended market price says how
-- hard sellers are undercutting each other:
--   askFloor > 1.0  -> nobody is undercutting; the book is thin  (tight)
--   askFloor < 0.85 -> sellers racing each other down            (glut)
-- Verified to behave as theory predicts: newest era medians ~0.93 (fresh
-- supply) vs vintage ~1.10 (thin supply).
-- directLowPrice is deliberately NOT used: only ~0.9% of rows carry it.
-- Plausibility guard: a cheapest ask above ~2.5x market (or below 0.2x) means
-- marketPrice is STALE, not that supply is tight -- illiquid vintage throws
-- these constantly (a $3.53 ratio on a 2014 tin is a dead listing, not signal).
-- Null them rather than let them top the "tightening" sort.
CREATE OR REPLACE VIEW supply_daily AS
SELECT date, groupId, productId,
       price, marketPrice, lowPrice, midPrice,
       CASE WHEN lowPrice / marketPrice BETWEEN 0.2 AND 2.5
            THEN lowPrice / marketPrice END              AS askFloor,
       CASE WHEN lowPrice / marketPrice BETWEEN 0.2 AND 2.5
            THEN (midPrice - lowPrice) / marketPrice END AS askSpread
FROM px
WHERE marketPrice > 0 AND lowPrice IS NOT NULL;

-- Intrinsic value + sealed premium as a TIME SERIES: every sealed
-- decomposable product, every day, decomposed against that day's pack
-- and promo prices.
CREATE OR REPLACE VIEW sealed_daily AS
WITH joined AS (
    SELECT
        x.date, x.productId, x.groupId,
        pr.productType,
        x.price AS sealedPrice,
        pr.packCount,
        pk.price AS packPrice,
        CASE WHEN pr.promoProductId IS NOT NULL
                  AND pr.promoSource IN ('auto', 'override')
             THEN COALESCE(pm.price, 0) ELSE 0 END AS promoPrice,
        pr.packCountSource, pr.promoSource, pr.intrinsicConfidence
    FROM px x
    JOIN products pr ON pr.productId = x.productId AND pr.decomposable
    JOIN px pk ON pk.productId = pr.packProductId AND pk.date = x.date
    LEFT JOIN px pm ON pm.productId = pr.promoProductId AND pm.date = x.date
)
SELECT *,
       packCount * packPrice + promoPrice AS intrinsicValue,
       sealedPrice / NULLIF(packCount * packPrice + promoPrice, 0) - 1 AS sealedPremiumPct
FROM joined
WHERE packPrice IS NOT NULL AND packPrice > 0;

-- Cohort series: one line per (set, seriesType). Sealed lines use the
-- set's canonical product of each type; "Chase Singles" pools the set's
-- top-5 singles, ranked on trailing-90d median value (see chase.py).
--
-- A skewed basket has no single right summary, so all four are stored and the
-- chart lets the user pick (ME02 Phantasmal Flames, top-5 = $703/$275/$27/
-- $21/$21 -- sum $1048, mean $210, median $27, top $703; every one of those
-- answers a different question). `price` stays the MEAN so that every
-- existing consumer -- movers, age bands, benchmarks, signals -- keeps the
-- units it has always had; the alternates are additive.
CREATE OR REPLACE VIEW series_daily AS
WITH sealed AS (
    SELECT
        x.groupId,
        pr.productType AS seriesType,
        x.date,
        x.price,
        x.price AS priceSum,        -- a sealed line is one product; every
        x.price AS priceMedian,     -- aggregate of a single value is itself
        x.price AS priceTop,
        sd.sealedPremiumPct AS premiumPct,
        sd.intrinsicConfidence,
        date_diff('day', s.releaseDate, x.date) AS ageDays
    FROM px x
    JOIN products pr ON pr.productId = x.productId AND pr.isCanonical
    JOIN sets s ON s.groupId = x.groupId
    LEFT JOIN sealed_daily sd ON sd.productId = x.productId AND sd.date = x.date
    WHERE s.releaseDate IS NOT NULL AND x.price > 0
),
-- Fixed basket size per set, so the sum below is a stable "all five" total.
chase_size AS (
    SELECT groupId, count(*) AS n FROM products WHERE isChase GROUP BY groupId
),
chase AS (
    SELECT
        x.groupId,
        'Chase Singles' AS seriesType,
        x.date,
        avg(x.price) AS price,
        -- Normalised sum = mean x full basket size, NOT sum(price). A card
        -- with no listing on a given day would otherwise drop straight out of
        -- a raw sum: basket size moves on ~1% of day-rows and the raw sum
        -- steps 48% on average when it does, against 21% for the mean. This
        -- form equals the true total whenever all five are priced and imputes
        -- a missing one at the basket's own average otherwise.
        avg(x.price) * any_value(cs.n) AS priceSum,
        median(x.price) AS priceMedian,
        max(x.price) AS priceTop,
        NULL::DOUBLE AS premiumPct,
        NULL::VARCHAR AS intrinsicConfidence,
        date_diff('day', s.releaseDate, x.date) AS ageDays
    FROM px x
    JOIN products pr ON pr.productId = x.productId AND pr.isChase
    JOIN sets s ON s.groupId = x.groupId
    JOIN chase_size cs ON cs.groupId = x.groupId
    WHERE s.releaseDate IS NOT NULL AND x.price > 0
    GROUP BY x.groupId, x.date, s.releaseDate
)
SELECT * FROM sealed UNION ALL SELECT * FROM chase;

-- Indexed to release day = 100. Complete sets index at true day 0;
-- right-censored (partial) sets index at first observation -- the
-- archiveComplete flag on sets tells the frontend which is which.
CREATE OR REPLACE VIEW series_indexed AS
WITH base AS (
    SELECT groupId, seriesType, arg_min(price, ageDays) AS basePrice
    FROM series_daily
    WHERE ageDays >= 0 AND price > 0
    GROUP BY groupId, seriesType
)
SELECT sd.*, 100.0 * sd.price / b.basePrice AS idxPrice
FROM series_daily sd
JOIN base b USING (groupId, seriesType)
WHERE b.basePrice > 0;

-- Age banding used by benchmarks and premium-vs-median.
CREATE OR REPLACE MACRO age_band(age) AS
CASE WHEN age <= 30  THEN '0-1mo'
     WHEN age <= 91  THEN '1-3mo'
     WHEN age <= 182 THEN '3-6mo'
     WHEN age <= 365 THEN '6-12mo'
     WHEN age <= 547 THEN '12-18mo'
     WHEN age <= 730 THEN '18-24mo'
     WHEN age <= 1095 THEN '24-36mo'
     ELSE '36mo+' END;
