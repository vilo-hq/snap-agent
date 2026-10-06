/**
 * Query parameters that only record HOW a visitor reached a page — ads, newsletters, the store's own
 * recommendation carousels — and never change what the page shows.
 *
 * Used as the FALLBACK identity signal, after the page's own `rel="canonical"` (see
 * `resolvePageIdentityUrl`), and to avoid crawling the same page once per carousel that links it.
 *
 * WHY: a Tiendanube store links every product as `…/producto/?recommendation_source=…&recommender=…`
 * from its carousels; one crawl indexed 671 URLs for 372 real pages, and the chat showed the same
 * product three times in a row.
 *
 * A closed list on purpose, not "drop the query": `?id=`, `?p=2` or `?variant=` DO change the
 * content on some sites. Kept in sync with AgentSnapServer `src/lib/trackingParams.ts`.
 */
const TRACKING_PARAMS = new Set([
  // Ads and analytics
  'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'li_fat_id',
  'igshid', 'srsltid', '_ga', '_gl',
  // Email
  'mc_cid', 'mc_eid',
  // Store recommendation and search tracking (Tiendanube, Shopify)
  'recommendation_source', 'recommender', '_pos', '_sid', '_ss', '_psq', '_fid',
]);
const TRACKING_PREFIXES = ['utm_', 'hsa_'];

export function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  return TRACKING_PARAMS.has(key) || TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Removes tracking parameters from an absolute URL, keeping every other parameter in order. */
export function stripTrackingParams(url: string): string {
  try {
    const u = new URL(url);
    for (const name of [...u.searchParams.keys()]) if (isTrackingParam(name)) u.searchParams.delete(name);
    return u.toString();
  } catch {
    return url;
  }
}
