-- Pooled age-band medians (price + sealed premium) with the hype split
-- as a first-class dimension. hypeBucket: all | hype | clean. The
-- "clean" bucket (hype sets excluded) is the honest baseline. Era 'All'
-- rows are cross-era rollups. Low-confidence premium rows are excluded
-- from the premium median (they still count for price).
WITH banded AS (
    SELECT
        s.game, s.era, s.isHype,
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
    SELECT game, era, seriesType, 'all'   AS hypeBucket, ageBand, price, premiumPct, groupId FROM banded
    UNION ALL
    SELECT game, era, seriesType, 'hype'  AS hypeBucket, ageBand, price, premiumPct, groupId FROM banded WHERE isHype
    UNION ALL
    SELECT game, era, seriesType, 'clean' AS hypeBucket, ageBand, price, premiumPct, groupId FROM banded WHERE NOT isHype
),
rollup AS (
    SELECT game, era, seriesType, hypeBucket, ageBand, price, premiumPct, groupId FROM buckets
    UNION ALL
    -- cross-era rollup stays WITHIN a game
    SELECT game, 'All' AS era, seriesType, hypeBucket, ageBand, price, premiumPct, groupId FROM buckets
)
SELECT
    game,
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
GROUP BY game, era, seriesType, hypeBucket, ageBand
HAVING count(*) > 0
ORDER BY era, seriesType, hypeBucket,
         CASE ageBand WHEN '0-1mo' THEN 0 WHEN '1-3mo' THEN 1 WHEN '3-6mo' THEN 2
                      WHEN '6-12mo' THEN 3 WHEN '12-18mo' THEN 4 WHEN '18-24mo' THEN 5
                      WHEN '24-36mo' THEN 6 ELSE 7 END;
