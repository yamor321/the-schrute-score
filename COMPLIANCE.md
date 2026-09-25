# Compliance: Artificial Analysis data redistribution

**Status: UNRESOLVED. The repo owner must verify this before promoting the dashboard widely.**

## What this project does with the data

- It fetches model benchmark and pricing data from the Artificial Analysis Data API (free tier), about 2 requests per day.
- It republishes derived data (a computed ranking plus the underlying benchmark and price values) on a public, free, non-commercial website (GitHub Pages).
- It commits the **raw, unmodified API responses** to a public GitHub repository (`data/raw/`) for auditability.
- It credits Artificial Analysis on every page ("Data from Artificial Analysis (artificialanalysis.ai)", with a link), as the free API's attribution requirement asks.

## The open question

Artificial Analysis's documentation says attribution is required for all use of the free API. Their pricing page also lists **"redistribution rights for customer-facing products"** as a feature associated with paid tiers.

It is **not clear** whether a free, public, non-commercial, attributed dashboard like this one:

1. is fine under the free tier's normal terms, or
2. counts as a "customer-facing product" that needs a paid tier or explicit permission.

Committing the raw API responses to a public repository may be a separate issue. It is closer to bulk redistribution than to showing derived results.

This project does **not** decide the question. Nothing here should be read as a legal opinion.

## What the repo owner should do

1. Read Artificial Analysis's current Terms of Service and API documentation (https://artificialanalysis.ai), because terms change.
2. Email Artificial Analysis directly. Describe this project (free, public, non-commercial, attributed, derived value ranking, link to the repo and dashboard). Ask whether it's allowed on the free tier, and specifically whether publishing raw API responses in `data/raw/` is acceptable.
3. Keep their written answer (e.g. summarize it here with a date).
4. Until you have an answer:
   - it's reasonable to keep building and testing,
   - but hold off on promoting the dashboard widely.
5. If they say raw responses must not be published, remove `data/raw/` from the repo (and its git history), and change `src/persist.ts` to stop writing raw files, or write them only as a workflow artifact.
6. If they require a paid tier, decide whether to upgrade or take the dashboard down.

## Record of verification

| Date | Who | Outcome |
|---|---|---|
| — | — | *Not yet verified* |
