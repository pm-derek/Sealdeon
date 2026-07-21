# Sealdeon

Pokemon TCG sealed-market intelligence. Not a portfolio tracker, not a buying
tool — the product is **analysis**: how every set performs over its lifecycle,
compared on a normalized basis. The centerpiece is **cohort analysis**
(compare sets by *age*, not calendar date), with **sealed premium / intrinsic
value** as a first-class time-series metric alongside price.

Data source: [TCGCSV.com](https://tcgcsv.com) (free, ~24h fresh, archive back
to **2024-02-08** — a hard floor). Single user, zero-cost, GitHub-native.

## Architecture

Two layers, no server:

- **Layer 1 — Parquet data lake** (`data/`): full daily price history,
  partitioned `prices/year=YYYY/month=MM/`, plus `sets.parquet` and
  `products.parquet` dimensions. Queried **server-side** by DuckDB inside
  GitHub Actions. The browser never loads this.
- **Layer 2 — pre-computed view JSON** (`web/public/views/`): each pipeline
  run executes fixed queries (`pipeline/queries/*.sql`) and writes small
  JSONs — `meta`, `cohort_curves`, `age_band_medians`, `movers`,
  `premium_vs_median`, `set_detail/{groupId}`. The React frontend loads only
  these; all dashboard filters are in-memory slices.

Frontend: React + Vite + Tailwind + Observable Plot, deployed to GitHub Pages
(`deploy-pages.yml`). Hash routing, relative base — works at any Pages path.

## Getting started (first build)

1. **Enable GitHub Pages** for the repo: Settings → Pages → Source = "GitHub Actions".
2. Run the **backfill** workflow (Actions → backfill). Optionally tick
   *validate_only* first — it downloads exactly one archive date (2024-02-08)
   and prints the extracted structure without writing anything.
3. The full backfill loops 2024-02-08 → today with a monthly checkpoint
   (`data/backfill_state.json`); re-running resumes where it stopped. It ends
   by building dimensions, flags, and views, then commits everything.
4. Review **`data/data_quality_report.json`** — every sealed product whose
   intrinsic-value inputs are medium/low confidence, with what auto-resolution
   produced. Correct only the wrong ones in:
   - `config/packcount_overrides.json` (productId → pack count)
   - `config/promo_overrides.json` (`"groupId:productType"` → promo card)
   - `config/hype_overrides.json` (groupId → true/false; seed with Prismatic
     Evolutions, Destined Rivals, Phantasmal Flames, Ascended Heroes)
5. Re-run the backfill's finalize (`python pipeline/backfill_archive.py
   --finalize` or just wait for the next daily run) — confidence rises as
   overrides land.
6. The **daily-snapshot** workflow (21:30 UTC cron) then keeps everything
   fresh: append snapshot → recompute flags + premium → rebuild views → commit
   → Pages redeploys.

## Data notes (respect these)

- `marketPrice` primary, `midPrice` fallback, `lowPrice` last resort.
  **`highPrice` is excluded everywhere** (price-parking corruption).
- No SKU/condition granularity — prices are per-product aggregates.
- **`qtyListed` / `qtySold` are nullable placeholders.** No free,
  ToS-compliant volume source exists; the UI stubs them. They light up only if
  a paid feed (TCGplayer API / TCGAPIs) is ever added.
- Sets released before 2024-02-08 are **right-censored ("partial")**: indexed
  to first observation, dashed/dimmed in cohort overlays, hidden by default.
- Be polite to TCGCSV: identifiable User-Agent, ~0.25 s between live calls
  (built into `pipeline/tcgcsv.py`).

## Ad-hoc analysis with Claude (the custom-query path)

There is deliberately no custom-query UI. For bespoke cuts, point Claude
(chat or Claude Code) at the Parquet lake and let it run DuckDB directly:

```python
import duckdb
con = duckdb.connect()
prices = "read_parquet('data/prices/*/*/*.parquet')"
con.sql(f"""
    SELECT s.name, avg(p.marketPrice) AS avg_price
    FROM {prices} p
    JOIN 'data/sets.parquet' s USING (groupId)
    WHERE p.date >= current_date - INTERVAL 30 DAY
    GROUP BY s.name ORDER BY avg_price DESC LIMIT 20
""").show()
```

Useful starting points:

- `data/products.parquet` carries the derived flags: `isSealed`,
  `productType`, `isChase`, `peakPrice/peakDate`, `packCount(+Source)`,
  `promoProductId(+Source)`, `intrinsicConfidence`, `isCanonical`.
- The exact derived views the dashboards use (price selection, per-day
  intrinsic value, cohort indexing, age bands) are defined in
  `pipeline/queries/_setup.sql` — paste that into a DuckDB session (after
  substituting the three path placeholders) to query `sealed_daily` /
  `series_indexed` directly.

## Repo layout

```
pipeline/    fetchers, classifiers, era/chase/hype/intrinsic logic,
             parquet writer, view builder, queries/*.sql
data/        Layer 1 Parquet lake + data_quality_report.json (committed)
config/      override files: hype, pack counts, promos, aliases
web/         Vite + React frontend; public/views/ = Layer 2 JSON (committed)
tests/       offline fixtures + end-to-end pipeline validation (run_e2e.py)
```

`python tests/run_e2e.py` validates the entire pipeline offline (synthetic
TCGCSV-shaped fixtures, including a PPMd .7z extraction roundtrip) — no
network needed.

## Explicitly not built

No buying/offer tooling, no collection tracking, no portfolio P&L, no auth.
Pokemon (category 3) only for v1; the schema is groupId-scoped so Magic
(category 1) can be added by fetching another category.
