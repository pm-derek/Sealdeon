-- Cohort curve points, downsampled: daily through age 120, weekly after --
-- plus each series' most recent observation, always. Without that last
-- clause a mature series ends at its last multiple of 7, which is up to 6
-- days stale by construction and worse whenever a daily snapshot is missing:
-- a skipped day knocks out that whole weekly point, so one gap costs 7 days
-- and two consecutive ones cost 14. That is what made every set older than
-- 120 days trail the newest sets by ~2 weeks on the calendar chart.
WITH src AS (
    SELECT *, max(ageDays) OVER (PARTITION BY groupId, seriesType) AS maxAge
    FROM series_indexed
    WHERE ageDays >= 0
      AND seriesType IN (
            -- Pokemon
            'Booster Box', 'ETB', 'PKC ETB', 'Booster Bundle', 'UPC', 'Chase Singles',
            -- Magic (box/display scope)
            'Collector Booster Box', 'Set Booster Box', 'Play Booster Box', 'Draft Booster Box')
)
SELECT
    groupId,
    seriesType,
    ageDays,
    round(idxPrice, 2)  AS idx,
    round(premiumPct, 4) AS prem,
    round(price, 2)     AS price,
    -- Basket alternates: only ever differ from `price` on Chase Singles, so
    -- build_views drops them from single-product series rather than write the
    -- same number three times for every sealed point. priceSum is deliberately
    -- NOT emitted per point -- it is mean x basket size, a per-series constant,
    -- so build_views ships the size once and the frontend multiplies.
    round(priceMedian, 2) AS priceMedian,
    round(priceTop, 2)    AS priceTop,
    priceSum / NULLIF(price, 0) AS basketSize,
    intrinsicConfidence AS conf
FROM src
WHERE ageDays <= 120 OR ageDays % 7 = 0 OR ageDays = maxAge
ORDER BY groupId, seriesType, ageDays;
