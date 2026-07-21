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
CREATE OR REPLACE VIEW px AS
SELECT date, groupId, productId,
       max(COALESCE(marketPrice, midPrice, lowPrice)) AS price,
       max(marketPrice) AS marketPrice
FROM prices
GROUP BY date, groupId, productId;

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
-- set's canonical product of each type; "Chase Singles" is the median of
-- the set's top-5 peak-ranked singles.
CREATE OR REPLACE VIEW series_daily AS
WITH sealed AS (
    SELECT
        x.groupId,
        pr.productType AS seriesType,
        x.date,
        x.price,
        sd.sealedPremiumPct AS premiumPct,
        sd.intrinsicConfidence,
        date_diff('day', s.releaseDate, x.date) AS ageDays
    FROM px x
    JOIN products pr ON pr.productId = x.productId AND pr.isCanonical
    JOIN sets s ON s.groupId = x.groupId
    LEFT JOIN sealed_daily sd ON sd.productId = x.productId AND sd.date = x.date
    WHERE s.releaseDate IS NOT NULL AND x.price > 0
),
chase AS (
    SELECT
        x.groupId,
        'Chase Singles' AS seriesType,
        x.date,
        median(x.price) AS price,
        NULL::DOUBLE AS premiumPct,
        NULL::VARCHAR AS intrinsicConfidence,
        date_diff('day', s.releaseDate, x.date) AS ageDays
    FROM px x
    JOIN products pr ON pr.productId = x.productId AND pr.isChase
    JOIN sets s ON s.groupId = x.groupId
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
CASE WHEN age <= 30 THEN '0-1mo'
     WHEN age <= 91 THEN '1-3mo'
     WHEN age <= 182 THEN '3-6mo'
     WHEN age <= 365 THEN '6-12mo'
     ELSE '12mo+' END;
