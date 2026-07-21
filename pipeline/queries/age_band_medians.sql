-- Pooled age-band medians (price + sealed premium) with the hype split
-- as a first-class dimension. hypeBucket: all | hype | clean. The
-- "clean" bucket (hype sets excluded) is the honest baseline. Era 'All'
-- rows are cross-era rollups. Low-confidence premium rows are excluded
-- from the premium median (they still count for price).
WITH banded AS (
    SELECT
        s.era, s.isHype,
        sd.seriesType,
        age_band(sd.ageDays) AS ageBand,
        sd.price,
        CASE WHEN sd.intrinsicConfidence = 'low' THEN NULL ELSE sd.premiumPct END AS premiumPct,
        sd.groupId
    FROM series_indexed sd
    JOIN sets s USING (groupId)
    WHERE sd.ageDays >= 0
),
buckets AS (
    SELECT era, seriesType, 'all'   AS hypeBucket, ageBand, price, premiumPct, groupId FROM banded
    UNION ALL
    SELECT era, seriesType, 'hype'  AS hypeBucket, ageBand, price, premiumPct, groupId FROM banded WHERE isHype
    UNION ALL
    SELECT era, seriesType, 'clean' AS hypeBucket, ageBand, price, premiumPct, groupId FROM banded WHERE NOT isHype
),
rollup AS (
    SELECT era, seriesType, hypeBucket, ageBand, price, premiumPct, groupId FROM buckets
    UNION ALL
    SELECT 'All' AS era, seriesType, hypeBucket, ageBand, price, premiumPct, groupId FROM buckets
)
SELECT
    era,
    seriesType,
    hypeBucket,
    ageBand,
    round(median(price), 2)          AS medianPrice,
    round(quantile_cont(price, 0.25), 2) AS p25Price,
    round(quantile_cont(price, 0.75), 2) AS p75Price,
    round(median(premiumPct), 4)     AS medianPremiumPct,
    count(*)                          AS n,
    count(DISTINCT groupId)           AS nSets
FROM rollup
GROUP BY era, seriesType, hypeBucket, ageBand
HAVING count(*) > 0
ORDER BY era, seriesType, hypeBucket,
         CASE ageBand WHEN '0-1mo' THEN 0 WHEN '1-3mo' THEN 1 WHEN '3-6mo' THEN 2
                      WHEN '6-12mo' THEN 3 ELSE 4 END;
