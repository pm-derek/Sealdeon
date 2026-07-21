-- Premium vs clean median (successor to Visualize.gs): each sealed
-- product's CURRENT premium against the HISTORICAL clean median premium
-- for the same productType + age band -- real historical medians, not a
-- static snapshot. Low-confidence rows are kept but flagged so the UI
-- can dim them.
WITH latest AS (
    SELECT max(date) AS d FROM px
),
clean_median AS (
    SELECT
        sd.productType,
        age_band(date_diff('day', s.releaseDate, sd.date)) AS ageBand,
        median(sd.sealedPremiumPct) AS cleanMedianPremium,
        count(*) AS n
    FROM sealed_daily sd
    JOIN sets s ON s.groupId = sd.groupId
    WHERE NOT s.isHype
      AND s.releaseDate IS NOT NULL
      AND date_diff('day', s.releaseDate, sd.date) >= 0
      AND sd.intrinsicConfidence != 'low'
    GROUP BY sd.productType, age_band(date_diff('day', s.releaseDate, sd.date))
),
current_prem AS (
    SELECT
        sd.productId, sd.groupId, sd.productType,
        sd.sealedPrice, sd.intrinsicValue, sd.sealedPremiumPct,
        sd.intrinsicConfidence,
        date_diff('day', s.releaseDate, latest.d) AS ageDays
    FROM sealed_daily sd
    JOIN sets s ON s.groupId = sd.groupId
    CROSS JOIN latest
    WHERE sd.date = latest.d AND s.releaseDate IS NOT NULL
)
SELECT
    cp.productId,
    cp.groupId,
    pr.name,
    pr.imageUrl,
    cp.productType,
    s.name AS setName,
    s.era,
    s.isHype,
    cp.ageDays,
    age_band(cp.ageDays) AS ageBand,
    round(cp.sealedPrice, 2)      AS price,
    round(cp.intrinsicValue, 2)   AS intrinsicValue,
    round(cp.sealedPremiumPct, 4) AS premiumPct,
    round(cm.cleanMedianPremium, 4) AS cleanMedianPremium,
    round(cp.sealedPremiumPct - cm.cleanMedianPremium, 4) AS deviation,
    cp.intrinsicConfidence AS conf
FROM current_prem cp
JOIN products pr ON pr.productId = cp.productId
JOIN sets s ON s.groupId = cp.groupId
LEFT JOIN clean_median cm
    ON cm.productType = cp.productType AND cm.ageBand = age_band(cp.ageDays)
ORDER BY deviation DESC NULLS LAST;
