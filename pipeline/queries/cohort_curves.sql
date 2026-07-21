-- Cohort curve points, downsampled: daily through age 120, weekly after.
-- Frontend slices in memory by era / seriesType / hype / complete-partial.
SELECT
    groupId,
    seriesType,
    ageDays,
    round(idxPrice, 2)  AS idx,
    round(premiumPct, 4) AS prem,
    round(price, 2)     AS price,
    intrinsicConfidence AS conf
FROM series_indexed
WHERE ageDays >= 0
  AND seriesType IN ('Booster Box', 'ETB', 'PKC ETB', 'Booster Bundle', 'UPC', 'Chase Singles')
  AND (ageDays <= 120 OR ageDays % 7 = 0)
ORDER BY groupId, seriesType, ageDays;
