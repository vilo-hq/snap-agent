# @snap-agent/rag-web — TODO

## Content extraction

### Cross-page template detection (boilerplate removal for crawls)  — *follow-up*

**Problem.** Per-page extraction (`htmlPageExtract.ts`: content-container selection + `DEFAULT_REMOVE_SELECTORS` + link-density pruning, shipped in 0.1.9) removes most chrome, but site-specific boilerplate that isn't link-dense and doesn't match a selector (e.g. a promo banner, a "store info" block, repeated marketing copy) still leaks into every page. On a website *crawl* this boilerplate is **byte-identical across every page** — which is exactly the signal we can exploit.

**Idea.** Detect blocks that repeat across many pages of the same crawl and strip them as template/boilerplate:

1. During a crawl, for each page hash its candidate blocks (e.g. normalized text of each block-level element, or shingles).
2. Accumulate block-hash → page-count across the run.
3. After (or progressively during) the crawl, treat any block appearing on ≥ K pages (or ≥ X% of pages) as boilerplate and remove it from extracted content.

This is the standard "template detection / site-level boilerplate removal" approach and is the most robust way to clean repeated chrome without per-site selectors.

**Where it fits in our system.** The server already drives a resumable BFS crawl (`AgentSnapServer`: `web_crawl_frontier_items`, `runWebRagCrawlSlice`). Block-frequency must accumulate **across slices**, so it's stateful:
- Option A — server-side: collect per-page block hashes from the SDK (would need the SDK to surface block hashes alongside `pageStatuses`), aggregate in Mongo, then re-process/strip on a second pass.
- Option B — SDK-side with a caller-provided frequency store (callback/handle) so the SDK can ask "have I seen this block before?".

**Cost / caveats.**
- Two-pass or deferred indexing (you don't know what's boilerplate until you've seen enough pages), or a rolling threshold that strips once a block crosses K.
- Small crawls (few pages) have weak signal — keep a minimum-page floor before trusting repetition.
- Must not strip legitimately-repeated *content* (rare, but e.g. a shared spec table) — tune K and require the block to be non-content-ish (short, navigational).

**Status:** not started. Do after 0.1.9 (#1 body-fallback fix, #2 stronger remove selectors, #3 link-density pruning) is validated against real crawls.
