-- Movers / notable changes: sealed products + chase singles only.
-- Price changes over 1d/7d/30d/90d and sealed-premium swings over
-- 7d/30d. qtyListed/qtySold are intentionally absent (no free source;
-- UI stubs them as "pending data source").
WITH latest AS (
    SELECT max(date) AS d FROM px
),
universe AS (
    SELECT productId, groupId, name, imageUrl, productType, isChase, intrinsicConfidence
    FROM products
    WHERE (isSealed AND productType IS NOT NULL) OR isChase
),
cur AS (
    SELECT x.productId, x.price
    FROM px x, latest WHERE x.date = latest.d
),
ago AS (
    SELECT productId,
        arg_max(price, date) FILTER (WHERE date <= d - 1)  AS p1,
        arg_max(price, date) FILTER (WHERE date <= d - 7)  AS p7,
        arg_max(price, date) FILTER (WHERE date <= d - 30) AS p30,
        arg_max(price, date) FILTER (WHERE date <= d - 90) AS p90
    FROM px, latest
    GROUP BY productId
),
prem AS (
    SELECT productId,
        arg_max(sealedPremiumPct, date)                              AS premNow,
        arg_max(sealedPremiumPct, date) FILTER (WHERE date <= d - 7)  AS prem7,
        arg_max(sealedPremiumPct, date) FILTER (WHERE date <= d - 30) AS prem30,
        arg_max(intrinsicValue, date)                                AS intrinsicNow
    FROM sealed_daily, latest
    GROUP BY productId
)
SELECT
    u.productId,
    u.groupId,
    u.name,
    u.imageUrl,
    u.productType,
    u.isChase,
    u.intrinsicConfidence AS conf,
    s.name AS setName,
    s.era,
    s.isHype,
    s.archiveComplete,
    date_diff('day', s.releaseDate, latest.d) AS ageDays,
    round(c.price, 2) AS price,
    round(c.price / NULLIF(a.p1, 0) - 1, 4)  AS chg1,
    round(c.price / NULLIF(a.p7, 0) - 1, 4)  AS chg7,
    round(c.price / NULLIF(a.p30, 0) - 1, 4) AS chg30,
    round(c.price / NULLIF(a.p90, 0) - 1, 4) AS chg90,
    round(p.premNow, 4)              AS premiumPct,
    round(p.premNow - p.prem7, 4)    AS premChg7,
    round(p.premNow - p.prem30, 4)   AS premChg30,
    round(p.intrinsicNow, 2)         AS intrinsicValue
FROM universe u
JOIN cur c USING (productId)
LEFT JOIN ago a USING (productId)
LEFT JOIN prem p USING (productId)
JOIN sets s ON s.groupId = u.groupId
CROSS JOIN latest
WHERE c.price > 0
ORDER BY u.groupId, u.productType NULLS LAST, u.name;
