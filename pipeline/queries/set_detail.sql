-- Per-product current stats for set detail pages: sealed grid rows and
-- chase-single rows for every set. build_views.py splits the result by
-- groupId into set_detail/{groupId}.json and attaches sparklines +
-- era median bands.
WITH latest AS (
    SELECT max(date) AS d FROM px
),
universe AS (
    SELECT productId, groupId, name, imageUrl, url, productType, isChase,
           isCanonical, peakPrice, peakDate, cardNumber, rarity,
           packCount, packCountSource, promoSource, intrinsicConfidence
    FROM products
    WHERE (isSealed AND productType IS NOT NULL) OR isChase
),
cur AS (
    SELECT x.productId, x.price FROM px x, latest WHERE x.date = latest.d
),
extremes AS (
    SELECT productId,
           max(price) AS athPrice,
           min(price) AS atlPrice,
           arg_min(price, date) AS launchPrice
    FROM px
    GROUP BY productId
),
prem AS (
    SELECT productId,
           arg_max(sealedPremiumPct, date) AS premiumPct,
           arg_max(intrinsicValue, date)   AS intrinsicValue,
           arg_max(promoPrice, date)       AS promoPrice,
           arg_max(packPrice, date)        AS packPrice
    FROM sealed_daily
    GROUP BY productId
)
SELECT
    u.groupId,
    u.productId,
    u.name,
    u.imageUrl,
    u.url,
    u.productType,
    u.isChase,
    u.isCanonical,
    u.cardNumber,
    u.rarity,
    u.packCount,
    u.packCountSource,
    u.promoSource,
    u.intrinsicConfidence AS conf,
    round(c.price, 2)        AS price,
    round(e.athPrice, 2)     AS athPrice,
    round(e.atlPrice, 2)     AS atlPrice,
    round(e.launchPrice, 2)  AS launchPrice,
    round(u.peakPrice, 2)    AS peakPrice,
    u.peakDate,
    round(c.price / NULLIF(u.peakPrice, 0) - 1, 4) AS pctOffPeak,
    round(p.premiumPct, 4)     AS premiumPct,
    round(p.intrinsicValue, 2) AS intrinsicValue,
    round(p.packPrice, 2)      AS packPrice,
    round(p.promoPrice, 2)     AS promoPrice
FROM universe u
JOIN cur c USING (productId)
LEFT JOIN extremes e USING (productId)
LEFT JOIN prem p USING (productId)
WHERE c.price > 0
ORDER BY u.groupId, u.isChase, u.productType NULLS LAST, u.name;
